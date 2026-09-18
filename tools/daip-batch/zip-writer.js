// zip-writer.js — сборка ZIP из нескольких процессов для пакетной печати.
//
// Формат архива НЕ повторяется здесь: заголовки и центральный каталог берутся
// из js/zip-stream.js (ZipFormat) — того же модуля, которым архив пишет вкладка
// приложения. Так две реализации не разъезжаются.
//
// Зачем не системный `zip` и не JSZip:
//   • `zip` из macOS собран без UNICODE_SUPPORT: он не ставит флаг UTF-8 (бит 11)
//     в именах, и «Рекомендация ДАиП …» на Windows превращается в кракозябры
//     (опция -UN=UTF8 там не поддерживается);
//   • JSZip держит весь архив в памяти — на годовом реестре это гигабайты;
//   • промежуточные PDF-файлы тоже не нужны: документ пишется в архив сразу
//     после генерации, на диск уходит ровно один архив, а не «папка PDF + ZIP».
//
// Как это работает при нескольких процессах: каждый процесс пишет свой
// part-файл — готовую последовательность локальных записей ZIP (заголовок +
// данные) — и список записей с их смещениями внутри part. Мастер склеивает
// part-файлы в итоговый архив (простое копирование байтов), сдвигая смещения на
// начало каждого part, и дописывает центральный каталог. Формат ZIP это
// позволяет: данные и каталог независимы, каталог хранит абсолютные смещения.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { ZipFormat } = require(path.resolve(__dirname, '..', '..', 'js', 'zip-stream.js'));

// CRC32 считаем нативным zlib (Node 20.15+): на 11 ГБ пакета это заметно
// быстрее, чем табличная реализация из ZipFormat. Нет функции — берём её.
const crc32 = (buf) => ((typeof zlib.crc32 === 'function' ? zlib.crc32(buf) : ZipFormat.crc32(buf)) >>> 0);

// Пишет последовательность локальных записей в один part-файл.
// В процессе-генераторе: add() → сразу на диск, в памяти ничего не копится.
class ZipPart {
  constructor(filePath, date) {
    this.path = filePath;
    this.fd = fs.openSync(filePath, 'w');
    this.offset = 0;
    this.entries = [];
    this.dos = ZipFormat.dosTime(date);
  }

  // name — имя внутри архива, data — Buffer с содержимым файла.
  add(name, data) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const header = ZipFormat.localHeader(nameBytes, crc, data.length, this.dos);
    const entryOffset = this.offset;
    fs.writeSync(this.fd, header);
    fs.writeSync(this.fd, data);
    this.offset += header.length + data.length;
    this.entries.push({ name, crc, size: data.length, offset: entryOffset });
    return entryOffset;
  }

  // Закрывает part и сохраняет список записей рядом (.json) — его читает мастер.
  // Отсутствие .json = процесс не довёл свою часть до конца.
  close() {
    fs.closeSync(this.fd);
    const meta = { size: this.offset, dos: this.dos, entries: this.entries };
    fs.writeFileSync(this.path + '.json', JSON.stringify(meta));
    return meta;
  }
}

// Склеивает part-файлы в готовый архив. parts — пути к part-файлам (рядом с
// каждым лежит <part>.json со списком записей). onProgress(скопировано, всего).
async function assemble(zipPath, parts, onProgress) {
  const metas = parts.map((p) => JSON.parse(fs.readFileSync(p + '.json', 'utf8')));
  const totalBytes = metas.reduce((a, m) => a + m.size, 0);
  const out = fs.createWriteStream(zipPath);
  const entries = [];
  let base = 0, copied = 0;
  for (let i = 0; i < parts.length; i++) {
    const meta = metas[i];
    for (const e of meta.entries) entries.push({ ...e, offset: e.offset + base });
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(parts[i], { highWaterMark: 4 << 20 });
      rs.on('data', (chunk) => {
        copied += chunk.length;
        if (onProgress) onProgress(copied, totalBytes);
      });
      rs.on('error', reject);
      rs.on('end', resolve);
      rs.pipe(out, { end: false });
    });
    base += meta.size;
  }
  const dos = metas[0] ? metas[0].dos : ZipFormat.dosTime();
  out.write(ZipFormat.tail(entries, base, dos));
  await new Promise((resolve, reject) => { out.on('error', reject); out.end(resolve); });
  return { count: entries.length, size: fs.statSync(zipPath).size };
}

module.exports = { ZipPart, assemble };
