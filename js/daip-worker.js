// daip-worker.js — печать «Рекомендаций ДАиП» в отдельном потоке.
//
// Зачем: один документ строится ~120 мс, поэтому годовой реестр (20 000+
// договоров) в одном потоке — это 40–50 минут, и всё это время вкладка занята.
// Воркеров по числу ядер → те же 20 000 печатаются за 5–7 минут, а интерфейс
// остаётся живым.
//
// Форма НЕ дублируется: воркер поднимает те же js/ar-form.js + js/ar-form-pdf.js,
// что и страница, и вызывает ARFormPdf.buildPdf — документ получается тот же.
//
// Две вещи, которые в воркере надо передать снаружи (иначе документ молча
// испортится):
//   • ФАКСИМИЛЕ. ARForm.SIGNATURES хранит пути вида 'assets/signatures/x.png'
//     относительно страницы, а в воркере базовый URL — папка js/. Поэтому
//     готовые data:URL подписей приходят в init-сообщении (страница всё равно
//     готовит их один раз на пакет).
//   • ИНДЕКС ГБД ЮЛ для суффикса «— резидент/нерезидент». Тот же вопрос с путём,
//     плюс его надо ДОЖДАТЬСЯ: без загруженного индекса ARForm._residencySuffix
//     вернёт пустую строку и суффикс тихо исчезнет из всех документов.
//
// pdfMake подключается ПОСЛЕ resident-check.js: последний в браузере сам
// стартует загрузку индекса по window/document, а в воркере их нет — если
// объявить window до него, он упадёт на document.readyState. Здесь индекс
// грузится вручную, с URL со страницы.

/* eslint-env worker */
importScripts('lib/pdf-fonts.js', 'resident-check.js', 'ar-form.js', 'ar-form-pdf.js', 'lib/pdfmake.min.js');

let SIGNATURES = null;      // {файл: {url, width, height}} — из init
let SIGNER = {};            // {name, role} — подписант Рекомендации

async function init(msg) {
  SIGNATURES = msg.signatures || {};
  SIGNER = { name: msg.underwriterName || '', role: msg.underwriterRole || '' };
  if (msg.residentDataUrl) {
    ResidentCheck.DATA_URL = msg.residentDataUrl;
    ResidentCheck.META_URL = msg.residentMetaUrl || msg.residentDataUrl.replace(/bins\.bin$/, 'meta.json');
    try { await ResidentCheck.load(); } catch (e) { /* без индекса суффикса не будет */ }
  }
  self.postMessage({ type: 'ready', resident: typeof ResidentCheck !== 'undefined' && ResidentCheck.ready() });
}

async function print(msg) {
  const t0 = (self.performance || Date).now();
  const blob = await ARFormPdf.buildPdf(msg.row, {
    underwriterName: SIGNER.name,
    underwriterRole: SIGNER.role,
    filials: msg.filials || [],
    printAlert: false,
    signatures: SIGNATURES,
  });
  const buf = await blob.arrayBuffer();
  // ms — сколько заняла сборка самого документа. Нужен не для красоты: если
  // печать идёт медленнее ожидаемого, сразу видно, тормозит документ или обмен
  // сообщениями/запись в архив.
  const ms = Math.round((self.performance || Date).now() - t0);
  // Передаём буфер владением (transfer) — копии в памяти не остаётся.
  self.postMessage({ type: 'done', id: msg.id, bytes: buf, ms }, [buf]);
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'init') await init(msg);
    else if (msg.type === 'print') await print(msg);
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: (err && err.message) || String(err) });
  }
};
