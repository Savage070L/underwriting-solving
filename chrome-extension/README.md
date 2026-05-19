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
