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

### Four tabs on index.html (one page, shared App state)

`index.html` is split into **4 tab-panel sections** (`.tab-panel#tab-{refs,contracts,contractor,decision}`). The nav (`.tab-nav`) lives **inside the header** (`.app-header-inner`, between the brand and `.app-meta`) — tabs use **SVG icons** (`.tab-btn-ico`), not numbers. It is **not** a multi-page app — all tabs share the in-memory `App` state and switching just shows/hides panels (no reload, nothing serialized). `App.switchTab(name[, scroll])` toggles `.is-active` on the panel + button and persists `localStorage['active_tab']`; `App._initTabs()` (called from `init()`) restores it, defaulting to `refs` when not all 6 refs are loaded, else `decision`. **Display order** (left→right, `App.TABS`) — the panel DOM order differs and doesn't matter:

1. **Проверка контрагента** — `#tab-contractor`: standalone БИН check: `#contractorBin` + «Проверить БИН» → `App.quickLookupByBin()` (which reads `#contractorBin`, not `#manualBin`). Renders the company profile only, no tariff.
2. **Проверка Договоров** — `#tab-contracts` / `#batch-section` (batch AR generation; see below).
3. **Андеррайтинговое решение** — `#tab-decision`: per-case files + manual full input (`#manualBin` + «Применить» → `applyManualZayavka`) + Шаги 1–3 + document generation.
4. **Справочники** — `#tab-refs` / `#refs-section` (the 6 reference files).

**stat.gov.kz status indicator — REMOVED.** The header pill (`#statgov-pill` / `.app-meta`) that showed the bridge connection status was removed at the user's request (the passive probe could read «недоступен» while lookups actually worked). The `App.STATGOV` object still exists and its `noteLookup`/`_set` are still called from `autoLookupStatGov`, but they no-op now (no `#statgov-pill` element) and `App.STATGOV.init()` is no longer called from `App.init()` (no polling). The `STATGOV_HEALTH` bridge message + `statgovHealth()` remain in the extension but are unused by the app. To re-add a status UI, restore the `.app-meta` pill in index.html and the `App.STATGOV.init()` call.

**Per-tab profile render.** `showPreview()` (single update path, reads `App.zayavka`) renders **two different views** from the same computed values:
- **Андеррайтинговое решение** (full): broadcast to all `.js-preview-grid` / `.js-preview-panel`. «Основная информация» card holds the full field grid **plus the ОКЭДы subsection** (`okedsSubBlock`, moved out of «Подробности»; each `.pi-oked-row` is a 5-column grid — code · kind (+«активный» badge) · **class** (`.pi-oked-class`, «кл. N») · **tariff** (`.pi-oked-tariff`, `_resolveTariff(class)` → `fmtPct`) · name); the collapsible «Подробности» now holds only the Реквизиты (`detailRows`: руководитель/КРП/КФС/КАТО/сектор/дата заявки) and renders only when `detailRows.length > 0`.
- **Проверка контрагента** (focused): `showPreview()` writes a separate, trimmed card to `#preview-grid-contractor` (which deliberately has **no** `.js-preview-grid` class, so the full render skips it) — only БИН, наименование, дата регистрации, юр. адрес, гос. участие, класс риска, тариф **+ ОКЭДы**, no premium/workers/period/НС.

Both keep `.js-preview-panel` (visibility toggle) + `.js-young-alert` (young-company alert broadcast). They share `App.zayavka`, so a БИН check in **Проверка контрагента** and a loaded case in **Андеррайтинговое решение** overwrite each other (acceptable — one workflow at a time). The avg-salary alert (`.js-avg-alert`) lives only in the **Андеррайтинговое решение** tab. ОКЭДы-as-subsection spans full width via `.preview-section > .pi-subsection { grid-column: 1 / -1 }`. When adding a new profile-render target, give it these classes rather than a new id.

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

All four generators must reflect the **risk decision** (`data.verdict`, from the «Решение по риску» block). Resolve it with `Utils.resolveVerdict(data.verdict, Utils.determineDecision(data.coeff, data.coeffDown))`, then phrase the accepted-conditions clause via `Utils.acceptanceConditionText(verdict, decision)` (standard / lowered / raised / «повышенным или пониженным»). The **final limit documents** — `protocol-generator.js` («Принято РЕШЕНИЕ») and `sz-generator.js` (проект решения + «Решение по риску» detail line) — derive their final wording from the verdict (reject → «отказать… в связи со степенью риска»; defer → «отложить… на определенный срок»). СЗ also shows the ПК-adjusted premium **only** when the verdict is `accept_adjusted` with a non-zero `coeffDown` — otherwise it would contradict a «стандарт» decision by displaying a discount.

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
2. Among the company's stat.gov.kz ОКЭД — the one whose class has the **highest tariff** (`App._tariffByClass`, NOT the highest class number; mapping is non-monotonic — see batch section). `source: 'statgov-max-tariff'`.
3. ОКЭД from заявки (D9)

