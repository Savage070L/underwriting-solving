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
  // Сначала проверяем ВХОД, а не sessid: у анонима sessid тоже есть (CSRF-токен
  // Bitrix), и раньше запрос молча уходил дальше, возвращая страницу логина
  // вместо данных — а индикатор считал сессию живой.
  if (!statgovIsLoggedIn(pageHtml)) {
    throw new Error('Нет ЭЦП-сессии — войдите в кабинет stat.gov.kz');
  }
  const sessidMatch = pageHtml.match(/<input[^>]*name="sessid"[^>]*value="([^"]+)"/i)
                   || pageHtml.match(/<input[^>]*value="([^"]+)"[^>]*name="sessid"/i);
  if (!sessidMatch) {
    throw new Error('sessid не найден на странице кабинета stat.gov.kz');
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
// EGOV — РЕЗИДЕНТСТВО ПО БИН (услуга P3001, запасная P3011)
// ----------------------------------------------------------------------------
// ПОРТАЛ ПЕРЕЕХАЛ. Старый JSF-портал с эндпоинтом
//   GET https://egov.kz/services/P30.11/rest/gbdul/organizations/{бин}   (куки-сессия)
// заменён Next.js-приложением: сам egov.kz теперь только фронт, а данные идут
// через шлюз fgw.egov.kz по Bearer-токену. Услуга «о госрегистрации юрлица и его
// подразделений» получила код P3011 (без точки), а лукап организации по БИН —
//   GET https://fgw.egov.kz/v1/P3011/organizations?bin={12 цифр}
//   Authorization: Bearer <access_token>
// Ответ:  { code:'SUCCESS', data:{ organization_info_list:[{ bin, name_ru, name_kz }] } }
// Ошибки в поле code (могут приходить с HTTP 200):
//   ORGANIZATION_NOT_FOUND_BY_BIN — в реестре юр. лиц РК такого БИН нет;
//   ORGANIZATION_LIQUIDATED       — юрлицо ликвидировано.
// Тот же путь есть у P3001/P3002/P3005/P3006 — это общий поиск организации в
// группе услуг ГБД ЮЛ. Основной теперь P3001 («Справки/сведения по юридическим
// лицам», тип «О госрегистрации юрлица и его подразделений») — см. ниже.
//
// ЧТО ИЗМЕНИЛОСЬ ДЛЯ НАС:
//   • признак resident отдельным полем больше НЕ приходит. Резидентство теперь
//     выводится из самого факта: организация найдена в реестре юр. лиц Минюста
//     РК → резидент; не найдена → нерезидент. Это ровно та же логика, что стоит
//     за старым resident:true/false, только считаем её мы.
//   • ликвидированная компания остаётся РЕЗИДЕНТОМ, но с пометкой (как в
//     локальном индексе ГБД ЮЛ: «резидент · ликвидирован»). Старый API отдавал
//     для неё resident:false — это давало ложного «нерезидента».
//   • дата регистрации и страна инкорпорации новым эндпоинтом не отдаются
//     (их и так дают stat.gov.kz / kyc.kz).
//
// ТОКЕН. Портал держит его не в куках, а в localStorage:
//   localStorage['identity_data'] → state.identityData.auth.access_token
// поэтому credentials:'include' больше не работает — токен читаем из вкладки
// egov.kz через chrome.scripting (host_permissions на egov.kz уже есть).
// Услуга ГБД ЮЛ, по которой ищем организацию по БИН. Пользователь указал
// P3001 («Справки/сведения по юридическим лицам», тип «О госрегистрации юрлица
// и его подразделений») — с неё и начинаем. Проверено вживую под сессией
// пользователя: на шаге поиска организации P3001 и P3011 отдают ОДИНАКОВЫЙ
// ответ (bin + name_ru/kz/en, тот же code/message), поэтому вердикт
// резидентства от смены услуги не меняется. Второй код оставлен запасным:
// если одну из услуг отключат, мост переживёт это без правок.
const EGOV_FGW_SERVICES = ['P3001', 'P3011'];
const egovFgwOrgUrl = (svc, bin) => `https://fgw.egov.kz/v1/${svc}/organizations?bin=${encodeURIComponent(bin)}`;
const EGOV_PORTAL_URL = 'https://egov.kz/ru';
const EGOV_TOKEN_LS_KEY = 'identity_data';
// Старый эндпоинт оставляем как fallback: если у пользователя ещё живёт сессия
// старого портала, а токена нового нет — резидентство всё равно проверится.
const EGOV_RESID_URL = 'https://egov.kz/services/P30.11/rest/gbdul/organizations/';

// ТОКЕНЫ КОРОТКИЕ (замерено на живом портале): access — 10 минут, refresh — 20,
// и refresh ОДНОРАЗОВЫЙ. Из этого следуют три жёстких правила:
//   1. Кэшируем пару в chrome.storage.session и обновляем её ЧИСТЫМ fetch —
//      фоновые вкладки egov.kz НЕ открываем вообще (они мигали у пользователя).
//   2. После каждого нашего refresh новую пару надо ДОНЕСТИ до портала: пишем
//      её в localStorage всех открытых вкладок egov.kz и кидаем synthetic
//      StorageEvent (портал слушает его и подхватывает пару в память), а
//      content-script egov-sync.js засеивает localStorage свежей парой ПРИ
//      ОТКРЫТИИ egov.kz — иначе портал стартует со сгоревшим refresh и
//      разлогинивает пользователя («постоянно вылетает из egov»).
//   3. Keepalive пару НЕ трогает (passive): жечь одноразовый refresh по таймеру
//      каждые 5 минут — это и была главная причина вылетов.
const EGOV_REFRESH_URL = 'https://fgw.egov.kz/identity/v3/auth/token/refresh';
const egovToken = { value: null, exp: 0 };        // access в памяти worker'а
let egovAuthPair = null;                          // {access_token, refresh_token} — зеркало storage.session
let egovTokenInFlight = null;                     // single-flight: пул из 6 воркеров ≠ 6 refresh
let egovTokenInFlightPassive = false;             // текущая попытка — пассивная (без refresh)

function jwtExpMs(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return 0;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const p = JSON.parse(json);
    return typeof p.exp === 'number' ? p.exp * 1000 : 0;
  } catch (e) {
    return 0;
  }
}

