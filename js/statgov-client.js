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
};

document.addEventListener('DOMContentLoaded', () => StatGovClient.init());
StatGovClient.init();