Returns `{oked, riskClass, activity, source}`. Class and activity are resolved through the classifier using `Utils.lookupOked()`:

1. Exact match first (e.g. `'07298'` → cls 21, even if `'07xxx'` would match cls 11).
2. Then prefix match (`'72xxx'` matches input starting with `72`), but **skips** the row if the input is listed in column D exceptions.

## Batch AR generation (реестр → .docx)

A separate workflow from the single-case form: upload the daily contracts export (one `.xlsx`, ~115 rows) and generate a filled **Андеррайтинговое решение** as an editable **Word `.docx`** per ОСНС contract, named `АР {БИН}.docx`, bundled into a ZIP. Lives in its own tab on `index.html` — **«Проверка Договоров»** (`#batch-section`, tab `#tab-contracts`; the section header was renamed from «Массовая генерация Рекомендации ДАиП» but the code/module names still say *batch*). Three modules:

- `js/batch-reader.js` — `BatchReader.parse(arrayBuffer)`. Finds columns **by header text** (row 1) with column-letter fallback (export is stable but resilient anyway). Filters to ОСНС rows with a valid 12-digit БИН. Key mapping (confirmed against a real export): БИН=H, Номер договора=D, Страхователь=BR, даты=B/K/L, Страховая сумма=V, ФОТ→ГФОТ=BY, Количество объектов→workers=AL, Класс проф риска=AK, Код ОКЭД=AJ, Вид деятельнсти Андеррайтеры=CA, **Поправочный Коэфициент=CM (1→standard, 0,9→discount)**, **Страховая премия без коэф=CU (premium before)**, **Страховая премия=W (premium with ПК = CU×ПК)**. `tariff = CU / V` (self-consistent with the risk class — no popravka reference needed).
- `js/ar-form.js` — `ARForm.buildDocx(row, opts)` → `Blob` (and `_buildDoc(row)` → docx `Document` for Node testing). Builds the 3-section form from the `Андеррешение_ОСНС.XLS` template sheet «АРешение» (Рекомендация ДАиП → Заключение по управлению рисками → Андеррайтинговое решение) as **one 9-column docx table** (label + 8 financial columns), tuned to fit **one A4 portrait page** (1cm margins, 8pt body / 6.5pt headers). Uses the `docx` lib (same as ar-generator.js). Fixed underwriter **Джелкобаев Т.К.**; document № = contract number (col D). Also exposes formatting helpers (`_esc`, `_money`, …) used by the preview table.
- `js/batch-ar.js` — `BatchAR` controller: parse → preview table → `.docx` per row via `ARForm.buildDocx` (instant — no rendering), batch → **JSZip** (lazy from CDN, `compression:'STORE'`). **Generation is gated on stat.gov.kz**: the "Сгенерировать Рекомендации АР" button stays **disabled until `_verifyComplete()`** (extension connected AND every row `statgovStatus==='done'`). No connection → rows `skip`, blocked, "Повторить проверку" (`retryStatgov()`). Verification runs **two decoupled pools in parallel** so neither waits on the other: statgov (`STATGOV_CONCURRENCY=6`, the gate — its lookup is a plain fetch in the extension, not tabs, so high concurrency is fine) and **e-Qazyna gov-participation** (`_poolEgov`, `EGOV_CONCURRENCY=8`, via `App.WORKER_URL`). After statgov, a **kyc.kz fallback** (`_fillMissingViaKyc`, `KYC_CONCURRENCY=5`, via `StatGovClient.lookupKyc`) fills **registration date + legal address** only for rows where stat.gov returned no reg date. Effective values: `_effRegDate` (statgov → kyc) drives the «Дата рег.» column (with a `kyc` source badge) and the young-company age «2 года 4 месяца» shown under the date; `_effLegalAddress` (statgov incl. «Местонахождение» for ИП → kyc) feeds the document address. UI updates are batched via `_scheduleAggregate` (rAF). Preview columns: `# · БИН · Страхователь · ОКЭД · Класс · Кол-во сотрудников · ФОТ · Страх. сумма · Страх. Премия · ПК · Премия с ПК · Дата рег. · Гос. участие` — ОКЭД/Класс are two-line (выгрузка top, statgov/computed bottom; класс lists per-OKED classes in OKED order). Discrepancies are highlighted at **two levels** (helpers `_okedError`, `_classDiff`, `_govDiff`, `_rowLevel` in `batch-ar.js`): **red** (`batch-row--err` / `batch-cell--err`) for a hard data error — the выгрузка ОКЭД is **absent from the company's stat.gov.kz ОКЭД list** (so the derived class is wrong too), or e-Qazyna gov-participation ≠ выгрузка; **yellow/amber** (`batch-row--warn` / `batch-cell--warn`) for a **soft** class mismatch — the ОКЭД is valid for the company but the выгрузка didn't pick the **highest-tariff** class. **CRITICAL: the "correct" class is the one with the maximum insurance TARIFF, NOT the maximum class number** — the class→tariff mapping (from `popravka.riskRates`) is non-monotonic (e.g. class 13 = 1.29% is higher than class 16 = 1.17%, so for {4,6,13,16} the right class is **13**, not 16). `BatchAR._maxTariffClass(classes)` (using `_tariffByClass`) replaces every `Math.max(...classes)` — used by `_computedClass` (страхователь), `_contrComputedClass`/`_contrClassDiffByBin` (контрагент); the same rule drives `App._resolveOked()` (active ОКЭД = max-tariff, via `App._tariffByClass`, not max class) so contractor-check and underwriting also use the max-tariff class. Falls back to max class number only when no tariffs are loaded. **Soft mismatches are flagged only when a high class is involved (≥ `_CLASS_WARN_MIN` = 13)** — discrepancies among classes 1–12 count as normal (green). Страхователь uses `_classDiffWarn` (threshold-gated; raw `_classDiff` still feeds the red «ОКЭД absent + class wrong» branch); контрагент threshold lives inside `_contrClassDiffByBin`. Alignment: БИН/Страхователь/Дата рег. left, everything else centered (header and value share the column-class `text-align`). e-Qazyna gov logic: **found in the registry → «Да», not found → «Нет»** — the **share is NOT shown** (computed only to infer found/not-found); gov participation by itself is **never** highlighted, only a выгрузка↔e-Qazyna mismatch (red).

