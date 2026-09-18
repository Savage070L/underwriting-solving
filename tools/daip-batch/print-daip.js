#!/usr/bin/env node
// print-daip.js — пакетная печать «Рекомендаций ДАиП» из выгрузки «АндерРешение»
// в один ZIP, без браузера.
//
// Зачем нужен, если во вкладке «Печать рекомендации ДАиП» есть та же кнопка:
// вкладка собирает ZIP в памяти страницы, и на выгрузках в 20 000+ договоров
// (годовые реестры) она упирается в лимит памяти вкладки — ZIP не собирается.
// Здесь документ попадает в архив сразу после генерации (потоковая запись,
// см. tools/daip-batch/zip-writer.js), а генерация раскладывается по процессам
// по числу ядер — память не растёт, промежуточных PDF-файлов на диске нет.
//
// Документ НЕ переписан: форму строит тот же js/ar-form-pdf.js (через
// tools/daip-batch/app-env.js), реестр читает тот же js/batch-reader.js,
// группировка по договору, имена файлов и подписанты — как в js/daip-print.js.
// Печатаются ВСЕ договоры реестра (включая «красные»), проверка stat.gov.kz
// не требуется — ровно как во вкладке.
//
// Использование:
//   node tools/daip-batch/print-daip.js --in "<реестр>.xlsx" [опции]
//
//   --in <файл>          выгрузка «АндерРешение» (.xlsx)                 [обяз.]
//   --sheet <имя|номер>  лист книги (по умолчанию первый)
//   --out <папка>        куда положить ZIP (по умолчанию рядом с --in)
//   --label <текст>      подпись в имени ZIP (по умолчанию — имя файла --in)
//   --work <папка>       где держать part-файлы архива (по умолчанию — в --out)
//   --workers <N>        процессов генерации (по умолчанию ядра − 2)
//   --signer-name <ФИО>  подписант Рекомендации (по умолчанию из ARForm)
//   --signer-role <дол.> должность подписанта (по умолчанию «Андеррайтер»)
//   --keep-parts         не удалять part-файлы после сборки архива
//   --limit <N>          напечатать только первые N договоров (проверка)
//
// Результат: «Рекомендации ДАиП <label> (<кол-во договоров>).zip».

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork } = require('child_process');

const { loadApp } = require('./app-env.js');
const { ZipPart, assemble } = require('./zip-writer.js');

// ===== аргументы =====
function parseArgs(argv) {
  const out = { workers: null, limit: null, keepParts: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--in': out.in = next(); break;
      case '--sheet': out.sheet = next(); break;
      case '--out': out.out = next(); break;
      case '--label': out.label = next(); break;
      case '--work': out.work = next(); break;
      case '--workers': out.workers = parseInt(next(), 10); break;
      case '--signer-name': out.signerName = next(); break;
      case '--signer-role': out.signerRole = next(); break;
      case '--keep-parts': out.keepParts = true; break;
      case '--limit': out.limit = parseInt(next(), 10); break;
      // Служебные (ставит мастер при форке дочернего процесса).
      case '--shard': out.shard = parseInt(next(), 10); break;
      case '--shards': out.shards = parseInt(next(), 10); break;
      case '--part': out.part = next(); break;
      case '--stamp': out.stamp = next(); break;
      default:
        if (a.startsWith('--')) throw new Error(`Неизвестная опция: ${a}`);
    }
  }
  return out;
}

// ===== общая с вкладкой логика реестра =====

