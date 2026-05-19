// background.js — service worker (MV3).
//
// Делает реальные fetch'ы к stat.gov.kz, используя cookies/ЭЦП-сессию пользователя
// (host_permissions включает stat.gov.kz → CORS не действует на extension fetch'и
// и cookies автоматически прикладываются при credentials:'include').
//
// stat.gov.kz отдаёт страницу как POST-форму с CSRF-токеном (sessid). JSON-API нет.
// Поэтому: GET страницу → parse sessid → POST с bin → parse результат-HTML.

const STATGOV_URL = 'https://stat.gov.kz/ru/cabinet/juridical/by/bin/';

// ============================================================
// Карта русских лейблов из stat.gov.kz → плоские поля для приложения.
// Дубликат "Наименование КРП" разрешаем позиционно (после Кода).
// ============================================================
const LABEL_MAP = {
  'БИН': 'bin',
  'Наименование': 'name',
  'Дата регистрации': 'registrationDate',
  'Основной код ОКЭД': 'okedPrimaryCode',
  'Наименование вида экономической деятельности': 'okedPrimaryName',
  'Вторичный код ОКЭД': 'okedSecondaryCode',
  'Код КРП (с учетом филиалов)': 'krpWithBranchesCode',
  'Код КРП (без учета филиалов)': 'krpWithoutBranchesCode',
  'КАТО': 'kato',
  'Юридический адрес': 'legalAddress',
  'Фамилия, имя, отчество руководителя': 'headFullname',
  'Код КФС': 'kfsCode',
  'Наименование КФС': 'kfsName',
  'Код сектора экономики': 'sectorCode',
  'Наименование сектора экономики': 'sectorName',
  // 'Наименование КРП' — обрабатываем позиционно ниже
};

/**
 * Главный лукап: GET-страница → sessid → POST с bin → распарсенный объект.
 */
async function fetchByBin(bin) {
  if (!/^\d{12}$/.test(bin)) {
    throw new Error('Invalid BIN — must be 12 digits');
  }

  // Step 1 — GET страницу, чтобы получить свежий sessid и cookies сессии.
  const pageResp = await fetch(STATGOV_URL, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!pageResp.ok) {
    throw new Error('stat.gov.kz GET вернул ' + pageResp.status);
  }
  const pageHtml = await pageResp.text();
  const sessidMatch = pageHtml.match(/<input[^>]*name="sessid"[^>]*value="([^"]+)"/i)
                   || pageHtml.match(/<input[^>]*value="([^"]+)"[^>]*name="sessid"/i);
  if (!sessidMatch) {
    // Скорее всего сессия не активна / истёк ЭЦП-логин.
    throw new Error('sessid не найден — войдите в кабинет stat.gov.kz через ЭЦП');
  }
  const sessid = sessidMatch[1];

  // Step 2 — POST с искомым БИН-ом (Bitrix принимает application/x-www-form-urlencoded).
  const body = new URLSearchParams({ sessid, bin }).toString();
  const searchResp = await fetch(STATGOV_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Origin': 'https://stat.gov.kz',
      'Referer': STATGOV_URL,
    },
    body,
  });
  if (!searchResp.ok) {
    throw new Error('stat.gov.kz POST вернул ' + searchResp.status);
  }
  const resultHtml = await searchResp.text();

  // Step 3 — парсим результат.
  return parseResultHtml(resultHtml, bin);
}

/**
 * Из HTML stat.gov.kz вытаскиваем .results-block .divTableRow > 2× .divTableCell
 * и маппим в плоский объект по русским лейблам.
 */
function parseResultHtml(html, requestedBin) {
  // Изолируем блок результатов, чтобы не зацепить шапку/футер.
  const blockMatch = html.match(/<div[^>]*class="[^"]*results-block[^"]*"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/i);
  const scope = blockMatch ? blockMatch[0] : html;

  // Проверка "не найдено".
  if (/Данные.*?не\s+найден/i.test(scope)) {
    return {
      bin: requestedBin,
      found: false,
      _source: 'stat.gov.kz',
      _fetchedAt: new Date().toISOString(),
    };
  }

  const rowRe = /<div[^>]*class="[^"]*divTableRow[^"]*"[^>]*>\s*<div[^>]*class="[^"]*divTableCell[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="[^"]*divTableCell[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  const pairs = [];
  let m;
  while ((m = rowRe.exec(scope)) !== null) {
    pairs.push([cleanText(m[1]), cleanText(m[2])]);
  }

  if (!pairs.length) {
    throw new Error('Результаты не распарсились. Скорее всего вёрстка stat.gov.kz изменилась.');
  }

  const out = {
    bin: null, name: null, registrationDate: null,
    okedPrimaryCode: null, okedPrimaryName: null, okedSecondaryCode: null,
    krpWithBranchesCode: null, krpWithBranchesName: null,
    krpWithoutBranchesCode: null, krpWithoutBranchesName: null,
    kato: null, legalAddress: null, headFullname: null,
    kfsCode: null, kfsName: null,
    sectorCode: null, sectorName: null,
    found: true,
    _source: 'stat.gov.kz',
    _fetchedAt: new Date().toISOString(),
    _raw: pairs, // отладка
  };

  // Позиционная обработка двух "Наименование КРП":
  // первое — после "Код КРП (с учетом ...)", второе — после "Код КРП (без учета ...)".
  let lastKrpVariant = null; // 'with' | 'without'
  for (const [label, value] of pairs) {
    const mapped = LABEL_MAP[label];
    if (mapped) {
      out[mapped] = value;
      if (label === 'Код КРП (с учетом филиалов)') lastKrpVariant = 'with';
      else if (label === 'Код КРП (без учета филиалов)') lastKrpVariant = 'without';
      continue;
    }
    if (label === 'Наименование КРП') {
      if (lastKrpVariant === 'with' && !out.krpWithBranchesName) out.krpWithBranchesName = value;
      else if (lastKrpVariant === 'without' && !out.krpWithoutBranchesName) out.krpWithoutBranchesName = value;
      else if (!out.krpWithBranchesName) out.krpWithBranchesName = value;
      else if (!out.krpWithoutBranchesName) out.krpWithoutBranchesName = value;
    }
  }

  return out;
}

function cleanText(htmlFragment) {
  return htmlFragment
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// === Message handler: получает запросы из content script ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'STATGOV_LOOKUP' && typeof msg.bin === 'string') {
    fetchByBin(msg.bin.trim())
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true; // keep channel open for async response
  }
  if (msg && msg.type === 'PING') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }
});
