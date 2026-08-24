// egov-sync.js — content-script на egov.kz (document_start).
//
// Зачем: refresh-токен egov ОДНОРАЗОВЫЙ. Когда мост обновляет пару токенов
// (для проверки резидентства), пара в localStorage портала устаревает — и если
// портал в этот момент закрыт, при следующем открытии egov.kz он стартует со
// сгоревшим refresh-токеном → SESSION_EXPIRED → пользователя разлогинивает
// («постоянно вылетает из egov»). Этот скрипт исполняется ДО кода портала:
// спрашивает у background свежую пару из кэша и, если она новее лежащей в
// localStorage (сравниваем exp access-токена), подменяет её — портал стартует
// с рабочими токенами и сессия живёт.
(function () {
  var KEY = 'identity_data';
  function expOf(tok) {
    try {
      var p = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return typeof p.exp === 'number' ? p.exp : 0;
    } catch (e) { return 0; }
  }
  try {
    chrome.runtime.sendMessage({ type: 'EGOV_AUTH_GET' }, function (resp) {
      if (chrome.runtime.lastError) return;
      var pair = resp && resp.pair;
      if (!pair || !pair.access_token) return;
      try {
        var raw = localStorage.getItem(KEY);
        var cur = raw ? JSON.parse(raw) : null;
        var curTok = cur && cur.state && cur.state.identityData && cur.state.identityData.auth
          && cur.state.identityData.auth.access_token;
        // Подменяем ТОЛЬКО если наша пара новее: свежую пару портала трогать нельзя.
        if (curTok && expOf(curTok) >= expOf(pair.access_token)) return;
        var d = (cur && cur.state) ? cur : { state: { identityData: null, oauthData: null, hasHydrated: true }, version: 0 };
        if (!d.state.identityData) d.state.identityData = {};
        d.state.identityData.auth = Object.assign({}, d.state.identityData.auth || {}, pair);
        localStorage.setItem(KEY, JSON.stringify(d));
      } catch (e) { /* не мешаем порталу грузиться */ }
    });
  } catch (e) { /* контекст расширения умер — портал живёт как жил */ }
})();
