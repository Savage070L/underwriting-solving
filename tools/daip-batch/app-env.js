// app-env.js — запуск браузерных модулей приложения в Node без изменений.
//
// Зачем: «Печать рекомендаций ДАиП» в браузере упирается в память вкладки —
// ZIP на 20 000+ документов не собирается. Логика документа при этом полностью
// в js/ar-form.js + js/ar-form-pdf.js, а реестр читает js/batch-reader.js, и
// всё это не завязано на DOM. Поэтому Node-версия НЕ дублирует форму: она
// поднимает те же файлы в контексте с браузерными глобалами (window, fetch,
// Blob) и вызывает ARFormPdf.buildPdf — документ байт-в-байт тот же, что из
// вкладки.
//
// Единственные подмены: fetch → чтение файла с диска (факсимиле подписантов и
// индекс ГБД ЮЛ лежат в репозитории) и document → заглушка (её трогает только
// код вкладок, здесь он не вызывается).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_DIR = path.resolve(__dirname, '..', '..');

// Скрипты в том же порядке, что <script> в index.html: сначала библиотеки
// (pdfmake + вшитый Times New Roman, SheetJS), затем модули приложения.
const SCRIPTS = [
  'js/lib/pdf-fonts.js',
  'js/lib/pdfmake.min.js',
  'js/lib/xlsx.full.min.js',
  'js/utils.js',
  'js/resident-check.js',
  'js/batch-reader.js',
  'js/ar-form.js',
  'js/ar-form-pdf.js',
];

// fetch по относительному пути репозитория: 'assets/signatures/x.png' → файл.
// Возвращаем минимум, которым пользуются модули: ok/status/arrayBuffer/json.
function fileFetch(url) {
  const rel = String(url).replace(/^\.?\//, '');
  const abs = path.join(APP_DIR, rel);
  return new Promise((resolve) => {
    fs.promises.readFile(abs).then((buf) => {
      resolve({
        ok: true,
        status: 200,
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        json: async () => JSON.parse(buf.toString('utf8')),
        text: async () => buf.toString('utf8'),
      });
    }).catch((e) => {
      resolve({ ok: false, status: 404, statusText: e.message,
        arrayBuffer: async () => { throw e; }, json: async () => { throw e; },
        text: async () => { throw e; } });
    });
  });
}

let loaded = false;

// Поднимает браузерное окружение и загружает модули приложения в ГЛОБАЛЬНЫЙ
// контекст Node (vm.runInThisContext) — так `const Utils = {...}` из utils.js
// виден следующим скриптам ровно как при загрузке через <script>.
function loadApp() {
  if (loaded) return globalThis;
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.fetch = fileFetch;
  globalThis.navigator = globalThis.navigator || { userAgent: 'node' };
  // Заглушка DOM: её касается только код вкладок (BatchAR/DaipPrint), который
  // здесь не подключается. Нужна на случай, если библиотека щупает document.
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    createElementNS: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    head: { appendChild() {} },
    body: { appendChild() {} },
  };
  if (typeof globalThis.btoa !== 'function') {
    globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
    globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
  }
  for (const rel of SCRIPTS) {
    const file = path.join(APP_DIR, rel);
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  }
  loaded = true;
  return globalThis;
}

module.exports = { APP_DIR, loadApp, fileFetch };
