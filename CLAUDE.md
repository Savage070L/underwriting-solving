# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this app does

Browser-based underwriting toolkit for Standard Life (Казахстан, ОСНС — обязательное страхование работника от несчастных случаев). All processing is client-side — the user uploads Excel files locally, the app parses them in the browser and generates `.docx` documents and an analytics dashboard.

Live: <https://savage070l.github.io/underwriting-solving/>

## Running locally

There is **no build step** — the app is pure HTML/CSS/JS. To develop:

```bash
# any static server works; the project's `.claude/launch.json` uses:
npx http-server . -p 8085 -c-1
# then open http://localhost:8085/
```

For testing reference files locally without re-uploading every time, drop them into `test-data/` and read via `fetch('/test-data/<filename>')` from the browser console. The directory is `.gitignore`d (test files contain real БИНы and ФИО — personal data, never commit).

Deployment to GitHub Pages is automatic on push to `main` via `.github/workflows/pages.yml`.

## Architecture

### Two pages, one shared state

- `index.html` — form-driven document generator
- `analytics.html` — read-only dashboard

The dashboard does NOT re-parse files. When the user clicks "Открыть аналитический дашборд" on the main page, `App.openAnalytics()` serializes a *snapshot* into `localStorage['analytics_snapshot']` and opens the dashboard in a new tab. `analytics.js` reads that snapshot — if missing, shows the empty state.

If you add new derived data to documents, you must also add it to the snapshot in **both** places: `openAnalytics()` and `toggleInlineAnalytics()` in `js/app.js`. They're near-duplicates of each other.

### Reference files and caching

The app expects **6 reference files** uploaded once and cached in `localStorage`:

| File | `App.refData` key | Purpose |
|---|---|---|
| Поправочные коэффициенты | `popravka` | Tariff per risk class + adjustment matrix |
| Норматив | `normativ` | Company assets, portfolio share, by month |
| КУ по классам | `ku` | Portfolio loss ratio (updates monthly) |
| Калькулятор рентабельности | `calculator` | Death/injury rates per ОКЭД |
| Классификатор ОКЭД | `classifier` | ОКЭД → risk class + activity name |
| Аффилированные лица | `affiliated` | List of related parties (БИН/ИИН + name) |

Plus **2 per-case files** (not cached): заявка `.xlsm` and история убытков `.xls`.

`App.refData` is restored from `localStorage` on init (`App.restoreCache`). The case (zayavka + claims + binData) is also persisted (`App._persistCase` / `_restoreCase`) so navigating back from the analytics dashboard does not lose loaded files.

### Document generators

Four generators in `js/`, all consume the same `data` object produced by `App._collectData()`:

- `ar-generator.js` — Андеррайтинговое Решение (АР)
- `zakl-generator.js` — Заключение департамента
- `protocol-generator.js` — Протокол заседания АС / Правления
- `sz-generator.js` — Служебная записка (`mode: 'pravlenie' | 'sd'`)

To add a field to documents, edit `_collectData()` in `js/app.js` (single source of truth for document inputs), then reference `data.<field>` in the generator(s).

When interpolating a count next to a Russian noun («3 работника», «5 траншей»), use `Utils.plural(n, one, few, many)` / `Utils.pluralize(...)` — never hard-code one form. Destructive UI actions (clearing reference/case files, section reset) must go through `App.confirmDialog({title, text, confirmLabel})` (markup `#confirm-overlay` in index.html).

### Resilient parsers (important)

Reference files like КУ по классам get **monthly updates** — rows shift, new classes get added, columns sometimes reorder. The parsers in `js/excel-reader.js` are designed to find data **by content** (label text), not by hard-coded coordinates. When extending or fixing parsers:

- Find header rows by searching for label text in early rows (e.g. «Итого», «Класс»+«Тариф», «Среднегодовое количество пострадавших»).
- Read data dynamically from that point until empty rows or until reaching another label.
- **Beware sparse arrays**: `XLSX.utils.sheet_to_json({header:1})` returns sparse arrays with holes. `findIndex`/`find` callbacks receive `undefined` for holes — always build dense lowercased arrays (`for (let j=0; j<row.length; j++) out[j] = String(row[j]||'').toLowerCase()`) before scanning headers.

