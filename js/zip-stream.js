// zip-stream.js — потоковая сборка ZIP без сжатия (store).
//
// Зачем: JSZip держит весь архив в памяти и на пакете в 20 000+ документов
// вкладка падает — ZIP просто не собирается (по ~120 КБ на документ это
// гигабайты в куче). Здесь запись идёт «на выход» по одному файлу: память не
// растёт, размер архива ограничен только диском.
//
// Куда пишем:
//   • в браузере — в FileSystemWritableFileStream (File System Access API),
//     то есть сразу в файл, выбранный пользователем;
//   • в Node — в part-файл пакетного генератора (tools/daip-batch/zip-writer.js
//     переиспользует отсюда формат заголовков, чтобы он не разъезжался).
//
// Сжатие не применяется намеренно: внутри PDF потоки уже сжаты, deflate даёт
// ~4 % и только тратит время (вкладка тоже пишет STORE).
//
// ZIP64 включается сам, когда архив перевалит 4 ГБ или записей станет больше
// 65 534 — годовой реестр это ~11 ГБ и ~96 000 документов.

const ZipFormat = {
  SIG_LOCAL: 0x04034b50,
  SIG_CEN: 0x02014b50,
  SIG_EOCD: 0x06054b50,
  SIG_Z64_EOCD: 0x06064b50,
  SIG_Z64_LOC: 0x07064b50,
  FLAG_UTF8: 0x0800,          // бит 11 — имя файла в UTF-8 (иначе кракозябры на Windows)
  U32_MAX: 0xFFFFFFFF,
  U16_MAX: 0xFFFF,

  _crcTable: null,
  _table() {
    if (ZipFormat._crcTable) return ZipFormat._crcTable;
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    ZipFormat._crcTable = t;
    return t;
  },

  crc32(bytes) {
    const t = ZipFormat._table();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  },

  // Дата/время записи в формате DOS (точность 2 секунды).
  dosTime(date) {
    const d = date || new Date();
    return {
      time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f),
      day: (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
    };
  },

  _utf8(s) {
    return new TextEncoder().encode(String(s));
  },

  _view(len) {
    const buf = new ArrayBuffer(len);
    return { bytes: new Uint8Array(buf), dv: new DataView(buf) };
  },

  // Локальный заголовок записи (30 байт + имя). Данные пишутся сразу за ним.
  localHeader(nameBytes, crc, size, dos) {
    const { bytes, dv } = ZipFormat._view(30 + nameBytes.length);
    dv.setUint32(0, ZipFormat.SIG_LOCAL, true);
    dv.setUint16(4, 20, true);                  // версия для распаковки: 2.0
    dv.setUint16(6, ZipFormat.FLAG_UTF8, true);
    dv.setUint16(8, 0, true);                   // метод: store
    dv.setUint16(10, dos.time, true);
    dv.setUint16(12, dos.day, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);               // сжатый размер = исходному
    dv.setUint32(22, size, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);                  // extra field отсутствует
    bytes.set(nameBytes, 30);
    return bytes;
  },

  // Запись центрального каталога. Смещение больше 4 ГБ уезжает в ZIP64-extra.
  centralEntry(e, dos) {
    const nameBytes = ZipFormat._utf8(e.name);
    const big = e.offset > ZipFormat.U32_MAX;
    const extraLen = big ? 12 : 0;              // id(2) + размер(2) + смещение(8)
    const { bytes, dv } = ZipFormat._view(46 + nameBytes.length + extraLen);
    dv.setUint32(0, ZipFormat.SIG_CEN, true);
    dv.setUint16(4, 0x031E, true);              // создано: Unix, ZIP 3.0
    dv.setUint16(6, big ? 45 : 20, true);       // версия для распаковки
    dv.setUint16(8, ZipFormat.FLAG_UTF8, true);
    dv.setUint16(10, 0, true);                  // метод: store
    dv.setUint16(12, dos.time, true);
    dv.setUint16(14, dos.day, true);
    dv.setUint32(16, e.crc, true);
    dv.setUint32(20, e.size, true);
    dv.setUint32(24, e.size, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint16(30, extraLen, true);
    dv.setUint16(32, 0, true);                  // комментарий
    dv.setUint16(34, 0, true);                  // номер диска
    dv.setUint16(36, 0, true);                  // внутренние атрибуты
    dv.setUint32(38, 0x81A40000, true);         // права 0644 (внешние атрибуты Unix)
    dv.setUint32(42, big ? ZipFormat.U32_MAX : e.offset, true);
    bytes.set(nameBytes, 46);
    if (big) {
      const p = 46 + nameBytes.length;
      dv.setUint16(p, 0x0001, true);            // id ZIP64
      dv.setUint16(p + 2, 8, true);
      dv.setBigUint64(p + 4, BigInt(e.offset), true);
    }
    return bytes;
  },

  // Хвост архива: центральный каталог + EOCD (при нужде — ZIP64 EOCD с локатором).
  tail(entries, cdOffset, dos) {
    const parts = [];
    let cdSize = 0;
    for (const e of entries) {
      const b = ZipFormat.centralEntry(e, dos);
      parts.push(b);
      cdSize += b.length;
    }
    const U32 = ZipFormat.U32_MAX, U16 = ZipFormat.U16_MAX;
    if (entries.length > U16 - 1 || cdOffset > U32 || cdSize > U32) {
      const z = ZipFormat._view(56);
      z.dv.setUint32(0, ZipFormat.SIG_Z64_EOCD, true);
      z.dv.setBigUint64(4, 44n, true);          // размер записи без первых 12 байт
      z.dv.setUint16(12, 0x031E, true);
      z.dv.setUint16(14, 45, true);
      z.dv.setUint32(16, 0, true);              // номер диска
      z.dv.setUint32(20, 0, true);              // диск с началом каталога
      z.dv.setBigUint64(24, BigInt(entries.length), true);
      z.dv.setBigUint64(32, BigInt(entries.length), true);
      z.dv.setBigUint64(40, BigInt(cdSize), true);
      z.dv.setBigUint64(48, BigInt(cdOffset), true);
      const l = ZipFormat._view(20);
      l.dv.setUint32(0, ZipFormat.SIG_Z64_LOC, true);
      l.dv.setUint32(4, 0, true);
      l.dv.setBigUint64(8, BigInt(cdOffset + cdSize), true);
      l.dv.setUint32(16, 1, true);              // всего дисков
      parts.push(z.bytes, l.bytes);
    }
    // Раскладка EOCD: sig(4) диск(2) диск каталога(2) записей на диске(2)
    // записей всего(2) размер каталога(4) смещение каталога(4) комментарий(2).
    const e = ZipFormat._view(22);
    e.dv.setUint32(0, ZipFormat.SIG_EOCD, true);
    e.dv.setUint16(4, 0, true);
    e.dv.setUint16(6, 0, true);
    e.dv.setUint16(8, Math.min(entries.length, U16), true);
    e.dv.setUint16(10, Math.min(entries.length, U16), true);
    e.dv.setUint32(12, Math.min(cdSize, U32), true);
    e.dv.setUint32(16, Math.min(cdOffset, U32), true);
    e.dv.setUint16(20, 0, true);
    parts.push(e.bytes);
    const total = parts.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  },
};

// Архив, который пишется «на выход» по одному файлу.
// sink — объект с методом write(Uint8Array) (годится FileSystemWritableFileStream,
// WritableStreamDefaultWriter или своя обёртка над файлом).
class ZipStream {
  constructor(sink, date) {
    this.sink = sink;
    this.dos = ZipFormat.dosTime(date);
    this.offset = 0;
    this.entries = [];
  }

  // name — имя внутри архива, data — Uint8Array/ArrayBuffer с содержимым.
  async add(name, data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const nameBytes = ZipFormat._utf8(name);
    const crc = ZipFormat.crc32(bytes);
    const header = ZipFormat.localHeader(nameBytes, crc, bytes.length, this.dos);
    this.entries.push({ name, crc, size: bytes.length, offset: this.offset });
    await this.sink.write(header);
    await this.sink.write(bytes);
    this.offset += header.length + bytes.length;
  }

  // Дописывает центральный каталог. Сам sink не закрывает — это дело вызывающего.
  async close() {
    const tail = ZipFormat.tail(this.entries, this.offset, this.dos);
    await this.sink.write(tail);
    this.offset += tail.length;
    return { count: this.entries.length, size: this.offset };
  }
}

if (typeof window !== 'undefined') { window.ZipFormat = ZipFormat; window.ZipStream = ZipStream; }
if (typeof module !== 'undefined' && module.exports) module.exports = { ZipFormat, ZipStream };