`.docx` chosen over raster PDF: editable, ~10 KB/doc, ~45 ms/doc (115-doc batch ≈ 5 s + ~1.2 MB ZIP). Duplicate БИНs get `(2)`, `(3)` suffixes. To verify layout/one-page: `docx.Packer.toBuffer(ARForm._buildDoc(row))` in Node + `soffice --headless --convert-to pdf`.

## BIN lookup architecture (CORS-critical)

The address (`pk.uchet.kz`) and gov-participation (`gr5.e-qazyna.kz`) APIs are blocked by CORS from any browser. A Cloudflare Worker (`worker/index.js`) proxies these requests with `Access-Control-Allow-Origin: *`. The Worker URL is hardcoded in `js/app.js` as `App.WORKER_URL`.

If the Worker goes down or the URL changes:
- Update `App.WORKER_URL` in `js/app.js`
- Redeploy the worker: `cd worker && wrangler deploy`
- The app degrades gracefully — БИН-поиск просто не отдаёт данные, all other features still work.

Do **not** try to call those APIs directly from the page — CORS will block it.

Beyond the Worker, the Chrome extension (`chrome-extension/`, "мост к stat.gov.kz") proxies browser-side sources via `StatGovClient` (page↔extension `postMessage` bridge): `STATGOV_LOOKUP` (stat.gov.kz, needs ЭЦП session — name/OKED/КРП/address/reg date), `STATGOV_HEALTH` (lightweight connectivity probe — Step-1 GET only, no БИН, reports `{reachable, session}`; drives the header `#statgov-pill`), `STATSNET_LOOKUP` (statsnet.co — industry, slow, opens tabs), and `KYC_LOOKUP` (**kyc.kz, no auth** — base card parsed from the SSR `window.__NUXT__` IIFE without eval; see `chrome-extension/README.md`). kyc is the registration-date/address fallback in batch generation. `Utils.statgovLegalAddress(sg)` resolves the legal address from a statgov object, falling back to «Местонахождение …» in `sg._raw` (ИП have no «Юридический адрес»). After changing extension `host_permissions`, the user must reload the unpacked extension.

