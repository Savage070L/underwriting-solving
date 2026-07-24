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

// ============================================================
// kyc.kz — базовая карточка компании из window.__NUXT__ (Nuxt SSR).
// Без авторизации/ЭЦП/cookies: GET страницы → парсинг __NUXT__ строками.
// __NUXT__ — это минифицированный IIFE: (function(a,b,..){return {...}}(args)).
// Часть значений в объекте — ссылки на параметры (a,b,..), которые подставляются
// хвостовыми аргументами вызова. eval/new Function в MV3 запрещены, поэтому
// разбираем сбалансированными скобками + резолвим плейсхолдеры из карты args.
// ============================================================
// ============================================================================
// EGOV — РЕЗИДЕНТСТВО ПО БИН (P30.11)
// ----------------------------------------------------------------------------
// Эндпоинт поля БИН на портале egov (услуга e_084 / P30.11). Отдаёт JSON с
// АВТОРИТЕТНЫМ признаком resident + код статуса. Требует активную сессию egov —
// credentials:'include' + host_permissions на egov.kz прикладывают куки
// пользователя автоматически (расширение работает в его браузере).
//   resident:true,  status.code 002              → резидент
//   resident:false, status.code 033              → БИН принадлежит ИП (не юрлицо)
//   resident:false, status.code 034              → снят с учётной регистрации
//   resident:false (прочее)                      → нерезидент
// Источник актуальнее и полнее открытого gbd_ul: видит свежие регистрации,
// которых в открытых данных ещё нет.
const EGOV_RESID_URL = 'https://egov.kz/services/P30.11/rest/gbdul/organizations/';

async function fetchEgovResidency(bin) {
  if (!/^\d{12}$/.test(bin)) throw new Error('Invalid BIN — must be 12 digits');
  const resp = await fetch(EGOV_RESID_URL + bin, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://egov.kz/services/P30.11/',
    },
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error('Нет сессии egov.kz — войдите на портал egov.kz');
  }
  if (!resp.ok) throw new Error('egov P30.11 вернул ' + resp.status);
  // Без сессии egov редиректит на SSO и отдаёт HTML вместо JSON — ловим это.
  const ct = resp.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    throw new Error('egov вернул не JSON — войдите в egov.kz (нужна активная сессия портала)');
  }
  const d = await resp.json();
  const st = (d && d.status) || {};
  return {
    bin: d && d.bin || bin,
    resident: (d && typeof d.resident === 'boolean') ? d.resident : null,
    statusCode: st.code || null,
    statusText: (st.description && st.description.ru) || '',
    shortName: (d && (d.shortName || d.fullName)) || null,
    fullName: (d && d.fullName) || null,
    registrationDate: (d && d.registrationDate) || null,
    incorporationCountry: (d && d.incorporationCountry) || null,
  };
}

const KYC_URL = 'https://kyc.kz/search/company/';

async function fetchKyc(bin) {
  if (!/^\d{12}$/.test(bin)) throw new Error('Invalid BIN — must be 12 digits');
  const resp = await fetch(KYC_URL + bin, {
    method: 'GET',
    credentials: 'omit',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!resp.ok) throw new Error('kyc.kz вернул ' + resp.status);
  const html = await resp.text();
  return parseKycNuxt(html, bin);
}

// Индекс парной закрывающей скобки для открывающей по openIdx (с учётом строк).
function kycMatchBracket(s, openIdx) {
  const open = s[openIdx];
  const close = open === '{' ? '}' : open === '(' ? ')' : open === '[' ? ']' : null;
  if (!close) return -1;
  let depth = 0, inStr = false, q = '', esc = false;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === q) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = true; q = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Разбить по запятым верхнего уровня (с учётом строк и вложенных скобок).
function kycSplitTopLevel(s) {
  const parts = [];
  let depth = 0, inStr = false, q = '', esc = false, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === q) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = true; q = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}

// Разделить «key:value» по первому двоеточию верхнего уровня.
function kycSplitKeyVal(seg) {
  let depth = 0, inStr = false, q = '', esc = false;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === q) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = true; q = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ':' && depth === 0) return [seg.slice(0, i).trim(), seg.slice(i + 1).trim()];
  }
  return [seg.trim(), ''];
}

// Резолв значения: литерал (строка/число/bool/null) или плейсхолдер (a,b,..→subMap).
function kycResolveValue(raw, subMap) {
  if (raw == null) return null;
  raw = String(raw).trim();
  if (raw === '') return null;
  const first = raw[0], last = raw[raw.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    try {
      if (first === "'") {
        const inner = raw.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"');
        return JSON.parse('"' + inner + '"');
      }
      return JSON.parse(raw); // двойные кавычки ≈ JSON: декодирует <, / и т.п.
    } catch (e) {
      return raw.slice(1, -1);
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === 'undefined' || raw === 'void 0') return null;
  if (/^[A-Za-z_$][\w$]*$/.test(raw)) {
    return (subMap && Object.prototype.hasOwnProperty.call(subMap, raw)) ? subMap[raw] : null;
  }
  return raw; // вложенный объект/массив/выражение — нам не нужно
}

function kycStrOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// Запасное имя из <title> / og:title: «<Название>, БИН <бин> …».
function kycNameFromMeta(html) {
  const m = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
         || html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!m) return null;
  let t = m[1].trim().replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  t = t.replace(/[,—-]?\s*(БИН|ИИН)\b.*$/i, '').trim();
  return t || null;
}