// Пара живёт в storage.session И в storage.local. session чистится при
// перезагрузке расширения и рестарте браузера — после этого мы переставали
// видеть сессию egov (нет открытой вкладки портала = нечего прочитать) и
// показывали «нужен вход», хотя пользователь был залогинен. local это
// переживает. Секрета мы не удлиняем: refresh живёт 20 минут, протухшую пару
// egovPairUsable() всё равно отбрасывает.
async function egovCacheLoad() {
  if (egovAuthPair) return egovAuthPair;
  try {
    const st = await chrome.storage.session.get('egovAuthPair');
    egovAuthPair = (st && st.egovAuthPair) || null;
  } catch (e) { /* session storage недоступен — живём на памяти */ }
  if (!egovAuthPair) {
    try {
      const st = await chrome.storage.local.get('egovAuthPair');
      egovAuthPair = (st && st.egovAuthPair) || null;
    } catch (e) {}
  }
  return egovAuthPair;
}
async function egovCacheSave(pair) {
  egovAuthPair = pair || null;
  try { await chrome.storage.session.set({ egovAuthPair: egovAuthPair }); } catch (e) {}
  try { await chrome.storage.local.set({ egovAuthPair: egovAuthPair }); } catch (e) {}
}

// Пара ещё на что-то годна: жив либо access, либо refresh (им обменяем access).
// Протухшая по обоим токенам пара — это не «сессия есть», а мусор.
function egovPairUsable(pair) {
  if (!pair || !pair.access_token) return false;
  const now = Date.now();
  if (jwtExpMs(pair.access_token) - 30000 > now) return true;
  if (!pair.refresh_token) return false;
  const rexp = jwtExpMs(pair.refresh_token);
  return rexp === 0 || rexp > now;   // exp не прочитался — считаем годной, решит сам запрос
}

// Читает пару токенов из localStorage вкладки egov.kz (zustand-persist store).
async function readEgovAuthFromTab(tabId) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func: (key) => {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const d = JSON.parse(raw);
        const auth = d && d.state && d.state.identityData && d.state.identityData.auth;
        return (auth && auth.access_token) ? { access_token: auth.access_token, refresh_token: auth.refresh_token || null } : null;
      } catch (e) {
        return null;
      }
    },
    args: [EGOV_TOKEN_LS_KEY],
  });
  return (res && res[0] && res[0].result) || null;
}