`readZayavka` is still position-based (D8, G8, D11–D20, E21, G21) because it parses a strict company template. If the заявка template ever changes structure, this parser will need the same context-based treatment.

### ОКЭД override flow

`App._resolveOked()` is the single entry point used by `_collectData`, `showPreview`, `openAnalytics`, `toggleInlineAnalytics`. Priority:

1. Manual input in `#okedInput` (overrides everything)
2. ОКЭД from заявки (D9)

Returns `{oked, riskClass, activity, source}`. Class and activity are resolved through the classifier using `Utils.lookupOked()`:

1. Exact match first (e.g. `'07298'` → cls 21, even if `'07xxx'` would match cls 11).
2. Then prefix match (`'72xxx'` matches input starting with `72`), but **skips** the row if the input is listed in column D exceptions.

## Batch AR generation (реестр → PDF)

A separate workflow from the single-case form: upload the daily contracts export (one `.xlsx`, ~115 rows) and generate a filled **Андеррайтинговое решение** as an editable **Word `.docx`** per ОСНС contract, named `АР {БИН}.docx`, bundled into a ZIP. Lives in its own collapsible section on `index.html` (`#batch-section`). Three modules:

- `js/batch-reader.js` — `BatchReader.parse(arrayBuffer)`. Finds columns **by header text** (row 1) with column-letter fallback (export is stable but resilient anyway). Filters to ОСНС rows with a valid 12-digit БИН. Key mapping (confirmed against a real export): БИН=H, Номер договора=D, Страхователь=BR, даты=B/K/L, Страховая сумма=V, ФОТ→ГФОТ=BY, Количество объектов→workers=AL, Класс проф риска=AK, Код ОКЭД=AJ, Вид деятельнсти Андеррайтеры=CA, **Поправочный Коэфициент=CM (1→standard, 0,9→discount)**, **Страховая премия без коэф=CU (premium before)**, **Страховая премия=W (premium with ПК = CU×ПК)**. `tariff = CU / V` (self-consistent with the risk class — no popravka reference needed).
- `js/ar-form.js` — `ARForm.buildDocx(row, opts)` → `Blob` (and `_buildDoc(row)` → docx `Document` for Node testing). Builds the 3-section form from the `Андеррешение_ОСНС.XLS` template sheet «АРешение» (Рекомендация ДАиП → Заключение по управлению рисками → Андеррайтинговое решение) as **one 9-column docx table** (label + 8 financial columns), tuned to fit **one A4 portrait page** (1cm margins, 8pt body / 6.5pt headers). Uses the `docx` lib (same as ar-generator.js). Fixed underwriter **Джелкобаев Т.К.**; document № = contract number (col D). Also exposes formatting helpers (`_esc`, `_money`, …) used by the preview table.
- `js/batch-ar.js` — `BatchAR` controller: parse → preview table → `.docx` per row via `ARForm.buildDocx` (instant — no rendering; docx/FileSaver already loaded), batch → **JSZip** (lazy-loaded from CDN, entries stored with `compression:'STORE'` since `.docx` is already zipped). **Generation is gated on stat.gov.kz verification**: after load, statgov runs for every БИН via `StatGovClient` (concurrency `STATGOV_CONCURRENCY=2`); the "Сгенерировать Рекомендации АР" button and the per-row "Word" buttons stay **disabled until `_verifyComplete()`** — i.e. extension connected AND every row `statgovStatus==='done'`. No connection → all rows `skip`, generation blocked, error banner + "Повторить проверку" (`retryStatgov()` re-runs only non-`done` rows). The `#batch-verify` status box shows progress / errors / ready. statgov fills official name/address and computes company age for the **young-company alert** (`< minCompanyAgeYears`, default 3) — UI-only (preview row highlight + summary banner), not printed on the doc (`opts.printAlert` defaults false). Note: a БИН that never resolves in stat.gov keeps generation blocked by design (the user wanted every contract verified); relax `_verifyComplete` if that becomes a problem for ИП.

