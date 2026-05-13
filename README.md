# Underwriting App — Standard Life

Генератор андеррайтинговых документов и аналитический дашборд по обязательному страхованию работников от несчастных случаев.

## Возможности

- Загрузка справочников (поправочные коэффициенты, норматив, КУ по классам, калькулятор рентабельности) с кешированием в `localStorage`
- Парсинг заявки на андеррайтинг (`.xlsm`) и истории убытков (`.xls`)
- Автоматический поиск адреса и доли государственного участия по БИН (через Cloudflare Worker)
- Генерация в `.docx`:
  - **Андеррайтинговое решение (АР)**
  - **Заключение департамента андеррайтинга**
  - **Протокол** заседания Андеррайтингового Совета / Правления
- Полноценный аналитический дашборд (`analytics.html`) с 40+ карточками: KPI, Risk Score, тяжесть, страховщики, актуарные показатели (Burning Cost, Pure Premium, PML, RAROC), стресс-тесты, рекомендации по перестрахованию

## Запуск локально

```bash
cd underwriting-app
python3 -m http.server 8000
# открыть http://localhost:8000
```

или любой другой статический HTTP-сервер.

## Деплой на GitHub Pages

1. Загрузить эту папку в репозиторий GitHub
2. В Settings → Pages выбрать source = «GitHub Actions»
3. Push в `main` → workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) автоматически развернёт сайт
4. URL будет вида `https://<user>.github.io/<repo>/`

## BIN-поиск и CORS

Поиск по БИН (адрес из `pk.uchet.kz`, доля гос. участия из `e-Qazyna`) **не работает напрямую с GitHub Pages** из-за CORS-ограничений браузера. Решение — Cloudflare Worker-прокси:

- Папка [`worker/`](worker/) содержит готовый Worker (`index.js`) и `wrangler.toml`
- Деплой: `cd worker && wrangler deploy`
- В [`js/app.js`](js/app.js) обновить константу `App.WORKER_URL` на ваш URL после деплоя

Текущий деплой Worker'а: `https://bin-lookup.toibaev-kuanysh-617.workers.dev`

## Почему НЕ WebAssembly

- Парсинг Excel: библиотека [`xlsx.full.min.js`](js/lib/xlsx.full.min.js) — pure JavaScript, работает быстро в любом современном браузере
- Генерация .docx: [`docx.min.js`](js/lib/docx.min.js) — также pure JS
- BIN-поиск: ограничен CORS, не размером данных — WASM не решает эту задачу
- Аналитика (Compound Poisson, регрессии, Pareto, HHI): тысячи операций на стороне клиента — JS справляется за миллисекунды

Если в будущем понадобится тяжёлая числовая обработка (например, Monte Carlo симуляция 100 000 итераций или сложные актуарные методы), можно интегрировать WASM-модуль, но в текущем сценарии — оверкилл.

## Структура

```
underwriting-app/
├── index.html              # форма ввода
├── analytics.html          # аналитический дашборд
├── css/
│   ├── style.css
│   └── analytics.css
├── js/
│   ├── app.js              # оркестратор формы
│   ├── analytics.js        # рендеринг дашборда
│   ├── excel-reader.js     # парсинг Excel
│   ├── ar-generator.js     # генератор АР
│   ├── zakl-generator.js   # генератор Заключения
│   ├── protocol-generator.js  # генератор Протокола
│   ├── utils.js            # утилиты и константы
│   └── lib/                # xlsx, docx, FileSaver
├── worker/                 # Cloudflare Worker для BIN-поиска
└── .github/workflows/      # автодеплой на GH Pages
```