// Кладёт пару в localStorage вкладки и КИДАЕТ StorageEvent: страница портала
// держит токены в памяти (zustand) и одну лишь запись в localStorage не видит —
// без события она продолжит слать старый (уже сгоревший) refresh и разлогинится.
async function writeEgovAuthToTab(tabId, pair) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (key, p) => {
      try {
        const raw = localStorage.getItem(key);
        const d = raw ? JSON.parse(raw) : { state: { identityData: null, oauthData: null, hasHydrated: true }, version: 0 };
        if (!d.state) d.state = {};
        if (!d.state.identityData) d.state.identityData = {};
        d.state.identityData.auth = Object.assign({}, d.state.identityData.auth || {}, p);
        const next = JSON.stringify(d);
        localStorage.setItem(key, next);
        try {
          window.dispatchEvent(new StorageEvent('storage', { key, newValue: next, oldValue: raw, storageArea: localStorage }));
        } catch (e2) {}
        return true;
      } catch (e) {
        return false;
      }
    },
    args: [EGOV_TOKEN_LS_KEY, pair],
  });
}

async function egovTabs() {
  try { return await chrome.tabs.query({ url: 'https://egov.kz/*' }); } catch (e) { return []; }
}

// Обмен refresh-токена на новую пару (тот же вызов, что делает сам портал).
// Чистый fetch — вкладка не нужна.
async function refreshEgovAuth(auth) {
  if (!auth || !auth.refresh_token) return null;
  const resp = await fetch(EGOV_REFRESH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': 'Bearer ' + auth.access_token,
    },
    body: JSON.stringify({ refresh_token: auth.refresh_token }),
    cache: 'no-store',
  });
  const d = await resp.json().catch(() => null);
  const pair = d && d.data;
  if (!pair || !pair.access_token) return null;
  await egovCacheSave(pair);
  // Доносим пару до всех открытых вкладок портала.
  for (const t of await egovTabs()) {
    try { await writeEgovAuthToTab(t.id, pair); } catch (e) {}
  }
  return pair;
}

// Токен: живой access из кэша → свежая пара из открытой вкладки → refresh по
// кэшированной паре. Фоновые вкладки НЕ открываются. passive=true — только
// посмотреть (keepalive), одноразовый refresh не тратить.
function getEgovToken(opts) {
  const passive = !!(opts && opts.passive);
  if (egovToken.value && egovToken.exp - 30000 > Date.now()) return Promise.resolve(egovToken.value);
  // Разделяем очереди: пассивная проба (индикатор) НЕ делает refresh, и раньше
  // реальный запрос, подсевший на её промис, тоже оставался без обновления
  // токена — и падал на пустом месте. Пассивный ждёт активного (тот сделает
  // больше), активный пассивного — никогда.
  if (egovTokenInFlight) {
    if (passive || !egovTokenInFlightPassive) return egovTokenInFlight;
  }
  egovTokenInFlightPassive = passive;
  egovTokenInFlight = _getEgovToken(passive).finally(() => {
    egovTokenInFlight = null;
    egovTokenInFlightPassive = false;
  });
  return egovTokenInFlight;
}

async function _getEgovToken(passive) {
  const remember = (tok) => {
    if (!tok) return null;
    egovToken.value = tok;
    egovToken.exp = jwtExpMs(tok) || (Date.now() + 5 * 60 * 1000);
    return tok;
  };
  const alive = (tok) => !!tok && (jwtExpMs(tok) === 0 || jwtExpMs(tok) - 30000 > Date.now());
  let pair = await egovCacheLoad();
  // Открытая вкладка портала могла обновить пару сама — берём более свежую
  // (побеждает бОльший exp access-токена).
  for (const t of await egovTabs()) {
    const tabAuth = await readEgovAuthFromTab(t.id).catch(() => null);
    if (tabAuth && (!pair || jwtExpMs(tabAuth.access_token) > jwtExpMs(pair.access_token))) {
      pair = tabAuth;
      await egovCacheSave(pair);
    }
  }
  if (!pair) return null;
  if (alive(pair.access_token)) return remember(pair.access_token);
  if (passive) return null;
  const fresh = await refreshEgovAuth(pair).catch(() => null);
  return fresh ? remember(fresh.access_token) : null;
}

