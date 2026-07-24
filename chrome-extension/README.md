# Standard Life — мост к stat.gov.kz

Мини-расширение для Chrome, которое позволяет нашему андеррайтинговому приложению
тянуть данные с `stat.gov.kz` по БИН, используя текущую ЭЦП-сессию пользователя.

## Зачем

`stat.gov.kz` не отдаёт CORS-заголовков, и сессия после ЭЦП живёт только в браузере
пользователя. Cloudflare Worker (как для `pk.uchet.kz`) тут не сработает — у него нет
твоего ЭЦП. Расширение получает `host_permissions` к обоим доменам и работает как мост.

## Установка (dev)

1. Открой `chrome://extensions`
2. Включи **Developer mode** в правом верхнем углу
3. Нажми **Load unpacked**
4. Укажи папку `underwriting-app/chrome-extension/`
5. Перезагрузи вкладку нашего приложения (`localhost:8085` или GitHub Pages)

## Как проверить, что мост работает

В консоли приложения:

```js
await StatGovClient.ping()
// → { ok: true, version: '0.1.0' }
```

Если `ok: false` — расширение не загружено или origin не в `host_permissions`/`content_scripts`.

## Использование

```js
const data = await StatGovClient.lookup('130740005369');
// data → { bin, name, okedPrimaryCode, ... }
```

## Источники данных (lookups)

Расширение проксирует несколько источников по БИН/ИИН (12 цифр). Каждый — отдельный
тип сообщения `{source:'sl-app', type, requestId, bin}` → ответ
`{source:'sl-bridge', type:'<TYPE>_RESULT', requestId, ok, data, error}`.

| Тип | Источник | Авторизация | Что отдаёт |
|---|---|---|---|
| `STATGOV_LOOKUP` | stat.gov.kz (кабинет) | нужна ЭЦП-сессия | официальная карточка, ОКЭД, КРП, адрес, дата рег. |
| `STATSNET_LOOKUP` | statsnet.co (через поиск) | не нужна | «Отрасль», основной ОКЭД (медленно, открывает вкладки) |
| `KYC_LOOKUP` | kyc.kz | **не нужна** | базовая карточка из SSR-страницы (быстро, обычный GET) |
| `EGOV_RESIDENCY_LOOKUP` | egov.kz (P30.11) | **нужна сессия egov** | резидентство: `GET /services/P30.11/rest/gbdul/organizations/{bin}` → `{resident, status.code, shortName, registrationDate}`. Авторитетный источник (`resident:true/false`); 033 = ИП, 034 = снят с учёта. |

### kyc.kz (`KYC_LOOKUP`)

`https://kyc.kz/search/company/{БИН}` отдаёт SSR-страницу (~250 КБ) без ЭЦП, cookies,
капчи и Cloudflare. Карточка вшита в `window.__NUXT__=(function(a,b,..){return {...}}(args))`
— это минифицированный IIFE, где часть значений — ссылки на параметры функции,
подставляемые хвостовыми аргументами. В service worker MV3 `eval`/`new Function`
запрещены, поэтому `parseKycNuxt()` разбирает его строками: считывает параметры и
аргументы (карта подстановки), сбалансированными скобками вырезает `data:[{result:{…}}]`,
резолвит литералы и плейсхолдеры.

Контракт — такой же, как у `STATGOV_LOOKUP`/`STATSNET_LOOKUP`: страница шлёт
`postMessage` и слушает ответ. Обёртки `StatGovClient.lookupKyc()` пока нет — её
можно добавить позже по аналогии с `StatGovClient.lookup()`. Быстрая проверка из консоли:

```js
const reqId = 'kyc-' + Math.random().toString(36).slice(2);
window.addEventListener('message', function h(e) {
  if (e.data?.source === 'sl-bridge' && e.data.type === 'KYC_LOOKUP_RESULT' && e.data.requestId === reqId) {
    window.removeEventListener('message', h); console.log(e.data.ok, e.data.data || e.data.error);
  }
});
window.postMessage({ source: 'sl-app', type: 'KYC_LOOKUP', requestId: reqId, bin: '830318351135' }, '*');
// data → { bin, name, isIndividual, okedPrimaryCode (okat), okedPrimaryName (main_activity),
//          okedSecondary, kato, krpCode, krpName, registrationDate, headFullname,
//          legalAddress, status, isActive, payNds, found, _source:'kyc.kz', _raw }
```

Несуществующий БИН → kyc.kz всё равно отдаёт 200, но с пустой карточкой
(`id:0, title:"-"`); парсер это распознаёт и возвращает `{ found:false }`.

**Скоуп:** только базовая карточка из серверного HTML. Риски/благонадёжность/налоги/
госзакупки грузятся клиентом за авторизацией (JWT/тариф) — их в SSR нет, не парсим.

## Keepalive сессий (stat.gov.kz + egov)

Сессии обеих служб вылетают по бездействию (≈15–30 мин). Расширение раз в **5 минут**
(`chrome.alarms`) делает лёгкий авторизованный GET к stat.gov.kz и egov, сдвигая idle-таймаут
сессии — так один утренний вход держится весь день. Пинги идут **только пока открыта вкладка
приложения** (закрыл на ночь → сессии истекают сами). Требует разрешение `alarms`.
Статус можно запросить сообщением `KEEPALIVE_STATUS` (`{lastRun, statgov, egov, periodMin}`).
Оговорка: продлевает только **idle**-таймаут; если у службы есть жёсткий предел длины сессии —
один перелогин за смену всё равно потребуется.

## Что осталось доделать

- Эндпоинты `stat.gov.kz` в `background.js` (`fetchByBin`) — пока заглушка. Нужно подставить
  реальный URL после анализа DevTools → Network на странице кабинета.
- Нормализатор `normalize(raw)` — заполнить маппинг полей после того, как увидим
  структуру ответа.

## Origin'ы

Если у тебя приложение раздаётся не из `savage070l.github.io` или `localhost:*` — добавь
свой origin в **оба** места в `manifest.json`:
- `host_permissions`
- `content_scripts[0].matches`
