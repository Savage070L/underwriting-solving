// statgov-client.js — клиентский мост к chrome-расширению,
// которое тянет данные с stat.gov.kz (требует ЭЦП-сессию в браузере).
//
// Расширение инжектит content.js на эту страницу. Мы общаемся через window.postMessage.

const StatGovClient = {
  SOURCE_APP: 'sl-app',
  SOURCE_BRIDGE: 'sl-bridge',
  _ready: false,
  _bridgeVersion: null,
  // Расширение (0.8.0+) ставит поиски stat.gov.kz в очередь по одному с паузой,
  // поэтому ответ может ждать своей очереди — таймаут с запасом.
  _pendingTimeoutMs: 45000,

  // ===== Бюджет запросов stat.gov.kz =====
  // У кабинета лимит на число поисков. Каждый ответ (найден / не найден) кэшируем
  // в IndexedDB: БИН из реестра в реестр в основном повторяются, и повторный
  // прогон не должен тратить лимит. Ошибки не кэшируем.
  CACHE_TTL_MS: 14 * 24 * 60 * 60 * 1000,          // найденная компания
  CACHE_TTL_NOTFOUND_MS: 3 * 24 * 60 * 60 * 1000,  // «не найдено» — может появиться
  _db: null,
  _mem: new Map(),        // БИН → {data, at} (зеркало IndexedDB в памяти)
  _inflight: new Map(),   // БИН → Promise (дедуп одновременных запросов)
  _limitedUntil: 0,       // пауза по лимиту (зеркало расширения)

  // Ошибка «превышено число запросов» от расширения: «STATGOV_RATE_LIMIT:<until>: текст».
  _wrapError(msg) {
    const m = /^STATGOV_RATE_LIMIT:(\d+):\s*(.*)$/.exec(String(msg || ''));
    if (!m) return new Error(msg || 'Неизвестная ошибка моста');
    const e = new Error(m[2]);
    e.code = 'RATE_LIMIT';
    e.until = Number(m[1]) || 0;
    StatGovClient._limitedUntil = e.until;
    document.dispatchEvent(new CustomEvent('sl:statgov-limit', { detail: { until: e.until } }));
    return e;
  },

  isRateLimit(e) { return !!(e && e.code === 'RATE_LIMIT'); },

  // ===== Источник данных о компании: stat.gov.kz или kyc.kz =====
  // ВРЕМЕННО (stat.gov.kz заблокировал аккаунт по лимиту поисков, 2026-10-21):
  // карточку компании можно брать с kyc.kz — там те же поля бизнес-регистра
  // (основной и вторичные ОКЭД, КРП, КАТО, дата регистрации, адрес, руководитель),
  // но обновляются с задержкой (dt_update). lookup() отдаёт объект в формате
  // stat.gov с _source:'kyc.kz', так что пакет, одиночная проверка и досье
  // работают без изменений. Выбор хранится в localStorage['statgov_source'].
  SOURCE_KEY: 'statgov_source',
  source() {
    try { return localStorage.getItem(StatGovClient.SOURCE_KEY) === 'statgov' ? 'statgov' : 'kyc'; }
    catch (e) { return 'kyc'; }
  },
  setSource(src) {
    try { localStorage.setItem(StatGovClient.SOURCE_KEY, src === 'statgov' ? 'statgov' : 'kyc'); } catch (e) { /* ignore */ }
    document.dispatchEvent(new CustomEvent('sl:statgov-source', { detail: { source: StatGovClient.source() } }));
  },
  sourceLabel() { return StatGovClient.source() === 'kyc' ? 'kyc.kz' : 'stat.gov.kz'; },

  // kyc.kz → формат stat.gov (поля fetchByBin + _raw парами «лейбл → значение»).
  _kycAsStatgov(k, bin) {
    if (!k || k.found === false) {
      return { bin, found: false, _source: 'kyc.kz', _fetchedAt: (k && k._fetchedAt) || new Date().toISOString() };
    }
    const raw = k._raw || {};
    const s = (v) => (v == null || v === '' ? null : String(v));
    const ddmmyyyy = (v) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
      return m ? `${m[3]}.${m[2]}.${m[1]}` : s(v);
    };
    const secondary = s(k.okedSecondary);
    const out = {
      bin: s(k.bin) || bin,
      name: s(k.name),
      registrationDate: ddmmyyyy(k.registrationDate),
      okedPrimaryCode: s(k.okedPrimaryCode),
      okedPrimaryName: s(k.okedPrimaryName),
      okedSecondaryCode: secondary,
      okedSecondaryCodes: secondary
        ? secondary.split(/[\s,;/]+/).map(x => x.trim()).filter(x => /^\d{4,5}$/.test(x))
        : [],
      krpWithBranchesCode: s(raw.code_krp_full),
      krpWithBranchesName: s(raw.title_krp),
      krpWithoutBranchesCode: s(raw.code_krp_clear),
      krpWithoutBranchesName: null,
      kato: s(k.kato),
      legalAddress: s(k.legalAddress),
      headFullname: s(k.headFullname),
      kfsCode: null, kfsName: null, sectorCode: null, sectorName: null,
      found: true,
      _source: 'kyc.kz',
      _kycUpdated: s(raw.dt_update),
      _fetchedAt: k._fetchedAt || new Date().toISOString(),
    };
    out._raw = [
      ['БИН', out.bin], ['Наименование', out.name], ['Дата регистрации', out.registrationDate],
      ['Основной код ОКЭД', out.okedPrimaryCode], ['Наименование вида экономической деятельности', out.okedPrimaryName],
      ['Вторичный код ОКЭД', out.okedSecondaryCode],
      ['Код КРП (с учетом филиалов)', out.krpWithBranchesCode], ['Наименование КРП', out.krpWithBranchesName],
      ['Код КРП (без учета филиалов)', out.krpWithoutBranchesCode],
      ['КАТО', out.kato], ['Юридический адрес', out.legalAddress],
      ['Фамилия, имя, отчество руководителя', out.headFullname],
      ['Статус', s(k.status)], ['Карточка обновлена на kyc.kz', out._kycUpdated],
    ].filter(([, v]) => v != null && v !== '');
    return out;
  },

  _openDb() {
    if (StatGovClient._db) return StatGovClient._db;
    StatGovClient._db = new Promise((resolve) => {
      try {
        const req = indexedDB.open('sl-statgov-cache', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('bin', { keyPath: 'bin' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return StatGovClient._db;
  },

  _fresh(rec) {
    if (!rec || !rec.data) return false;
    const ttl = rec.data.found === false ? StatGovClient.CACHE_TTL_NOTFOUND_MS : StatGovClient.CACHE_TTL_MS;
    return Date.now() - rec.at < ttl;
  },

  async _cacheGet(bin) {
    const m = StatGovClient._mem.get(bin);
    if (StatGovClient._fresh(m)) return m.data;
    const db = await StatGovClient._openDb();
    if (!db) return null;
    const rec = await new Promise((resolve) => {
      try {
        const r = db.transaction('bin').objectStore('bin').get(bin);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    if (!StatGovClient._fresh(rec)) return null;
    StatGovClient._mem.set(bin, rec);
    return rec.data;
  },

  async _cachePut(bin, data) {
    const rec = { bin, data, at: Date.now() };
    StatGovClient._mem.set(bin, rec);
    const db = await StatGovClient._openDb();
    if (!db) return;
    try { db.transaction('bin', 'readwrite').objectStore('bin').put(rec); } catch (e) { /* квота — не критично */ }
  },

  // Состояние паузы по лимиту (без сети). → { limited, until }
  async limitStatus() {
    const d = await StatGovClient._bridgeCall('STATGOV_LIMIT_STATUS', 3000).catch(() => null);
    if (d) StatGovClient._limitedUntil = d.limited ? d.until : 0;
    return { limited: Date.now() < StatGovClient._limitedUntil, until: StatGovClient._limitedUntil };
  },

  // Снять паузу вручную («лимит уже сняли — попробовать сейчас»).
  async limitClear() {
    await StatGovClient._bridgeCall('STATGOV_LIMIT_CLEAR', 3000).catch(() => null);
    StatGovClient._limitedUntil = 0;
  },

  // Простой вызов моста без БИН: type → type_RESULT.
  _bridgeCall(type, timeoutMs) {
    const requestId = type.toLowerCase() + '-' + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      let done = false;
      const handler = (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.source !== StatGovClient.SOURCE_BRIDGE) return;
        if (d.type !== type + '_RESULT' || d.requestId !== requestId) return;
        done = true;
        window.removeEventListener('message', handler);
        if (d.ok) resolve(d.data); else reject(new Error(d.error || 'ошибка моста'));
      };
      window.addEventListener('message', handler);
      window.postMessage({ source: StatGovClient.SOURCE_APP, type, requestId }, '*');
      setTimeout(() => {
        if (done) return;
        window.removeEventListener('message', handler);
        reject(new Error('Мост не ответил'));
      }, timeoutMs);
    });
  },

  // Слушаем "BRIDGE_READY" handshake, чтобы знать, что расширение установлено.
  init() {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.source !== StatGovClient.SOURCE_BRIDGE) return;
      if (d.type === 'BRIDGE_READY') {
        StatGovClient._ready = true;
        StatGovClient._bridgeVersion = d.version || null;
        document.dispatchEvent(new CustomEvent('sl:bridge-ready', { detail: { version: d.version } }));
      }
    });
  },

  isAvailable() {
    return StatGovClient._ready;
  },

  // Активная проверка через PING (на случай, если handshake пришёл до того, как мы его слушали).
  async ping(timeoutMs = 1500) {
    const requestId = 'ping-' + Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      let done = false;
      const handler = (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.source !== StatGovClient.SOURCE_BRIDGE) return;
        if (d.type !== 'PONG' || d.requestId !== requestId) return;
        done = true;
        window.removeEventListener('message', handler);
        StatGovClient._ready = true;
        StatGovClient._bridgeVersion = d.version || null;
        resolve({ ok: true, version: d.version });
      };
      window.addEventListener('message', handler);
      window.postMessage({ source: StatGovClient.SOURCE_APP, type: 'PING', requestId }, '*');
      setTimeout(() => {
        if (done) return;
        window.removeEventListener('message', handler);
        resolve({ ok: false });
      }, timeoutMs);
    });
  },

  // Реальная проверка подключения к stat.gov.kz (без БИН): расширение делает
  // GET кабинета и проверяет наличие ЭЦП-сессии (sessid). Возвращает:
  //   { bridge:false }                      — расширение не ответило (не установлено/выключено)
  //   { bridge:true, reachable:false }      — мост есть, но stat.gov.kz не отвечает
  //   { bridge:true, reachable:true, session:false } — сайт открылся, но нет ЭЦП-сессии
  //   { bridge:true, reachable:true, session:true }  — всё работает
  async health(timeoutMs = 6000) {
    const requestId = 'health-' + Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      let done = false;
      const handler = (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.source !== StatGovClient.SOURCE_BRIDGE) return;
        if (d.type !== 'STATGOV_HEALTH_RESULT' || d.requestId !== requestId) return;
        done = true;
        window.removeEventListener('message', handler);
        StatGovClient._ready = true; // мост ответил — он точно установлен
        if (d.ok && d.data) {
          if (d.data.limited) StatGovClient._limitedUntil = Number(d.data.limitedUntil) || 0;
          resolve({ bridge: true, reachable: !!d.data.reachable, session: !!d.data.session,
            limited: !!d.data.limited, limitedUntil: Number(d.data.limitedUntil) || 0 });
        } else {
          resolve({ bridge: true, reachable: false, session: false, error: d.error });
        }
      };
      window.addEventListener('message', handler);
      window.postMessage({ source: StatGovClient.SOURCE_APP, type: 'STATGOV_HEALTH', requestId }, '*');
      setTimeout(() => {
        if (done) return;
        window.removeEventListener('message', handler);
        resolve({ bridge: false, reachable: false, session: false });
      }, timeoutMs);
    });
  },

  // Статус сессии egov (для индикатора). Возвращает:
  //   { bridge:false }                       — расширение не ответило
  //   { bridge:true, token:true }            — живой access, запросы пройдут
  //   { bridge:true, token:false, hasPair:true }  — пара есть, access протух (обновится сам при запросе)
  //   { bridge:true, token:false, hasPair:false } — сессии нет, нужен вход на egov.kz
  // ПАССИВНО: сети не касается, одноразовый refresh не тратит — можно опрашивать часто.
  async egovHealth(timeoutMs = 4000) {
    const requestId = 'egovh-' + Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      let done = false;
      const handler = (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.source !== StatGovClient.SOURCE_BRIDGE) return;
        if (d.type !== 'EGOV_HEALTH_RESULT' || d.requestId !== requestId) return;
        done = true;
        window.removeEventListener('message', handler);
        StatGovClient._ready = true; // мост ответил — он установлен
        const v = (d.ok && d.data) ? d.data : {};
        // tabOpen/hadPair обязаны пройти сюда: без них App.EGOV._probe считает,
        // что состояние портала не видно, и красный вердикт недостижим.
        resolve({ bridge: true, token: !!v.token, hasPair: !!v.hasPair,
          tabOpen: !!v.tabOpen, hadPair: !!v.hadPair, paused: !!v.paused });
      };
      window.addEventListener('message', handler);
      window.postMessage({ source: StatGovClient.SOURCE_APP, type: 'EGOV_HEALTH', requestId }, '*');
      setTimeout(() => {
        if (done) return;
        window.removeEventListener('message', handler);
        resolve({ bridge: false, token: false, hasPair: false });
      }, timeoutMs);
    });
  },

  // Лукап через statsnet.co — ищем «Отрасль» (10-40 сек, открывает background-вкладки).
  async lookupStatsnet(bin) {
    const cleanBin = String(bin || '').trim();
    if (!/^\d{12}$/.test(cleanBin)) {
      throw new Error('БИН должен содержать 12 цифр');
    }
    if (!StatGovClient._ready) {
      const p = await StatGovClient.ping();
      if (!p.ok) throw new Error('Расширение «Standard Life — мост к stat.gov.kz» не установлено');
    }
    const requestId = 'statsnet-' + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      let done = false;
      const handler = (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.source !== StatGovClient.SOURCE_BRIDGE) return;
        if (d.type !== 'STATSNET_LOOKUP_RESULT' || d.requestId !== requestId) return;
        done = true;
        window.removeEventListener('message', handler);
        if (d.ok) resolve(d.data);
        else reject(new Error(d.error || 'Неизвестная ошибка statsnet-лукапа'));
      };
      window.addEventListener('message', handler);
      window.postMessage(
        { source: StatGovClient.SOURCE_APP, type: 'STATSNET_LOOKUP', requestId, bin: cleanBin },
        '*',
      );
      // 60 секунд таймаут — statsnet через 2 вкладки + рендер может занять до 30-40 сек
      setTimeout(() => {
        if (done) return;
        window.removeEventListener('message', handler);
        reject(new Error('Таймаут statsnet-лукапа (60 сек)'));
      }, 60000);
    });
  },

  // Главный метод: возвращает Promise с данными по БИН или error.
  // Сначала кэш (IndexedDB), потом одна сетевая попытка через расширение.
  // opts.noCache — принудительно спросить stat.gov.kz.
  async lookup(bin, opts) {
    const cleanBin = String(bin || '').trim();
    if (!/^\d{12}$/.test(cleanBin)) {
      throw new Error('БИН должен содержать 12 цифр');
    }
    // Кэш раздельный по источнику: ответ kyc.kz не должен потом выдаваться за stat.gov.
    const kyc = StatGovClient.source() === 'kyc';
    const key = (kyc ? 'kyc:' : '') + cleanBin;
    if (!(opts && opts.noCache)) {
      const hit = await StatGovClient._cacheGet(key);
      if (hit) return Object.assign({}, hit, { _cached: true });
    }
    if (StatGovClient._inflight.has(key)) return StatGovClient._inflight.get(key);
    const net = kyc
      ? StatGovClient.lookupKyc(cleanBin).then(k => StatGovClient._kycAsStatgov(k, cleanBin))
      : StatGovClient._lookupNet(cleanBin);
    const p = net
      .then((data) => {
        // kyc.kz: «не найдено» не кэшируем — так же выглядит и страница-заглушка
        // (капча/блокировка), а её нельзя запомнить на дни как факт.
        if (data && (data.found === true || (data.found === false && !kyc))) StatGovClient._cachePut(key, data);
        return data;
      })
      .finally(() => StatGovClient._inflight.delete(key));
    StatGovClient._inflight.set(key, p);
    return p;
  },

  async _lookupNet(cleanBin) {
    if (!StatGovClient._ready) {
      // Попробуем ping на случай, если handshake пропустили
      const p = await StatGovClient.ping();
      if (!p.ok) throw new Error('Расширение «Standard Life — мост к stat.gov.kz» не установлено или не активно');
    }
    const requestId = 'lookup-' + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      let done = false;
      const handler = (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.source !== StatGovClient.SOURCE_BRIDGE) return;
        if (d.type !== 'STATGOV_LOOKUP_RESULT' || d.requestId !== requestId) return;
        done = true;
        window.removeEventListener('message', handler);
        if (d.ok) resolve(d.data);
        else reject(StatGovClient._wrapError(d.error));
      };
      window.addEventListener('message', handler);
      window.postMessage(
        { source: StatGovClient.SOURCE_APP, type: 'STATGOV_LOOKUP', requestId, bin: cleanBin },
        '*',
      );
      setTimeout(() => {
        if (done) return;
        window.removeEventListener('message', handler);
        reject(new Error('Таймаут запроса к stat.gov.kz (' + StatGovClient._pendingTimeoutMs + ' мс)'));
      }, StatGovClient._pendingTimeoutMs);
    });
  },

  // Лукап карточки компании через kyc.kz (мост KYC_LOOKUP). Без ЭЦП — обычный GET.
  // Используется как fallback, когда stat.gov.kz не отдаёт дату регистрации/адрес.
  async lookupKyc(bin) {
    const cleanBin = String(bin || '').trim();
    if (!/^\d{12}$/.test(cleanBin)) {
      throw new Error('БИН должен содержать 12 цифр');
    }
    if (!StatGovClient._ready) {
      const p = await StatGovClient.ping();
      if (!p.ok) throw new Error('Расширение «Standard Life — мост к stat.gov.kz» не установлено или не активно');
    }
    const requestId = 'kyc-' + Math.random().toString(36).slice(2);
    const timeoutMs = 20000; // kyc.kz — одна GET-страница ~250 КБ
    return new Promise((resolve, reject) => {
      let done = false;
      const handler = (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.source !== StatGovClient.SOURCE_BRIDGE) return;
        if (d.type !== 'KYC_LOOKUP_RESULT' || d.requestId !== requestId) return;
        done = true;
        window.removeEventListener('message', handler);
        if (d.ok) resolve(d.data);
        else reject(new Error(d.error || 'Неизвестная ошибка моста (kyc)'));
      };
      window.addEventListener('message', handler);
      window.postMessage(
        { source: StatGovClient.SOURCE_APP, type: 'KYC_LOOKUP', requestId, bin: cleanBin },
        '*',
      );
      setTimeout(() => {
        if (done) return;
        window.removeEventListener('message', handler);
        reject(new Error('Таймаут запроса к kyc.kz (' + timeoutMs + ' мс)'));
      }, timeoutMs);
    });
  },

  // Резидентство по БИН через egov P30.01/P30.11 (мост EGOV_RESIDENCY_LOOKUP). Использует
  // сессию egov.kz пользователя. Возвращает { resident, statusCode, statusText,
  // shortName, registrationDate, incorporationCountry } — авторитетный источник.
  async lookupEgovResidency(bin) {
    const cleanBin = String(bin || '').trim();
    if (!/^\d{12}$/.test(cleanBin)) {
      throw new Error('БИН должен содержать 12 цифр');
    }
    if (!StatGovClient._ready) {
      const p = await StatGovClient.ping();
      if (!p.ok) throw new Error('Расширение-мост не установлено или не активно');
    }
    const requestId = 'egov-' + Math.random().toString(36).slice(2);
    const timeoutMs = 20000;
    return new Promise((resolve, reject) => {
      let done = false;
      const handler = (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.source !== StatGovClient.SOURCE_BRIDGE) return;
        if (d.type !== 'EGOV_RESIDENCY_LOOKUP_RESULT' || d.requestId !== requestId) return;
        done = true;
        window.removeEventListener('message', handler);
        if (d.ok) resolve(d.data);
        else reject(new Error(d.error || 'Неизвестная ошибка моста (egov)'));
      };
      window.addEventListener('message', handler);
      window.postMessage(
        { source: StatGovClient.SOURCE_APP, type: 'EGOV_RESIDENCY_LOOKUP', requestId, bin: cleanBin },
        '*',
      );
      setTimeout(() => {
        if (done) return;
        window.removeEventListener('message', handler);
        reject(new Error('Таймаут запроса к egov.kz (' + timeoutMs + ' мс)'));
      }, timeoutMs);
    });
  },
};

document.addEventListener('DOMContentLoaded', () => StatGovClient.init());
StatGovClient.init();