// Ответ нового шлюза → та же форма, что отдавал старый P30.11, чтобы
// приложению (ResidentCheck._egovVerdict) ничего не пришлось переписывать.
function egovOrgToResidency(d, bin, svc) {
  const code = (d && d.code) || null;
  const list = (d && d.data && d.data.organization_info_list) || [];
  const first = list[0] || null;
  const name = first ? (first.name_ru || first.name_kz || first.name_en || null) : null;
  // У шлюза своя человекочитаемая формулировка на трёх языках — она точнее
  // наших домыслов, поэтому в statusText кладём именно её.
  const msg = (d && d.message && d.message.ru) || '';
  const base = {
    bin: (first && first.bin) || bin,
    resident: null,
    statusCode: code,
    statusText: msg,
    shortName: name,
    fullName: name,
    registrationDate: null,       // новый эндпоинт их не отдаёт
    incorporationCountry: null,
    liquidated: false,
    _source: `fgw.egov.kz/v1/${svc || 'P3001'}/organizations`,
  };
  if (code === 'ORGANIZATION_LIQUIDATED') {
    return { ...base, resident: true, liquidated: true, statusText: msg || 'Юридическое лицо ликвидировано' };
  }
  if (code === 'ORGANIZATION_NOT_FOUND_BY_BIN' || code === 'ORGANIZATION_NOT_FOUND_BY_NAME') {
    return { ...base, resident: false, statusText: msg || 'Организация с указанным БИН не найдена' };
  }
  if (list.length) {
    return { ...base, resident: true, statusText: msg || 'Организация найдена в реестре юр. лиц РК' };
  }
  // SUCCESS с пустым списком либо незнакомый код — вердикт не выносим.
  return { ...base, statusText: msg || (code ? 'egov вернул код ' + code : 'egov вернул пустой ответ') };
}

// Отсечка «сессии нет»: когда токена нет и legacy-путь тоже упал, минуту НЕ
// делаем новых сетевых попыток — иначе пакетная проверка на мёртвой сессии
// молотит egov.kz десятками бессмысленных запросов подряд (пугает пользователя).
// Минута — чтобы после входа на портал проверка ожила сама без перезапуска.
let egovNoSessionUntil = 0;

async function fetchEgovResidency(bin, retried) {
  if (!/^\d{12}$/.test(bin)) throw new Error('Invalid BIN — must be 12 digits');
  if (Date.now() < egovNoSessionUntil) {
    throw new Error('Сессия egov.kz не активна — войдите на egov.kz (повторная попытка через минуту)');
  }
  const token = await getEgovToken();
  if (!token) {
    // Нового токена нет — пробуем старый портал (вдруг у пользователя ещё жив).
    try {
      return await fetchEgovResidencyLegacy(bin);
    } catch (e) {
      egovNoSessionUntil = Date.now() + 60 * 1000;
      throw e;
    }
  }
  egovNoSessionUntil = 0;
  // Перебираем коды услуг по порядку. Со второй услугой пробуем ТОЛЬКО когда
  // шлюз сломался (5xx / не JSON): «организация не найдена» — это валидный
  // вердикт (нерезидент), и повторять его другой услугой нельзя.
  let lastErr = null;
  for (let i = 0; i < EGOV_FGW_SERVICES.length; i++) {
    const svc = EGOV_FGW_SERVICES[i];
    const resp = await fetch(egovFgwOrgUrl(svc, bin), {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token },
      cache: 'no-store',
    });
    if (resp.status === 401 || resp.status === 403) {
      // Access протух между проверкой exp и запросом — сбрасываем и пробуем ОДИН
      // раз заново (getEgovToken перечитает вкладку и при нужде сделает refresh).
      egovToken.value = null; egovToken.exp = 0;
      if (!retried) return fetchEgovResidency(bin, true);
      egovNoSessionUntil = Date.now() + 60 * 1000;
      throw new Error('Сессия egov.kz истекла — откройте egov.kz и войдите заново');
    }
    const ct = resp.headers.get('content-type') || '';
    if (resp.status >= 500 || !ct.includes('json')) {
      lastErr = new Error(resp.status >= 500
        ? `egov (${svc}) вернул ${resp.status}`
        : `egov (${svc}) вернул не JSON — проверьте вход на egov.kz`);
      continue;   // услуга недоступна — пробуем следующую
    }
    // ВАЖНО: «организация не найдена» приходит НЕ с 200, причём код статуса у
    // разных услуг РАЗНЫЙ: P3001 → 404, P3011 → 412 (проверено вживую), тело в
    // обоих случаях нормальный JSON с code:'ORGANIZATION_NOT_FOUND_BY_BIN'.
    // Поэтому resp.ok здесь НЕ проверяем и по коду статуса вердикт не выносим —
    // его целиком определяет поле code. Иначе «нерезидент» превратился бы в
    // ошибку запроса при любой смене услуги.
    const d = await resp.json();
    return egovOrgToResidency(d, bin, svc);
  }
  throw lastErr || new Error('egov (fgw) недоступен');
}