## Payment installment schedule

**Real tranches from the выгрузка take priority.** The contracts export has `ПорядокОплаты` + repeating `Этап{N}Дата` / `Этап{N}Сумма` columns (N = 1…12; **column positions vary between export versions → matched by header**, not letter). `BatchReader._resolveEtapCols()` + `_rowTranches()` walk the stages until a stage is **fully empty** (no date AND no sum) and attach `row.tranches = [{date, amount}, …]` (so 4 filled stages ⇒ 4 tranches, not 5). The **«Проверка договоров»** table has a **«Транш оплаты»** column (`_trancheCell`/`_trancheCount`): «—» for «Единовременно», else the tranche count (number of filled Этап sums); the toolbar «⏳ Сначала транши» (`toggleSortByTranche`, mutually exclusive with «Сначала ошибки») sorts rows by tranche count descending. `applyRegistryRow` copies them onto the case as `zayavka.tranchesFromFile` (dates as ISO strings, persistence-safe). `zayavka.tranchesFromFile` is also the **single source of truth for the editable tranche list** in Шаг 1: selecting «В рассрочку» shows `#manual-tranches` (one editable date+amount row per tranche; **count = number of rows**). `onPaymentChange` auto-seeds it by the current frequency when empty (via `fillTranchesByFreq` → `calcPaymentTranches`, amounts blank), the «↻ По периодичности» button / `#paymentFrequency` change regenerates it, and `addManualTranche`/`removeManualTranche`/`updateManualTranche` edit it (dates kept as ISO via `_dateInputToIso`/`_isoToDateInput`, amounts via `_parseMoney`). `_collectData` builds the schedule text from whatever rows are in `tranchesFromFile`. So registry-loaded tranches are pre-filled and editable; manual/заявка cases start from the frequency cycle and can be hand-tuned to an arbitrary count. The editor requires `App.zayavka` (it stores onto it); a missing case shows a hint.

When user picks «В рассрочку» + frequency (and there are no real file tranches), `Utils.calcPaymentTranches()` generates a **fixed annual cycle** (not based on contract duration):

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
- **Signer defaults live in TWO places — keep them in sync**: `App.SIGNERS_DEFAULTS` + `App.SIGNERS_ROLES` (js/app.js, the editable form source of truth, rebuilt into `Utils.*` at runtime + the `#sgn-*` inputs in index.html — adding a member means adding a `sgn-row-*` block AND the `buildMembers([...])` key) and the hardcoded fallbacks in `js/utils.js` (`AS_MEMBERS`, `PRAVLENIE_MEMBERS`, `UPRAV_DIR_ROLE/NAME`, …). Order = array order. **Both `pravlenie` and `sd` organs use `PRAVLENIE_MEMBERS`** (АР `ar-generator.js` + Протокол `protocol-generator.js`), and the АР member header is **«Члены Правления» for both** (`membersHeader`); `as` uses `AS_MEMBERS` / «Члены Андеррайтингового Совета». Current defaults: Правление (4) = Амерходжаев (Председатель) · Кныкова · Аринов · Ашимов (last three all «Заместитель Председателя Правления, член Правления»); АС (6) has Аринов at position 3; Директор ДАиП = **Бурханов Д.К.** (also `ar-form.js` `UNDERWRITER` for batch АР + заключение signer); СЗ-СД recipient `sdChair` = «М.К. Альжанову» (dative). СЗ subjects/details depend on `data.organ`: `sz-generator.js` — Правление-limit → «…рассмотрение Правления…»; **SD-limit sz_pravlenie → «…рассмотрение Совета директоров…решении о заключении {крупной сделки | сделки с аффил.} (договора ОСРНС)»** and drops the «Страховая премия с учётом ПК»/«Решение по риску» lines; sz_sd → «О заключении крупной сделки[ с аффилированным лицом] (договор ОСРНС)», replaces «Решение по риску» with «Лимит СД – …», drops «со стандартным коэффициентом».
- **Dates with the month spelled out use the GENITIVE case** («02 июля 2026», not «02 июль»): `Utils.RUSSIAN_MONTHS_GEN` (via `fmtDateRu`), `ar-form.js` `MONTHS_GEN`, `protocol-generator.js` `MONTHS_GEN`. Never format a date with the nominative `RUSSIAN_MONTHS` / `MONTHS_NOM`.
