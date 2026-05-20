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
    okedPrimaryCode: null, okedPrimaryName: null,
    okedSecondaryCode: null,         // raw value (для обратной совместимости)
    okedSecondaryCodes: [],          // распарсенный массив
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

  // Разбиваем «Вторичный код ОКЭД» (может быть «02100, 81290, 81300» в одной ячейке).
  if (out.okedSecondaryCode) {
    out.okedSecondaryCodes = String(out.okedSecondaryCode)
      .split(/[\s,;/]+/)
      .map(s => s.trim())
      .filter(s => /^\d{4,5}$/.test(s));
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

// ============================================================
// STATSNET INDUSTRY LOOKUP
// Через background-вкладки: Яндекс-поиск → statsnet.co → парсинг «Отрасль».
// ============================================================

// Ждёт пока вкладка загрузится (status='complete')
function waitTabLoaded(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdate);
      reject(new Error('Таймаут загрузки вкладки'));
    }, timeoutMs);
    const onUpdate = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        if (done) return;
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdate);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdate);
  });
}

// Извлекает первую ссылку statsnet.co/companies из текущей страницы поиска
async function extractStatsnetUrl(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const links = Array.from(document.querySelectorAll('a'))
        .map(a => a.href)
        .filter(h => /statsnet\.co\/companies\//i.test(h));
      return links[0] || null;
    },
  });
  return result?.[0]?.result || null;
}

// Парсит «Отрасль» со страницы statsnet
async function extractIndustry(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const text = document.body?.innerText || '';
      const idx = text.indexOf('Отрасль');
      if (idx < 0) return { otrasl: null, h4s: [] };
      const after = text.slice(idx + 'Отрасль'.length);
      // Берём первую непустую строку после метки
      const lines = after.split('\n').map(s => s.trim()).filter(Boolean);
      const otrasl = lines[0] || null;
      // На всякий случай вернём заголовки H4 (там встречается название деятельности)
      const h4s = Array.from(document.querySelectorAll('h4'))
        .map(h => h.textContent?.trim() || '');
      // Также основной ОКЭД — иногда отображается как «Основной вид деятельности ОКЭД ХХХХХ»
      const okedMatch = text.match(/Основной\s+вид\s+деятельности\s+ОКЭД\s+(\d{4,5})/i);
      const oked = okedMatch ? okedMatch[1] : null;
      return { otrasl, h4s, oked };
    },
  });
  return result?.[0]?.result || null;
}

// Главная функция: ищет в Яндекс, fallback DuckDuckGo, парсит statsnet
async function fetchStatsnetIndustry(bin) {
  if (!/^\d{12}$/.test(bin)) throw new Error('Invalid BIN');

  const query = encodeURIComponent('statsnet.co ' + bin);
  // 1. Создаём фоновую вкладку с Яндекс-поиском
  const tab = await chrome.tabs.create({
    url: 'https://yandex.kz/search/?text=' + query,
    active: false,
  });

  try {
    await waitTabLoaded(tab.id);
    // Дадим время Яндекс-результатам полностью отрисоваться
    await new Promise(r => setTimeout(r, 1500));

    let statsnetUrl = await extractStatsnetUrl(tab.id);

    // 2. Fallback на DuckDuckGo если Яндекс не дал ссылки
    if (!statsnetUrl) {
      await chrome.tabs.update(tab.id, {
        url: 'https://duckduckgo.com/?q=' + query,
      });
      await waitTabLoaded(tab.id);
      await new Promise(r => setTimeout(r, 1500));
      statsnetUrl = await extractStatsnetUrl(tab.id);
    }

    if (!statsnetUrl) {
      return { found: false, reason: 'Ссылка на statsnet.co не найдена в поиске' };
    }

    // 3. Открываем statsnet в этой же вкладке
    await chrome.tabs.update(tab.id, { url: statsnetUrl });
    await waitTabLoaded(tab.id);
    // Подождать React-рендер (statsnet — SPA)
    await new Promise(r => setTimeout(r, 2500));

    const data = await extractIndustry(tab.id);
    return {
      found: true,
      statsnetUrl,
      industry: data?.otrasl || null,
      h4s: data?.h4s || [],
      okedFromStatsnet: data?.oked || null,
    };
  } finally {
    // 4. Всегда закрываем фоновую вкладку
    try { await chrome.tabs.remove(tab.id); } catch (_) {}
  }
}

// === Message handler: получает запросы из content script ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'STATGOV_LOOKUP' && typeof msg.bin === 'string') {
    fetchByBin(msg.bin.trim())
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg && msg.type === 'STATSNET_LOOKUP' && typeof msg.bin === 'string') {
    fetchStatsnetIndustry(msg.bin.trim())
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg && msg.type === 'PING') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }
});