`.docx` chosen over raster PDF: editable, ~10 KB/doc, and ~45 ms/doc (a 115-doc batch ≈ 5 s + ~1.2 MB ZIP, vs ~100 s + ~30 MB for the old html2canvas+jsPDF path). Duplicate БИНs get `(2)`, `(3)` suffixes in the ZIP. To verify layout/one-page: generate a `.docx` in Node (`docx.Packer.toBuffer(ARForm._buildDoc(row))`) and `soffice --headless --convert-to pdf`.

## BIN lookup architecture (CORS-critical)

The address (`pk.uchet.kz`) and gov-participation (`gr5.e-qazyna.kz`) APIs are blocked by CORS from any browser. A Cloudflare Worker (`worker/index.js`) proxies these requests with `Access-Control-Allow-Origin: *`. The Worker URL is hardcoded in `js/app.js` as `App.WORKER_URL`.

If the Worker goes down or the URL changes:
- Update `App.WORKER_URL` in `js/app.js`
- Redeploy the worker: `cd worker && wrangler deploy`
- The app degrades gracefully — БИН-поиск просто не отдаёт данные, all other features still work.

Do **not** try to call those APIs directly from the page — CORS will block it.

## Payment installment schedule

When user picks «В рассрочку» + frequency, `Utils.calcPaymentTranches()` generates a **fixed annual cycle** (not based on contract duration):

| Frequency | Tranches per year |
|---|---:|
| year / halfYear / quarter / month / week / day | 1 / 2 / 4 / 12 / 52 / 365 |

First tranche is always `today + 1 day`. Long lists (>14) are auto-formatted to `«1 транш — DD.MM.YYYY; 2 транш — ... ; N транш — DD.MM.YYYY (всего N траншей, раз в неделю)»`.

## Document margins and tab stops

All docx generators use **A4 with symmetric 2 cm margins** (1134 twips). The available content width is `9638 twips`. Long lines that must span full width (e.g. director signature with name aligned to the right edge) use right-aligned tab stops at `9638`, not literal space characters.

AR uses a 3-column invisible-border table for the signature block so name/line/date columns align vertically across all members — see `ar-generator.js` `sigRow()` helper. Don't replace this with manually-spaced paragraphs.

## AI consultant ("Спросить ИИ")

Split into two shared modules used by **both pages**:

- `js/ai-prompt.js` — `AIPrompt.build(snap)` builds the ~9K-char prompt from an analytics *snapshot* only (no DOM/App access).
- `js/ai-consultant.js` — `createAIConsultant(getPrompt, opts)` drives the right-side slide-over panel (same element ids on both pages: `ai-panel`, `ai-overlay`, `ai-prompt-text`, …).

On `analytics.html` (standalone tab) the floating FAB works as before. In **inline mode** (`body.is-inline`, iframe on index.html) the in-iframe FAB/panel are hidden entirely — `position: fixed` inside the auto-height iframe would land at the very bottom of the content. Instead `index.html` provides its own "Спросить ИИ" button in the analytics CTA row plus a parent-page FAB (visible while `body.inline-analytics-open`), both opening `App.AI` — a `createAIConsultant` instance that builds the prompt on the fly from `App._buildAnalyticsSnapshot()`.

The prompt deliberately:
- Excludes identifying data (no insurer name, no BIN, no address)
- Asks the AI to recompute key actuarial metrics independently (don't pre-compute and present)
- References KZ legislation (Закон РК № 30-III от 07.02.2005, Соц. кодекс ст. 195-1, АРРФР, Solvency II)
- Avoids biasing the AI with the current underwriter's verdict

`AIConsultant.sendTo(service)` copies the prompt to clipboard, opens the AI service in a new tab. For ChatGPT/Perplexity, also tries URL prefill via `?q=...` (only if encoded prompt fits in ~1900 chars — usually not, since our prompt is ~9K). Full auto-submit is impossible due to same-origin policy.

## Common gotchas

- **`activityType` dropdown is gone** — it was removed when ОКЭД input took over. If you see code reading `document.getElementById('activityType').value`, that's a bug (it returns null). Use `App._resolveOked()` instead.
- **`data.docDate` is the date from F3 of заявка** (date of application submission), not `periodFrom`. Don't override with contract dates.
- **Affiliated lookup is by raw БИН string** (12 digits). Always strip whitespace before comparing.
- **`window.open` from inside a click handler** is required for "Open in new tab" — calling it from an async chain after `await` will be blocked by browser as a popup.