// Старый портал (до редизайна). Оставлен как запасной путь.
async function fetchEgovResidencyLegacy(bin) {
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
    liquidated: false,
    _source: 'egov.kz/services/P30.11 (старый портал)',
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
  // Свой таймаут обязателен: без него зависший fetch молчит дольше, чем ждёт
  // приложение, и оно принимало это за «расширение не отвечает» → индикатор
  // писал «нет расширения», хотя мост жив, а тормозит сам stat.gov.kz.
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 7000);
  try {
    pageResp = await fetch(STATGOV_URL, {
      method: 'GET',
      credentials: 'include',
      signal: ctl.signal,
      headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
  } catch (e) {
    return { reachable: false, session: false, error: String(e && e.message || e) };
  } finally {
    clearTimeout(t);
  }
  if (!pageResp.ok) {
    return { reachable: false, session: false, error: 'stat.gov.kz GET вернул ' + pageResp.status };
  }
  const html = await pageResp.text();
  return { reachable: true, session: statgovIsLoggedIn(html) };
}

/**
 * Есть ли на странице кабинета активная ЭЦП-сессия.
 *
 * ВАЖНО: по наличию `sessid` это определять НЕЛЬЗЯ — это CSRF-токен Bitrix,
 * он есть и у анонима (проверено на живой странице), из-за чего индикатор
 * всегда светился «подключено», даже когда пользователь не вошёл.
 * Настоящие признаки:
 *   аноним      → блок `stat-authform` («Пожалуйста, авторизуйтесь») + authBySSO,
 *                 поля поиска `name="bin"` НЕТ;
 *   авторизован → есть поле поиска по БИН.
 * Требуем оба условия: форма поиска есть И формы логина нет.
 */
function statgovIsLoggedIn(html) {
  const authForm = /stat-authform|authBySSO|Пожалуйста,\s*авториз/i.test(html);
  const searchField = /<input[^>]*name="bin"/i.test(html);
  return searchField && !authForm;
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
  // egov: новый портал авторизуется Bearer-токеном из localStorage, а не кукой,
  // поэтому «пинговать» нечего — просто перечитываем токен из УЖЕ открытой
  // вкладки egov.kz (фоновую не открываем: это заметно пользователю). Наличие
  // свежего токена и есть признак живой сессии.
  // ПАССИВНО: только смотрим, жив ли access. Refresh здесь ЗАПРЕЩЁН — он
  // одноразовый, и его трата по таймеру раз в 5 минут гарантированно
  // рассинхронизировала пару с порталом (то самое «вылетает из egov»).
  getEgovToken({ passive: true })
    .then((t) => { keepaliveState.egov = !!t; })
    .catch(() => { keepaliveState.egov = false; });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // egov-sync.js (content-script на egov.kz, document_start) просит свежую пару:
  // засеять localStorage ДО старта портала, чтобы тот не стартовал со сгоревшим
  // refresh-токеном после наших обновлений.
  if (msg && msg.type === 'EGOV_AUTH_GET') {
    egovCacheLoad()
      .then(pair => sendResponse({ ok: true, pair: pair || null }))
      .catch(() => sendResponse({ ok: false, pair: null }));
    return true;
  }
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
  // Статус сессии egov для индикатора в приложении. СТРОГО ПАССИВНО:
  // getEgovToken({passive:true}) только читает кэш/localStorage открытых вкладок,
  // НЕ ходит в сеть и НЕ тратит одноразовый refresh-токен. Поэтому индикатор
  // можно опрашивать сколь угодно часто — обращений к egov.kz он не добавляет.
  if (msg && msg.type === 'EGOV_HEALTH') {
    getEgovToken({ passive: true })
      .then(async (token) => {
        const pair = await egovCacheLoad().catch(() => null);
        // tabOpen важен для честности индикатора: сессию портала мы можем
        // увидеть ТОЛЬКО через кэш или открытую вкладку egov.kz. Если ни того,
        // ни другого нет — мы не знаем состояния, и говорить «нужен вход»
        // нельзя (пользователь может быть залогинен). Приложение покажет
        // нейтральное «сессия не видна».
        const tabs = await egovTabs().catch(() => []);
        sendResponse({ ok: true, data: {
          token: !!token,                          // живой access — запросы пройдут
          hasPair: egovPairUsable(pair),           // пара годна (access либо refresh жив)
          // Пара была, но протухла по обоим токенам — это ЗНАНИЕ, а не «не видно»:
          // сессия точно кончилась, нужен новый вход. Позволяет дать честный
          // красный статус даже без открытой вкладки портала.
          hadPair: !!(pair && pair.access_token) && !egovPairUsable(pair),
          tabOpen: !!(tabs && tabs.length),        // портал открыт — состояние видно
          paused: Date.now() < egovNoSessionUntil, // недавняя неудача (сессия мертва)
        } });
      })
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