function parseKycNuxt(html, bin) {
  const notFound = () => ({ bin, found: false, _source: 'kyc.kz', _fetchedAt: new Date().toISOString() });
  if (!html) return notFound();
  try {
    const nx = html.match(/window\.__NUXT__\s*=\s*([\s\S]*?)<\/script>/);
    const nameFallback = kycNameFromMeta(html);
    if (!nx) return notFound();
    const expr = nx[1];

    // Параметры IIFE и хвостовые аргументы → карта подстановки плейсхолдеров.
    const subMap = {};
    const pm = expr.match(/function\s*\(([^)]*)\)/);
    const params = pm ? pm[1].split(',').map(s => s.trim()).filter(Boolean) : [];
    if (params.length) {
      const bodyOpen = expr.indexOf('{', pm.index + pm[0].length);
      const bodyClose = bodyOpen >= 0 ? kycMatchBracket(expr, bodyOpen) : -1;
      if (bodyClose >= 0) {
        const callOpen = expr.indexOf('(', bodyClose);
        const callClose = callOpen >= 0 ? kycMatchBracket(expr, callOpen) : -1;
        if (callClose >= 0) {
          const argVals = kycSplitTopLevel(expr.slice(callOpen + 1, callClose)).map(a => kycResolveValue(a, {}));
          params.forEach((p, idx) => { subMap[p] = argVals[idx]; });
        }
      }
    }

    // Объект result внутри data:[{result:{...}}].
    let resultOpen = -1;
    const dataM = expr.match(/data\s*:\s*\[/);
    if (dataM) {
      const rm = expr.slice(dataM.index).match(/result\s*:\s*\{/);
      if (rm) resultOpen = expr.indexOf('{', dataM.index + rm.index + rm[0].length - 1);
    }
    if (resultOpen < 0) {
      const rm = expr.match(/result\s*:\s*\{/);
      if (rm) resultOpen = expr.indexOf('{', rm.index + rm[0].length - 1);
    }
    if (resultOpen < 0) return notFound(); // нет карточки → не найдено

    const resultClose = kycMatchBracket(expr, resultOpen);
    if (resultClose < 0) return notFound();
    const body = expr.slice(resultOpen + 1, resultClose);

    const fields = {};
    for (const seg of kycSplitTopLevel(body)) {
      const [k, v] = kycSplitKeyVal(seg);
      if (!k) continue;
      fields[k.replace(/^["']|["']$/g, '')] = v;
    }
    const rv = (k) => kycResolveValue(fields[k], subMap);
    const resolved = {};
    for (const k in fields) resolved[k] = kycResolveValue(fields[k], subMap);

    let name = kycStrOrNull(rv('title')) || kycStrOrNull(rv('short_name_ru'));
    if (name === '-') name = null;                 // плейсхолдер пустой карточки
    name = name || nameFallback || null;

    const okedPrimaryCode = kycStrOrNull(rv('okat'));   // okat в kyc.kz — это ОКЭД
    const legalAddress = kycStrOrNull(rv('official_address'));
    const registrationDate = kycStrOrNull(rv('dt_registration'));
    const headFullname = kycStrOrNull(rv('chief_name'));

    // «Не найдено»: kyc.kz отдаёт 200 даже для несуществующего БИН, но с пустой
    // карточкой (id:0, title:"-", остальные поля null). Считаем найденным, если
    // есть реальный id (>0) либо имя + хотя бы одно поле карточки.
    const idNum = Number(rv('id')) || 0;
    const isFound = idNum > 0 || (!!name && (!!okedPrimaryCode || !!legalAddress || !!registrationDate || !!headFullname));
    if (!isFound) return notFound();

    return {
      bin: kycStrOrNull(rv('bin')) || bin,
      name,
      isIndividual: rv('is_individual') === true,
      okedPrimaryCode,
      okedPrimaryName: kycStrOrNull(rv('main_activity')),
      okedSecondary: kycStrOrNull(rv('okat_secondary')),
      kato: kycStrOrNull(rv('kato')),
      krpCode: kycStrOrNull(rv('code_krp_full')),
      krpName: kycStrOrNull(rv('title_krp')),
      registrationDate,
      headFullname,
      legalAddress,
      status: kycStrOrNull(rv('reorg_status')),
      isActive: rv('is_active') === true,
      payNds: rv('pay_nds'),
      found: true,
      _source: 'kyc.kz',
      _fetchedAt: new Date().toISOString(),
      _raw: resolved,
    };
  } catch (e) {
    return Object.assign(notFound(), { _error: String(e && e.message || e) });
  }
}

/**
 * Лёгкая проверка реального подключения к stat.gov.kz — БЕЗ БИН.
 * Делает только Step 1 (GET кабинета) и смотрит, есть ли в странице sessid
 * (= активная ЭЦП-сессия). Возвращает { reachable, session }.
 *  - reachable:false        → stat.gov.kz не ответил (сеть/блокировка/5xx)
 *  - reachable:true, session:false → сайт открылся, но ЭЦП-сессии нет (нужен вход)
 *  - reachable:true, session:true  → всё работает, запросы по БИН пройдут
 */
async function statgovHealth() {
  let pageResp;
  try {
    pageResp = await fetch(STATGOV_URL, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
  } catch (e) {
    return { reachable: false, session: false, error: String(e && e.message || e) };
  }
  if (!pageResp.ok) {
    return { reachable: false, session: false, error: 'stat.gov.kz GET вернул ' + pageResp.status };
  }
  const html = await pageResp.text();
  const hasSessid = /<input[^>]*name="sessid"[^>]*value="[^"]+"/i.test(html)
                 || /<input[^>]*value="[^"]+"[^>]*name="sessid"/i.test(html);
  return { reachable: true, session: hasSessid };
}

// === Message handler: получает запросы из content script ===
// ============================================================================
// KEEPALIVE — держим сессии stat.gov.kz и egov живыми в течение рабочего дня.
// ----------------------------------------------------------------------------
// Сессии обеих служб истекают по БЕЗДЕЙСТВИЮ (обычно 15–30 мин) → под вечер
// пришлось бы перелогиниваться. Раз в KEEPALIVE_PERIOD_MIN минут делаем лёгкий
// авторизованный GET к каждой службе — это сдвигает idle-таймаут сессии
// (Set-Cookie обновляет общий cookie-jar браузера). Пингуем ТОЛЬКО пока открыта
// вкладка приложения (закрыл на ночь → сессии истекают сами). MV3 service worker
// эфемерный, поэтому расписание — на chrome.alarms (будит worker), не setInterval.
//
// Оговорка: если служба ограничивает АБСОЛЮТНУЮ длину сессии (а не только
// бездействие), keepalive её не продлит — тогда один перелогин за смену всё равно
// понадобится. Но частый кейс (вылет по бездействию) закрывается.
const KEEPALIVE_ALARM = 'sl-session-keepalive';
const KEEPALIVE_PERIOD_MIN = 5;
const KEEPALIVE_APP_TABS = [
  'https://savage070l.github.io/*',
  'http://localhost/*',
  'http://127.0.0.1/*',
];
const keepaliveState = { lastRun: 0, statgov: null, egov: null };

function ensureKeepaliveAlarm() {
  chrome.alarms.get(KEEPALIVE_ALARM, (a) => {
    if (!a) chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
  });
}
ensureKeepaliveAlarm();
chrome.runtime.onInstalled.addListener(ensureKeepaliveAlarm);
chrome.runtime.onStartup.addListener(ensureKeepaliveAlarm);

async function keepaliveHasAppTab() {
  try {
    const tabs = await chrome.tabs.query({ url: KEEPALIVE_APP_TABS });
    return !!(tabs && tabs.length);
  } catch (e) {
    return true; // не смогли узнать — на всякий случай пингуем
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!(await keepaliveHasAppTab())) return; // приложение закрыто → сессии пусть истекают сами
  keepaliveState.lastRun = Date.now();
  // Лёгкие authenticated GET'ы. Сессия жива → запрос сдвигает её таймаут.
  // Ошибки / редирект на SSO (сессия уже мертва) — просто глотаем.
  fetch(STATGOV_URL, { method: 'GET', credentials: 'include', cache: 'no-store' })
    .then((r) => { keepaliveState.statgov = !!(r && r.ok); })
    .catch(() => { keepaliveState.statgov = false; });
  // egov: read-only GET org-endpoint с dummy-БИН (000…0) — «трогает» сессию,
  // не запрашивая реальную компанию (сервер вернёт «не зарегистрирован»).
  fetch(EGOV_RESID_URL + '000000000000', {
    method: 'GET', credentials: 'include', cache: 'no-store',
    headers: { 'Accept': 'application/json' },
  })
    .then((r) => { keepaliveState.egov = !!(r && r.ok); })
    .catch(() => { keepaliveState.egov = false; });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'KEEPALIVE_STATUS') {
    sendResponse({ ok: true, data: { ...keepaliveState, periodMin: KEEPALIVE_PERIOD_MIN } });
    return false;
  }
  if (msg && msg.type === 'STATGOV_HEALTH') {
    statgovHealth()
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
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
  if (msg && msg.type === 'KYC_LOOKUP' && typeof msg.bin === 'string') {
    fetchKyc(msg.bin.trim())
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg && msg.type === 'EGOV_RESIDENCY_LOOKUP' && typeof msg.bin === 'string') {
    fetchEgovResidency(msg.bin.trim())
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg && msg.type === 'PING') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }
});
