// batch-ar.js — контроллер массовой генерации Андеррайтинговых решений (АР).
//
// Поток: загрузка ежедневного реестра (.xlsx) → BatchReader.parse → превью-
// таблица → генерация заполненных .docx по форме ARForm (docx-библиотека,
// редактируемые таблицы), поодиночке или пакетом в ZIP (JSZip). Имена файлов —
// «АР {БИН}.docx». Генерация быстрая — просто сборка docx-объектов, без рендера.
//
// Параллельно (в фоне, с лимитом параллельности) по каждому БИНу запрашивается
// statgov: подтягивается официальное название/адрес и дата регистрации. Если
// компания моложе порога (по умолчанию 3 года) — строка помечается алертом
// (в самой выгрузке коэффициент мог быть проставлен ошибочно).

const BatchAR = {
  rows: [],
  _busy: false,
  _statgovRunning: false,
  _statgovPaused: false,      // пользователь поставил проверку stat.gov.kz на паузу
  _sgQueue: null,             // очередь оставшихся индексов statgov (для возобновления после паузы)
  _statgovConnected: false,   // подтверждено ли соединение с stat.gov.kz (ping ok)
  _tableVersion: 0,           // растёт при каждом изменении таблицы (для зеркала в новой вкладке)
  // Активные переключатели сортировки «Сначала …» (массив ключей: 'errors' |
  // 'filial' | 'tranche'). Приоритет применения — порядок _SORT_DEFS. Пусто — как в файле.
  _sorts: [],

  // Постраничного режима НЕТ — таблица одна, пользователь просто прокручивает.
  // Но сразу класть в DOM весь реестр нельзя: 16 тыс. строк × 21 колонка — это
  // ~65 МБ разметки, и вкладка виснет на несколько десятков секунд (замерено).
  // Поэтому строки добавляются ПОРЦИЯМИ по мере прокрутки к низу таблицы:
  // _shown — сколько строк уже в DOM, _order — текущий порядок отображения.
  CHUNK: 200,           // строк в порции (первый рендер и каждая подгрузка)
  SCROLL_MARGIN: 900,   // за сколько px до низа подгружать следующую порцию
  _shown: 0,
  _order: [],
  _rowEls: null,        // idx строки → <tr> (без querySelector по огромному DOM)
  _scrollHooked: false,

  // JSZip грузим по требованию (для пакета). docx/FileSaver уже подключены.
  // ExcelJS — для выгрузки ошибок с заливкой ячеек (XLSX CE заливки не пишет).
  CDN: {
    jszip: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    exceljs: 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
  },

  // statgov-лукап — это fetch (GET sessid + POST), а не открытие вкладок,
  // поэтому безопасно гнать с высокой параллельностью. e-Qazyna — лёгкий fetch
  // к воркеру, отдельным пулом и ещё параллельнее.
  STATGOV_CONCURRENCY: 6,
  EGOV_CONCURRENCY: 8,
  KYC_CONCURRENCY: 5,   // fallback дат/адреса через kyc.kz (один GET ~250 КБ)
  EGOV_RESID_CONCURRENCY: 6,  // авторитетная проверка резидентства через egov P30.11
  // Фаза авторитетной проверки резидентства (egov): пока 'pending' — в ячейках
  // резидентства показываем ⏳, а не промежуточный локальный вердикт. 'unavailable'
  // (нет моста) / 'done' (пул отработал) → показываем что есть (egov или локальный).
  _egovResidPhase: 'idle',
  // Дата регистрации приходит из statgov, а если там нет — из kyc. kyc теперь
  // идёт ПАРАЛЛЕЛЬНО statgov: как только строка закрылась в statgov без даты —
  // сразу ставим её в kyc-очередь (не ждём конца всего прохода statgov).
  // _kycFinished=true → все kyc отработали, снимаем ⏳ с колонки «Дата рег.».
  _kycFinished: false,
  _kycQueue: [],       // индексы строк, ждущих kyc
  _kycActive: 0,       // kyc-запросов «в полёте» (ограничено KYC_CONCURRENCY)
  _kycCacheP: null,    // БИН → Promise (дедуп филиалов)

  _loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Не удалось загрузить ' + src));
      document.head.appendChild(s);
    });
  },

  async _ensureZip() {
    if (typeof window.JSZip === 'undefined') await BatchAR._loadScript(BatchAR.CDN.jszip);
  },

  async _ensureExcelJS() {
    if (typeof window.ExcelJS === 'undefined') await BatchAR._loadScript(BatchAR.CDN.exceljs);
  },

  _youngThreshold() {
    return (typeof App !== 'undefined' && App._getLimit) ? (App._getLimit('minCompanyAgeYears') || 3) : 3;
  },

  // ===== Загрузка файла реестра =====
  async loadFile(file) {
    if (!file) return;
    const statusEl = document.getElementById('batch-status');
    try {
      if (statusEl) statusEl.textContent = 'Чтение файла…';
      const buf = await file.arrayBuffer();
      const { rows, total, skipped, header, idx } = BatchReader.parse(buf);
      BatchAR.rows = rows;
      BatchAR._sourceFileName = file.name || '';  // для шапки HTML-отчёта
      BatchAR._egovResidPhase = 'pending';  // резидентство ещё не проверяли egov → ⏳
      BatchAR._kycFinished = false;         // дата рег. ещё может прийти из kyc → ⏳
      BatchAR._kycQueue = []; BatchAR._kycActive = 0; BatchAR._kycCacheP = new Map();
      BatchAR._filialContracts = null;     // сбросить кэш филиалов (пересоберётся по новым строкам)
      BatchAR._fotByContract = null;       // сбросить кэш суммарного ФОТ по договорам
      BatchAR._aggByContract = null;       // сбросить кэш агрегатов по договору (СС/СП/ФОТ контрагентов)
      BatchAR._rawHeader = header || [];   // исходный заголовок (для выгрузки превышений)
      BatchAR._fieldIdx = idx || {};       // поле→индекс колонки (для подсветки ошибок)
      const zone = document.getElementById('zone-batch');
      if (zone) zone.classList.add('loaded');
      if (statusEl) {
        statusEl.textContent = total
          ? `Загружено: ${total} договоров ОСНС${skipped ? ` (пропущено строк: ${skipped})` : ''}`
          : 'Подходящих строк ОСНС не найдено';
      }
      BatchAR.renderTable();
      BatchAR._updateControls();
      if (total) BatchAR.startStatgov();
    } catch (e) {
      console.error('Batch load error:', e);
      if (statusEl) statusEl.textContent = 'Ошибка чтения файла: ' + e.message;
      App.showMsg && App.showMsg('Не удалось прочитать реестр: ' + e.message, 'error');
    }
  },

  // Деньги с группировкой разрядов; тиыны показываем только если они есть.
  _fmtMoney(v) {
    if (v == null || isNaN(v)) return '—';
    const num = Math.round(Number(v) * 100) / 100;
    const parts = num.toFixed(2).split('.');
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return parts[1] === '00' ? intPart : intPart + ',' + parts[1];
  },

  // Лукап гос. участия через e-Qazyna (Cloudflare-воркер). Возвращает
  // { status, found, share }. Логика: само НАЛИЧИЕ компании в реестре e-Qazyna
  // означает гос. участие (Да) — даже если доля 0,000%. Не найден по БИН/ИИН —
  // значит НЕ гос. участник (Нет). Долю в UI НЕ показываем (только Да/Нет) —
  // она нужна лишь чтобы вывести «найден» при отсутствии явного gov.found.
  // Не блокирует генерацию.
  async _lookupEgov(bin) {
    const url = (typeof App !== 'undefined' && App.WORKER_URL) ? App.WORKER_URL : null;
    if (!url) return { status: 'error', found: null, share: null };
    try {
      const resp = await fetch(url + '?bin=' + encodeURIComponent(bin));
      if (!resp.ok) throw new Error('worker ' + resp.status);
      const data = await resp.json();
      const gov = data && data.gov;
      if (!gov) return { status: 'done', found: null, share: null };
      let found;
      if (gov.found === true) found = true;
      else if (gov.found === false) found = false;
      else found = gov.share != null;            // есть доля → найден
      const share = gov.share != null ? String(gov.share) : null;
      return { status: 'done', found, share };
    } catch (e) {
      return { status: 'error', found: null, share: null };
    }
  },

  // ===== СОРТИРОВКА «Сначала …» =====
  // Три переключателя: показать сверху строки с ошибками / с траншами рассрочки /
  // с дублирующимися номерами договора (несколько филиалов на один договор).
  // Каждый — вкл/выкл; можно включить несколько сразу (не сбрасывают друг друга),
  // применяются в фиксированном приоритете — порядок _SORT_DEFS.
  _SORT_DEFS: [
    { key: 'errors',  icon: '⚑', off: 'Сначала ошибки',  on: 'Ошибки сверху',  title: 'Показать сначала строки с ошибками (красные), затем жёлтые', rank: (r) => { const l = BatchAR._rowLevel(r); return l === 'err' ? 2 : (l === 'warn' ? 1 : 0); } },
    { key: 'filial',  icon: '🏢', off: 'Сначала филиалы', on: 'Филиалы сверху', title: 'Договоры с несколькими филиалами (дублирующиеся номера договора) — наверх и рядом друг с другом', dup: true },
    { key: 'tranche', icon: '⏳', off: 'Сначала транши',  on: 'Транши сверху',  title: 'Показать сначала договоры с наибольшим числом траншей рассрочки', rank: (r) => BatchAR._trancheCount(r) || 0 },
    { key: 'nonresident', icon: '🌐', off: 'Сначала нерезиденты', on: 'Нерезиденты сверху', title: 'Показать сначала нерезидентов, затем ИП, затем резидентов. Учитывается любая из сторон договора (Страхователь или Контрагент).', rank: (r) => BatchAR._residRowRank(r) },
  ],

  // Порядок строк для отрисовки. По умолчанию — как в файле. Активные переключатели
  // применяются в фиксированном приоритете (порядок _SORT_DEFS), все — «сверху»
  // (по убыванию ранга). Возвращает массив ОРИГИНАЛЬНЫХ индексов («#» и data-idx
  // остаются исходными).
  _displayOrder() {
    const idxs = BatchAR.rows.map((_, i) => i);
    if (!BatchAR._sorts.length) return idxs;
    const active = new Set(BatchAR._sorts);
    // Значения считаем ОДИН раз на строку (не на каждое сравнение) — при тысячах строк важно.
    const cols = BatchAR._SORT_DEFS.filter((d) => active.has(d.key)).map((d) => {
      if (d.dup) {
        const counts = {};
        for (const r of BatchAR.rows) { const c = String(r.contractNumber || ''); counts[c] = (counts[c] || 0) + 1; }
        return { dup: true, val: BatchAR.rows.map((r) => counts[String(r.contractNumber || '')] || 1), cn: BatchAR.rows.map((r) => String(r.contractNumber || '')) };
      }
      return { val: BatchAR.rows.map(d.rank) };
    });
    return idxs.sort((ia, ib) => {
      for (const c of cols) {
        const a = c.val[ia], b = c.val[ib];
        if (b !== a) return b - a;   // больший ранг (ошибочнее / больше траншей / дублируемее) — выше
        // Одинаковый ранг у филиалов → всегда по номеру договора, чтобы одинаковые шли подряд.
        if (c.dup) { const t = String(c.cn[ia]).localeCompare(String(c.cn[ib]), 'ru'); if (t !== 0) return t; }
      }
      return 0; // стабильно — при равенстве сохраняется порядок файла
    });
  },

  // Вкл/выкл переключателя «Сначала …». Несколько можно держать активными сразу.
  toggleSort(key) {
    const i = BatchAR._sorts.indexOf(key);
    if (i >= 0) BatchAR._sorts.splice(i, 1);
    else BatchAR._sorts.push(key);
    const wrap = document.getElementById('batch-table-wrap');
    if (wrap) wrap.scrollTop = 0;   // после смены сортировки — к началу таблицы
    BatchAR.renderTable();
    BatchAR._updateControls();
  },

  // Согласовано андеррайтером (галочка после «Менеджера»). Снимает ошибки со строки:
  // _rowLevel становится null → строка печатается с ИСХОДНЫМИ данными (под ответственность
  // андеррайтера), уходит из «ошибочных» в обычные, подсветка ячеек гасится (CSS). Снятие
  // галочки возвращает строку в исходное состояние. При активной сортировке (напр.
  // по ошибкам) строка может сместиться — поэтому перерисовываем всю таблицу; иначе — только строку.
  toggleApproved(i, el) {
    const r = BatchAR.rows[i];
    if (!r) return;
    r._approved = !!(el && el.checked);
    if (BatchAR._sorts.length) BatchAR.renderTable();
    else BatchAR._refreshRow(i);
    BatchAR._updateControls();
  },

  // ===== Превью-таблица =====
  renderTable() {
    const wrap = document.getElementById('batch-table-wrap');
    const tbody = document.getElementById('batch-tbody');
    if (!wrap || !tbody) return;
    if (!BatchAR.rows.length) {
      wrap.style.display = 'none';
      BatchAR._shown = 0; BatchAR._order = []; BatchAR._rowEls = null;
      BatchAR._renderScrollInfo();
      tbody.innerHTML = '';
      return;
    }
    wrap.style.display = 'block';
    // Порядок считаем по ВСЕМ строкам, в DOM кладём первую порцию — остальные
    // добавит _appendChunk при прокрутке. Проверка/статус/выгрузка идут по rows.
    BatchAR._order = BatchAR._displayOrder();
    BatchAR._shown = Math.min(BatchAR.CHUNK, BatchAR._order.length);
    tbody.innerHTML = BatchAR._rowsHtml(BatchAR._order.slice(0, BatchAR._shown));
    BatchAR._indexRows();
    BatchAR._hookScroll();
    BatchAR._tableVersion++;
    BatchAR._renderScrollInfo();
    // Индекс ГБД ЮЛ мог ещё не догрузиться к моменту первого рендера — тогда
    // колонка «Резидент» показала бы «н/д». Перерисуем таблицу, когда он готов.
    if (typeof ResidentCheck !== 'undefined' && !BatchAR._residHooked
        && !ResidentCheck.ready() && !ResidentCheck.failed()) {
      BatchAR._residHooked = true;
      ResidentCheck.onReady(() => BatchAR.renderTable());
    }
  },
  _residHooked: false,

  // HTML набора строк по индексам (используется и для порций в таблице, и для
  // HTML-отчёта, где нужны ВСЕ строки, но трогать живой DOM нельзя).
  _rowsHtml(idxs) {
    return idxs.map(BatchAR._rowHtml).join('');
  },

  // Разметка одной строки таблицы.
  // Порядок столбцов: # · Договор · Наим.Страхователя · БИН Страхователя ·
  // Контрагент(имя+БИН) · ОКЭД · Класс(страх) · Класс+тариф(контр) ·
  // Кол-во(контр) · ФОТ(контр) · СС(контр) · СП(контр) · СС(страх) · ПК ·
  // СПсПК(страх) · Дата рег. · Гос. участие · Менеджер.
  _rowHtml(i) {
    const r = BatchAR.rows[i];
    const okedErr = BatchAR._okedError(r);
    const cDiff = BatchAR._classDiff(r);
    const cDiffWarn = BatchAR._classDiffWarn(r);
    const classWrong = BatchAR._classWrongForOked(r);
    const gDiff = BatchAR._govDiff(r);
    const okedCls = okedErr ? ' batch-cell--err' : '';
    const classCls = (classWrong || (okedErr && cDiff)) ? ' batch-cell--err' : (cDiffWarn ? ' batch-cell--warn' : '');
    const classTitle = classWrong ? ` title="Класс не соответствует ОКЭД: по классификатору ${ARForm._esc(r.oked)} → класс ${BatchAR._classOf(r.oked)}, а в выгрузке ${ARForm._esc(r.riskClass)}"` : '';
    const govCls = gDiff ? ' batch-cell--err' : '';
    const pkCls = BatchAR._pkYoungError(r) ? ' batch-cell--err' : '';
    // ===== КОНТРАГЕНТ (строка) =====
    const contrSumLtFot = BatchAR._contrSumLtFotError(r);
    const contrTarErr = BatchAR._contrTariffClassError(r);
    const contrClassWrongBin = BatchAR._contrClassWrongByBin(r);
    const contrClassDiffBin = BatchAR._contrClassDiffByBin(r);
    const contrPremDiff = BatchAR._contrPremiumDiff(r);
    const contrBinCls = BatchAR._binInvalid(r) ? ' batch-cell--err' : '';
    const contrClassCls = (contrTarErr || contrClassWrongBin) ? ' batch-cell--err' : (contrClassDiffBin ? ' batch-cell--warn' : '');
    const contrClassTitle = contrClassWrongBin
      ? ` title="Класс контрагента в выгрузке (${ARForm._esc(String(BatchAR._contrClass(r)))}) отсутствует среди классов по его ОКЭД из stat.gov.kz"`
      : (contrClassDiffBin ? ` title="Класс контрагента ${ARForm._esc(String(BatchAR._contrClass(r)))} есть среди классов по ОКЭД, но не с наибольшим тарифом (нужен класс ${BatchAR._contrComputedClass(r)})"`
      : (contrTarErr ? ` title="Тариф из выгрузки не соответствует классу контрагента ${ARForm._esc(String(BatchAR._contrClass(r)))} по справочнику (должен быть ${BatchAR._fmtPct(BatchAR._contrTariff(r))})"` : ''));
    // СС контрагента красным: < ФОТ, или отличается от расчётной больше чем на ±100 ₸.
    const contrSumDiff = BatchAR._contrSumDiff(r);
    const contrSumCls = (contrSumLtFot || contrSumDiff) ? ' batch-cell--err' : '';
    const contrSumTitle = contrSumLtFot ? ' title="СС контрагента меньше его ФОТ (должна быть ≥ ФОТ)"'
      : (contrSumDiff ? ' title="СС контрагента отличается от расчётной больше чем на 100 ₸"' : '');
    // СП контрагента красным, если премия ≠ СС(контр) × тариф(класс K) × ПК (допуск ±1 ₸).
    const contrPremCls = contrPremDiff ? ' batch-cell--err' : '';
    const contrPremTitle = contrPremDiff ? ' title="СП контрагента ≠ СС(контр) × тариф(класс K) × ПК (допуск ±1 ₸)"' : '';
    // ===== СТРАХОВАТЕЛЬ (договор) =====
    const sumLtPrem = BatchAR._sumLtPremiumError(r);
    const sumLtFot = BatchAR._sumLtFotError(r);
    const premBelowMin = BatchAR._premiumBelowMinError(r);
    const insSumMis = BatchAR._insurerSumMismatch(r);
    const insPremMis = BatchAR._insurerPremMismatch(r);
    // СС/СП страхователя красным (допуск ±1 ₸): ≠ сумме контрагентов, СС < ФОТ/премии, премия < 1 МЗП.
    const sumCls = (sumLtPrem || sumLtFot || premBelowMin || insSumMis) ? ' batch-cell--err' : '';
    const premCls = (sumLtPrem || premBelowMin || insPremMis) ? ' batch-cell--err' : '';
    const sumTitle = insSumMis ? ' title="СС страхователя ≠ сумме СС контрагентов (допуск ±1 ₸)"'
      : (sumLtFot ? ' title="Ошибка: страховая сумма меньше ФОТ (должна быть ≥ ФОТ)"'
      : (premBelowMin ? ' title="Премия меньше 1 МЗП (85 000) → СС должна быть = 85 000 / тариф"'
      : (sumLtPrem ? ' title="Ошибка: страховая сумма меньше страховой премии"' : '')));
    const premTitle = insPremMis ? ' title="СП страхователя ≠ сумме СП контрагентов (допуск ±1 ₸)"'
      : (premBelowMin ? ' title="Премия меньше 1 МЗП (85 000) — должна быть ≥ 85 000"'
      : (sumLtPrem ? ' title="Ошибка: страховая сумма меньше страховой премии"' : ''));
    const binStReason = BatchAR._insurerBinInvalidReason(r);
    const binStCls = binStReason ? ' batch-cell--err' : '';
    const binStTitle = binStReason ? ` title="Некорректный ИИН/БИН Страхователя: ${ARForm._esc(binStReason)}"` : '';
    // Класс строки = жизненный цикл проверки (серый/синий/зелёный) + ошибка (красный/жёлтый)
    // + метка «согласовано андеррайтером».
    const cls = BatchAR._rowClassList(r);
    const rowCls = cls.length ? ` class="${cls.join(' ')}"` : '';
    return `<tr data-idx="${i}"${rowCls}>
      <td class="batch-c-num">${i + 1}</td>
      <td class="batch-c-contract">${ARForm._esc(r.contractNumber || '—')}</td>
      <td class="batch-c-insurer${binStCls}"${binStTitle}>${BatchAR._insurerIdentCell(r)}</td>
      <td class="batch-c-contr${contrBinCls}">${BatchAR._contrIdentCell(r)}</td>
      <td class="batch-c-oked${okedCls}">${BatchAR._okedCell(r)}</td>
      <td class="batch-c-class${classCls}"${classTitle}>${BatchAR._classCell(r)}</td>
      <td class="batch-c-contr-class${contrClassCls}"${contrClassTitle}>${BatchAR._contrClassTariffCell(r)}</td>
      <td class="batch-c-num2">${ARForm._int(r.workers)}</td>
      <td class="batch-c-num2">${BatchAR._fmtMoney(r.gfot)}</td>
      <td class="batch-c-num2 batch-c-sum${sumCls}"${sumTitle}>${BatchAR._sumCellHtml(r)}</td>
      <td class="batch-c-num2 batch-c-contr-sum${contrSumCls}"${contrSumTitle}>${BatchAR._contrSumCell(r)}</td>
      <td class="batch-c-center${pkCls}">${BatchAR._pkCell(r)}</td>
      <td class="batch-c-num2 batch-c-prem${premCls}"${premTitle}>${BatchAR._premiumCellHtml(r)}</td>
      <td class="batch-c-num2 batch-c-contr-prem${contrPremCls}"${contrPremTitle}>${BatchAR._contrPremCell(r)}</td>
      <td class="batch-c-reg">${BatchAR._regCell(r)}</td>
      <td class="batch-c-gov${govCls}">${BatchAR._govCell(r)}</td>
      <td class="batch-c-resident batch-c-resident-s${BatchAR._residRegDiff(r) ? ' batch-cell--err' : ''}">${BatchAR._residCellInsurer(r)}</td>
      <td class="batch-c-author" title="${ARForm._esc(r.author || '')}">${r.author ? ARForm._esc(r.author).replace(/\s+/g, '<br>') : '—'}</td>
      <td class="batch-c-tranche">${BatchAR._trancheCell(r)}</td>
      <td class="batch-c-approve">${BatchAR._approveCell(r, i)}</td>
    </tr>`;
  },

  // Карта idx → <tr>: _refreshRow иначе делает querySelector по таблице на
  // тысячи строк (замерено ~0,7 мс на вызов — при 16 тыс. строк это заметно).
  _indexRows() {
    const tbody = document.getElementById('batch-tbody');
    BatchAR._rowEls = new Map();
    if (!tbody) return;
    for (const tr of tbody.rows) BatchAR._rowEls.set(Number(tr.dataset.idx), tr);
  },

  // Подгрузка следующей порции строк при прокрутке к низу таблицы.
  _hookScroll() {
    if (BatchAR._scrollHooked) return;
    const wrap = document.getElementById('batch-table-wrap');
    if (!wrap) return;
    BatchAR._scrollHooked = true;
    let ticking = false;
    wrap.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        if (wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < BatchAR.SCROLL_MARGIN) {
          BatchAR._appendChunk();
        }
      });
    }, { passive: true });
  },

  _appendChunk() {
    const tbody = document.getElementById('batch-tbody');
    if (!tbody || BatchAR._shown >= BatchAR._order.length) return;
    const next = BatchAR._order.slice(BatchAR._shown, BatchAR._shown + BatchAR.CHUNK);
    tbody.insertAdjacentHTML('beforeend', BatchAR._rowsHtml(next));
    // Дописываем в карту только новые строки (полный пересбор — лишняя работа).
    if (!BatchAR._rowEls) BatchAR._rowEls = new Map();
    for (let k = tbody.rows.length - next.length; k < tbody.rows.length; k++) {
      const tr = tbody.rows[k];
      if (tr) BatchAR._rowEls.set(Number(tr.dataset.idx), tr);
    }
    BatchAR._shown += next.length;
    BatchAR._tableVersion++;
    BatchAR._renderScrollInfo();
  },

  // «Показано N из M» под таблицей. Скрыто, когда показаны все строки.
  _renderScrollInfo() {
    const host = document.getElementById('batch-scroll-info');
    if (!host) return;
    const total = BatchAR._order.length;
    if (!total || BatchAR._shown >= total) { host.style.display = 'none'; host.innerHTML = ''; return; }
    host.style.display = '';
    host.innerHTML = `Показано <b>${BatchAR._shown}</b> из <b>${total}</b> — прокрутите таблицу вниз, чтобы подгрузить ещё`
      + ` <button type="button" class="batch-scroll-more" onclick="BatchAR._appendChunk()">Показать ещё ${Math.min(BatchAR.CHUNK, total - BatchAR._shown)}</button>`;
  },

  // Кол-во траншей рассрочки (по числу заполненных этапов «Этап{N}Сумма»).
  // null = единовременно / не рассрочка → в таблице «—».
  _trancheCount(r) {
    if (!/рассроч/i.test(String(r.paymentOrder || ''))) return null;
    const tr = Array.isArray(r.tranches) ? r.tranches : [];
    const bySum = tr.filter(t => t && t.amount != null).length; // считаем этапы с суммой
    const n = bySum > 0 ? bySum : tr.length;
    return n > 0 ? n : null;
  },
  // Ячейка «Транш оплаты»: «—» при единовременной оплате, иначе число траншей.
  _trancheCell(r) {
    const n = BatchAR._trancheCount(r);
    if (n == null) return '<span class="batch-tranche batch-tranche--once">—</span>';
    const word = (typeof Utils !== 'undefined' && Utils.pluralize) ? Utils.pluralize(n, 'транш', 'транша', 'траншей') : 'траншей';
    return `<span class="batch-tranche batch-tranche--split" title="Рассрочка: ${n} ${word}">${n}</span>`;
  },

  // ПК: 1 (стандарт, зелёный) или 0,9 (со скидкой, синий).
  _pkCell(r) {
    const v = String(r.coeff).replace('.', ',');
    const cls = r.decision === 'discount' ? 'batch-pk batch-pk--discount' : 'batch-pk batch-pk--standard';
    const title = BatchAR._pkYoungError(r)
      ? 'Скидка при компании моложе 3 лет — не должна применяться'
      : (r.decision === 'discount' ? 'Принятие с понижающим коэффициентом' : 'Принятие со стандартным тарифом');
    return `<span class="${cls}" title="${title}">${v}</span>`;
  },

  // Молодая компания (моложе порога) со скидкой (ПК<1): скидка применяться не
  // должна → ошибка, подсвечиваем ячейку ПК (и строку) красным.
  _pkYoungError(r) {
    return !!r.youngAlert && r.coeff != null && r.coeff < 1;
  },

  // ===== Проверка страховой суммы и премии (методология) =====
  // Премия = ФОТ × тариф, но не меньше 1 МЗП (85 000); СС = премия / тариф,
  // т.е. СС = max(ФОТ, 1 МЗП / тариф) — всегда ≥ ФОТ (тариф — по классу из справочника).
  // Допуск на округление копеек: расхождение МЕНЬШЕ 1 тенге (только знаки после
  // запятой) — это округление, а не ошибка. Жёсткие проверки «меньше» (СС<ФОТ,
  // СС<премии, премия<МЗП) сравнивают с этим допуском, чтобы, например, СС
  // 19 851 890 и ФОТ 19 851 890,04 не считались ошибкой.
  _MONEY_EPS: 1,
  _CONTR_SUM_EPS: 100,   // допуск СС контрагента: |исходная − расчётная| > 100 ₸ → ошибка (красным)
  _minPremium() {
    return (typeof App !== 'undefined' && App._getLimit) ? (App._getLimit('minPremium') || 85000) : 85000;
  },
  _avgSalaryMonthly(r) {
    return (r.gfot > 0 && r.workers > 0) ? (r.gfot / 12 / r.workers) : null;
  },
  // Премия договора ДО ПК (ИТОГ) = ОбщаяСтраховаяПремия (с ПК) / ПК.
  _premBaseTotal(r) {
    if (r.premiumTotal == null) return null;
    return Number(r.premiumTotal) / (r.coeff && r.coeff > 0 ? r.coeff : 1);
  },
  // ===== Агрегаты по договору (страхователь = сумма контрагентов) =====
  // Один проход по реестру: по каждому НомеруДоговора суммируем ФОТ, СС и СП
  // контрагентов и Σ(ФОТ×тариф_контрагента) — для ожидаемой премии договора (до ПК)
  // с учётом РАЗНЫХ классов контрагентов. Кэш до перезагрузки реестра.
  _contractAgg(r) {
    if (!BatchAR._aggByContract) {
      const m = new Map();
      for (const x of BatchAR.rows) {
        const cn = x.contractNumber || '';
        if (!cn) continue;
        let a = m.get(cn);
        if (!a) { a = { sumFot: 0, sumSS: 0, sumSP: 0, sumFotTariff: 0, count: 0 }; m.set(cn, a); }
        const fot = Number(x.gfot) || 0;
        a.sumFot += fot;
        a.sumSS  += Number(x.insuranceSum) || 0;
        a.sumSP  += Number(x.premiumWithCoeff != null ? x.premiumWithCoeff : 0) || 0;
        a.sumFotTariff += fot * (BatchAR._contrTariff(x) || 0);
        a.count += 1;
      }
      BatchAR._aggByContract = m;
    }
    return BatchAR._aggByContract.get(r.contractNumber) || { sumFot: 0, sumSS: 0, sumSP: 0, sumFotTariff: 0, count: 0 };
  },
  // Суммарный ФОТ по договору (сумма ФОТ контрагентов).
  _contractFotTotal(r) {
    const v = BatchAR._contractAgg(r).sumFot;
    return v > 0 ? v : (Number(r.gfot) || 0);
  },

  // ===== Уровень КОНТРАГЕНТА (строка) =====
  // Класс контрагента (K); если его нет — класс страхователя (J).
  _contrClass(r) {
    const k = parseInt(r.riskClassContragent, 10);
    if (Number.isFinite(k) && k > 0) return k;
    const j = parseInt(r.riskClass, 10);
    return (Number.isFinite(j) && j > 0) ? j : null;
  },
  // Правильный тариф контрагента: по классу K из справочника «Поправочные коэффициенты»;
  // если справочника нет — тариф из выгрузки (tariffExport), затем расчётный r.tariff.
  _contrTariff(r) {
    const cls = BatchAR._contrClass(r);
    const rr = (typeof App !== 'undefined' && App.refData && App.refData.popravka) ? App.refData.popravka.riskRates : null;
    if (rr && cls) { const t = rr.get(cls); if (Number.isFinite(t) && t > 0) return t; }
    if (r.tariffExport != null && r.tariffExport > 0) return r.tariffExport;
    return (r.tariff && r.tariff > 0) ? r.tariff : null;
  },
  // 🔴 СС(контрагент) < ФОТ(контрагент) — СС контрагента должна покрывать его ФОТ.
  _contrSumLtFotError(r) {
    const o = Number(r.insuranceSum), m = Number(r.gfot);
    return Number.isFinite(o) && Number.isFinite(m) && m > 0 && o < m - BatchAR._MONEY_EPS;
  },
  // Ожидаемая СС контрагента — ВЫЧИСЛЯЕМ по премии (а не берём ФОТ):
  //   база премии (СП/ПК) < 1 МЗП → СС = ФОТ (премия ниже пола, СС не поднималась);
  //   база = 1 МЗП → СС = 1 МЗП / тариф; база > 1 МЗП → СС = база / тариф = СП/(тариф×ПК).
  // (Случаи «=» и «>» сводятся к база/тариф.) Тариф — контрагента (класс K).
  _contrExpectedSum(r) {
    const t = BatchAR._contrTariff(r);
    const Q = (r.coeff && r.coeff > 0) ? r.coeff : 1;
    const S = (r.premiumWithCoeff != null) ? Number(r.premiumWithCoeff) : null;
    const m = Number(r.gfot);
    if (!(t > 0) || S == null) return null;
    const base = S / Q;
    if (base < BatchAR._minPremium() - BatchAR._MONEY_EPS) return Number.isFinite(m) ? m : null;
    return Math.round(base / t * 100) / 100;
  },
  // 🔴 СС контрагента отличается от РАСЧЁТНОЙ (_contrExpectedSum: ФОТ при премии < 1 МЗП,
  // иначе СП/(тариф×ПК)) больше чем на ±100 ₸ — в любую сторону. Допуск 100 ₸ поглощает
  // округление СП, усиленное делением на малый тариф. Договор «на полу» 1 МЗП пропускаем:
  // там пол распределяется по контрагентам и СС законно может быть > ФОТ.
  _contrSumDiff(r) {
    const o = Number(r.insuranceSum);
    const exp = BatchAR._contrExpectedSum(r);
    if (exp == null || !Number.isFinite(o)) return false;
    const agg = BatchAR._contractAgg(r);
    // Договор с НЕСКОЛЬКИМИ контрагентами, опущенный до пола 1 МЗП: пол распределяется
    // по контрагентам, и СС отдельного контрагента может законно ≠ расчётной из его премии —
    // такую проверку пропускаем. Для одиночного контрагента расчётная = фактической, проверяем.
    if (agg.count > 1 && agg.sumFotTariff > 0 && agg.sumFotTariff < BatchAR._minPremium() - BatchAR._MONEY_EPS) return false;
    // Допуск: 100 ₸ (по требованию), но НЕ туже «шумового пола» округления премии,
    // усиленного делением на тариф: премия в выгрузке хранится в целых тенге, и при делении
    // на малый тариф (0,12–0,5%) её округление ±0,5 ₸ раздувается в сотни тенге по СС.
    // Поэтому на малых тарифах допуск авто-расширяется до 1/(тариф×ПК), убирая ложные ошибки.
    const t = BatchAR._contrTariff(r);
    const pk = (r.coeff && r.coeff > 0) ? r.coeff : 1;
    const tol = (t > 0) ? Math.max(BatchAR._CONTR_SUM_EPS, 1 / (t * pk)) : BatchAR._CONTR_SUM_EPS;
    return Math.abs(o - exp) > tol;
  },
  // 🔴 Тариф из выгрузки не соответствует классу контрагента по справочнику.
  // Проверяем, только если справочник загружен, в нём есть класс K и в выгрузке есть тариф.
  _contrTariffClassError(r) {
    const rr = (typeof App !== 'undefined' && App.refData && App.refData.popravka) ? App.refData.popravka.riskRates : null;
    const cls = BatchAR._contrClass(r);
    if (!rr || !cls) return false;
    const correct = rr.get(cls);
    if (!Number.isFinite(correct) || correct <= 0) return false;
    const used = (r.tariffExport != null && r.tariffExport > 0) ? r.tariffExport : ((r.tariff && r.tariff > 0) ? r.tariff : null);
    if (!(used > 0)) return false;
    return Math.abs(used - correct) > correct * 0.01;   // расхождение тарифов > 1%
  },
  // Ожидаемая СП контрагента (с ПК) = СС(контр) × тариф(K) × ПК.
  _contrExpectedPremium(r) {
    const t = BatchAR._contrTariff(r);
    const o = Number(r.insuranceSum);
    if (!(t > 0) || !Number.isFinite(o)) return null;
    const pk = (r.coeff && r.coeff > 0) ? r.coeff : 1;
    return Math.round(o * t * pk * 100) / 100;
  },
  _contrActualPremium(r) {
    return (r.premiumWithCoeff != null) ? Number(r.premiumWithCoeff) : null;
  },
  // 🟡 СП(контр) ≠ СС(контр) × тариф(K) × ПК.
  _contrPremiumDiff(r) {
    return BatchAR._moneyDiff(BatchAR._contrExpectedPremium(r), BatchAR._contrActualPremium(r));
  },
  // ОКЭД контрагента из stat.gov.kz (по его БИНКонтрагента) — primary + secondary, без дублей.
  _contrStatgovOkeds(r) {
    const sg = (r.statgovContr && !r.statgovContr.error) ? r.statgovContr : null;
    if (!sg) return [];
    const list = [];
    if (sg.okedPrimaryCode) list.push(String(sg.okedPrimaryCode));
    if (Array.isArray(sg.okedSecondaryCodes)) for (const c of sg.okedSecondaryCodes) if (c) list.push(String(c));
    return [...new Set(list)];
  },
  // Классы по КАЖДОМУ ОКЭД контрагента (из stat.gov.kz) в порядке кодов — как для
  // страхователя. null в списке = ОКЭД нет в классификаторе.
  _contrClassList(r) {
    return BatchAR._contrStatgovOkeds(r).map(o => BatchAR._classOf(o));
  },
  // «Правильный» класс по ОКЭД контрагента — с НАИБОЛЬШИМ ТАРИФОМ (не номером).
  _contrComputedClass(r) {
    const classes = BatchAR._contrClassList(r).filter(c => c != null);
    return classes.length ? BatchAR._maxTariffClass(classes) : null;
  },
  // 🔴 Класс из выгрузки (K) ОТСУТСТВУЕТ среди классов по ОКЭД контрагента —
  // класс невозможен для его деятельности (грубая ошибка).
  _contrClassWrongByBin(r) {
    const classes = BatchAR._contrClassList(r).filter(c => c != null);
    const k = BatchAR._contrClass(r);
    return classes.length > 0 && k != null && !classes.includes(k);
  },
  // 🟡 Класс из выгрузки (K) ЕСТЬ среди возможных по ОКЭД, но это НЕ класс с
  // наибольшим тарифом — мягкое расхождение (выбран не самый «дорогой» класс).
  _contrClassDiffByBin(r) {
    const classes = BatchAR._contrClassList(r).filter(c => c != null);
    const k = BatchAR._contrClass(r);
    if (!classes.length || k == null || !classes.includes(k)) return false;
    const maxC = BatchAR._maxTariffClass(classes); // класс с наибольшим тарифом
    if (k === maxC) return false;
    // Жёлтым только высокие классы (≥ _CLASS_WARN_MIN); до 12-го → зелёное.
    return maxC >= BatchAR._CLASS_WARN_MIN;
  },

  // ===== Уровень СТРАХОВАТЕЛЯ (договор) =====
  // Ожидаемая база премии договора (до ПК) = max( Σ(ФОТ_контр × тариф(K)), 1 МЗП ).
  // Учитывает РАЗНЫЕ классы контрагентов — поэтому корректна и для смешанных договоров.
  _expectedPremium(r) {
    const agg = BatchAR._contractAgg(r);
    if (!(agg.sumFotTariff > 0)) return null;
    return Math.round(Math.max(agg.sumFotTariff, BatchAR._minPremium()) * 100) / 100;
  },
  // Ожидаемая СС страхователя ПО ПРЕМИИ: СС = база_премии / эфф.тариф.
  // База = max(СП/ПК, 1 МЗП); эфф.тариф = Σ(ФОТ×тариф) / Σ ФОТ. СС МОЖЕТ быть больше ФОТ
  // (переплата допустима) — поэтому сверяем СС с премией (СП = СС×тариф×ПК), а не с ФОТ.
  // Если премия > МЗП → СС = СП/(тариф×ПК); если премия опущена до пола → СС = 1 МЗП/тариф.
  _expectedSum(r) {
    const agg = BatchAR._contractAgg(r);
    const Q = (r.coeff && r.coeff > 0) ? r.coeff : 1;
    const R = (r.premiumTotal != null) ? Number(r.premiumTotal) : null;
    if (R == null || !(agg.sumFot > 0) || !(agg.sumFotTariff > 0)) return null;
    const effTariff = agg.sumFotTariff / agg.sumFot;
    if (!(effTariff > 0)) return null;
    const base = Math.max(R / Q, BatchAR._minPremium());
    return Math.round(base / effTariff * 100) / 100;
  },
  // 🔴 СС страхователя (ОбщаяСС, N) ≠ Σ СС контрагентов (Σ O).
  _insurerSumMismatch(r) {
    const agg = BatchAR._contractAgg(r);
    const n = (r.insuranceSumTotal != null) ? Number(r.insuranceSumTotal) : null;
    return n != null && agg.sumSS > 0 && Math.abs(n - agg.sumSS) > 1.0001;   // допуск строго ±1 ₸
  },
  // 🔴 СП страхователя (ОбщаяСП, R) ≠ Σ СП контрагентов (Σ S). Допуск строго ±1 ₸.
  _insurerPremMismatch(r) {
    const agg = BatchAR._contractAgg(r);
    const rr = (r.premiumTotal != null) ? Number(r.premiumTotal) : null;
    return rr != null && agg.sumSP > 0 && Math.abs(rr - agg.sumSP) > 1.0001;
  },
  // Расхождение БОЛЬШЕ ±1 ₸ — ошибка (меньше/равно 1 ₸ — округление копеек, не ошибка).
  _moneyDiff(a, b) {
    return a != null && b != null && Math.abs(a - b) > 1.0001;
  },
  _premiumDiff(r) {
    return BatchAR._moneyDiff(BatchAR._expectedPremium(r), BatchAR._premBaseTotal(r));
  },
  _sumDiff(r) {
    return BatchAR._moneyDiff(BatchAR._expectedSum(r), r.insuranceSumTotal);
  },
  // Грубая ошибка: страховая сумма МЕНЬШЕ страховой премии. Премия всегда должна
  // быть малой долей суммы (премия = СС × тариф), поэтому СС < премии — точно
  // ошибка данных → красным вся строка и обе ячейки (СС и премия).
  _sumLtPremiumError(r) {
    const pb = BatchAR._premBaseTotal(r);
    return r.insuranceSumTotal != null && pb != null && Number(r.insuranceSumTotal) < pb - BatchAR._MONEY_EPS;
  },

  // Грубая ошибка: СС (ИТОГ) < ФОТ (ИТОГ по договору). СС всегда должна быть ≥ ФОТ.
  _sumLtFotError(r) {
    const fot = BatchAR._contractFotTotal(r);
    return r.insuranceSumTotal != null && fot > 0 && Number(r.insuranceSumTotal) < fot - BatchAR._MONEY_EPS;
  },
  // Любая грубая ошибка по страховой сумме (СС < премии ИЛИ СС < ФОТ).
  _sumError(r) {
    return BatchAR._sumLtPremiumError(r) || BatchAR._sumLtFotError(r);
  },

  // Договор с ФИЛИАЛАМИ — несколько РАЗНЫХ БИНов под одним номером договора.
  // Для филиалов пол 1 МЗП применяется к договору в целом (сумме по филиалам),
  // а не к каждой строке — поэтому per-row премия может быть < 85 000, и это НЕ ошибка.
  _filialContractSet() {
    if (BatchAR._filialContracts) return BatchAR._filialContracts;
    // Филиалы = несколько СТРОК под одним номером договора (в полном формате это
    // разные БИНКонтрагента; в сокращённом БИНКонтрагента нет, поэтому считаем строки).
    const countByContract = new Map();
    for (const x of BatchAR.rows) {
      const cn = x.contractNumber || '';
      if (!cn) continue;
      countByContract.set(cn, (countByContract.get(cn) || 0) + 1);
    }
    const set = new Set();
    for (const [cn, n] of countByContract) if (n > 1) set.add(cn);
    BatchAR._filialContracts = set;
    return set;
  },
  _isFilial(r) {
    return !!(r.contractNumber && BatchAR._filialContractSet().has(r.contractNumber));
  },

  // Грубая ошибка: премия по договору ДО ПК < 1 МЗП (85 000). ОбщаяСтраховаяПремия —
  // это ИТОГ с ПК по договору, поэтому до ПК = ОбщаяСтраховаяПремия / ПК. Считаем по
  // договору в целом (филиалы учтены автоматически — отдельного исключения не нужно).
  _premiumBelowMinError(r) {
    const pb = BatchAR._premBaseTotal(r);
    return pb != null && pb > 0 && pb < BatchAR._minPremium() - BatchAR._MONEY_EPS;
  },

  // Невалидный ИИН/БИН (формат / тип по 5-й цифре / контрольная цифра mod-11).
  // Возвращает причину (строку) либо null, если БИН корректен или проверить нечем.
  _binInvalidReason(r) {
    if (typeof Utils === 'undefined' || !Utils.validateIinBin) return null;
    const v = Utils.validateIinBin(r.bin);
    return v.valid ? null : (v.reason || 'некорректный ИИН/БИН');
  },
  _binInvalid(r) {
    return BatchAR._binInvalidReason(r) != null;
  },
  // Невалидный БИН Страхователя (если он присутствует в строке). По нему идёт
  // проверка возраста, поэтому его корректность важна.
  _insurerBinInvalidReason(r) {
    if (typeof Utils === 'undefined' || !Utils.validateIinBin) return null;
    const v = r.binInsurer && String(r.binInsurer).trim();
    if (!v) return null; // нет БИН Страхователя в строке — не ошибка
    const res = Utils.validateIinBin(v);
    return res.valid ? null : (res.reason || 'некорректный ИИН/БИН');
  },

  // Тариф в проценты: 0,0049 → «0,49%».
  _fmtPct(t) {
    if (t == null || isNaN(t)) return '';
    const p = Math.round(Number(t) * 100 * 100) / 100;
    return String(p).replace('.', ',') + '%';
  },

  // Страхователь: БИН (сверху, чёрный жирный) + наименование (снизу, серое мельче, с обрезкой).
  _insurerIdentCell(r) {
    const bin = r.binInsurer || '';
    const nm = r.insurerNameSt || '';
    return `<div class="batch-stack"><span class="batch-stack-top batch-party-bin">${bin ? ARForm._esc(bin) : '—'}</span><span class="batch-stack-bot batch-party-name" title="${ARForm._esc(nm)}">${nm ? ARForm._esc(nm) : '—'}</span></div>`;
  },
  // ===== Ячейки уровня КОНТРАГЕНТА =====
  // Контрагент: БИН (сверху, чёрный жирный) + наименование (снизу, серое мельче, с обрезкой).
  _contrIdentCell(r) {
    const bin = r.bin || '';
    const nm = r.insurerName || r.excelName || '';
    return `<div class="batch-stack"><span class="batch-stack-top batch-party-bin">${bin ? ARForm._esc(bin) : '—'}</span><span class="batch-stack-bot batch-party-name" title="${ARForm._esc(nm)}">${nm ? ARForm._esc(nm) : '—'}</span></div>`;
  },
  // Класс контрагента (K, сверху) + тариф из выгрузки (снизу). Если тариф не
  // соответствует классу по справочнику — снизу красным «было → должно».
  // Класс контрагента: сверху — из выгрузки (K), снизу в скобках — классы по КАЖДОМУ
  // ОКЭД контрагента из stat.gov.kz, как «(класс_окэд1, класс_окэд2, …)». Красным,
  // если K нет среди них; жёлтым, если K есть, но не максимальный.
  _contrClassTariffCell(r) {
    const k = r.riskClassContragent || '—';
    let bottom = '';
    if (r.statgovStatus === 'loading') {
      bottom = '<span class="batch-sub batch-sub--load">⏳</span>';
    } else {
      // Снизу — ТОЛЬКО классы по ОКЭД контрагента (это колонка класса, не тарифа).
      // Тариф здесь больше не показываем. Подсветку несёт сама ЯЧЕЙКА
      // (batch-cell--err/warn из renderTable), поэтому список нейтральный —
      // без второй раскраски текста.
      const list = BatchAR._contrClassList(r);
      if (list.length) {
        const classes = list.map(c => c == null ? '?' : c);
        const wrong = BatchAR._contrClassWrongByBin(r);
        const diff = BatchAR._contrClassDiffByBin(r);
        const title = wrong ? 'Класс из выгрузки отсутствует среди классов по ОКЭД контрагента (stat.gov.kz)'
          : (diff ? 'Класс из выгрузки есть среди возможных, но не максимальный по ОКЭД контрагента'
          : 'Классы по ОКЭД контрагента (stat.gov.kz)');
        bottom = `<span class="batch-sub" title="${title}">(${classes.join(', ')})</span>`;
      }
    }
    return `<div class="batch-stack"><span class="batch-stack-top">${ARForm._esc(String(k))}</span>${bottom ? `<span class="batch-stack-bot">${bottom}</span>` : ''}</div>`;
  },
  // СС контрагента (O, сверху). Снизу — ВЫЧИСЛЕННАЯ ожидаемая СС: ФОТ (если премия < пола
  // 85 000), иначе СП/(тариф×ПК). Красным — если СС < ФОТ; жёлтым — если ≠ вычисленной;
  // серым — если совпадает.
  _contrSumCell(r) {
    const top = BatchAR._fmtMoney(r.insuranceSum);
    const exp = BatchAR._contrExpectedSum(r);
    let bottom = '';
    if (exp != null) {
      const ltFot = BatchAR._contrSumLtFotError(r);
      const diff = BatchAR._contrSumDiff(r);
      const cls = (ltFot || diff) ? 'batch-sub--err' : '';
      const title = ltFot ? 'СС контрагента меньше ФОТ — должна быть ≥ ФОТ'
        : (diff ? 'СС контрагента отличается от расчётной больше чем на 100 ₸'
        : 'Расчётная СС контрагента: ФОТ если премия < 85 000, иначе СП/(тариф×ПК). Допуск ±100 ₸');
      bottom = `<span class="batch-sub ${cls}" title="${title}">(${BatchAR._fmtMoney(exp)})</span>`;
    }
    return `<div class="batch-stack"><span class="batch-stack-top">${top}</span>${bottom ? `<span class="batch-stack-bot">${bottom}</span>` : ''}</div>`;
  },
  // СП контрагента (S, сверху). Снизу — расчётная СС(контр)×тариф(класс K)×ПК (БЕЗ пола
  // МЗП — у контрагента премия МОЖЕТ быть < 85 000). Серым при совпадении (±1 ₸ —
  // округление), жёлтым при расхождении. Ошибки класса/тарифа — в своих колонках,
  // на премию красным НЕ переносим (премия может быть верной даже при споре о классе).
  _contrPremCell(r) {
    const top = BatchAR._fmtMoney(r.premiumWithCoeff);
    const exp = BatchAR._contrExpectedPremium(r);
    let bottom = '';
    if (exp != null) {
      const diff = BatchAR._contrPremiumDiff(r);
      bottom = `<span class="batch-sub ${diff ? 'batch-sub--err' : ''}" title="Расчётная СП контрагента = СС × тариф(класс K) × ПК (допуск ±1 ₸)">(${BatchAR._fmtMoney(exp)})</span>`;
    }
    return `<div class="batch-stack"><span class="batch-stack-top">${top}</span>${bottom ? `<span class="batch-stack-bot">${bottom}</span>` : ''}</div>`;
  },

  // ===== Ячейки уровня СТРАХОВАТЕЛЯ =====
  // СС страхователя (N, сверху). Снизу — расчётная СС ПО ПРЕМИИ: СП/(тариф×ПК) (или 1 МЗП/тариф
  // при поле). СС может быть БОЛЬШЕ ФОТ (переплата) — это не ошибка. Красным: N ≠ Σ СС(контр),
  // СС < ФОТ, СС < премии; жёлтым — расхождение СС с премией (несогласованность СС и СП).
  _sumCellHtml(r) {
    const top = BatchAR._fmtMoney(r.insuranceSumTotal);
    const agg = BatchAR._contractAgg(r);
    let bottom = '';
    if (BatchAR._insurerSumMismatch(r)) {
      bottom = `<span class="batch-sub batch-sub--err" title="Σ СС контрагентов ≠ СС страхователя (ОбщаяСС), допуск ±1 ₸">(${BatchAR._fmtMoney(agg.sumSS)})</span>`;
    } else if (BatchAR._sumLtFotError(r) || BatchAR._sumLtPremiumError(r)) {
      bottom = `<span class="batch-sub batch-sub--err" title="СС страхователя меньше ФОТ или меньше страховой премии">(${BatchAR._fmtMoney(agg.sumSS)})</span>`;
    } else {
      bottom = `<span class="batch-sub" title="Σ СС контрагентов (= СС страхователя)">(${BatchAR._fmtMoney(agg.sumSS)})</span>`;
    }
    return `<div class="batch-stack"><span class="batch-stack-top">${top}</span><span class="batch-stack-bot">${bottom}</span></div>`;
  },
  // СПсПК страхователя (R, сверху). Снизу — Σ СП контрагентов (по номеру договора): должна
  // равняться СП страхователя. Красным при ≠ (агрегация) или базе < 1 МЗП; иначе серым.
  // Премия выше расчётной по ФОТ — НЕ ошибка (следствие переплаты по СС).
  _premiumCellHtml(r) {
    const top = BatchAR._fmtMoney(r.premiumTotal);
    const agg = BatchAR._contractAgg(r);
    let bottom = '';
    if (BatchAR._insurerPremMismatch(r)) {
      bottom = `<span class="batch-sub batch-sub--err" title="Σ СП контрагентов ≠ СП страхователя (ОбщаяСП)">(${BatchAR._fmtMoney(agg.sumSP)})</span>`;
    } else if (BatchAR._premiumBelowMinError(r)) {
      bottom = `<span class="batch-sub batch-sub--err" title="База премии (СП/ПК) меньше 1 МЗП (85 000) — премия страхователя должна быть ≥ 85 000">(${BatchAR._fmtMoney(agg.sumSP)})</span>`;
    } else {
      bottom = `<span class="batch-sub" title="Σ СП контрагентов (= СП страхователя)">(${BatchAR._fmtMoney(agg.sumSP)})</span>`;
    }
    return `<div class="batch-stack"><span class="batch-stack-top">${top}</span><span class="batch-stack-bot">${bottom}</span></div>`;
  },

  // Нормализованный ОКЭД — только цифры (устойчиво к точкам/пробелам/суффиксам).
  _normOked(x) {
    const m = String(x == null ? '' : x).match(/\d{3,}/);
    return m ? m[0] : '';
  },

  // Подтверждён ли ОКЭД из выгрузки по stat.gov.kz?
  //   null  — проверить нельзя (statgov не дал кодов / нет кода в выгрузке);
  //   true  — код есть среди ОКЭД компании;
  //   false — кода компании НЕТ → ОКЭД в выгрузке ошибочный.
  _okedConfirmed(r) {
    const codes = BatchAR._statgovOkeds(r).map(BatchAR._normOked).filter(Boolean);
    if (!codes.length) return null;
    const our = BatchAR._normOked(r.oked);
    if (!our) return null;
    return codes.includes(our);
  },

  // ОКЭД ошибочный (КРАСНЫЙ): stat.gov.kz дал коды, но кода из выгрузки среди
  // них нет → класс риска, посчитанный по нему, тоже ошибочный → точно ошибка.
  _okedError(r) {
    return BatchAR._okedConfirmed(r) === false;
  },

  // Жёлтым подсвечиваем мягкое расхождение класса ТОЛЬКО для высоких классов
  // (≥ _CLASS_WARN_MIN). Расхождения среди классов 1–12 несущественны → зелёные.
  _CLASS_WARN_MIN: 13,

  // Расхождение класса: вычисленный по ОКЭД (макс.) ≠ класс из выгрузки.
  // (Сырое расхождение — используется и для красной ветки «ОКЭД ошибочен + класс».)
  _classDiff(r) {
    const comp = BatchAR._computedClass(r);
    return comp != null && String(comp) !== String(r.riskClass || '').trim();
  },
  // Жёлтое (мягкое) расхождение класса СТРАХОВАТЕЛЯ — только если задействован
  // высокий класс (≥ _CLASS_WARN_MIN). До 12-го расхождение считается зелёным.
  _classDiffWarn(r) {
    if (!BatchAR._classDiff(r)) return false;
    const comp = BatchAR._computedClass(r);
    const v = parseInt(r.riskClass, 10);
    const maxClass = Math.max(comp || 0, Number.isFinite(v) ? v : 0);
    return maxClass >= BatchAR._CLASS_WARN_MIN;
  },

  // ГРУБАЯ ошибка класса (КРАСНЫЙ): класс из выгрузки не совпадает с классом ЕЁ ЖЕ
  // ОКЭД по классификатору. То есть для указанного ОКЭД класс проставлен неверно —
  // это некорректные данные (в отличие от мягкого _classDiff, где у компании несколько
  // ОКЭД и просто выбран не максимальный). Проверяется по классификатору, без stat.gov.
  _classWrongForOked(r) {
    const c = BatchAR._classOf(r.oked);
    if (c == null) return false; // ОКЭД нет в классификаторе — проверить нельзя
    const v = parseInt(r.riskClass, 10);
    return Number.isFinite(v) && v !== c;
  },

  // Расхождение гос. участия (КРАСНЫЙ): вывод e-Qazyna (найден/не найден) ≠ выгрузка.
  _govDiff(r) {
    const eg = r.egov;
    if (!eg || eg.status !== 'done' || eg.found == null) return false;
    return eg.found !== !!r.govParticipation;
  },

  // Уровень подсветки строки — должен совпадать с подсветкой ЯЧЕЕК (любая красная
  // ячейка → 'err', любая жёлтая → 'warn'), чтобы вся строка красилась и поднималась
  // наверх по «Сначала ошибки».
  //   'err'  (красный) — точная ошибка данных: ошибочный ОКЭД (→ ошибочный класс),
  //                      расхождение гос. участия, СС<ФОТ/премии, премия<МЗП и т.п.;
  //   'warn' (жёлтый)  — мягкое расхождение: класс (выбран не тот ОКЭД) ИЛИ расчётная
  //                      СС/премия не совпала с выгрузкой;
  //   null             — расхождений нет.
  // «Сырой» уровень — РЕАЛЬНЫЙ результат валидации, без учёта согласования андеррайтером.
  _rawRowLevel(r) {
    if (BatchAR._okedError(r) || BatchAR._govDiff(r) || BatchAR._residRegDiff(r) || BatchAR._pkYoungError(r)
        || BatchAR._sumError(r) || BatchAR._premiumBelowMinError(r) || BatchAR._binInvalid(r)
        || BatchAR._insurerBinInvalidReason(r) || BatchAR._classWrongForOked(r)
        || BatchAR._contrSumLtFotError(r) || BatchAR._contrTariffClassError(r)
        || BatchAR._contrClassWrongByBin(r) || BatchAR._contrSumDiff(r) || BatchAR._contrPremiumDiff(r)
        || BatchAR._insurerSumMismatch(r) || BatchAR._insurerPremMismatch(r)) return 'err';
    // Жёлтым остаются только мягкие расхождения класса (СС/СП-расхождения теперь
    // красные), и только для высоких классов (≥13) — см. _classDiffWarn.
    if (BatchAR._classDiffWarn(r) || BatchAR._contrClassDiffByBin(r)) return 'warn';
    return null;
  },
  // Эффективный уровень строки для ВСЕЙ логики (печать/счётчики/сортировка/цвет).
  // Согласовано андеррайтером → ошибки сняты (печать с исходными данными под его
  // ответственность) → null. Снятие галочки возвращает реальный уровень.
  _rowLevel(r) {
    return r._approved ? null : BatchAR._rawRowLevel(r);
  },

  // Состояние строки для подсветки = жизненный цикл проверки stat.gov.kz + результат
  // валидации. Возвращает суффикс класса .batch-row--*:
  //   'pending'  — серый: ещё НЕ проверено (только загружено / в очереди / нет моста / ошибка проверки);
  //   'checking' — синий: проверяется сейчас;
  //   'err'/'warn' — красный/жёлтый: ошибка/расхождение (ТОЛЬКО после проверки 'done');
  //   'ok'       — зелёный: проверено, ошибок нет (либо согласовано андеррайтером).
  // Вердикт (красный/жёлтый/зелёный) показываем только когда строка реально проверена
  // ('done'); до этого — серый. Поэтому сразу после загрузки файла ВСЕ строки серые.
  _rowState(r) {
    const st = r.statgovStatus;
    if (st === 'loading') return 'checking';
    if (st === 'done') return BatchAR._rowLevel(r) || 'ok';  // level: null если согласовано
    // Расхождение резидентства «выгрузка ↔ egov» от statgov НЕ зависит (сравниваем
    // колонку выгрузки с ответом egov), поэтому красим строку красной сразу, не
    // дожидаясь statgov — иначе серый «в очереди» маскировал бы ошибку.
    if (!r._approved && BatchAR._residRegDiff(r)) return 'err';
    return 'pending';                                         // undefined/pending/skip/error → серый
  },
  // Набор классов <tr>: состояние + метка «согласовано» (для гашения подсветки ячеек в CSS).
  _rowClassList(r) {
    const out = [];
    const s = BatchAR._rowState(r);
    if (s) out.push('batch-row--' + s);
    if (r._approved) out.push('batch-row--approved');
    return out;
  },
  // Ячейка «Согласовано андеррайтером»: галочка. Подсказка зависит от реального уровня строки.
  _approveCell(r, i) {
    const lvl = BatchAR._rawRowLevel(r);
    const hint = lvl === 'err'
      ? 'Строка с ошибкой. Поставить галочку — согласовать и печатать с исходными данными под ответственность андеррайтера; строка перестанет считаться ошибочной, но подсветка ошибочных ячеек останется (видно, на что согласились). Снять — вернуть в исходное состояние.'
      : (lvl === 'warn'
        ? 'Строка с расхождением. Поставить галочку — согласовать и печатать как есть; подсветка ячеек останется. Снять — вернуть в исходное состояние.'
        : 'Отметить строку согласованной андеррайтером.');
    return `<label class="batch-approve" title="${ARForm._esc(hint)}"><input type="checkbox"${r._approved ? ' checked' : ''} onchange="BatchAR.toggleApproved(${i}, this)"></label>`;
  },

  // Все ОКЭД компании из stat.gov.kz (primary + secondary), без дублей.
  _statgovOkeds(r) {
    const sg = r.statgov && !r.statgov.error ? r.statgov : null;
    if (!sg) return [];
    const list = [];
    if (sg.okedPrimaryCode) list.push(String(sg.okedPrimaryCode));
    if (Array.isArray(sg.okedSecondaryCodes)) {
      for (const c of sg.okedSecondaryCodes) if (c) list.push(String(c));
    }
    return [...new Set(list)];
  },

  // Упорядоченный список ОКЭД для нижних строк (ОКЭД и Класс) — один и тот же,
  // чтобы классы шли в том же порядке, что и коды: класс_окэд1, класс_окэд2, …
  // Источник — stat.gov.kz; если проверка завершена, но кодов нет — ОКЭД из выгрузки.
  _okedList(r) {
    const sg = BatchAR._statgovOkeds(r);
    if (sg.length) return sg;
    if (r.statgovStatus === 'done' && r.oked) return [String(r.oked)];
    return [];
  },

  // Класс по одному ОКЭД через классификатор (null если не загружен / нет совпадения).
  _classOf(oked) {
    const classifier = (typeof App !== 'undefined' && App.refData && App.refData.classifier) || null;
    if (!classifier || !classifier.length || !Utils.lookupOked) return null;
    const found = Utils.lookupOked(String(oked), classifier);
    return (found && found.cls != null && !isNaN(Number(found.cls))) ? Number(found.cls) : null;
  },

  // Страховой тариф по классу из справочника «Поправочные коэффициенты» (или null).
  _tariffByClass(cls) {
    const rr = (typeof App !== 'undefined' && App.refData && App.refData.popravka) ? App.refData.popravka.riskRates : null;
    if (!rr || cls == null) return null;
    const t = rr.get(cls);
    return Number.isFinite(t) ? t : null;
  },

  // Из набора классов возвращает класс с НАИБОЛЬШИМ страховым ТАРИФОМ (а не с
  // наибольшим НОМЕРОМ): маппинг класс→тариф немонотонный (напр. класс 13 = 1,29%
  // выше, чем класс 16 = 1,17%), поэтому «правильный» класс для договора — тот, у
  // которого выше тариф. Тай-брейк при равных тарифах — больший номер класса.
  // Если тарифов нет в справочнике — fallback на максимальный номер класса.
  _maxTariffClass(classes) {
    const list = (classes || []).filter(c => c != null);
    if (!list.length) return null;
    let best = null, bestTar = -Infinity, anyTar = false;
    for (const c of list) {
      const t = BatchAR._tariffByClass(c);
      if (t == null) continue;
      anyTar = true;
      if (t > bestTar || (t === bestTar && (best == null || c > best))) { bestTar = t; best = c; }
    }
    return anyTar ? best : Math.max(...list);
  },

  // Классы по каждому ОКЭД (в порядке _okedList).
  _computedClasses(r) {
    return BatchAR._okedList(r).map(o => BatchAR._classOf(o));
  },

  // «Правильный» класс среди ОКЭД страхователя — с НАИБОЛЬШИМ ТАРИФОМ (не номером).
  _computedClass(r) {
    const list = BatchAR._computedClasses(r).filter(c => c != null);
    return list.length ? BatchAR._maxTariffClass(list) : null;
  },

  // ОКЭД: сверху — из выгрузки, снизу в скобках — из stat.gov.kz (все коды по порядку).
  // Если кода из выгрузки нет среди ОКЭД компании — список снизу краснеет (ошибка).
  _okedCell(r) {
    const top = ARForm._esc(r.oked || '—');
    let bottom = '';
    if (r.statgovStatus === 'loading') {
      bottom = '<span class="batch-sub batch-sub--load">⏳ statgov…</span>';
    } else {
      const list = BatchAR._okedList(r);
      if (list.length) {
        const err = BatchAR._okedError(r);
        const title = err
          ? 'ОКЭД из выгрузки не найден среди ОКЭД компании по stat.gov.kz — код ошибочный'
          : 'ОКЭД компании по stat.gov.kz';
        bottom = `<span class="batch-sub ${err ? 'batch-sub--err' : ''}" title="${title}">(${ARForm._esc(list.join(', '))})</span>`;
      }
    }
    return `<div class="batch-stack"><span class="batch-stack-top batch-oked-code">${top}</span>${bottom ? `<span class="batch-stack-bot">${bottom}</span>` : ''}</div>`;
  },

  // Класс: сверху — из выгрузки, снизу в скобках — классы по каждому ОКЭД
  // в том же порядке, что и коды в столбце ОКЭД. Если макс. ≠ выгрузки — подсветка.
  _classCell(r) {
    const top = ARForm._esc(r.riskClass || '—');
    let bottom = '';
    if (r.statgovStatus === 'loading') {
      bottom = '<span class="batch-sub batch-sub--load">⏳</span>';
    } else {
      const list = BatchAR._okedList(r);
      if (list.length) {
        const classes = list.map(o => { const c = BatchAR._classOf(o); return c == null ? '?' : c; });
        const diff = BatchAR._classDiff(r);
        const err = diff && BatchAR._okedError(r);
        const title = err
          ? 'Класс ошибочный: ОКЭД из выгрузки отсутствует у компании по stat.gov.kz'
          : (diff ? 'Макс. класс по ОКЭД не совпадает с выгрузкой — выбран не тот ОКЭД из нескольких' : 'классы по каждому ОКЭД');
        // Список классов нейтральный — подсветку несёт сама ЯЧЕЙКА
        // (batch-cell--err/warn из renderTable), без второй раскраски текста.
        bottom = `<span class="batch-sub" title="${title}">(${classes.join(', ')})</span>`;
      }
    }
    return `<div class="batch-stack"><span class="batch-stack-top">${top}</span>${bottom ? `<span class="batch-stack-bot">${bottom}</span>` : ''}</div>`;
  },

  // Эффективная дата регистрации: из stat.gov.kz; если её нет — из kyc.kz.
  _effRegDate(r) {
    const sg = (r.statgov && !r.statgov.error) ? r.statgov.registrationDate : null;
    if (sg) return { raw: sg, source: 'statgov' };
    const kyc = (r.kyc && !r.kyc.error && r.kyc.found !== false) ? r.kyc.registrationDate : null;
    if (kyc) return { raw: kyc, source: 'kyc' };
    return null;
  },

  // Эффективный юр. адрес: stat.gov.kz (вкл. «Местонахождение») → kyc.kz.
  _effLegalAddress(r) {
    const sgAddr = (typeof Utils !== 'undefined' && Utils.statgovLegalAddress)
      ? Utils.statgovLegalAddress(r.statgov)
      : ((r.statgov && r.statgov.legalAddress) || '');
    if (sgAddr) return sgAddr;
    const kyc = (r.kyc && !r.kyc.error && r.kyc.found !== false) ? r.kyc.legalAddress : null;
    return kyc ? String(kyc).trim() : '';
  },

  // БИН Страхователя (по нему — проверка возраста ≥3 лет): приоритет у отдельного
  // поля binInsurer (БИН Страхователя), иначе текущий БИН строки (БИН Контрагента).
  // Контрагент может быть моложе 3 лет, а Страхователь — нет, поэтому возраст
  // считаем именно по Страхователю.
  _insurerBin(r) {
    const ib = r.binInsurer && String(r.binInsurer).replace(/\s+/g, '');
    return (ib && /^\d{12}$/.test(ib)) ? ib : r.bin;
  },

  // Окно андеррайтера на проверку договора после его даты (дней). Возраст
  // компании считаем на конец этого окна, а не строго на дату договора.
  AGE_REF_GRACE_DAYS: 5,

  // Дата, НА КОТОРУЮ считается возраст компании для ПК: дата договора + 5 дней
  // (AGE_REF_GRACE_DAYS). Дата договора берётся из его номера — BatchReader.
  // _contractDate, цифры [2..8) = ДД.ММ.ГГ; это же значение стоит в шапке
  // «Рекомендации ДАиП»/АР как «от …». Сегодняшний день НЕ годится: право на
  // скидку определяется при заключении договора, а выгрузку проверяют позже —
  // иначе компания «дорастает» до 3 лет уже после подписания и ПК задним числом
  // выглядит правомерным. Запас в 5 дней — окно, в течение которого андеррайтер
  // проверяет договор. Номера без даты → откат на сегодня.
  _ageRefDate(r) {
    const d = r && r.dateContract;
    if (!(d instanceof Date) || isNaN(d)) return new Date();
    const ref = new Date(d);
    ref.setDate(ref.getDate() + BatchAR.AGE_REF_GRACE_DAYS);
    return ref;
  },

  // Дата, на которую ПОКАЗЫВАЕМ возраст в таблице — сама дата договора, без
  // 5-дневного запаса (запас нужен только для решения по ПК, а в колонке
  // «Дата рег.» андеррайтер хочет видеть возраст на дату договора).
  _ageShownRef(r) {
    const d = r && r.dateContract;
    return (d instanceof Date && !isNaN(d)) ? d : new Date();
  },

  // Подпись к возрасту: на какую дату он посчитан (для title).
  _ageShownTitle(r) {
    const d = r && r.dateContract;
    return (d instanceof Date && !isNaN(d))
      ? `Возраст на дату договора ${Utils.fmtDateShort(d)} (право на ПК проверяется на +${BatchAR.AGE_REF_GRACE_DAYS} дней)`
      : 'Возраст на сегодня — в номере договора нет даты';
  },

  // Пересчитать возраст/флаг «моложе порога» на дату договора + 5 дней (_ageRefDate).
  // Дата основания = САМАЯ РАННЯЯ (старшая) из доступных:
  //   • дата регистрации из stat.gov.kz / kyc.kz;
  //   • дата из первых 4 цифр БИН Страхователя (ГГ ММ) — учитывает перерегистрацию:
  //     если в stat.gov.kz дата моложе 3 лет (перерегистрация), но БИН начинается с
  //     «22…», компания основана в 2022 г. и моложе 3 лет НЕ считается.
  // Берём самую раннюю дату → компания не моложе этого. youngAlert — по порогу.
  _applyYoung(r) {
    const now = new Date();
    const ref = BatchAR._ageRefDate(r);
    const candidates = [];
    let regSource = null;
    const insurerBin = BatchAR._insurerBin(r);
    // stat.gov/kyc теперь ищутся по БИН Страхователя, поэтому дата регистрации относится
    // к нему — используем её напрямую (плюс дату из первых 4 цифр БИН Страхователя).
    const eff = BatchAR._effRegDate(r);
    if (eff && eff.raw) {
      const d = Utils.parseCompanyRegDate ? Utils.parseCompanyRegDate(eff.raw) : null;
      if (d && !isNaN(d)) { candidates.push(d); regSource = d; }
    }
    const binDate = Utils.binRegistrationDate ? Utils.binRegistrationDate(insurerBin) : null;
    // Сверка с СЕГОДНЯ (а не с датой договора) — это защита от мусорного разбора
    // БИН: дата основания в будущем невозможна. Сам возраст считается на ref.
    if (binDate && !isNaN(binDate) && binDate <= now) candidates.push(binDate);
    if (candidates.length) {
      const founding = candidates.reduce((a, b) => (a <= b ? a : b)); // самая ранняя
      const age = Utils.companyAgeYears(founding, ref);
      r.ageYears = age;
      r.youngAlert = (age != null && age < BatchAR._youngThreshold());
      r._foundingDate = founding;
      // Возраст «вытянут» из БИН (БИН старше даты регистрации из реестра) — для пояснения в UI.
      r._agedByBin = !!(binDate && founding.getTime() === binDate.getTime()
        && (!regSource || binDate < regSource));
    } else {
      r.ageYears = null;
      r.youngAlert = false;
      r._foundingDate = null;
      r._agedByBin = false;
    }
  },

  // «окт. 2016» из даты — компактная пометка года/месяца основания по БИН.
  _monthYear(d) {
    if (!d || isNaN(d)) return '';
    const MON = ['янв.', 'фев.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сен.', 'окт.', 'ноя.', 'дек.'];
    return `${MON[d.getMonth()]} ${d.getFullYear()}`;
  },

  // Возраст компании «2 года 4 месяца» по дате регистрации (или null).
  // refDate — момент, на который считаем (дата договора + 5 дней, см. _ageRefDate);
  // без него — сегодня. Должен совпадать с базой расчёта youngAlert, иначе
  // подпись под датой разойдётся с подсветкой.
  _ageText(regRaw, refDate) {
    const reg = Utils.parseExcelDate(regRaw);
    if (!reg || isNaN(reg)) return null;
    const now = (refDate instanceof Date && !isNaN(refDate)) ? refDate : new Date();
    let years = now.getFullYear() - reg.getFullYear();
    let months = now.getMonth() - reg.getMonth();
    if (now.getDate() < reg.getDate()) months--;
    if (months < 0) { years--; months += 12; }
    if (years < 0) return null;
    const parts = [];
    if (years > 0) parts.push(Utils.pluralize(years, 'год', 'года', 'лет'));
    if (months > 0) parts.push(Utils.pluralize(months, 'месяц', 'месяца', 'месяцев'));
    if (!parts.length) parts.push('меньше месяца');
    return parts.join(' ');
  },

  // Дата регистрации: stat.gov.kz, иначе fallback на kyc.kz. Дата сверху; для
  // молодых компаний снизу в скобках — возраст «2 года 4 месяца».
  _regCell(r) {
    if (r.statgovStatus === 'loading') return '<span class="batch-sg batch-sg--load">⏳ проверка…</span>';
    if (r.statgovStatus === 'pending') return '<span class="batch-sg batch-sg--wait">ожидает</span>';
    if (r.statgovStatus === 'skip') return '<span class="batch-sg">—</span>';
    if (r.statgovStatus === 'error') return '<span class="batch-sg batch-sg--err" title="' + ARForm._esc((r.statgov && r.statgov.error) || '') + '">н/д</span>';
    // statgovStatus === 'done'
    const eff = BatchAR._effRegDate(r);
    const binDate = Utils.binRegistrationDate ? Utils.binRegistrationDate(BatchAR._insurerBin(r)) : null;
    const binUsable = binDate && !isNaN(binDate) && binDate <= new Date();
    if (!eff) {
      // Даты из statgov нет. Но есть fallback на kyc.kz, который стартует ТОЛЬКО
      // после того, как весь statgov-проход завершится. Пока kyc-фаза для этой
      // строки не закрыта — показываем ⏳, а НЕ промежуточную дату из БИН /
      // «найдено без даты»: иначе кажется, что дата уже финальная.
      const kycMayRun = typeof StatGovClient !== 'undefined' && !!StatGovClient.lookupKyc && !BatchAR._kycFinished;
      if (r.kycStatus === 'loading'
          || (kycMayRun && r.kycStatus !== 'done' && r.kycStatus !== 'error')) {
        return '<span class="batch-sg batch-sg--load">⏳ проверка…</span>';
      }
      // kyc завершён (или недоступен) → финал. Нет даты из реестров, но БИН
      // Страхователя даёт дату основания — показываем её.
      if (binUsable) {
        const ds = ARForm._esc(Utils.fmtDateShort(binDate));
        let aRow = '';
        if (r.youngAlert) { const a = BatchAR._ageText(binDate, BatchAR._ageShownRef(r)); if (a) aRow = `<span class="batch-sub batch-young" title="${ARForm._esc(BatchAR._ageShownTitle(r))}">(${ARForm._esc(a)})</span>`; }
        return `<div class="batch-stack"><span class="batch-stack-top batch-reg" title="дата основания из БИН Страхователя">${ds}<span class="batch-regsrc" title="из БИН Страхователя">БИН</span></span>${aRow ? `<span class="batch-stack-bot">${aRow}</span>` : ''}</div>`;
      }
      return '<span class="batch-sg batch-sg--ok">✓ найдено (без даты)</span>';
    }
    const dateStr = ARForm._esc(Utils.fmtDateShort(eff.raw));
    // Видимую метку «kyc» и месяц/год из БИН не показываем (лишний шум); источник
    // в подписи тоже не называем. Снизу — только возраст молодой компании.
    const srcTitle = 'дата регистрации';
    let ageRow = '';
    if (r.youngAlert) {
      const age = BatchAR._ageText(r._foundingDate || eff.raw, BatchAR._ageShownRef(r));
      if (age) ageRow = `<span class="batch-sub batch-young" title="${ARForm._esc(BatchAR._ageShownTitle(r))}">(${ARForm._esc(age)})</span>`;
    }
    return `<div class="batch-stack"><span class="batch-stack-top batch-reg" title="${srcTitle}">${dateStr}</span>${ageRow ? `<span class="batch-stack-bot">${ageRow}</span>` : ''}</div>`;
  },

  // Гос. участие: сверху — из выгрузки, снизу в скобках — вывод по e-Qazyna.
  // По e-Qazyna: найден в реестре → «Да», не найден → «Нет» (долю НЕ показываем).
  // Подсветка — только при РАСХОЖДЕНИИ выгрузки и e-Qazyna (корректность данных),
  // а не за само наличие гос. участия.
  _govCell(r) {
    const reg = !!r.govParticipation;
    // Сверху — из выгрузки: есть гос. участие → «✓», нет → «—».
    const top = reg
      ? '<span class="batch-gov-yes" title="В выгрузке: гос. участие есть">✓</span>'
      : '<span class="batch-gov-no" title="В выгрузке: гос. участия нет">—</span>';
    let bottom = '';
    const eg = r.egov;
    if (eg) {
      if (eg.status === 'loading') {
        bottom = '<span class="batch-sub batch-sub--load">⏳</span>';
      } else if (eg.status === 'error' || eg.found == null) {
        bottom = '<span class="batch-sub" title="e-Qazyna: нет данных">(н/д)</span>';
      } else {
        // Снизу — из e-Qazyna: найден → «(✓)», не найден → «(—)».
        const diff = eg.found !== reg; // расхождение выгрузки и e-Qazyna
        const mark = eg.found ? '✓' : '—';
        const title = diff
          ? `Расхождение: в выгрузке «${reg ? 'есть' : 'нет'}», по e-Qazyna «${eg.found ? 'есть' : 'нет'}»`
          : (eg.found ? 'e-Qazyna: гос. участник (совпадает с выгрузкой)' : 'e-Qazyna: не гос. участник (совпадает с выгрузкой)');
        bottom = `<span class="batch-sub ${diff ? 'batch-sub--err' : ''}" title="${title}">(${mark})</span>`;
      }
    }
    return `<div class="batch-stack"><span class="batch-stack-top">${top}</span>${bottom ? `<span class="batch-stack-bot">${bottom}</span>` : ''}</div>`;
  },

  // Резидентство Страхователя ПО ВЫГРУЗКЕ (колонка «СтранаРезидентстваСтрахователя»):
  // «Казахстан» → резидент, любая другая непустая страна → нерезидент, пусто → нет данных.
  _residRegistryStatus(r) {
    const c = String((r && r.residencyCountry) || '').trim();
    if (!c) return null;
    return /казахстан|kazakhstan|қазақстан/i.test(c) ? 'resident' : 'nonresident';
  },

  // Расхождение «выгрузка ↔ egov» по резидентству Страхователя. Сравниваем только
  // когда ОБА известны и вердикт авторитетный (egov): локальный индекс ГБД ЮЛ
  // отстаёт, по нему расхождения не выставляем — иначе ложные ошибки.
  _residRegDiff(r) {
    const reg = BatchAR._residRegistryStatus(r);
    if (!reg) return false;
    const bin = BatchAR._insurerBin(r);
    const eg = (typeof ResidentCheck !== 'undefined' && ResidentCheck.egovResolved)
      ? ResidentCheck.egovResolved(bin) : null;
    if (!eg || (eg.status !== 'resident' && eg.status !== 'nonresident')) return false;
    return eg.status !== reg;
  },

  // Вердикт egov по БИН для таблицы. В таблице снизу показываем ТОЛЬКО egov —
  // локальный индекс ГБД ЮЛ здесь не подставляем (он отстаёт → ложные нерезиденты).
  //   {kind:'off'}   — моста/сессии egov нет: проверка не делалась → «отключен»
  //   {kind:'wait'}  — проверка ещё идёт → ⏳
  //   {kind:'ip'}    — ИИН: резидентство ИП не вычисляется → «ИП»
  //   {kind:'res'|'non'} — авторитетный ответ egov
  //   {kind:'na'}    — egov не ответил по этому БИН
  _residEgov(bin) {
    if (typeof ResidentCheck === 'undefined') return { kind: 'off', txt: 'отключен', title: 'Проверка резидентства недоступна' };
    if (BatchAR._egovResidPhase === 'unavailable') {
      return { kind: 'off', txt: 'отключен', title: 'Нет подключения к egov — проверка резидентства не выполнялась' };
    }
    if (ResidentCheck.idKind && ResidentCheck.idKind(bin) !== 'bin') {
      return { kind: 'ip', txt: 'ИП', title: 'ИИН (ИП/физлицо) — резидентство автоматически не определяется' };
    }
    const eg = ResidentCheck.egovResolved && ResidentCheck.egovResolved(bin);
    if (eg) {
      return eg.status === 'resident'
        ? { kind: 'res', txt: '✓', title: eg.title }
        : { kind: 'non', txt: 'нерез.', title: eg.title };
    }
    if (BatchAR._egovResidPhase === 'pending' || BatchAR._egovResidPhase === 'idle') {
      return { kind: 'wait', txt: '⏳', title: 'Резидентство проверяется через egov (P30.11)…' };
    }
    return { kind: 'na', txt: 'н/д', title: 'egov не вернул данные по этому БИН' };
  },

  // Ячейка резидентства СТРАХОВАТЕЛЯ. Соглашение таблицы: СВЕРХУ ЧЁРНЫМ — значение
  // из выгрузки (база), СНИЗУ СЕРЫМ в скобках — из реестра egov.
  //   верх:  ✓ (Казахстан) · нерез. (другая страна) · «отсутствует» (в выгрузке пусто)
  //   низ:   (✓) · (нерез.) · (ИП) · (отключен) · (⏳) · (н/д)
  // Если в выгрузке пусто — сверять не с чем, правильным считаем значение egov.
  _residCellInsurer(r) {
    const reg = BatchAR._residRegistryStatus(r);
    const country = String((r && r.residencyCountry) || '').trim();
    const top = reg === null
      ? '<span class="batch-res batch-res--absent" title="В выгрузке страна резидентства не указана — правильным считается значение egov (снизу)">отсутствует</span>'
      : (reg === 'resident'
        ? `<span class="batch-res batch-res--reg" title="В выгрузке: ${ARForm._esc(country)} → резидент">✓</span>`
        : `<span class="batch-res batch-res--reg" title="В выгрузке: ${ARForm._esc(country)} → нерезидент">нерез.</span>`);
    const eg = BatchAR._residEgov(BatchAR._insurerBin(r));
    const diff = BatchAR._residRegDiff(r);
    const subTitle = diff
      ? `Расхождение: в выгрузке «${reg === 'resident' ? 'резидент' : 'нерезидент'}» (${ARForm._esc(country)}), по egov — «${ARForm._esc(eg.txt)}»`
      : ARForm._esc(eg.title);
    const bottom = `<span class="batch-sub ${diff ? 'batch-sub--err' : ''}" title="${subTitle}">(${eg.txt})</span>`;
    return `<div class="batch-stack"><span class="batch-stack-top">${top}</span><span class="batch-stack-bot">${bottom}</span></div>`;
  },

  // Эффективный статус резидентства Страхователя для сортировки/счётчиков:
  // приоритет у egov, если он ответил; иначе — значение из выгрузки.
  // 'nonresident' | 'individual' | 'resident' | null.
  _residEffStatus(r) {
    const eg = BatchAR._residEgov(BatchAR._insurerBin(r));
    if (eg.kind === 'non') return 'nonresident';
    if (eg.kind === 'res') return 'resident';
    if (eg.kind === 'ip') return 'individual';
    return BatchAR._residRegistryStatus(r);   // egov отключён/не ответил → выгрузка
  },

  // Ранг строки для сортировки «Сначала нерезиденты»:
  // нерезидент(3) > ИП(2) > резидент(1) > нет данных(0). Больше — выше.
  _residRowRank(r) {
    const s = BatchAR._residEffStatus(r);
    return s === 'nonresident' ? 3 : (s === 'individual' ? 2 : (s === 'resident' ? 1 : 0));
  },

  // Обновить одну строку таблицы (после statgov / e-Qazyna), не перерисовывая всю.
  // Обновляет одну строку по месту. Строки, ещё не добавленные в DOM (порции по
  // прокрутке), просто пропускаем — они отрисуются актуальными.
  _refreshRow(i) {
    const tr = BatchAR._rowEls ? BatchAR._rowEls.get(i) : null;
    if (!tr || !tr.isConnected) return;
    const r = BatchAR.rows[i];
    const set = (sel, html) => { const c = tr.querySelector(sel); if (c) c.innerHTML = html; };
    set('.batch-c-oked', BatchAR._okedCell(r));
    set('.batch-c-class', BatchAR._classCell(r));
    set('.batch-c-reg', BatchAR._regCell(r));
    set('.batch-c-gov', BatchAR._govCell(r));
    set('.batch-c-resident-s', BatchAR._residCellInsurer(r));
    // Подсветка расхождения «выгрузка ↔ egov» по резидентству Страхователя.
    const tdRs = tr.querySelector('.batch-c-resident-s');
    if (tdRs) tdRs.classList.toggle('batch-cell--err', BatchAR._residRegDiff(r));
    // СС/премия зависят от вычисленного класса/тарифа → обновляем после statgov.
    set('.batch-c-sum', BatchAR._sumCellHtml(r));
    set('.batch-c-prem', BatchAR._premiumCellHtml(r));
    // Класс/премия контрагента зависят от реального ОКЭД контрагента (statgovContr).
    set('.batch-c-contr-class', BatchAR._contrClassTariffCell(r));
    set('.batch-c-contr-prem', BatchAR._contrPremCell(r));
    set('.batch-c-contr-sum', BatchAR._contrSumCell(r));
    const contrSumCell = tr.querySelector('.batch-c-contr-sum');
    if (contrSumCell) {
      contrSumCell.classList.toggle('batch-cell--err', BatchAR._contrSumLtFotError(r) || BatchAR._contrSumDiff(r));
      contrSumCell.classList.remove('batch-cell--warn');
    }
    const contrClassWrongBin = BatchAR._contrClassWrongByBin(r);
    const contrClassDiffBin = BatchAR._contrClassDiffByBin(r);
    const contrTarErr = BatchAR._contrTariffClassError(r);
    const contrClassCell = tr.querySelector('.batch-c-contr-class');
    if (contrClassCell) {
      const ccErr = contrTarErr || contrClassWrongBin;
      contrClassCell.classList.toggle('batch-cell--err', ccErr);
      contrClassCell.classList.toggle('batch-cell--warn', !ccErr && contrClassDiffBin);
      if (contrClassWrongBin) contrClassCell.title = `Класс контрагента в выгрузке (${BatchAR._contrClass(r)}) отсутствует среди классов по его ОКЭД из stat.gov.kz`;
      else if (contrClassDiffBin) contrClassCell.title = `Класс контрагента ${BatchAR._contrClass(r)} есть среди ОКЭД, но не с наибольшим тарифом (нужен класс ${BatchAR._contrComputedClass(r)})`;
      else if (contrTarErr) contrClassCell.title = 'Тариф не соответствует классу контрагента по справочнику';
      else contrClassCell.removeAttribute('title');
    }
    const contrPremCell = tr.querySelector('.batch-c-contr-prem');
    if (contrPremCell) {
      // СП контрагента красным, если премия ≠ СС × тариф × ПК (допуск ±1 ₸).
      contrPremCell.classList.toggle('batch-cell--err', BatchAR._contrPremiumDiff(r));
      contrPremCell.classList.remove('batch-cell--warn');
    }
    // Подсветка расхождений: красный — точная ошибка (ошибочный ОКЭД/класс,
    // расхождение гос. участия); жёлтый — мягкое расхождение класса.
    const okedErr = BatchAR._okedError(r);
    const cDiff = BatchAR._classDiff(r);
    const classWrong = BatchAR._classWrongForOked(r);
    const gDiff = BatchAR._govDiff(r);
    const okedCell = tr.querySelector('.batch-c-oked');
    if (okedCell) okedCell.classList.toggle('batch-cell--err', okedErr);
    const classCell = tr.querySelector('.batch-c-class');
    if (classCell) {
      classCell.classList.toggle('batch-cell--err', classWrong || (cDiff && okedErr));
      classCell.classList.toggle('batch-cell--warn', cDiff && !okedErr && !classWrong);
    }
    tr.querySelector('.batch-c-gov')?.classList.toggle('batch-cell--err', gDiff);
    // ПК красным, если молодая компания (< порога) со скидкой.
    tr.querySelector('.batch-c-center')?.classList.toggle('batch-cell--err', BatchAR._pkYoungError(r));
    // СС: красным если СС < премии ИЛИ СС < ФОТ; премия: красным если СС < премии;
    // иначе жёлтым при расхождении с методологией. Красный приоритетнее жёлтого.
    const sumLtPrem = BatchAR._sumLtPremiumError(r);
    const sumLtFot = BatchAR._sumLtFotError(r);
    const premBelowMin = BatchAR._premiumBelowMinError(r);
    const insSumMis = BatchAR._insurerSumMismatch(r);
    const insPremMis = BatchAR._insurerPremMismatch(r);
    const sumErr = sumLtPrem || sumLtFot || premBelowMin || insSumMis;
    const sumCell = tr.querySelector('.batch-c-sum');
    if (sumCell) {
      sumCell.classList.toggle('batch-cell--err', sumErr);
      sumCell.classList.remove('batch-cell--warn');
      if (insSumMis) sumCell.title = 'СС страхователя ≠ сумме СС контрагентов (допуск ±1 ₸)';
      else if (sumLtFot) sumCell.title = 'Ошибка: страховая сумма меньше ФОТ (должна быть ≥ ФОТ)';
      else if (premBelowMin) sumCell.title = 'Премия меньше 1 МЗП (85 000) → СС должна быть = 85 000 / тариф';
      else if (sumLtPrem) sumCell.title = 'Ошибка: страховая сумма меньше страховой премии';
      else sumCell.removeAttribute('title');
    }
    const premCell = tr.querySelector('.batch-c-prem');
    if (premCell) {
      // СП страхователя красным — только агрегация (≠ Σ контр), пол МЗП, СС<СП. Жёлтого нет.
      const premErr = sumLtPrem || premBelowMin || insPremMis;
      premCell.classList.toggle('batch-cell--err', premErr);
      premCell.classList.remove('batch-cell--warn');
      if (insPremMis) premCell.title = 'СП страхователя ≠ сумме СП контрагентов';
      else if (premBelowMin) premCell.title = 'Премия меньше 1 МЗП (85 000) — должна быть ≥ 85 000';
      else if (sumLtPrem) premCell.title = 'Ошибка: страховая сумма меньше страховой премии';
      else premCell.removeAttribute('title');
    }
    // Невалидный ИИН/БИН Страхователя → красная ячейка Страхователя.
    const binStCell = tr.querySelector('.batch-c-insurer');
    if (binStCell) {
      const binStReason = BatchAR._insurerBinInvalidReason(r);
      binStCell.classList.toggle('batch-cell--err', !!binStReason);
      if (binStReason) binStCell.title = 'Некорректный ИИН/БИН Страхователя: ' + binStReason;
      else binStCell.removeAttribute('title');
    }
    // Класс строки: жизненный цикл (серый/синий/зелёный) + ошибка (красный/жёлтый) + согласование.
    tr.classList.remove('batch-row--err', 'batch-row--warn', 'batch-row--ok', 'batch-row--pending', 'batch-row--checking');
    const state = BatchAR._rowState(r);
    if (state) tr.classList.add('batch-row--' + state);
    tr.classList.toggle('batch-row--approved', !!r._approved);
    BatchAR._tableVersion++;
  },

  // ===== Проверка БИНов через stat.gov.kz =====
  // Генерация документов разрешена только после успешной проверки ВСЕХ БИН.
  // indices — подмножество для повторной проверки (по умолчанию все строки).
  async startStatgov(indices) {
    if (BatchAR._statgovRunning) return;
    const targets = indices && indices.length ? indices : BatchAR.rows.map((_, i) => i);

    // Нет моста к stat.gov.kz → генерация недоступна (по требованию: без
    // подключения документы не формируем).
    const markUnavailable = () => {
      BatchAR._statgovConnected = false;
      BatchAR._egovResidPhase = 'unavailable'; // моста нет → egov не будет, показываем локальный вердикт
      BatchAR._kycFinished = true;              // kyc тоже не побежит → дата рег. финальна (без ⏳)
      targets.forEach(i => { BatchAR.rows[i].statgovStatus = 'skip'; BatchAR._refreshRow(i); });
      BatchAR._updateVerify();
      BatchAR._updateControls();
    };
    if (typeof StatGovClient === 'undefined') { markUnavailable(); return; }
    const ping = await StatGovClient.ping(1800).catch(() => ({ ok: false }));
    if (!ping.ok) { markUnavailable(); return; }

    BatchAR._statgovConnected = true;
    BatchAR._statgovPaused = false;
    BatchAR._egovResidPhase = 'pending';  // мост есть → egov проверит; до ответа ⏳
    BatchAR._kycFinished = false;         // дата рег. ещё может прийти из kyc → ⏳
    BatchAR._kycQueue = []; BatchAR._kycActive = 0; BatchAR._kycCacheP = new Map();
    targets.forEach(i => {
      BatchAR.rows[i].statgovStatus = 'pending';
      BatchAR.rows[i].egov = { status: 'loading' };
      BatchAR._refreshRow(i);
    });
    BatchAR._updateVerify();
    BatchAR._updateControls();

    // e-Qazyna — отдельный пул с высокой параллельностью (лёгкие fetch к воркеру),
    // в фоне. Гос. участие не гейтит генерацию, поэтому не ждём его здесь — чтобы
    // не тормозить основную проверку statgov.
    BatchAR._poolEgov(targets.slice());

    // Авторитетное резидентство через egov P30.11 — тоже отдельным фоновым пулом.
    // Не гейтит генерацию; уточняет локальный вердикт по мере ответов.
    BatchAR._poolEgovResidency(targets.slice());

    // Очередь и кэш statgov храним на объекте, чтобы «Продолжить» после паузы дочитал
    // ОСТАВШИЕСЯ БИН, а не начинал заново. Кэш по БИН дедуплицирует филиалы.
    BatchAR._sgQueue = targets.slice();
    BatchAR._sgCache = new Map();
    await BatchAR._runStatgovWorkers();
  },

  // Пул воркеров statgov по BatchAR._sgQueue. На паузе (_statgovPaused) воркер
  // дорабатывает текущий БИН и выходит; оставшиеся остаются в очереди (серые).
  // «Продолжить» вызывает этот метод снова — он дочитывает остаток очереди.
  async _runStatgovWorkers() {
    const sgQueue = BatchAR._sgQueue;
    const sgCache = BatchAR._sgCache;
    if (!sgQueue || !sgCache) return;
    BatchAR._statgovRunning = true;
    BatchAR._updateVerify();
    BatchAR._updateControls();
    // Лукап — по БИН СТРАХОВАТЕЛЯ (_insurerBin): ОКЭД/класс/гос.участие проверяем у
    // страхователя (головной организации). Для филиалов все строки — по головному БИН.
    const sgWorker = async () => {
      while (sgQueue.length) {
        if (BatchAR._statgovPaused) break;     // пауза — новые БИН не берём
        const i = sgQueue.shift();
        const r = BatchAR.rows[i];
        r.statgovStatus = 'loading';
        BatchAR._refreshRow(i);
        BatchAR._scheduleAggregate();
        try {
          const lbin = BatchAR._insurerBin(r);
          let p = sgCache.get(lbin);
          if (!p) { p = StatGovClient.lookup(lbin); sgCache.set(lbin, p); }
          const data = await p;
          r.statgov = data || {};
          r.statgovStatus = 'done';
          if (r.statgov.name && !r.statgov.error) r.insurerName = r.statgov.name;
          // ИП/часть ТОО: нет «Юридический адрес» → берём «Местонахождение».
          if (!r.statgov.error && !r.statgov.legalAddress) {
            r.statgov.legalAddress = Utils.statgovLegalAddress(r.statgov);
          }
          BatchAR._applyYoung(r);
          // Контрагент: лукап по БИНКонтрагента → его реальный ОКЭД → класс (для проверки
          // КлассРискаКонтрагента). Если БИН контрагента = БИН страхователя — переиспользуем.
          const cbin = r.bin && String(r.bin).replace(/\s+/g, '');
          if (cbin && /^\d{12}$/.test(cbin) && cbin !== lbin) {
            let pc = sgCache.get(cbin);
            if (!pc) { pc = StatGovClient.lookup(cbin); sgCache.set(cbin, pc); }
            try { r.statgovContr = (await pc) || {}; } catch (e2) { r.statgovContr = { error: (e2 && e2.message) || 'ошибка' }; }
          } else {
            r.statgovContr = r.statgov;
          }
        } catch (e) {
          r.statgov = { error: (e && e.message) || 'ошибка' };
          r.statgovStatus = 'error';
        }
        BatchAR._refreshRow(i);
        BatchAR._scheduleAggregate();
        // Строка закрылась в statgov без даты рег. → сразу в kyc-очередь,
        // ПАРАЛЛЕЛЬНО остальным statgov-лукапам (не ждём конца всего прохода).
        BatchAR._maybeQueueKyc(i);
      }
    };
    const n = Math.max(1, BatchAR.STATGOV_CONCURRENCY);
    await Promise.all(Array.from({ length: n }, sgWorker));
    BatchAR._statgovRunning = false;
    BatchAR._updateVerify();
    BatchAR._updateControls();
    // Весь statgov пройден (не пауза) → добираем kyc для оставшихся и проверяем,
    // не завершилась ли kyc-фаза (снять ⏳ с даты, где kyc не нужен/недоступен).
    if (!BatchAR._statgovPaused && !sgQueue.length) {
      BatchAR.rows.forEach((_, i) => BatchAR._maybeQueueKyc(i));
      BatchAR._maybeFinishKyc();
    }
  },

  // Пауза проверки stat.gov.kz: воркеры дорабатывают текущие БИН и останавливаются,
  // оставшиеся остаются «в очереди» (серые). Возобновление — resumeStatgov().
  pauseStatgov() {
    if (!BatchAR._statgovRunning || BatchAR._statgovPaused) return;
    BatchAR._statgovPaused = true;
    BatchAR._updateVerify();
    BatchAR._updateControls();
  },
  // Продолжить проверку с места остановки (дочитать BatchAR._sgQueue). Срабатывает,
  // когда воркеры уже вышли (текущие in-flight БИН доехали) — иначе клик игнорируется.
  resumeStatgov() {
    if (BatchAR._statgovRunning || !BatchAR._statgovPaused) return;
    BatchAR._statgovPaused = false;
    if (BatchAR._sgQueue && BatchAR._sgQueue.length) BatchAR._runStatgovWorkers();
    else { BatchAR._updateVerify(); BatchAR._updateControls(); }
  },
  togglePause() {
    if (BatchAR._statgovPaused) BatchAR.resumeStatgov();
    else BatchAR.pauseStatgov();
  },

  // ===== Fallback через kyc.kz (ПАРАЛЛЕЛЬНО statgov) =====
  // Для строк, где stat.gov.kz не вернул дату регистрации, тянем карточку с
  // kyc.kz (быстрый GET, без ЭЦП) — оттуда дата регистрации и адрес. Запросы
  // идут по мере готовности строк в statgov (не одним пулом в конце), с лимитом
  // KYC_CONCURRENCY и дедупом по БИН. Не гейтит генерацию.

  // Поставить строку в kyc-очередь, если после statgov у неё нет даты регистрации.
  _maybeQueueKyc(i) {
    const r = BatchAR.rows[i];
    if (!r || r.statgovStatus !== 'done') return;
    if (r.statgov && !r.statgov.error && r.statgov.registrationDate) return; // дата уже есть
    if (r._kycQueued || r.kycStatus === 'loading' || r.kycStatus === 'done') return;
    if (typeof StatGovClient === 'undefined' || !StatGovClient.lookupKyc) return;
    r._kycQueued = true;
    BatchAR._kycQueue.push(i);
    BatchAR._pumpKyc();
  },

  // Держим до KYC_CONCURRENCY kyc-запросов «в полёте», добирая из очереди.
  _pumpKyc() {
    if (!BatchAR._kycCacheP) BatchAR._kycCacheP = new Map();
    const cache = BatchAR._kycCacheP;
    const limit = Math.max(1, BatchAR.KYC_CONCURRENCY);
    while (BatchAR._kycActive < limit && BatchAR._kycQueue.length) {
      const i = BatchAR._kycQueue.shift();
      const r = BatchAR.rows[i];
      if (!r) continue;
      BatchAR._kycActive++;
      r.kycStatus = 'loading';
      BatchAR._refreshRow(i);
      (async () => {
        try {
          const lbin = BatchAR._insurerBin(r);
          let p = cache.get(lbin);
          if (!p) { p = StatGovClient.lookupKyc(lbin); cache.set(lbin, p); }
          const data = await p;
          r.kyc = data || {};
          r.kycStatus = 'done';
          if (r.kyc.found !== false && r.kyc.name && !(r.statgov && r.statgov.name)) {
            r.insurerName = r.kyc.name;   // kyc-имя — только если у stat.gov имени не было
          }
          BatchAR._applyYoung(r);
        } catch (e) {
          r.kyc = { error: (e && e.message) || 'ошибка' };
          r.kycStatus = 'error';
        }
        BatchAR._kycActive--;
        BatchAR._refreshRow(i);
        BatchAR._pumpKyc();          // взять следующий из очереди
        BatchAR._maybeFinishKyc();   // всё дочитано? → снять ⏳ с даты
      })();
    }
  },

  // kyc-фаза завершена, когда statgov полностью пройден, очередь kyc пуста и нет
  // запросов «в полёте». Тогда снимаем ⏳ с даты (непокрытые падают на БИН-дату).
  _maybeFinishKyc() {
    const sgLeft = BatchAR._sgQueue && BatchAR._sgQueue.length;
    if (!BatchAR._statgovRunning && !sgLeft
        && !BatchAR._kycQueue.length && BatchAR._kycActive === 0
        && !BatchAR._kycFinished) {
      BatchAR._kycFinished = true;
      BatchAR.renderTable();
    }
  },

  // Объединяет частые агрегатные обновления UI (статус проверки, кнопка)
  // в одно на кадр — чтобы при всплеске параллельных ответов не было дёрганья.
  _scheduleAggregate() {
    if (BatchAR._aggregateScheduled) return;
    BatchAR._aggregateScheduled = true;
    requestAnimationFrame(() => {
      BatchAR._aggregateScheduled = false;
      BatchAR._updateVerify();
      BatchAR._updateControls();
    });
  },

  // Пул e-Qazyna: тянет гос. участие по всем БИНам параллельно (не гейтит генерацию).
  async _poolEgov(targets) {
    const queue = targets.slice();
    const egovCache = new Map(); // БИН Страхователя → Promise (дедуп филиалов)
    const worker = async () => {
      while (queue.length) {
        const i = queue.shift();
        const r = BatchAR.rows[i];
        try {
          const lbin = BatchAR._insurerBin(r);
          let p = egovCache.get(lbin);
          if (!p) { p = BatchAR._lookupEgov(lbin); egovCache.set(lbin, p); }
          r.egov = await p;
        } catch (e) {
          r.egov = { status: 'error', found: null, share: null };
        }
        BatchAR._refreshRow(i);
      }
    };
    const n = Math.max(1, BatchAR.EGOV_CONCURRENCY);
    await Promise.all(Array.from({ length: n }, worker));
  },

  // Пул АВТОРИТЕТНОГО резидентства через egov P30.11 (мост-расширение). Локальный
  // индекс ГБД ЮЛ даёт мгновенный вердикт в каждой ячейке при рендере; этот пул в
  // фоне уточняет его egov'ом (источник актуальнее — видит свежие регистрации) и
  // перерисовывает строки по мере ответов. Наполняет общий кэш
  // ResidentCheck.egovResolved (его же читает _residVerdict). Не гейтит генерацию.
  // ИИН пропускаются (эндпоинт P30.11 — только для БИН юрлиц; checkEgov сам это
  // проверяет). Дедуп по БИН: страхователь и филиалы с одним БИН — один запрос.
  async _poolEgovResidency(targets) {
    if (typeof ResidentCheck === 'undefined'
        || !ResidentCheck.bridgeAvailable || !ResidentCheck.bridgeAvailable()) {
      // Нет моста/сессии egov → проверку НЕ делаем вовсе, в колонке «отключен».
      BatchAR._egovResidPhase = 'unavailable';
      BatchAR.renderTable();
      return;
    }
    // Уникальные БИН СТРАХОВАТЕЛЯ (единственная колонка резидентства) → строки,
    // которые их используют (для точечной перерисовки).
    const binRows = new Map();
    const isBin = (b) => ResidentCheck.idKind && ResidentCheck.idKind(b) === 'bin';
    for (const i of targets) {
      const r = BatchAR.rows[i];
      if (!r) continue;
      const bin = BatchAR._insurerBin(r);
      if (!isBin(bin)) continue;                       // ИИН/некорректные — не в egov
      if (ResidentCheck.egovResolved(bin)) continue;   // уже получен — не перезапрашиваем
      if (!binRows.has(bin)) binRows.set(bin, new Set());
      binRows.get(bin).add(i);
    }
    const queue = [...binRows.keys()];
    const worker = async () => {
      while (queue.length) {
        const bin = queue.shift();
        await ResidentCheck.checkEgov(bin).catch(() => null);  // наполняет egovResolved
        const rows = binRows.get(bin);
        if (rows) rows.forEach((i) => BatchAR._refreshRow(i));
      }
    };
    const n = Math.max(1, BatchAR.EGOV_RESID_CONCURRENCY);
    await Promise.all(Array.from({ length: n }, worker));
    // Пул отработал: те БИН, что egov не смог подтвердить (сессия egov мертва и
    // т.п.), больше не «⏳» — показываем локальный вердикт. Перерисуем страницу.
    BatchAR._egovResidPhase = 'done';
    BatchAR.renderTable();
  },

  // Повторить проверку для непройденных (error/skip/pending) БИН.
  retryStatgov() {
    if (BatchAR._statgovRunning) return;
    const idx = BatchAR.rows
      .map((r, i) => (r.statgovStatus !== 'done' ? i : -1))
      .filter(i => i >= 0);
    if (!idx.length) return;
    BatchAR.startStatgov(idx);
  },

  // Готовность к генерации: соединение есть и ВСЕ БИН успешно проверены.
  _verifyComplete() {
    return BatchAR.rows.length > 0
      && BatchAR._statgovConnected
      && BatchAR.rows.every(r => r.statgovStatus === 'done');
  },

  _verifyCounts() {
    let done = 0, err = 0, pending = 0;
    for (const r of BatchAR.rows) {
      if (r.statgovStatus === 'done') done++;
      else if (r.statgovStatus === 'error') err++;
      else pending++; // pending | loading | skip
    }
    return { done, err, pending, total: BatchAR.rows.length };
  },

  // Полоса/строка статуса проверки stat.gov.kz над кнопкой генерации.
  _updateVerify() {
    const box = document.getElementById('batch-verify');
    const txt = document.getElementById('batch-verify-text');
    const retry = document.getElementById('batch-verify-retry');
    if (!box || !txt || !retry) return;
    if (!BatchAR.rows.length) { box.style.display = 'none'; return; }
    box.style.display = '';
    const { done, err, total } = BatchAR._verifyCounts();

    if (!BatchAR._statgovConnected) {
      box.className = 'batch-verify batch-verify--err';
      txt.innerHTML = '✕ Нет подключения к stat.gov.kz — генерация недоступна. Активируйте расширение-мост «Standard Life — мост к stat.gov.kz» и повторите проверку.';
      retry.style.display = '';
      retry.disabled = false;
      return;
    }
    if (BatchAR._statgovPaused) {
      box.className = 'batch-verify batch-verify--warn';
      const drain = BatchAR._statgovRunning ? ' (останавливаю текущие…)' : '';
      txt.innerHTML = `⏸ Проверка приостановлена: <b>${done}</b> из <b>${total}</b>${drain}. Нажмите «Продолжить», чтобы возобновить.`;
      retry.style.display = 'none';
      return;
    }
    if (BatchAR._statgovRunning) {
      box.className = 'batch-verify batch-verify--load';
      txt.innerHTML = `⏳ Проверка stat.gov.kz: <b>${done}</b> из <b>${total}</b>… Кнопка генерации станет доступна, когда все БИН пройдут проверку.`;
      retry.style.display = 'none';
      return;
    }
    if (err > 0) {
      box.className = 'batch-verify batch-verify--warn';
      txt.innerHTML = `⚠ Проверено: <b>${done}</b> из <b>${total}</b>. Не пройдено: <b>${err}</b>. Генерация станет доступна после успешной проверки всех БИН.`;
      retry.style.display = '';
      retry.disabled = false;
    } else {
      box.className = 'batch-verify batch-verify--ok';
      txt.innerHTML = `✓ Все <b>${total}</b> БИН проверены через stat.gov.kz — можно генерировать.`;
      retry.style.display = 'none';
    }
  },

  // ===== Сборка одной формы в .docx (Blob) =====
  _genBlob(row) {
    return ARForm.buildDocx(row, { printAlert: false });
  },

  // Номер договора → безопасный кусок имени файла. Слеши (в номерах договоров
  // они встречаются: «T04/290526/0002») заменяем на ДЕФИС, а не на «_»: так
  // читается ближе к оригиналу, и внутри ZIP «/» не создаёт лишнюю папку.
  // Остальные запрещённые в именах файлов символы → «_».
  _safeName(s) {
    return String(s == null ? '' : s)
      .replace(/[\\/]/g, '-')
      .replace(/[:*?"<>|]/g, '_')
      .trim();
  },

  _fileName(contractNumber, taken) {
    const safe = BatchAR._safeName(contractNumber) || 'без_номера';
    const base = `АР ${safe}`;
    let name = `${base}.docx`;
    if (taken) {
      let k = 2;
      while (taken.has(name)) { name = `${base} (${k}).docx`; k++; }
      taken.add(name);
    }
    return name;
  },

  // Группировка строк по номеру договора: один документ АР на договор.
  // Несколько строк одного договора = филиалы (Map сохраняет порядок встречи).
  _groupByContract() {
    const groups = new Map();
    BatchAR.rows.forEach((r, i) => {
      const key = r.contractNumber || `__no_${r.bin}_${i}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });
    return groups;
  },

  _contractCount() {
    return BatchAR._groupByContract().size;
  },

  // Договор «красный» — хотя бы одна строка с грубой ошибкой (_rowLevel==='err').
  // Такие договоры не печатаем (для красных полей печать не делаем).
  _groupHasError(group) {
    return group.some(r => BatchAR._rowLevel(r) === 'err');
  },
  // Уровень договора: 'err' (есть красная строка) > 'warn' (есть жёлтая, красных нет) > null.
  _groupLevel(group) {
    let warn = false;
    for (const r of group) {
      const l = BatchAR._rowLevel(r);
      if (l === 'err') return 'err';
      if (l === 'warn') warn = true;
    }
    return warn ? 'warn' : null;
  },
  _errorContractCount() {
    let n = 0;
    for (const [, g] of BatchAR._groupByContract()) if (BatchAR._groupLevel(g) === 'err') n++;
    return n;
  },
  _warnContractCount() {
    let n = 0;
    for (const [, g] of BatchAR._groupByContract()) if (BatchAR._groupLevel(g) === 'warn') n++;
    return n;
  },

  // Договор превышает лимиты АС: класс 1–15 и СС свыше 2 млрд, либо
  // класс 16–22 и СС свыше 1,5 млрд (СС = сумма по всем филиалам договора).
  // Класс берём ВЫЧИСЛЕННЫЙ по ОКЭД из stat.gov.kz (а не из выгрузки); макс. по
  // филиалам. Если вычислить нельзя (нет классификатора/ОКЭД) — fallback на выгрузку.
  _exceedsAsLimit(group) {
    // СС договора — это ОбщаяСтраховаяСумма (одинакова во всех строках договора),
    // поэтому берём её ОДИН раз (max), а не суммируем по филиалам.
    const totalSum = Math.max(0, ...group.map(r => Number(r.insuranceSumTotal) || 0));
    // Класс — из ИСХОДНОЙ выгрузки (КлассПрофРиска), а НЕ вычисленный по stat.gov.kz:
    // превышение лимитов АС определяем по данным самой таблицы-источника.
    const cls = Math.max(0, ...group.map(r => parseInt(r.riskClass, 10) || 0));
    const low1_15 = (typeof App !== 'undefined' && App._getLimit) ? App._getLimit('limitAsLowCls1_15') : 2000000000;
    const low16_22 = (typeof App !== 'undefined' && App._getLimit) ? App._getLimit('limitAsLowCls16_22') : 1500000000;
    if (cls >= 1 && cls <= 15 && totalSum > low1_15) return true;
    if (cls >= 16 && cls <= 22 && totalSum > low16_22) return true;
    return false;
  },

  // xlsx-список договоров, превысивших лимиты АС, в ИСХОДНОМ формате выгрузки:
  // тот же заголовок и те же строки (все филиалы), что в загруженном файле.
  // Возвращает ArrayBuffer.
  _buildOverLimitXlsx(groups, sheetName) {
    const header = (BatchAR._rawHeader && BatchAR._rawHeader.length) ? BatchAR._rawHeader : [];
    const aoa = [header];
    for (const [, group] of groups) {
      for (const r of group) {
        if (r._raw) aoa.push(r._raw);
      }
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    // Имя листа в Excel — максимум 31 символ.
    XLSX.utils.book_append_sheet(wb, ws, String(sheetName || 'Превышение лимитов АС').slice(0, 31));
    return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  },

  // Поля строки, подлежащие подсветке в выгрузке ошибок, с цветом заливки:
  // красный (FFC7CE) — грубая ошибка; жёлтый (FFEB9C) — мягкое расхождение класса.
  // Зеркалит подсветку таблицы: красим колонки выгрузки по типу ошибки/расхождения.
  // СС/премию красим в колонках ОбщаяСтраховаяСумма/ОбщаяСтраховаяПремия (по ним проверяем).
  _erroredCells(r) {
    const RED = 'FFC7CE', YEL = 'FFEB9C';
    const out = [];
    const okedErr = BatchAR._okedError(r);
    // СС страхователя (ОбщаяСтраховаяСумма) — красным (допуск ±1 ₸): ≠ Σ контр, < ФОТ, < премии, премия < МЗП.
    if (BatchAR._sumLtFotError(r) || BatchAR._sumLtPremiumError(r) || BatchAR._premiumBelowMinError(r) || BatchAR._insurerSumMismatch(r)) out.push(['insuranceSumTotal', RED]);
    // СП страхователя (ОбщаяСтраховаяПремия) — красным: ≠ Σ контр, база < 1 МЗП, СС < СП.
    if (BatchAR._sumLtPremiumError(r) || BatchAR._premiumBelowMinError(r) || BatchAR._insurerPremMismatch(r)) out.push(['premiumTotal', RED]);
    // СС контрагента (СтраховаяСумма) — красным: < ФОТ или (при премии < 1 МЗП) ≠ ФОТ.
    if (BatchAR._contrSumLtFotError(r) || BatchAR._contrSumDiff(r)) out.push(['insuranceSum', RED]);
    // Тариф контрагента (СтраховойТариф) — красным при несоответствии класса по справочнику.
    if (BatchAR._contrTariffClassError(r)) out.push(['tariffExport', RED]);
    // Класс контрагента (КлассРискаКонтрагента) — красным, если не совпал с реальным по ОКЭД
    // из stat.gov.kz ИЛИ с тарифом по справочнику; жёлтым — если есть среди ОКЭД, но не макс.
    if (BatchAR._contrClassWrongByBin(r) || BatchAR._contrTariffClassError(r)) out.push(['riskClassContragent', RED]);
    else if (BatchAR._contrClassDiffByBin(r)) out.push(['riskClassContragent', YEL]);
    // СП контрагента (СтраховаяПремия) — красным при расхождении с СС×тариф×ПК (допуск ±1 ₸).
    if (BatchAR._contrPremiumDiff(r)) out.push(['premiumWith', RED]);
    if (BatchAR._pkYoungError(r)) out.push(['coeff', RED]);
    if (BatchAR._insurerBinInvalidReason(r)) out.push(['binInsurer', RED]);
    if (BatchAR._binInvalidReason(r)) out.push(['bin', RED]);
    if (okedErr) out.push(['oked', RED]);
    if (BatchAR._classWrongForOked(r) || (okedErr && BatchAR._classDiff(r))) out.push(['riskClass', RED]);
    else if (BatchAR._classDiff(r)) out.push(['riskClass', YEL]);
    if (BatchAR._govDiff(r)) out.push(['govParticip', RED]);
    // Расхождение резидентства «выгрузка ↔ egov» — подсветить страну в выгрузке.
    if (BatchAR._residRegDiff(r)) out.push(['residencyCountry', RED]);
    return out;
  },

  // xlsx красных строк в ИСХОДНОМ формате выгрузки с ЗАЛИВКОЙ ошибочных ячеек.
  // XLSX CE заливки не пишет — используем ExcelJS. Возвращает ArrayBuffer.
  async _buildErroredXlsxStyled(errored, sheetName) {
    await BatchAR._ensureExcelJS();
    const ExcelLib = window.ExcelJS;
    const wb = new ExcelLib.Workbook();
    const ws = wb.addWorksheet(String(sheetName || 'С ошибками').slice(0, 31));
    const header = (BatchAR._rawHeader && BatchAR._rawHeader.length) ? BatchAR._rawHeader : [];
    ws.addRow(header.map(h => (h == null ? '' : h)));
    // Карта поле→колонка: из загрузки, иначе восстанавливаем из заголовка (страховка,
    // чтобы подсветка ячеек работала даже если _fieldIdx не сохранился).
    let idx = BatchAR._fieldIdx;
    if ((!idx || !Object.keys(idx).length) && typeof BatchReader !== 'undefined' && BatchReader.resolveIdx) {
      idx = BatchReader.resolveIdx(header);
    }
    idx = idx || {};
    let rowNum = 1; // строка 1 — заголовок
    // Сортировка по Менеджеру (А→Я); договоры (филиалы) остаются вместе (по первой строке).
    const sorted = [...errored].sort((a, b) => {
      const an = String((a[1][0] && a[1][0].author) || '').toLowerCase();
      const bn = String((b[1][0] && b[1][0].author) || '').toLowerCase();
      return an.localeCompare(bn, 'ru');
    });
    for (const [, group] of sorted) {
      for (const r of group) {
        rowNum++;
        const raw = Array.isArray(r._raw) ? r._raw.map(v => (v === undefined ? null : v)) : [];
        ws.addRow(raw);
        for (const [field, color] of BatchAR._erroredCells(r)) {
          const ci = idx[field];
          if (ci == null || ci < 0) continue;
          ws.getCell(rowNum, ci + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + color } };
        }
      }
    }
    // Автофильтр на всю таблицу (фильтр/сортировка по Менеджеру и др. колонкам).
    const lastCol = Math.max(header.length, 1);
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(rowNum, 1), column: lastCol } };
    // Автоширина по содержимому: Менеджер (U) и L,M,N,Q,R,S.
    const colNum = (L) => L.charCodeAt(0) - 64; // 'A'→1
    for (const cn of ['L', 'M', 'N', 'Q', 'R', 'S', 'U'].map(colNum)) {
      if (cn > lastCol) continue;
      let maxLen = 6;
      ws.getColumn(cn).eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value == null ? '' : String(cell.value);
        if (v.length > maxLen) maxLen = v.length;
      });
      ws.getColumn(cn).width = Math.min(maxLen + 2, 60);
    }
    return wb.xlsx.writeBuffer();
  },

  // Кнопка «Выгрузить некорректные»: отдельный xlsx со всеми красными строками
  // (договоры с грубой ошибкой) и подсвеченными ячейками — для правки и повторной загрузки.
  async exportErrors(btn) {
    if (!BatchAR.rows.length) { App.showMsg && App.showMsg('Сначала загрузите реестр договоров.', 'error'); return; }
    const errored = [...BatchAR._groupByContract().entries()].filter(([, g]) => BatchAR._groupHasError(g));
    if (!errored.length) { App.showMsg && App.showMsg('Строк с ошибками нет — выгружать нечего.', 'success'); return; }
    const nRows = errored.reduce((a, [, g]) => a + g.length, 0);
    const prev = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Подготовка…'; }
    try {
      const buf = await BatchAR._buildErroredXlsxStyled(errored);
      const t = new Date();
      const stamp = `${String(t.getDate()).padStart(2, '0')}.${String(t.getMonth() + 1).padStart(2, '0')}.${t.getFullYear()}`;
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      saveAs(blob, `Некорректные строки ${stamp} (${nRows}).xlsx`);
      App.showMsg && App.showMsg(`Выгружено строк с ошибками: ${nRows}. Исправьте подсвеченные ячейки и загрузите файл заново как реестр.`, 'success');
    } catch (e) {
      console.error('export errors', e);
      App.showMsg && App.showMsg('Ошибка выгрузки некорректных строк: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = prev; }
    }
  },

  // Кнопка «Выгрузить расхождения (жёлтые)»: отдельный xlsx с договорами, где есть жёлтые
  // расхождения (класс/расчёт), но НЕТ красных ошибок. Ячейки подсвечены (жёлтым/красным).
  async exportWarnings(btn) {
    if (!BatchAR.rows.length) { App.showMsg && App.showMsg('Сначала загрузите реестр договоров.', 'error'); return; }
    const warned = [...BatchAR._groupByContract().entries()].filter(([, g]) => BatchAR._groupLevel(g) === 'warn');
    if (!warned.length) { App.showMsg && App.showMsg('Жёлтых расхождений нет — выгружать нечего.', 'success'); return; }
    const nRows = warned.reduce((a, [, g]) => a + g.length, 0);
    const prev = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Подготовка…'; }
    try {
      const buf = await BatchAR._buildErroredXlsxStyled(warned, 'С расхождениями');
      const t = new Date();
      const stamp = `${String(t.getDate()).padStart(2, '0')}.${String(t.getMonth() + 1).padStart(2, '0')}.${t.getFullYear()}`;
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      saveAs(blob, `Жёлтые расхождения ${stamp} (${nRows}).xlsx`);
      App.showMsg && App.showMsg(`Выгружено строк с расхождениями (жёлтые): ${nRows}.`, 'success');
    } catch (e) {
      console.error('export warnings', e);
      App.showMsg && App.showMsg('Ошибка выгрузки расхождений: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = prev; }
    }
  },

  // Сводные счётчики для шапки HTML-отчёта: статусы строк + резидентство сторон.
  _resultCounts() {
    let ok = 0, warn = 0, err = 0, checking = 0, pending = 0, approved = 0, unchecked = 0;
    // Резидентство Страхователя (единственная колонка) + расхождения с egov.
    let nrS = 0, ipS = 0, residDiff = 0;
    for (const r of BatchAR.rows) {
      if (r._approved) approved++;
      else {
        const s = BatchAR._rowState(r);
        if (s === 'err') err++;
        else if (s === 'warn') warn++;
        else if (s === 'checking') checking++;
        else if (s === 'ok') ok++;
        else { const st = r.statgovStatus; if (st === 'skip' || st === 'error') unchecked++; else pending++; }
      }
      const sS = BatchAR._residEffStatus(r);
      if (sS === 'nonresident') nrS++; else if (sS === 'individual') ipS++;
      if (BatchAR._residRegDiff(r)) residDiff++;
    }
    return { total: BatchAR.rows.length, ok, warn, err, checking, pending, approved, unchecked,
      nrS, ipS, residDiff, egovOff: BatchAR._egovResidPhase === 'unavailable' };
  },

  // Кнопка «Скачать результаты проверки (HTML)»: единый самодостаточный HTML со
  // ВСЕМИ строками (не только текущая страница пагинации), сводкой, легендой и
  // цветовой разметкой — открывается в браузере, печатается в PDF. Проверка
  // stat.gov.kz НЕ требуется (резидентство/расчёты/подсветка уже в таблице).
  async downloadResults(btn) {
    if (!BatchAR.rows.length) { App.showMsg && App.showMsg('Сначала загрузите реестр договоров.', 'error'); return; }
    const prev = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Готовлю HTML…'; }
    try {
      // 1. В отчёт идут ВСЕ строки, а в живой таблице их только часть (порции по
      //    прокрутке). Поэтому собираем разметку из данных в строку и парсим её
      //    отдельно — живой DOM не трогаем (иначе вкладка виснет на 16 тыс. строк).
      const wrap = document.getElementById('batch-table-wrap');
      const table = wrap ? wrap.querySelector('table') : null;
      const allRows = BatchAR._rowsHtml(BatchAR._displayOrder());
      const tmp = document.createElement('div');
      tmp.innerHTML = table
        ? table.outerHTML.replace(/<tbody[^>]*>[\s\S]*?<\/tbody>/, `<tbody>${allRows}</tbody>`)
        : '';
      // Статичный отчёт: галочку «Согласовано» → текст ✓/—, снять все обработчики.
      tmp.querySelectorAll('.batch-c-approve').forEach((td) => {
        const cb = td.querySelector('input[type="checkbox"]');
        td.innerHTML = (cb && cb.checked) ? '<span style="color:#16a34a;font-weight:700">✓</span>' : '—';
      });
      tmp.querySelectorAll('[onclick]').forEach((el) => el.removeAttribute('onclick'));
      tmp.querySelectorAll('[oninput]').forEach((el) => el.removeAttribute('oninput'));
      tmp.querySelectorAll('input, button').forEach((el) => el.setAttribute('disabled', 'disabled'));
      const tableHtml = tmp.innerHTML;

      // 2. Собрать документ (инлайн CSS приложения) и скачать.
      const html = await BatchAR._buildResultsHtml(tableHtml);
      const t = new Date();
      const stamp = `${String(t.getDate()).padStart(2, '0')}.${String(t.getMonth() + 1).padStart(2, '0')}.${t.getFullYear()}`;
      const blob = new Blob(['﻿' + html], { type: 'text/html;charset=utf-8' });
      saveAs(blob, `Результаты проверки договоров ${stamp} (${BatchAR.rows.length}).html`);
      App.showMsg && App.showMsg(`Скачан HTML-отчёт по ${BatchAR.rows.length} строкам.`, 'success');
    } catch (e) {
      console.error('download results', e);
      App.showMsg && App.showMsg('Ошибка формирования HTML-отчёта: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = prev; }
    }
  },

  async _buildResultsHtml(tableHtml) {
    const esc = (s) => ARForm._esc(s == null ? '' : String(s));
    const c = BatchAR._resultCounts();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dt = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const src = BatchAR._sourceFileName ? esc(BatchAR._sourceFileName) : '—';
    const resDate = (typeof ResidentCheck !== 'undefined' && ResidentCheck.updatedText) ? ResidentCheck.updatedText() : '';
    const sortsActive = BatchAR._sorts.length
      ? BatchAR._SORT_DEFS.filter((d) => BatchAR._sorts.includes(d.key)).map((d) => d.on).join(', ')
      : 'как в файле';

    // CSS приложения — инлайним для точной вёрстки; при неудаче отчёт всё равно
    // читаем (базовые wrapper-стили ниже дают таблицу без цветов).
    let appCss = '';
    try { appCss = await (await fetch(new URL('css/style.css', location.href).href)).text(); } catch (e) { appCss = ''; }

    const chip = (label, val, color) => `<span class="rp-chip"><b style="color:${color}">${val}</b> ${esc(label)}</span>`;
    const notChecked = c.pending + c.checking + c.unchecked;
    const summary = [
      chip('всего', c.total, '#334155'),
      chip('корректных', c.ok, '#16a34a'),
      chip('расхождений', c.warn, '#d97706'),
      chip('ошибок', c.err, '#dc2626'),
      c.approved ? chip('согласовано андеррайтером', c.approved, '#2563eb') : '',
      notChecked ? chip('не проверено (stat.gov.kz)', notChecked, '#94a3b8') : '',
    ].filter(Boolean).join('');
    // Сводки «Резидентство» чипами в отчёте НЕТ: признак виден в самой колонке
    // «Резидент». Счётчики (c.nrS/c.ipS/c.residDiff) считаются в _resultCounts и
    // используются на экране.

    const legend = `
      <div class="rp-section-title">Обозначения</div>
      <div class="rp-legend">
        <span><i style="background:#fdcdcd"></i>красный — некорректные данные</span>
        <span><i style="background:#fde68a"></i>жёлтый — расхождения, нужна доп. проверка</span>
        <span><i style="background:#dcfce7"></i>зелёный — корректно</span>
        <span><i style="background:#e0e7ff"></i>синий — согласовано андеррайтером</span>
        <span class="rp-legend-res">Колонка «Резидент»: сверху — из выгрузки (<b>✓</b> Казахстан · <b>нерез.</b> иная страна · <b>отсутствует</b> — не указана), снизу в скобках — из реестра egov (<b>(✓)</b> резидент · <b>(нерез.)</b> нерезидент · <b>(ИП)</b> ИП/физлицо, не определяется · <b>(отключен)</b> нет связи с egov). Красная ячейка — расхождение выгрузки с egov.</span>
      </div>`;

    const wrapperCss = `
      body{margin:0;padding:24px;background:#fff;color:#0f172a;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
      .rp-head h1{font-size:1.18rem;margin:0 0 6px;color:#111827;}
      .rp-meta{color:#64748b;font-size:.85rem;line-height:1.6;}
      .rp-meta b{color:#334155;}
      .rp-section-title{font-size:.72rem;text-transform:uppercase;letter-spacing:.6px;color:#94a3b8;font-weight:700;margin:16px 0 7px;}
      .rp-summary{display:flex;flex-wrap:wrap;gap:8px;}
      .rp-chip{font-size:.82rem;border:1px solid #e2e8f0;border-radius:999px;padding:4px 12px;background:#fff;white-space:nowrap;}
      .rp-legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:.8rem;color:#475569;align-items:center;}
      .rp-legend i{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:middle;margin-right:5px;}
      .rp-legend-res{flex-basis:100%;color:#334155;}
      .rp-table{display:block!important;max-height:none!important;overflow:auto;border:1px solid #e5e7eb;border-radius:10px;margin-top:8px;}
      .rp-table table.batch-table{width:100%;}
      .rp-foot{color:#94a3b8;font-size:.76rem;margin-top:18px;border-top:1px solid #eef2f6;padding-top:10px;line-height:1.5;}
      @media print{@page{size:A4 landscape;margin:8mm;}body{padding:0;}.rp-table{border:none;overflow:visible;max-height:none!important;border-radius:0;}}`;

    return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">`
      + `<meta name="viewport" content="width=device-width, initial-scale=1">`
      + `<title>Результаты проверки договоров — ${dt}</title>`
      + `<style>${appCss}</style><style>${wrapperCss}</style></head><body>`
      + `<div class="rp-report">`
      + `<header class="rp-head"><h1>Результаты проверки договоров</h1>`
      + `<div class="rp-meta">Сформировано: <b>${dt}</b>${src !== '—' ? ` · файл-источник: <b>${src}</b>` : ''}`
      + `${resDate ? ` · база ГБД ЮЛ от <b>${esc(resDate)}</b>` : ''} · сортировка: <b>${esc(sortsActive)}</b></div></header>`
      + `<div class="rp-section-title">Сводка по строкам</div><div class="rp-summary">${summary}</div>`
      + legend
      + `<div class="rp-section-title">Все договоры (${c.total})</div>`
      + `<div class="batch-table-wrap rp-table">${tableHtml}</div>`
      + `<footer class="rp-foot">Отчёт сформирован приложением Underwriting Suite (Standard Life).</footer>`
      + `</div></body></html>`;
  },

  // Открыть таблицу-превью в отдельной вкладке — полная ширина окна, все строки.
  // Окно ЖИВОЕ: пока открыто, отражает актуальную таблицу (обновляется по мере
  // проверки stat.gov.kz), а не статический снимок на момент открытия.
  openInNewTab() {
    if (!BatchAR.rows.length) {
      App.showMsg && App.showMsg('Сначала загрузите реестр договоров.', 'error');
      return;
    }
    const wrap = document.getElementById('batch-table-wrap');
    if (!wrap) return;
    const cssHref = new URL('css/style.css', location.href).href;
    const win = window.open('', '_blank');
    if (!win) {
      App.showMsg && App.showMsg('Разрешите всплывающие окна, чтобы открыть таблицу в новой вкладке.', 'error');
      return;
    }
    win.document.write(
      '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Реестр договоров — просмотр</title>' +
      '<link rel="stylesheet" href="' + cssHref + '">' +
      '<style>body{margin:0;padding:24px;background:#fff;font-family:system-ui,-apple-system,sans-serif}' +
      'h1{font-size:1.05rem;margin:0 0 16px;color:#1f2937}' +
      '.batch-table-wrap{display:block!important;max-height:none!important;overflow:auto;border:1px solid #e5e7eb;border-radius:10px}</style>' +
      '</head><body><h1 id="batch-mirror-title"></h1>' +
      '<div class="batch-table-wrap" id="batch-mirror"></div></body></html>'
    );
    win.document.close();
    // Живое зеркало: копируем актуальную таблицу, пока окно открыто и таблица меняется.
    let lastVer = -1;
    const sync = () => {
      if (!win || win.closed) { clearInterval(timer); return; }
      if (BatchAR._tableVersion === lastVer) return;     // без изменений — не копируем
      lastVer = BatchAR._tableVersion;
      try {
        const title = win.document.getElementById('batch-mirror-title');
        const mirror = win.document.getElementById('batch-mirror');
        if (title) title.textContent = `Массовая генерация — реестр (${BatchAR.rows.length} строк)`;
        if (mirror) mirror.innerHTML = wrap.innerHTML;   // wrap.innerHTML = <table class="batch-table">…
      } catch (e) { clearInterval(timer); }
    };
    sync();
    const timer = setInterval(sync, 700);
  },

  // ===== Сгенерировать все → ZIP =====
  async generateAll(btn) {
    if (BatchAR._busy || !BatchAR.rows.length) return;
    if (!BatchAR._verifyComplete()) {
      App.showMsg && App.showMsg('Генерация недоступна: дождитесь проверки всех БИН через stat.gov.kz.', 'error');
      return;
    }
    BatchAR._busy = true;
    BatchAR._updateControls();
    const progress = document.getElementById('batch-progress');
    const bar = document.getElementById('batch-progress-bar');
    const txt = document.getElementById('batch-progress-text');
    if (progress) progress.style.display = 'block';
    try {
      await BatchAR._ensureZip();
      const zip = new window.JSZip();
      const taken = new Set();
      // Группируем по номеру договора: один документ АР на договор (филиалы — внутри).
      const groups = [...BatchAR._groupByContract().entries()];
      const errored = [];     // договоры с грубыми ошибками (красные) → НЕ печатаем
      const overLimit = [];   // договоры свыше лимитов АС → отдельная папка
      const toGenerate = [];  // остальные → стандартный АР
      for (const entry of groups) {
        if (BatchAR._groupHasError(entry[1])) errored.push(entry);
        else if (BatchAR._exceedsAsLimit(entry[1])) overLimit.push(entry);
        else toGenerate.push(entry);
      }
      const N = toGenerate.length;
      for (let i = 0; i < N; i++) {
        const [cn, group] = toGenerate[i];
        if (txt) txt.textContent = `Генерация ${i + 1} из ${N} — АР ${cn}`;
        if (bar) bar.style.width = Math.round((i / N) * 100) + '%';
        const blob = await ARForm.buildDocx(group[0], { printAlert: false, filials: group.slice(1) });
        // .docx уже сжат (zip) — храним без перекомпрессии (STORE) — быстрее.
        zip.file(BatchAR._fileName(cn, taken), blob, { compression: 'STORE' });
        // Изредка уступаем поток UI (каждые 10 документов)
        if (i % 10 === 9) await new Promise(r => setTimeout(r, 0));
      }
      // Договоры свыше лимитов АС — отдельная папка с отфильтрованным xlsx.
      if (overLimit.length) {
        const xlsxBuf = BatchAR._buildOverLimitXlsx(overLimit, 'Превышение лимитов АС');
        zip.file(`Превышение лимитов АС/Превышение лимитов АС (${overLimit.length}).xlsx`, xlsxBuf, { compression: 'STORE' });
      }
      // Договоры с ошибками (красные) — НЕ печатаем, выгружаем отдельной папкой,
      // чтобы было видно, что и почему исключено из печати.
      if (errored.length) {
        const xlsxBuf = await BatchAR._buildErroredXlsxStyled(errored, 'С ошибками');
        const nErrRows = errored.reduce((a, [, g]) => a + g.length, 0);
        zip.file(`С ошибками (не напечатано)/С ошибками (${nErrRows}).xlsx`, xlsxBuf, { compression: 'STORE' });
      }
      // Договоры с жёлтыми расхождениями — печатаются, но отдельно выгружаем для сверки.
      const warned = groups.filter(([, g]) => BatchAR._groupLevel(g) === 'warn');
      if (warned.length) {
        const xlsxBuf = await BatchAR._buildErroredXlsxStyled(warned, 'С расхождениями');
        const nWarnRows = warned.reduce((a, [, g]) => a + g.length, 0);
        zip.file(`С расхождениями (жёлтые)/С расхождениями (${nWarnRows}).xlsx`, xlsxBuf, { compression: 'STORE' });
      }
      if (txt) txt.textContent = 'Упаковка ZIP…';
      if (bar) bar.style.width = '100%';
      const out = await zip.generateAsync({ type: 'blob' });
      const today = new Date();
      const stamp = `${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}.${today.getFullYear()}`;
      saveAs(out, `АР пакет ${stamp} (${N}).zip`);
      const extras = [
        overLimit.length ? `${overLimit.length} на АС` : '',
        errored.length ? `${errored.length} с ошибками (не напечатано)` : '',
        warned.length ? `${warned.length} с расхождениями` : '',
      ].filter(Boolean).join(', ');
      if (txt) txt.textContent = `Готово: ${N} документов${extras ? ` + ${extras} (отдельные папки)` : ''}`;
    } catch (e) {
      console.error('Batch ZIP error:', e);
      if (txt) txt.textContent = 'Ошибка: ' + e.message;
      App.showMsg && App.showMsg('Ошибка пакетной генерации: ' + e.message, 'error');
    } finally {
      BatchAR._busy = false;
      BatchAR._updateControls();
      setTimeout(() => { if (progress) progress.style.display = 'none'; }, 2500);
    }
  },

  _updateControls() {
    // Блок «Печать рекомендаций ДАиП» живёт внизу этой же вкладки и работает по
    // тому же реестру — обновляем его счётчик/кнопку вместе с остальным UI.
    if (typeof DaipPrint !== 'undefined') DaipPrint.refresh();
    // Во время проверки stat.gov.kz (идёт/на паузе) вместо недоступной кнопки генерации
    // показываем кнопку Пауза/Продолжить.
    const inProgress = BatchAR._statgovRunning || BatchAR._statgovPaused;
    const btnPause = document.getElementById('batch-pause');
    if (btnPause) {
      btnPause.style.display = inProgress ? '' : 'none';
      const draining = BatchAR._statgovPaused && BatchAR._statgovRunning; // пауза нажата, in-flight доезжают
      if (BatchAR._statgovPaused) {
        btnPause.textContent = draining ? '⏸ Останавливаю…' : '▶ Продолжить';
        btnPause.disabled = draining;
        btnPause.classList.toggle('batch-pause--paused', !draining);
      } else {
        btnPause.textContent = '⏸ Пауза';
        btnPause.disabled = false;
        btnPause.classList.remove('batch-pause--paused');
      }
    }
    const btnAll = document.getElementById('batch-gen-all');
    if (btnAll) {
      btnAll.style.display = inProgress ? 'none' : '';   // прячем во время проверки — вместо неё «Пауза»
      const ready = BatchAR._verifyComplete();
      btnAll.disabled = BatchAR._busy || !ready;
      let label = 'Сгенерировать Рекомендации АР';
      if (BatchAR._busy) {
        label = 'Генерация…';
      } else if (BatchAR.rows.length && ready) {
        const errN = BatchAR._errorContractCount();
        const printable = BatchAR._contractCount() - errN;
        label = errN
          ? `Сгенерировать Рекомендации АР (${printable}, исключено ${errN})`
          : `Сгенерировать Рекомендации АР (${printable})`;
      } else if (BatchAR.rows.length && !ready) {
        label = 'Ожидание проверки stat.gov.kz…';
      }
      btnAll.textContent = label;
    }
    // Кнопка «Выгрузить некорректные» — видна, когда есть красные строки.
    const btnErr = document.getElementById('batch-export-errors');
    if (btnErr) {
      const errN = BatchAR.rows.length ? BatchAR._errorContractCount() : 0;
      btnErr.style.display = errN ? '' : 'none';
      btnErr.disabled = BatchAR._busy;
      btnErr.textContent = `Выгрузить некорректные (xlsx)${errN ? ` · ${errN}` : ''}`;
    }
    // Кнопка «Выгрузить расхождения (жёлтые)» — видна, когда есть жёлтые строки.
    const btnWarn = document.getElementById('batch-export-warns');
    if (btnWarn) {
      const warnN = BatchAR.rows.length ? BatchAR._warnContractCount() : 0;
      btnWarn.style.display = warnN ? '' : 'none';
      btnWarn.disabled = BatchAR._busy;
      btnWarn.textContent = `Выгрузить расхождения (жёлтые)${warnN ? ` · ${warnN}` : ''}`;
    }
    // Кнопка «Скачать результаты проверки (HTML)» — доступна всегда, когда есть
    // строки (проверка stat.gov.kz не требуется).
    const btnDl = document.getElementById('batch-download-html');
    if (btnDl) {
      btnDl.style.display = BatchAR.rows.length ? '' : 'none';
      btnDl.disabled = BatchAR._busy;
    }
    // Чипы мультисортировки (по столбцам) — перерисовываем состояние ↑/↓/приоритет.
    BatchAR._renderSortChips();
    const btnClear = document.getElementById('batch-clear');
    if (btnClear) btnClear.style.display = BatchAR.rows.length ? '' : 'none';
    BatchAR._updateStatusBar();
  },

  // Рендер кнопок сортировки «Сначала …» (под статус-баром). Каждая — вкл/выкл;
  // активная подсвечивается и меняет текст на «… сверху ✓».
  _renderSortChips() {
    const host = document.getElementById('batch-sort-chips');
    if (!host) return;
    if (!BatchAR.rows.length) { host.innerHTML = ''; host.style.display = 'none'; return; }
    host.style.display = '';
    host.innerHTML = BatchAR._SORT_DEFS.map((d) => {
      const on = BatchAR._sorts.includes(d.key);
      const text = on ? `${d.icon} ${d.on} ✓` : `${d.icon} ${d.off}`;
      return `<button type="button" class="batch-sort-btn batch-sort-btn--${d.key}${on ? ' is-active' : ''}" onclick="BatchAR.toggleSort('${d.key}')" title="${ARForm._esc(d.title)}">${text}</button>`;
    }).join('');
  },

  // Статус-бар: сводка по строкам реестра (по состоянию строки). Согласованные
  // считаем отдельно (они зелёные, но это решение андеррайтера, а не «чисто»).
  _updateStatusBar() {
    const bar = document.getElementById('batch-statusbar');
    if (!bar) return;
    if (!BatchAR.rows.length) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    let ok = 0, warn = 0, err = 0, checking = 0, pending = 0, approved = 0, unchecked = 0;
    for (const r of BatchAR.rows) {
      if (r._approved) { approved++; continue; }
      const s = BatchAR._rowState(r);
      if (s === 'err') err++;
      else if (s === 'warn') warn++;
      else if (s === 'checking') checking++;
      else if (s === 'ok') ok++;       // проверено через stat.gov.kz, ошибок нет
      else {                            // 'pending' (серый): различаем очередь и «не проверено»
        const st = r.statgovStatus;
        if (st === 'skip' || st === 'error') unchecked++;  // нет моста / ошибка проверки
        else pending++;                                     // только загружено (undefined) / в очереди
      }
    }
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    // Прогресс проверки: ПРОВЕРЕНО = строки с реальным вердиктом (корректна /
    // расхождение / ошибка / согласована андеррайтером). «Не проверено» (skip —
    // нет моста к stat.gov.kz, error — проверка упала) в прогресс НЕ идёт: иначе
    // при отсутствии расширения бар показывал 100% при нуле реально проверенных.
    const total = BatchAR.rows.length;
    const done = ok + warn + err + approved;
    const pct = total ? Math.floor((done / total) * 100) : 0;
    set('bs-done', done);
    set('bs-total', total);
    // 100% пишем только когда действительно все строки проверены (иначе floor
    // даёт «100%» уже на 29 016 из 29 017).
    set('bs-progress-pct', (done >= total && total > 0 ? 100 : Math.min(pct, 99)) + '%');
    const pbar = document.getElementById('bs-progress-bar');
    if (pbar) pbar.style.width = (total ? (done / total) * 100 : 0) + '%';
    const pwrap = document.getElementById('bs-progress-wrap');
    if (pwrap) {
      pwrap.classList.toggle('is-complete', total > 0 && done >= total);
      // Проверка закончилась, но часть строк осталась непроверенной — не зелёный.
      pwrap.classList.toggle('is-stalled', total > 0 && done < total && !checking && !pending);
      pwrap.title = unchecked
        ? `Проверено ${done} из ${total}. Не проверено: ${unchecked} (нет подключения к stat.gov.kz или ошибка проверки) — в прогресс не засчитываются.`
        : `Проверено ${done} из ${total} строк реестра`;
    }
    set('bs-ok', ok); set('bs-warn', warn); set('bs-err', err);
    set('bs-checking', checking); set('bs-pending', pending);
    set('bs-approved', approved); set('bs-unchecked', unchecked);
    // Скрываем нулевые «проверяется/в очереди/не проверено/согласовано» — чтобы бар не шумел.
    const toggle = (cls, n) => { const el = bar.querySelector('.' + cls); if (el) el.style.display = n ? '' : 'none'; };
    toggle('batch-stat--checking', checking);
    toggle('batch-stat--pending', pending);
    toggle('batch-stat--unchecked', unchecked);
    toggle('batch-stat--approved', approved);
  },

  async clear() {
    const ok = (typeof App !== 'undefined' && App.confirmDialog)
      ? await App.confirmDialog({ title: 'Очистить загруженный реестр?', text: 'Список договоров и сгенерированные данные будут сброшены.', confirmLabel: 'Очистить' })
      : confirm('Очистить реестр?');
    if (!ok) return;
    BatchAR.rows = [];
    BatchAR._statgovRunning = false;
    BatchAR._statgovPaused = false;
    BatchAR._sgQueue = null;
    BatchAR._statgovConnected = false;
    BatchAR._kycQueue = []; BatchAR._kycActive = 0; BatchAR._kycCacheP = null;
    BatchAR._kycFinished = false; BatchAR._egovResidPhase = 'idle';
    const zone = document.getElementById('zone-batch');
    if (zone) zone.classList.remove('loaded');
    const input = document.getElementById('batch-file-input');
    if (input) input.value = '';
    const statusEl = document.getElementById('batch-status');
    if (statusEl) statusEl.textContent = 'Файл не загружен';
    document.getElementById('batch-verify')?.setAttribute('style', 'display:none');
    BatchAR.renderTable();
    BatchAR._updateControls();
  },
};

if (typeof window !== 'undefined') window.BatchAR = BatchAR;
