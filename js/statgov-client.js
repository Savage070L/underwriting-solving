// statgov-client.js — клиентский мост к chrome-расширению,
// которое тянет данные с stat.gov.kz (требует ЭЦП-сессию в браузере).
//
// Расширение инжектит content.js на эту страницу. Мы общаемся через window.postMessage.

const StatGovClient = {
  SOURCE_APP: 'sl-app',
  SOURCE_BRIDGE: 'sl-bridge',
  _ready: false,
  _bridgeVersion: null,
  _pendingTimeoutMs: 15000,

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
          resolve({ bridge: true, reachable: !!d.data.reachable, session: !!d.data.session });
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
  async lookup(bin) {
    const cleanBin = String(bin || '').trim();
    if (!/^\d{12}$/.test(cleanBin)) {
      throw new Error('БИН должен содержать 12 цифр');
    }
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
        else reject(new Error(d.error || 'Неизвестная ошибка моста'));
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
};

document.addEventListener('DOMContentLoaded', () => StatGovClient.init());
StatGovClient.init();
