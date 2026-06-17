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
  CDN: {
    jszip: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
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
      const { rows, total, skipped, header } = BatchReader.parse(buf);
      BatchAR.rows = rows;
      BatchAR._rawHeader = header || [];   // исходный заголовок (для выгрузки превышений)
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
    tbody.innerHTML = BatchAR.rows.map((r, i) => {
      const okedErr = BatchAR._okedError(r);
      const cDiff = BatchAR._classDiff(r);
      const gDiff = BatchAR._govDiff(r);
      // ОКЭД ошибочный → красный; класс: красный, если из-за ошибочного ОКЭД,
      // иначе жёлтый (мягкое расхождение); гос. участие при расхождении → красный.
      const okedCls = okedErr ? ' batch-cell--err' : '';
      const classCls = cDiff ? (okedErr ? ' batch-cell--err' : ' batch-cell--warn') : '';
      const govCls = gDiff ? ' batch-cell--err' : '';
      // Молодая компания (< порога) со скидкой → ПК подсвечиваем красным.
      const pkCls = BatchAR._pkYoungError(r) ? ' batch-cell--err' : '';
      // СС < премии → красным (грубая ошибка); иначе жёлтым при расхождении с
      // расчётом по методологии. Красный приоритетнее жёлтого.
      const sumLtPrem = BatchAR._sumLtPremiumError(r);
      const sumCls = sumLtPrem ? ' batch-cell--err' : (BatchAR._sumDiff(r) ? ' batch-cell--warn' : '');
      const premCls = sumLtPrem ? ' batch-cell--err' : (BatchAR._premiumDiff(r) ? ' batch-cell--warn' : '');
      const sumPremTitle = sumLtPrem ? ' title="Ошибка: страховая сумма меньше страховой премии"' : '';
      const level = BatchAR._rowLevel(r);
      const rowCls = level ? ` class="batch-row--${level}"` : '';
      const nm = ARForm._effName(r);
      return `<tr data-idx="${i}"${rowCls}>
        <td class="batch-c-num">${i + 1}</td>
        <td class="batch-c-contract">${ARForm._esc(r.contractNumber || '—')}</td>
        <td class="batch-c-bin">${r.bin}</td>
        <td class="batch-c-name" title="${ARForm._esc(nm)}">${ARForm._esc(nm)}</td>
        <td class="batch-c-oked${okedCls}">${BatchAR._okedCell(r)}</td>
        <td class="batch-c-class${classCls}">${BatchAR._classCell(r)}</td>
        <td class="batch-c-num2">${ARForm._int(r.workers)}</td>
        <td class="batch-c-num2">${BatchAR._fmtMoney(r.gfot)}</td>
        <td class="batch-c-num2 batch-c-sum${sumCls}"${sumPremTitle}>${BatchAR._sumCellHtml(r)}</td>
        <td class="batch-c-num2 batch-c-prem${premCls}"${sumPremTitle}>${BatchAR._premiumCellHtml(r)}</td>
        <td class="batch-c-center${pkCls}">${BatchAR._pkCell(r)}</td>
        <td class="batch-c-num2">${BatchAR._fmtMoney(r.premiumWithCoeff)}</td>
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
  // Месячный ФОТ = ФОТ/12; Ср.ЗП = месячный ФОТ / кол-во работников;
  // Премия = Ср.ЗП, но не меньше 85 000; СС = премия / тариф (тариф — по классу).
  _minPremium() {
    return (typeof App !== 'undefined' && App._getLimit) ? (App._getLimit('minAvgSalary') || 85000) : 85000;
  },
  _avgSalaryMonthly(r) {
    return (r.gfot > 0 && r.workers > 0) ? (r.gfot / 12 / r.workers) : null;
  },
  // Ожидаемая премия = max(Ср.ЗП мес., 85 000).
  _expectedPremium(r) {
    const a = BatchAR._avgSalaryMonthly(r);
    return a != null ? Math.max(a, BatchAR._minPremium()) : null;
  },
  // Тариф для проверки: по вычисленному классу из справочника «Поправочные
  // коэффициенты»; если справочника нет — тариф из выгрузки (премия/СС).
  _checkTariff(r) {
    const cls = BatchAR._computedClass(r);
    const c = (cls != null) ? cls : (parseInt(r.riskClass, 10) || 0);
    const rr = (typeof App !== 'undefined' && App.refData && App.refData.popravka) ? App.refData.popravka.riskRates : null;
    if (rr && c) { const t = rr.get(c); if (Number.isFinite(t) && t > 0) return t; }
    return (r.tariff && r.tariff > 0) ? r.tariff : null;
  },
  // Ожидаемая СС = ожидаемая премия / тариф (до тиынов, не округляем до целого).
  _expectedSum(r) {
    const p = BatchAR._expectedPremium(r), t = BatchAR._checkTariff(r);
    return (p != null && t) ? Math.round(p / t * 100) / 100 : null;
  },
  // Относительное расхождение > 1% (и не меньше 1 ₸) — считаем значимым.
  _moneyDiff(a, b) {
    return a != null && b != null && Math.abs(a - b) > Math.max(1, 0.01 * Math.abs(b));
  },
  _premiumDiff(r) {
    return BatchAR._moneyDiff(BatchAR._expectedPremium(r), r.premiumBase);
  },
  _sumDiff(r) {
    return BatchAR._moneyDiff(BatchAR._expectedSum(r), r.insuranceSum);
  },
  // Грубая ошибка: страховая сумма МЕНЬШЕ страховой премии. Премия всегда должна
  // быть малой долей суммы (премия = СС × тариф), поэтому СС < премии — точно
  // ошибка данных → красным вся строка и обе ячейки (СС и премия).
  _sumLtPremiumError(r) {
    return r.insuranceSum != null && r.premiumBase != null
      && Number(r.insuranceSum) < Number(r.premiumBase);
  },

  // СС: сверху — из выгрузки, снизу в скобках — расчётная (премия/тариф).
  _sumCellHtml(r) {
    const top = BatchAR._fmtMoney(r.insuranceSum);
    const exp = BatchAR._expectedSum(r);
    let bottom = '';
    if (exp != null) {
      const diff = BatchAR._sumDiff(r);
      const title = diff ? 'Расчётная СС (премия / тариф) не совпадает с выгрузкой' : 'Расчётная СС (премия / тариф)';
      bottom = `<span class="batch-sub ${diff ? 'batch-sub--warn' : ''}" title="${title}">(${BatchAR._fmtMoney(exp)})</span>`;
    }
    return `<div class="batch-stack"><span class="batch-stack-top">${top}</span>${bottom ? `<span class="batch-stack-bot">${bottom}</span>` : ''}</div>`;
  },
  // Премия: сверху — из выгрузки, снизу в скобках — расчётная (Ср.ЗП мес., мин. 85к).
  _premiumCellHtml(r) {
    const top = BatchAR._fmtMoney(r.premiumBase);
    const exp = BatchAR._expectedPremium(r);
    let bottom = '';
    if (exp != null) {
      const diff = BatchAR._premiumDiff(r);
      const title = diff ? 'Расчётная премия (Ср.ЗП мес., мин. 85 000) не совпадает с выгрузкой' : 'Расчётная премия (Ср.ЗП мес., мин. 85 000)';
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
    if (BatchAR._okedError(r) || BatchAR._govDiff(r) || BatchAR._pkYoungError(r) || BatchAR._sumLtPremiumError(r)) return 'err';
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

  // Пересчитать возраст/флаг «моложе порога» по эффективной дате регистрации.
  _applyYoung(r) {
    const eff = BatchAR._effRegDate(r);
    if (eff && eff.raw) {
      const age = Utils.companyAgeYears(eff.raw, new Date());
      r.ageYears = age;
      r.youngAlert = (age != null && age < BatchAR._youngThreshold());
    } else {
      r.ageYears = null;
      r.youngAlert = false;
    }
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
    if (!eff) {
      if (r.kycStatus === 'loading') return '<span class="batch-sg batch-sg--load">⏳ kyc.kz…</span>';
      return '<span class="batch-sg batch-sg--ok">✓ найдено (без даты)</span>';
    }
    const dateStr = ARForm._esc(Utils.fmtDateShort(eff.raw));
    const srcTitle = eff.source === 'kyc' ? 'дата из kyc.kz' : 'дата из stat.gov.kz';
    const srcMark = eff.source === 'kyc' ? '<span class="batch-regsrc" title="kyc.kz">kyc</span>' : '';
    let ageRow = '';
    if (r.youngAlert) {
      const age = BatchAR._ageText(eff.raw);
      if (age) ageRow = `<span class="batch-sub batch-young">(${ARForm._esc(age)})</span>`;
    }
    return `<div class="batch-stack"><span class="batch-stack-top batch-reg" title="${srcTitle}">${dateStr}${srcMark}</span>${ageRow ? `<span class="batch-stack-bot">${ageRow}</span>` : ''}</div>`;
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
    const nameCell = tr.querySelector('.batch-c-name');
    if (nameCell) {
      const nm = ARForm._effName(r);
      nameCell.innerHTML = ARForm._esc(nm);
      nameCell.title = ARForm._esc(nm);
    }
    // Подсветка расхождений: красный — точная ошибка (ошибочный ОКЭД/класс,
    // расхождение гос. участия); жёлтый — мягкое расхождение класса.
    const okedErr = BatchAR._okedError(r);
    const cDiff = BatchAR._classDiff(r);
    const gDiff = BatchAR._govDiff(r);
    const okedCell = tr.querySelector('.batch-c-oked');
    if (okedCell) okedCell.classList.toggle('batch-cell--err', okedErr);
    const classCell = tr.querySelector('.batch-c-class');
    if (classCell) {
      classCell.classList.toggle('batch-cell--err', cDiff && okedErr);
      classCell.classList.toggle('batch-cell--warn', cDiff && !okedErr);
    }
    tr.querySelector('.batch-c-gov')?.classList.toggle('batch-cell--err', gDiff);
    // ПК красным, если молодая компания (< порога) со скидкой.
    tr.querySelector('.batch-c-center')?.classList.toggle('batch-cell--err', BatchAR._pkYoungError(r));
    // СС/премия: красным если СС < премии (грубая ошибка), иначе жёлтым при
    // расхождении с методологией. Красный приоритетнее жёлтого.
    const sumLtPrem = BatchAR._sumLtPremiumError(r);
    const setSumPremLvl = (sel, warnOn) => {
      const c = tr.querySelector(sel); if (!c) return;
      c.classList.toggle('batch-cell--err', sumLtPrem);
      c.classList.toggle('batch-cell--warn', !sumLtPrem && warnOn);
      if (sumLtPrem) c.title = 'Ошибка: страховая сумма меньше страховой премии';
      else c.removeAttribute('title');
    };
    setSumPremLvl('.batch-c-sum', BatchAR._sumDiff(r));
    setSumPremLvl('.batch-c-prem', BatchAR._premiumDiff(r));
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
    const sgWorker = async () => {
      while (sgQueue.length) {
        const i = sgQueue.shift();
        const r = BatchAR.rows[i];
        r.statgovStatus = 'loading';
        BatchAR._refreshRow(i);
        BatchAR._scheduleAggregate();
        try {
          const data = await StatGovClient.lookup(r.bin);
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
    const worker = async () => {
      while (queue.length) {
        const i = queue.shift();
        const r = BatchAR.rows[i];
        r.kycStatus = 'loading';
        BatchAR._refreshRow(i);
        try {
          const data = await StatGovClient.lookupKyc(r.bin);
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
    const worker = async () => {
      while (queue.length) {
        const i = queue.shift();
        const r = BatchAR.rows[i];
        try {
          r.egov = await BatchAR._lookupEgov(r.bin);
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

  // Договор превышает лимиты АС: класс 1–15 и СС свыше 2 млрд, либо
  // класс 16–22 и СС свыше 1,5 млрд (СС = сумма по всем филиалам договора).
  // Класс берём ВЫЧИСЛЕННЫЙ по ОКЭД из stat.gov.kz (а не из выгрузки); макс. по
  // филиалам. Если вычислить нельзя (нет классификатора/ОКЭД) — fallback на выгрузку.
  _exceedsAsLimit(group) {
    const totalSum = group.reduce((a, r) => a + (Number(r.insuranceSum) || 0), 0);
    const cls = Math.max(0, ...group.map(r => {
      const c = BatchAR._computedClass(r);
      return c != null ? c : (parseInt(r.riskClass, 10) || 0);
    }));
    const low1_15 = (typeof App !== 'undefined' && App._getLimit) ? App._getLimit('limitAsLowCls1_15') : 2000000000;
    const low16_22 = (typeof App !== 'undefined' && App._getLimit) ? App._getLimit('limitAsLowCls16_22') : 1500000000;
    if (cls >= 1 && cls <= 15 && totalSum > low1_15) return true;
    if (cls >= 16 && cls <= 22 && totalSum > low16_22) return true;
    return false;
  },

  // xlsx-список договоров, превысивших лимиты АС, в ИСХОДНОМ формате выгрузки:
  // тот же заголовок и те же строки (все филиалы), что в загруженном файле.
  // Возвращает ArrayBuffer.
  _buildOverLimitXlsx(overLimit) {
    const header = (BatchAR._rawHeader && BatchAR._rawHeader.length) ? BatchAR._rawHeader : [];
    const aoa = [header];
    for (const [, group] of overLimit) {
      for (const r of group) {
        if (r._raw) aoa.push(r._raw);
      }
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Превышение лимитов АС');
    return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
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
      const overLimit = [];   // договоры свыше лимитов АС → отдельная папка
      const toGenerate = [];  // остальные → стандартный АР
      for (const entry of groups) {
        (BatchAR._exceedsAsLimit(entry[1]) ? overLimit : toGenerate).push(entry);
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
        const xlsxBuf = BatchAR._buildOverLimitXlsx(overLimit);
        zip.file(`Превышение лимитов АС/Превышение лимитов АС (${overLimit.length}).xlsx`, xlsxBuf, { compression: 'STORE' });
      }
      if (txt) txt.textContent = 'Упаковка ZIP…';
      if (bar) bar.style.width = '100%';
      const out = await zip.generateAsync({ type: 'blob' });
      const today = new Date();
      const stamp = `${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}.${today.getFullYear()}`;
      saveAs(out, `АР пакет ${stamp} (${N}).zip`);
      if (txt) txt.textContent = `Готово: ${N} документов${overLimit.length ? ` + ${overLimit.length} на АС (отдельная папка)` : ''}`;
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
      btnAll.textContent = BatchAR._busy
        ? 'Генерация…'
        : (!BatchAR.rows.length
            ? 'Сгенерировать Рекомендации АР'
            : (ready
                ? `Сгенерировать Рекомендации АР (${BatchAR._contractCount()})`
                : 'Ожидание проверки stat.gov.kz…'));
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