// Санитайзер имени файла — один в один BatchAR._safeName (js/batch-ar.js).
function safeName(s) {
  return String(s == null ? '' : s)
    .replace(/[\\/]/g, '-')
    .replace(/[:*?"<>|]/g, '_')
    .trim();
}

// Группировка по номеру договора — как DaipPrint._groupByContract:
// одна рекомендация на договор, остальные строки договора идут филиалами.
function groupByContract(rows) {
  const groups = new Map();
  rows.forEach((r, i) => {
    const key = r.contractNumber || `__no_${r.bin}_${i}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  return groups;
}

// Имя файла — как DaipPrint._fileName. Дубликаты получают « (2)», « (3)»…
// Ключ занятости в нижнем регистре: APFS по умолчанию регистр не различает, и
// два номера, отличающихся только регистром буквы, перезаписали бы друг друга.
function fileNameFor(cn, taken) {
  const base = `Рекомендация ДАиП ${safeName(cn) || 'без номера'}`;
  let name = `${base}.pdf`;
  let n = 2;
  while (taken.has(name.toLowerCase())) name = `${base} (${n++}).pdf`;
  taken.add(name.toLowerCase());
  return name;
}

// Читает реестр и возвращает [[номер договора, [строки]], …] в порядке файла,
// плюс готовое имя файла для каждого договора. Порядок детерминирован, поэтому
// мастер и дочерние процессы получают одинаковые имена, считая их независимо.
function readRegistry(file, sheet) {
  const buf = fs.readFileSync(file);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  // BatchReader.parse читает первый лист книги. Для многолистовых книг
  // («АндерРешение2021-2026П1.xlsx») нужный лист вырезаем в отдельную книгу —
  // парсер при этом остаётся нетронутым.
  let input = u8;
  if (sheet) {
    const wb = XLSX.read(u8, { type: 'array' });
    const name = /^\d+$/.test(String(sheet)) ? wb.SheetNames[parseInt(sheet, 10)] : sheet;
    if (!name || !wb.Sheets[name]) {
      throw new Error(`Лист «${sheet}» не найден. Есть: ${wb.SheetNames.join(', ')}`);
    }
    const one = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(one, wb.Sheets[name], 'Лист_1');
    input = new Uint8Array(XLSX.write(one, { type: 'array', bookType: 'xlsx' }));
  }
  const parsed = BatchReader.parse(input);
  // _raw — исходные ячейки строки, нужны только выгрузке превышений в Excel.
  // В документ они не идут, а на 29 000 строках это лишние сотни мегабайт.
  parsed.rows.forEach((r) => { delete r._raw; });
  const taken = new Set();
  const groups = [...groupByContract(parsed.rows).entries()].map(([cn, rows]) => ({
    cn, rows, file: fileNameFor(cn, taken),
  }));
  return { groups, total: parsed.total, skipped: parsed.skipped };
}

// ===== дочерний процесс: генерация своей доли документов =====
async function runChild(opts) {
  loadApp();
  // Признак резидентства в документе («БИН — резидент/нерезидент») берётся из
  // локального индекса ГБД ЮЛ. Ждём загрузку, иначе суффикс потеряется.
  await ResidentCheck.load();
  const { groups } = readRegistry(opts.in, opts.sheet);
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, groups.length) : groups.length;
  const signatures = await ARFormPdf._signaturesDataUrl();
  // Дата записей архива одна на весь запуск — мастер передаёт её всем процессам,
  // чтобы у документов в одном ZIP не разъезжалось время на секунды.
  const part = new ZipPart(opts.part, opts.stamp ? new Date(Number(opts.stamp)) : new Date());
  let done = 0, failed = 0, bytes = 0;
  const report = () => { try { process.send({ done, failed, bytes }); } catch (e) { /* мастер уже ушёл */ } };
  for (let i = opts.shard; i < limit; i += opts.shards) {
    const g = groups[i];
    try {
      const blob = await ARFormPdf.buildPdf(g.rows[0], {
        underwriterName: opts.signerName,
        underwriterRole: opts.signerRole,
        filials: g.rows.slice(1),
        printAlert: false,
        signatures,
      });
      const buf = Buffer.from(await blob.arrayBuffer());
      part.add(g.file, buf);
      bytes += buf.length;
    } catch (e) {
      failed++;
      process.send({ error: `Договор ${g.cn}: ${e.message}` });
    }
    done++;
    if (done % 25 === 0) report();
  }
  const meta = part.close();
  report();
  process.send({ finished: true, done, failed, bytes, entries: meta.entries.length });
}

// ===== мастер =====
function fmtBytes(n) {
  const u = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m} мин ${s % 60} с` : `${s} с`;
}

async function runMaster(opts) {
  if (!opts.in) throw new Error('Не указан --in <реестр .xlsx>');
  const inFile = path.resolve(opts.in);
  if (!fs.existsSync(inFile)) throw new Error(`Файл не найден: ${inFile}`);
  const outDir = path.resolve(opts.out || path.dirname(inFile));
  const label = opts.label || path.basename(inFile).replace(/\.xlsx?$/i, '');

  loadApp();
  await ResidentCheck.load();
  const t0 = Date.now();
  process.stdout.write(`Читаю реестр: ${path.basename(inFile)}${opts.sheet ? ` (лист ${opts.sheet})` : ''}…\n`);
  const { groups, total, skipped } = readRegistry(inFile, opts.sheet);
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, groups.length) : groups.length;
  process.stdout.write(`Строк ОСНС: ${total}${skipped ? ` (пропущено без БИН: ${skipped})` : ''} · договоров: ${groups.length}`
    + `${limit !== groups.length ? ` · печатаю первые ${limit}` : ''}\n`);
  if (!limit) throw new Error('В реестре нет договоров для печати');

  // Папка под part-файлы (по одному на процесс). По умолчанию рядом с ZIP:
  // в сумме они весят как итоговый архив — на годовом реестре это гигабайты,
  // в /tmp такое класть не стоит.
  const workRoot = path.resolve(opts.work || outDir);
  const workDir = path.join(workRoot, `.daip-part-${label.replace(/[\\/:*?"<>|]/g, '_')}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const cores = os.cpus().length;
  const workers = Math.max(1, Math.min(opts.workers || Math.max(1, cores - 2), limit));
  process.stdout.write(`Генерация: ${workers} процесс(ов)\n`);

  const stamp = Date.now();
  const partPath = (k) => path.join(workDir, `part-${k}.zipdata`);
  const childArgs = ['--in', inFile, '--shards', String(workers), '--stamp', String(stamp)];
  if (opts.sheet) childArgs.push('--sheet', String(opts.sheet));
  if (opts.signerName) childArgs.push('--signer-name', opts.signerName);
  if (opts.signerRole) childArgs.push('--signer-role', opts.signerRole);
  if (opts.limit) childArgs.push('--limit', String(opts.limit));

  const progress = new Array(workers).fill(0);
  const fails = new Array(workers).fill(0);
  const written = new Array(workers).fill(0);
  const errors = [];
  let lastPrint = 0;
  const printProgress = (force) => {
    const now = Date.now();
    if (!force && now - lastPrint < 5000) return;
    lastPrint = now;
    const done = progress.reduce((a, b) => a + b, 0);
    const pct = (done / limit * 100).toFixed(1);
    const rate = done / ((now - t0) / 1000);
    const eta = rate > 0 ? fmtDur((limit - done) / rate * 1000) : '—';
    const vol = fmtBytes(written.reduce((a, b) => a + b, 0));
    process.stdout.write(`  ${done}/${limit} (${pct}%) · ${rate.toFixed(1)} док/с · ${vol} · осталось ~${eta}\n`);
  };

  await new Promise((resolve, reject) => {
    let alive = workers;
    for (let k = 0; k < workers; k++) {
      const args = [...childArgs, '--shard', String(k), '--part', partPath(k)];
      const child = fork(__filename, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      child.on('message', (m) => {
        if (m.error) { errors.push(m.error); return; }
        if (m.done != null) progress[k] = m.done;
        if (m.failed != null) fails[k] = m.failed;
        if (m.bytes != null) written[k] = m.bytes;
        printProgress(false);
      });
      child.on('exit', (code) => {
        if (code !== 0) errors.push(`Процесс ${k} завершился с кодом ${code}`);
        if (--alive === 0) resolve();
      });
      child.on('error', reject);
    }
  });
  printProgress(true);

  const failed = fails.reduce((a, b) => a + b, 0);
  const made = progress.reduce((a, b) => a + b, 0) - failed;
  process.stdout.write(`Напечатано: ${made} из ${limit}${failed ? ` · ошибок: ${failed}` : ''}`
    + ` · ${fmtDur(Date.now() - t0)}\n`);
  if (errors.length) {
    process.stdout.write(`Ошибки (${errors.length}), первые 10:\n`);
    errors.slice(0, 10).forEach((e) => process.stdout.write(`  • ${e}\n`));
  }
  // part-файлы без .json — процесс упал, не закрыв свою часть: такой архив был
  // бы молча неполным, поэтому лучше остановиться.
  const parts = [];
  for (let k = 0; k < workers; k++) {
    if (!fs.existsSync(partPath(k) + '.json')) {
      throw new Error(`Часть ${k} не завершена (${path.basename(partPath(k))}) — архив не собираю,`
        + ` part-файлы оставлены в ${workDir}`);
    }
    parts.push(partPath(k));
  }
  if (!made) throw new Error('Ни один документ не напечатан — ZIP не собираю');

  // Сборка архива: копирование part-файлов + центральный каталог (см. zip-writer.js).
  const zipName = `Рекомендации ДАиП ${label} (${made}).zip`;
  const zipPath = path.join(outDir, zipName);
  fs.rmSync(zipPath, { force: true });
  process.stdout.write(`Собираю ZIP: ${zipName}\n`);
  let lastZipPrint = 0;
  const res = await assemble(zipPath, parts, (copied, totalBytes) => {
    const now = Date.now();
    if (now - lastZipPrint < 5000) return;
    lastZipPrint = now;
    process.stdout.write(`  ${fmtBytes(copied)} из ${fmtBytes(totalBytes)}\n`);
  });
  if (!opts.keepParts) fs.rmSync(workDir, { recursive: true, force: true });
  process.stdout.write(`Готово: ${zipPath}\n  документов: ${res.count} · ${fmtBytes(res.size)}`
    + ` · всего ${fmtDur(Date.now() - t0)}\n`);
  return { zipPath, count: res.count, size: res.size };
}

// ===== точка входа =====
// Разбор реестра переиспользует tools/daip-batch/verify-zip.js — поэтому при
// require() ничего не запускаем, только отдаём функции.
if (require.main === module) {
  const opts = parseArgs(process.argv);
  const isChild = opts.shard != null && opts.shards != null && opts.part;
  (isChild ? runChild(opts) : runMaster(opts)).catch((e) => {
    process.stderr.write(`Ошибка: ${e.message}\n${e.stack ? e.stack.split('\n').slice(1, 4).join('\n') + '\n' : ''}`);
    process.exit(1);
  });
}

module.exports = { readRegistry, groupByContract, fileNameFor, safeName };
