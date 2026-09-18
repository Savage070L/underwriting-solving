#!/usr/bin/env node
// verify-zip.js — проверка готового архива «Рекомендации ДАиП» против реестра.
//
// Зачем отдельная проверка: пакет на десятки тысяч документов глазами не
// посмотришь, а тихо пропущенный договор выглядит точно так же, как успешный
// прогон. Здесь архив читается СВОИМ разбором центрального каталога (не тем
// кодом, что его писал) и сверяется с реестром по именам файлов:
//   • каждому договору реестра соответствует запись в архиве и наоборот;
//   • у выборки записей сверяется CRC32 и то, что внутри действительно PDF.
//
// Использование:
//   node tools/daip-batch/verify-zip.js --zip "<архив>.zip" --in "<реестр>.xlsx"
//                                      [--sheet <имя>] [--sample <N>]
//
//   --sample <N>  сколько записей распаковать и проверить (по умолчанию 25;
//                 0 — только сверка состава, без распаковки)

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { loadApp } = require('./app-env.js');
const { readRegistry } = require('./print-daip.js');

function parseArgs(argv) {
  const out = { sample: 25 };
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case '--zip': out.zip = next(); break;
      case '--in': out.in = next(); break;
      case '--sheet': out.sheet = next(); break;
      case '--sample': out.sample = parseInt(next(), 10); break;
      default: throw new Error(`Неизвестная опция: ${argv[i]}`);
    }
  }
  return out;
}

// Разбор центрального каталога: [{name, crc, size, offset}]. Поддержан ZIP64
// (смещение больше 4 ГБ лежит в extra-поле 0x0001).
function readCentralDirectory(fd, fileSize) {
  // EOCD ищем с конца — в нём может быть комментарий до 64 КБ.
  const tailLen = Math.min(fileSize, 66560);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, fileSize - tailLen);
  const eocdAt = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdAt < 0) throw new Error('EOCD не найден — это не ZIP или файл обрезан');
  let count = tail.readUInt16LE(eocdAt + 10);
  let cdSize = tail.readUInt32LE(eocdAt + 12);
  let cdOffset = tail.readUInt32LE(eocdAt + 16);
  // ZIP64: маркеры 0xFFFF/0xFFFFFFFF означают «смотри ZIP64 EOCD».
  const locAt = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
  if (locAt >= 0 && (count === 0xFFFF || cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF)) {
    const z64At = Number(tail.readBigUInt64LE(locAt + 8));
    const z64 = Buffer.alloc(56);
    fs.readSync(fd, z64, 0, 56, z64At);
    if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('ZIP64 EOCD не на месте');
    count = Number(z64.readBigUInt64LE(32));
    cdSize = Number(z64.readBigUInt64LE(40));
    cdOffset = Number(z64.readBigUInt64LE(48));
  }
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  const entries = [];
  let at = 0;
  while (at < cd.length && cd.readUInt32LE(at) === 0x02014b50) {
    const nameLen = cd.readUInt16LE(at + 28);
    const extraLen = cd.readUInt16LE(at + 30);
    const commentLen = cd.readUInt16LE(at + 32);
    const e = {
      name: cd.toString('utf8', at + 46, at + 46 + nameLen),
      crc: cd.readUInt32LE(at + 16),
      size: cd.readUInt32LE(at + 24),
      offset: cd.readUInt32LE(at + 42),
      utf8: !!(cd.readUInt16LE(at + 8) & 0x0800),
      method: cd.readUInt16LE(at + 10),
    };
    if (e.offset === 0xFFFFFFFF) {
      // ZIP64-extra: перебираем поля extra, ищем id 0x0001.
      let p = at + 46 + nameLen;
      const end = p + extraLen;
      while (p + 4 <= end) {
        const id = cd.readUInt16LE(p), len = cd.readUInt16LE(p + 2);
        if (id === 0x0001) { e.offset = Number(cd.readBigUInt64LE(p + 4 + (e.size === 0xFFFFFFFF ? 16 : 0))); break; }
        p += 4 + len;
      }
    }
    entries.push(e);
    at += 46 + nameLen + extraLen + commentLen;
  }
  if (entries.length !== count) {
    throw new Error(`В каталоге ${entries.length} записей, а EOCD обещал ${count}`);
  }
  return entries;
}

// Читает содержимое записи по локальному заголовку и сверяет CRC32.
function readEntry(fd, e) {
  const head = Buffer.alloc(30);
  fs.readSync(fd, head, 0, 30, e.offset);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`${e.name}: локальный заголовок не на месте`);
  const nameLen = head.readUInt16LE(26), extraLen = head.readUInt16LE(28);
  const data = Buffer.alloc(e.size);
  fs.readSync(fd, data, 0, e.size, e.offset + 30 + nameLen + extraLen);
  const crc = zlib.crc32(data) >>> 0;
  if (crc !== e.crc) throw new Error(`${e.name}: CRC не сходится`);
  return data;
}

function main() {
  const opts = parseArgs(process.argv);
  if (!opts.zip || !opts.in) throw new Error('Нужны --zip <архив> и --in <реестр .xlsx>');
  loadApp();
  const { groups, total } = readRegistry(path.resolve(opts.in), opts.sheet);
  const expected = new Set(groups.map((g) => g.file));

  const zipPath = path.resolve(opts.zip);
  const fd = fs.openSync(zipPath, 'r');
  const size = fs.statSync(zipPath).size;
  const entries = readCentralDirectory(fd, size);
  const got = new Set(entries.map((e) => e.name));

  const missing = [...expected].filter((n) => !got.has(n));
  const extra = [...got].filter((n) => !expected.has(n));
  const notStored = entries.filter((e) => e.method !== 0).length;
  const notUtf8 = entries.filter((e) => !e.utf8).length;

  console.log(`Архив: ${path.basename(zipPath)}`);
  console.log(`  записей: ${entries.length} · договоров в реестре: ${groups.length} (строк ОСНС: ${total})`);
  console.log(`  нет в архиве: ${missing.length} · лишних: ${extra.length}`
    + ` · дубликатов имён: ${entries.length - got.size}`);
  console.log(`  без флага UTF-8: ${notUtf8} · со сжатием: ${notStored}`);
  missing.slice(0, 5).forEach((n) => console.log(`    нет: ${n}`));
  extra.slice(0, 5).forEach((n) => console.log(`    лишний: ${n}`));

  let checked = 0, notPdf = 0;
  const N = Math.max(0, Math.min(opts.sample || 0, entries.length));
  for (let i = 0; i < N; i++) {
    // Равномерная выборка по всему архиву, а не первые N подряд.
    const e = entries[Math.floor(i * entries.length / N)];
    const data = readEntry(fd, e);
    if (!data.slice(0, 5).equals(Buffer.from('%PDF-'))) { notPdf++; console.log(`    не PDF: ${e.name}`); }
    checked++;
  }
  fs.closeSync(fd);
  console.log(`  проверено распаковкой: ${checked} · CRC совпал у всех · не PDF: ${notPdf}`);
  const ok = !missing.length && !extra.length && entries.length === got.size && !notPdf && !notUtf8;
  console.log(ok ? '  ИТОГ: архив полный и читается' : '  ИТОГ: ЕСТЬ РАСХОЖДЕНИЯ (см. выше)');
  process.exit(ok ? 0 : 2);
}

main();
