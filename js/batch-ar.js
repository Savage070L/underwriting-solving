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
  _statgovConnected: false,   // подтверждено ли соединение с stat.gov.kz (ping ok)
  _tableVersion: 0,           // растёт при каждом изменении таблицы (для зеркала в новой вкладке)

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
      BatchAR._filialContracts = null;     // сбросить кэш филиалов (пересоберётся по новым строкам)
      BatchAR._fotByContract = null;       // сбросить кэш суммарного ФОТ по договорам
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

  // Порядок строк для отрисовки. По умолчанию — как в файле. Если включена сортировка
  // по ошибкам — сначала красные (err), потом жёлтые (warn), потом остальные.
  // Возвращает массив ОРИГИНАЛЬНЫХ индексов (data-idx и «#» остаются исходными).
  _displayOrder() {
    const idxs = BatchAR.rows.map((_, i) => i);
    if (!BatchAR._sortByError) return idxs;
    const rank = (r) => { const l = BatchAR._rowLevel(r); return l === 'err' ? 0 : (l === 'warn' ? 1 : 2); };
    return idxs.sort((a, b) => rank(BatchAR.rows[a]) - rank(BatchAR.rows[b])); // стабильно в совр. JS
  },
  toggleSortByError() {
    BatchAR._sortByError = !BatchAR._sortByError;
    BatchAR.renderTable();
    BatchAR._updateControls();
  },

  // ===== Превью-таблица =====
  renderTable() {
    const wrap = document.getElementById('batch-table-wrap');
    const tbody = document.getElementById('batch-tbody');
    const toolbar = document.getElementById('batch-toolbar');
    if (!wrap || !tbody) return;
    if (!BatchAR.rows.length) {
      wrap.style.display = 'none';
      if (toolbar) toolbar.style.display = 'none';
      tbody.innerHTML = '';
      return;
    }
    wrap.style.display = 'block';
    if (toolbar) toolbar.style.display = '';
    // Порядок столбцов: # · БИН · Страхователь · ОКЭД · Класс · Кол-во сотр. ·
    // ГФОТ · Страх. сумма · Страх. Премия (до ПК) · ПК · Премия с ПК ·
    // Дата рег. · Гос. участие.
    tbody.innerHTML = BatchAR._displayOrder().map((i) => {
      const r = BatchAR.rows[i];
      const okedErr = BatchAR._okedError(r);
      const cDiff = BatchAR._classDiff(r);
      const classWrong = BatchAR._classWrongForOked(r);
      const gDiff = BatchAR._govDiff(r);
      // ОКЭД ошибочный → красный. Класс: КРАСНЫЙ, если класс не соответствует своему
      // ОКЭД (грубая ошибка) или из-за ошибочного ОКЭД; иначе ЖЁЛТЫЙ при мягком
      // расхождении (выбран не максимальный класс). Гос. участие при расхождении → красный.
      const okedCls = okedErr ? ' batch-cell--err' : '';
      const classCls = (classWrong || (okedErr && cDiff)) ? ' batch-cell--err' : (cDiff ? ' batch-cell--warn' : '');
      const classTitle = classWrong ? ` title="Класс не соответствует ОКЭД: по классификатору ${ARForm._esc(r.oked)} → класс ${BatchAR._classOf(r.oked)}, а в выгрузке ${ARForm._esc(r.riskClass)}"` : '';
      const govCls = gDiff ? ' batch-cell--err' : '';
      // Молодая компания (< порога) со скидкой → ПК подсвечиваем красным.
      const pkCls = BatchAR._pkYoungError(r) ? ' batch-cell--err' : '';
      // СС < премии → красным (грубая ошибка); иначе жёлтым при расхождении с
      // расчётом по методологии. Красный приоритетнее жёлтого.
      const sumLtPrem = BatchAR._sumLtPremiumError(r);
      const sumLtFot = BatchAR._sumLtFotError(r);
      const premBelowMin = BatchAR._premiumBelowMinError(r);
      const sumDiff = BatchAR._sumDiff(r);
      const premDiff = BatchAR._premiumDiff(r);
      // Красный ОКЭД → класс/тариф неверны: если расчётная СС/СП расходится с выгрузкой —
      // красим СС/СП красным (а не жёлтым), т.к. суммы посчитаны по неверному ОКЭД.
      const sumCls = (sumLtPrem || sumLtFot || premBelowMin || (okedErr && sumDiff)) ? ' batch-cell--err' : (sumDiff ? ' batch-cell--warn' : '');
      const premCls = (sumLtPrem || premBelowMin || (okedErr && premDiff)) ? ' batch-cell--err' : (premDiff ? ' batch-cell--warn' : '');
      const sumTitle = sumLtFot ? ' title="Ошибка: страховая сумма меньше ФОТ (должна быть ≥ ФОТ)"'
        : (premBelowMin ? ' title="Премия меньше 1 МЗП (85 000) → СС должна быть = 85 000 / тариф"'
        : ((okedErr && sumDiff) ? ' title="ОКЭД неверный → класс/тариф неверны, СС не совпадает с расчётом"'
        : (sumLtPrem ? ' title="Ошибка: страховая сумма меньше страховой премии"' : '')));
      const premTitle = premBelowMin ? ' title="Премия меньше 1 МЗП (85 000) — должна быть ≥ 85 000"'
        : ((okedErr && premDiff) ? ' title="ОКЭД неверный → класс/тариф неверны, премия не совпадает с расчётом"'
        : (sumLtPrem ? ' title="Ошибка: страховая сумма меньше страховой премии"' : ''));
      const binStReason = BatchAR._insurerBinInvalidReason(r);
      const binStCls = binStReason ? ' batch-cell--err' : '';
      const binStTitle = binStReason ? ` title="Некорректный ИИН/БИН Страхователя: ${ARForm._esc(binStReason)}"` : '';
      const level = BatchAR._rowLevel(r);
      const rowCls = level ? ` class="batch-row--${level}"` : '';
      const nmSt = r.insurerNameSt || '';
      return `<tr data-idx="${i}"${rowCls}>
        <td class="batch-c-num">${i + 1}</td>
        <td class="batch-c-contract">${ARForm._esc(r.contractNumber || '—')}</td>
        <td class="batch-c-name-st" title="${ARForm._esc(nmSt)}">${nmSt ? ARForm._esc(nmSt) : '—'}</td>
        <td class="batch-c-bin-st${binStCls}"${binStTitle}>${r.binInsurer ? ARForm._esc(r.binInsurer) : '—'}</td>
        <td class="batch-c-oked${okedCls}">${BatchAR._okedCell(r)}</td>
        <td class="batch-c-class${classCls}"${classTitle}>${BatchAR._classCell(r)}</td>
        <td class="batch-c-num2">${ARForm._int(r.workers)}</td>
        <td class="batch-c-num2">${BatchAR._fmtMoney(r.gfot)}</td>
        <td class="batch-c-num2 batch-c-sum${sumCls}"${sumTitle}>${BatchAR._sumCellHtml(r)}</td>
        <td class="batch-c-num2 batch-c-prem${premCls}"${premTitle}>${BatchAR._premiumCellHtml(r)}</td>
        <td class="batch-c-center${pkCls}">${BatchAR._pkCell(r)}</td>
        <td class="batch-c-num2">${BatchAR._fmtMoney(r.premiumTotal)}</td>
        <td class="batch-c-reg">${BatchAR._regCell(r)}</td>
        <td class="batch-c-gov${govCls}">${BatchAR._govCell(r)}</td>
        <td class="batch-c-author" title="${ARForm._esc(r.author || '')}">${r.author ? ARForm._esc(r.author).replace(/\s+/g, '<br>') : '—'}</td>
      </tr>`;
    }).join('');
    BatchAR._tableVersion++;
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
  // Суммарный ФОТ по договору (филиалы = сумма по строкам; одиночный = ФОТ строки).
  _contractFotTotal(r) {
    if (!BatchAR._fotByContract) {
      const m = new Map();
      for (const x of BatchAR.rows) {
        const cn = x.contractNumber || '';
        if (!cn) continue;
        m.set(cn, (m.get(cn) || 0) + (Number(x.gfot) || 0));
      }
      BatchAR._fotByContract = m;
    }
    const v = BatchAR._fotByContract.get(r.contractNumber);
    return (v != null && v > 0) ? v : (Number(r.gfot) || 0);
  },
  // Тариф для проверки. Класс берём:
  //   • ОКЭД красный (кода нет в stat.gov.kz) → вычисленный (правильный) класс из stat.gov;
  //   • ОКЭД жёлтый (валиден, но класс не совпал) → класс ОКЭД ИЗ ВЫГРУЗКИ (как считали премию);
  //   • иначе → вычисленный (= выгрузка).
  // Тариф — из «Поправочных коэффициентов» по классу; если справочника нет — из выгрузки.
  _checkTariff(r) {
    let cls;
    if (BatchAR._okedError(r)) cls = BatchAR._computedClass(r);
    else if (BatchAR._classDiff(r)) cls = BatchAR._classOf(r.oked);
    else cls = BatchAR._computedClass(r);
    if (cls == null) cls = parseInt(r.riskClass, 10) || 0;
    const rr = (typeof App !== 'undefined' && App.refData && App.refData.popravka) ? App.refData.popravka.riskRates : null;
    if (rr && cls) { const t = rr.get(cls); if (Number.isFinite(t) && t > 0) return t; }
    return (r.tariff && r.tariff > 0) ? r.tariff : null;
  },
  // Ожидаемая премия ДО ПК (ИТОГ по договору) = max(ФОТ_дог × тариф, 1 МЗП).
  _expectedPremium(r) {
    const t = BatchAR._checkTariff(r);
    const fot = BatchAR._contractFotTotal(r);
    if (!(fot > 0) || !(t > 0)) return null;
    return Math.round(Math.max(fot * t, BatchAR._minPremium()) * 100) / 100;
  },
  // Ожидаемая СС (ИТОГ по договору) = max(ФОТ_дог, 1 МЗП / тариф).
  _expectedSum(r) {
    const t = BatchAR._checkTariff(r);
    const fot = BatchAR._contractFotTotal(r);
    if (!(fot > 0) || !(t > 0)) return null;
    return Math.max(fot, Math.round(BatchAR._minPremium() / t * 100) / 100);
  },
  // Относительное расхождение > 1% (и не меньше 1 ₸) — считаем значимым.
  _moneyDiff(a, b) {
    return a != null && b != null && Math.abs(a - b) > Math.max(1, 0.01 * Math.abs(b));
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
    return r.insuranceSumTotal != null && pb != null && Number(r.insuranceSumTotal) < pb;
  },

  // Грубая ошибка: СС (ИТОГ) < ФОТ (ИТОГ по договору). СС всегда должна быть ≥ ФОТ.
  _sumLtFotError(r) {
    const fot = BatchAR._contractFotTotal(r);
    return r.insuranceSumTotal != null && fot > 0 && Number(r.insuranceSumTotal) < fot;
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
    return pb != null && pb > 0 && pb < BatchAR._minPremium();
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

  // СС: сверху — из выгрузки, снизу в скобках — расчётная (премия/тариф).
  // СС: сверху — ОбщаяСтраховаяСумма (ИТОГ по договору), снизу — расчётная (max(ФОТ, 85к/тариф)).
  _sumCellHtml(r) {
    const top = BatchAR._fmtMoney(r.insuranceSumTotal);
    const exp = BatchAR._expectedSum(r);
    let bottom = '';
    if (exp != null) {
      const diff = BatchAR._sumDiff(r);
      const title = diff ? 'Расчётная СС (по ФОТ договора и тарифу) не совпадает с выгрузкой' : 'Расчётная СС (по ФОТ договора и тарифу)';
      bottom = `<span class="batch-sub ${diff ? 'batch-sub--warn' : ''}" title="${title}">(${BatchAR._fmtMoney(exp)})</span>`;
    }
    return `<div class="batch-stack"><span class="batch-stack-top">${top}</span>${bottom ? `<span class="batch-stack-bot">${bottom}</span>` : ''}</div>`;
  },
  // Премия (до ПК): сверху — ОбщаяСтраховаяПремия÷ПК (ИТОГ по договору, до ПК),
  // снизу — расчётная (ФОТ договора × тариф, мин. 85к).
  _premiumCellHtml(r) {
    const top = BatchAR._fmtMoney(BatchAR._premBaseTotal(r));
    const exp = BatchAR._expectedPremium(r);
    let bottom = '';
    if (exp != null) {
      const diff = BatchAR._premiumDiff(r);
      const title = diff ? 'Расчётная премия (ФОТ договора × тариф, мин. 85 000) не совпадает с выгрузкой' : 'Расчётная премия (ФОТ договора × тариф, мин. 85 000)';
      bottom = `<span class="batch-sub ${diff ? 'batch-sub--warn' : ''}" title="${title}">(${BatchAR._fmtMoney(exp)})</span>`;
    }
    return `<div class="batch-stack"><span class="batch-stack-top">${top}</span>${bottom ? `<span class="batch-stack-bot">${bottom}</span>` : ''}</div>`;
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

  // Расхождение класса: вычисленный по ОКЭД (макс.) ≠ класс из выгрузки.
  _classDiff(r) {
    const comp = BatchAR._computedClass(r);
    return comp != null && String(comp) !== String(r.riskClass || '').trim();
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

  // Уровень подсветки строки:
  //   'err'  (красный) — точная ошибка данных: ошибочный ОКЭД (→ ошибочный класс)
  //                      или расхождение гос. участия;
  //   'warn' (жёлтый)  — мягкое расхождение класса: ОКЭД подтверждён, но класс
  //                      не совпал (у компании несколько ОКЭД, выбран не тот);
  //   null             — расхождений нет.
  _rowLevel(r) {
    if (BatchAR._okedError(r) || BatchAR._govDiff(r) || BatchAR._pkYoungError(r)
        || BatchAR._sumError(r) || BatchAR._premiumBelowMinError(r) || BatchAR._binInvalid(r)
        || BatchAR._insurerBinInvalidReason(r) || BatchAR._classWrongForOked(r)) return 'err';
    if (BatchAR._classDiff(r)) return 'warn';
    return null;
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

  // Классы по каждому ОКЭД (в порядке _okedList).
  _computedClasses(r) {
    return BatchAR._okedList(r).map(o => BatchAR._classOf(o));
  },

  // Макс. класс среди ОКЭД — для определения расхождения с выгрузкой.
  _computedClass(r) {
    const list = BatchAR._computedClasses(r).filter(c => c != null);
    return list.length ? Math.max(...list) : null;
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
        const subCls = err ? 'batch-sub--err' : (diff ? 'batch-sub--warn' : '');
        const title = err
          ? 'Класс ошибочный: ОКЭД из выгрузки отсутствует у компании по stat.gov.kz'
          : (diff ? 'Макс. класс по ОКЭД не совпадает с выгрузкой — выбран не тот ОКЭД из нескольких' : 'классы по каждому ОКЭД');
        bottom = `<span class="batch-sub ${subCls}" title="${title}">(${classes.join(', ')})</span>`;
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

  // Пересчитать возраст/флаг «моложе порога».
  // Дата основания = САМАЯ РАННЯЯ (старшая) из доступных:
  //   • дата регистрации из stat.gov.kz / kyc.kz;
  //   • дата из первых 4 цифр БИН Страхователя (ГГ ММ) — учитывает перерегистрацию:
  //     если в stat.gov.kz дата моложе 3 лет (перерегистрация), но БИН начинается с
  //     «22…», компания основана в 2022 г. и моложе 3 лет НЕ считается.
  // Берём самую раннюю дату → компания не моложе этого. youngAlert — по порогу.
  _applyYoung(r) {
    const now = new Date();
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
    if (binDate && !isNaN(binDate) && binDate <= now) candidates.push(binDate);
    if (candidates.length) {
      const founding = candidates.reduce((a, b) => (a <= b ? a : b)); // самая ранняя
      const age = Utils.companyAgeYears(founding, now);
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
  _ageText(regRaw) {
    const reg = Utils.parseExcelDate(regRaw);
    if (!reg || isNaN(reg)) return null;
    const now = new Date();
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
      // Нет даты из реестров, но БИН Страхователя даёт дату основания — показываем её.
      if (binUsable) {
        const ds = ARForm._esc(Utils.fmtDateShort(binDate));
        let aRow = '';
        if (r.youngAlert) { const a = BatchAR._ageText(binDate); if (a) aRow = `<span class="batch-sub batch-young">(${ARForm._esc(a)})</span>`; }
        return `<div class="batch-stack"><span class="batch-stack-top batch-reg" title="дата основания из БИН Страхователя">${ds}<span class="batch-regsrc" title="из БИН Страхователя">БИН</span></span>${aRow ? `<span class="batch-stack-bot">${aRow}</span>` : ''}</div>`;
      }
      if (r.kycStatus === 'loading') return '<span class="batch-sg batch-sg--load">⏳ kyc.kz…</span>';
      return '<span class="batch-sg batch-sg--ok">✓ найдено (без даты)</span>';
    }
    const dateStr = ARForm._esc(Utils.fmtDateShort(eff.raw));
    const srcTitle = eff.source === 'kyc' ? 'дата из kyc.kz' : 'дата из stat.gov.kz';
    const srcMark = eff.source === 'kyc' ? '<span class="batch-regsrc" title="kyc.kz">kyc</span>' : '';
    // Дата сверху — из stat.gov.kz. Если в БИН Страхователя зашит ДРУГОЙ год/месяц
    // (перерегистрация) — показываем его снизу компактно как «(окт. 2016)», и только тогда.
    let binNote = '';
    if (binUsable) {
      const topD = Utils.parseCompanyRegDate ? Utils.parseCompanyRegDate(eff.raw) : null;
      const sameMonthYear = topD && !isNaN(topD)
        && topD.getFullYear() === binDate.getFullYear()
        && topD.getMonth() === binDate.getMonth();
      if (!sameMonthYear) {
        binNote = `<span class="batch-sub" title="В БИН Страхователя зашит другой год/месяц регистрации (перерегистрация)">(${ARForm._esc(BatchAR._monthYear(binDate))})</span>`;
      }
    }
    let ageRow = '';
    if (r.youngAlert) {
      const age = BatchAR._ageText(r._foundingDate || eff.raw);
      if (age) ageRow = `<span class="batch-sub batch-young">(${ARForm._esc(age)})</span>`;
    }
    const bottom = [binNote, ageRow].filter(Boolean).join(' ');
    return `<div class="batch-stack"><span class="batch-stack-top batch-reg" title="${srcTitle}">${dateStr}${srcMark}</span>${bottom ? `<span class="batch-stack-bot">${bottom}</span>` : ''}</div>`;
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

  // Обновить одну строку таблицы (после statgov / e-Qazyna), не перерисовывая всю.
  _refreshRow(i) {
    const tr = document.querySelector(`#batch-tbody tr[data-idx="${i}"]`);
    if (!tr) return;
    const r = BatchAR.rows[i];
    const set = (sel, html) => { const c = tr.querySelector(sel); if (c) c.innerHTML = html; };
    set('.batch-c-oked', BatchAR._okedCell(r));
    set('.batch-c-class', BatchAR._classCell(r));
    set('.batch-c-reg', BatchAR._regCell(r));
    set('.batch-c-gov', BatchAR._govCell(r));
    // СС/премия зависят от вычисленного класса/тарифа → обновляем после statgov.
    set('.batch-c-sum', BatchAR._sumCellHtml(r));
    set('.batch-c-prem', BatchAR._premiumCellHtml(r));
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
    const sumDiff = BatchAR._sumDiff(r);
    const premDiff = BatchAR._premiumDiff(r);
    const sumErr = sumLtPrem || sumLtFot || premBelowMin || (okedErr && sumDiff);
    const sumCell = tr.querySelector('.batch-c-sum');
    if (sumCell) {
      sumCell.classList.toggle('batch-cell--err', sumErr);
      sumCell.classList.toggle('batch-cell--warn', !sumErr && sumDiff);
      if (sumLtFot) sumCell.title = 'Ошибка: страховая сумма меньше ФОТ (должна быть ≥ ФОТ)';
      else if (premBelowMin) sumCell.title = 'Премия меньше 1 МЗП (85 000) → СС должна быть = 85 000 / тариф';
      else if (okedErr && sumDiff) sumCell.title = 'ОКЭД неверный → класс/тариф неверны, СС не совпадает с расчётом';
      else if (sumLtPrem) sumCell.title = 'Ошибка: страховая сумма меньше страховой премии';
      else sumCell.removeAttribute('title');
    }
    const premCell = tr.querySelector('.batch-c-prem');
    if (premCell) {
      const premErr = sumLtPrem || premBelowMin || (okedErr && premDiff);
      premCell.classList.toggle('batch-cell--err', premErr);
      premCell.classList.toggle('batch-cell--warn', !premErr && premDiff);
      if (premBelowMin) premCell.title = 'Премия меньше 1 МЗП (85 000) — должна быть ≥ 85 000';
      else if (okedErr && premDiff) premCell.title = 'ОКЭД неверный → класс/тариф неверны, премия не совпадает с расчётом';
      else if (sumLtPrem) premCell.title = 'Ошибка: страховая сумма меньше страховой премии';
      else premCell.removeAttribute('title');
    }
    // Невалидный ИИН/БИН Страхователя → красная ячейка БИН Страхователя.
    const binStCell = tr.querySelector('.batch-c-bin-st');
    if (binStCell) {
      const binStReason = BatchAR._insurerBinInvalidReason(r);
      binStCell.classList.toggle('batch-cell--err', !!binStReason);
      if (binStReason) binStCell.title = 'Некорректный ИИН/БИН Страхователя: ' + binStReason;
      else binStCell.removeAttribute('title');
    }
    const level = BatchAR._rowLevel(r);
    tr.classList.toggle('batch-row--err', level === 'err');
    tr.classList.toggle('batch-row--warn', level === 'warn');
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
      targets.forEach(i => { BatchAR.rows[i].statgovStatus = 'skip'; BatchAR._refreshRow(i); });
      BatchAR._updateVerify();
      BatchAR._updateControls();
    };
    if (typeof StatGovClient === 'undefined') { markUnavailable(); return; }
    const ping = await StatGovClient.ping(1800).catch(() => ({ ok: false }));
    if (!ping.ok) { markUnavailable(); return; }

    BatchAR._statgovConnected = true;
    BatchAR._statgovRunning = true;
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

    // statgov — гейтит генерацию. Лукап — обычные fetch (GET+POST), не вкладки,
    // поэтому гоним с заметной параллельностью.
    const sgQueue = targets.slice();
    // Лукап — по БИН СТРАХОВАТЕЛЯ (_insurerBin): ОКЭД/класс/гос.участие проверяем у
    // страхователя (головной организации). Для одиночных договоров БИН Страхователя =
    // БИН Контрагента (без изменений). Для филиалов — все строки проверяются по
    // головному БИН (ОКЭД выгрузки — это его деятельность). Кэш по БИН дедуплицирует филиалы.
    const sgCache = (BatchAR._sgCache = new Map());
    const sgWorker = async () => {
      while (sgQueue.length) {
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
        } catch (e) {
          r.statgov = { error: (e && e.message) || 'ошибка' };
          r.statgovStatus = 'error';
        }
        BatchAR._refreshRow(i);
        BatchAR._scheduleAggregate();
      }
    };
    const n = Math.max(1, BatchAR.STATGOV_CONCURRENCY);
    await Promise.all(Array.from({ length: n }, sgWorker));
    BatchAR._statgovRunning = false;
    BatchAR._updateVerify();
    BatchAR._updateControls();
    // Fallback дат регистрации/адреса через kyc.kz — для тех, у кого stat.gov не дал даты.
    BatchAR._fillMissingViaKyc();
  },

  // ===== Fallback через kyc.kz =====
  // Для строк, где stat.gov.kz не вернул дату регистрации, тянем карточку с
  // kyc.kz (быстрый GET, без ЭЦП) — берём оттуда дату регистрации и адрес.
  // Не гейтит генерацию; идёт в фоне после основного прохода statgov.
  async _fillMissingViaKyc() {
    if (BatchAR._kycRunning) return;
    if (typeof StatGovClient === 'undefined' || !StatGovClient.lookupKyc) return;
    const targets = BatchAR.rows
      .map((r, i) => i)
      .filter(i => {
        const r = BatchAR.rows[i];
        return r.statgovStatus === 'done'
          && !(r.statgov && !r.statgov.error && r.statgov.registrationDate)
          && r.kycStatus !== 'done';
      });
    if (!targets.length) return;
    BatchAR._kycRunning = true;
    const queue = targets.slice();
    const kycCache = new Map(); // БИН Страхователя → Promise (дедуп филиалов)
    const worker = async () => {
      while (queue.length) {
        const i = queue.shift();
        const r = BatchAR.rows[i];
        r.kycStatus = 'loading';
        BatchAR._refreshRow(i);
        try {
          const lbin = BatchAR._insurerBin(r);
          let p = kycCache.get(lbin);
          if (!p) { p = StatGovClient.lookupKyc(lbin); kycCache.set(lbin, p); }
          const data = await p;
          r.kyc = data || {};
          r.kycStatus = 'done';
          // kyc-имя — только если из stat.gov имени не было.
          if (r.kyc.found !== false && r.kyc.name && !(r.statgov && r.statgov.name)) {
            r.insurerName = r.kyc.name;
          }
          BatchAR._applyYoung(r);
        } catch (e) {
          r.kyc = { error: (e && e.message) || 'ошибка' };
          r.kycStatus = 'error';
        }
        BatchAR._refreshRow(i);
      }
    };
    const c = Math.max(1, BatchAR.KYC_CONCURRENCY);
    await Promise.all(Array.from({ length: c }, worker));
    BatchAR._kycRunning = false;
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

  _fileName(contractNumber, taken) {
    const safe = String(contractNumber || 'без_номера').replace(/[\\/:*?"<>|]/g, '_');
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
    const okedErr = BatchAR._okedError(r), sumDiff = BatchAR._sumDiff(r), premDiff = BatchAR._premiumDiff(r);
    // СС (ОбщаяСтраховаяСумма)
    if (BatchAR._sumLtFotError(r) || BatchAR._sumLtPremiumError(r) || BatchAR._premiumBelowMinError(r) || (okedErr && sumDiff)) out.push(['insuranceSumTotal', RED]);
    else if (sumDiff) out.push(['insuranceSumTotal', YEL]);
    // Премия (ОбщаяСтраховаяПремия)
    if (BatchAR._sumLtPremiumError(r) || BatchAR._premiumBelowMinError(r) || (okedErr && premDiff)) out.push(['premiumTotal', RED]);
    else if (premDiff) out.push(['premiumTotal', YEL]);
    if (BatchAR._pkYoungError(r)) out.push(['coeff', RED]);
    if (BatchAR._insurerBinInvalidReason(r)) out.push(['binInsurer', RED]);
    if (BatchAR._binInvalidReason(r)) out.push(['bin', RED]);
    if (okedErr) out.push(['oked', RED]);
    if (BatchAR._classWrongForOked(r) || (okedErr && BatchAR._classDiff(r))) out.push(['riskClass', RED]);
    else if (BatchAR._classDiff(r)) out.push(['riskClass', YEL]);
    if (BatchAR._govDiff(r)) out.push(['govParticip', RED]);
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
    const btnAll = document.getElementById('batch-gen-all');
    if (btnAll) {
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
    // Кнопка сортировки — подсветка активного состояния.
    const btnSort = document.getElementById('batch-sort-errors');
    if (btnSort) {
      btnSort.style.display = BatchAR.rows.length ? '' : 'none';
      btnSort.classList.toggle('is-active', !!BatchAR._sortByError);
      btnSort.textContent = BatchAR._sortByError ? '⚑ Ошибки сверху ✓' : '⚑ Сначала ошибки';
    }
    const btnClear = document.getElementById('batch-clear');
    if (btnClear) btnClear.style.display = BatchAR.rows.length ? '' : 'none';
  },

  async clear() {
    const ok = (typeof App !== 'undefined' && App.confirmDialog)
      ? await App.confirmDialog({ title: 'Очистить загруженный реестр?', text: 'Список договоров и сгенерированные данные будут сброшены.', confirmLabel: 'Очистить' })
      : confirm('Очистить реестр?');
    if (!ok) return;
    BatchAR.rows = [];
    BatchAR._statgovRunning = false;
    BatchAR._statgovConnected = false;
    BatchAR._kycRunning = false;
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
