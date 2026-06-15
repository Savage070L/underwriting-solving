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
      const { rows, total, skipped } = BatchReader.parse(buf);
      BatchAR.rows = rows;
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
  // значит НЕ гос. участник (Нет). Доля — справочно. Не блокирует генерацию.
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
    if (!wrap || !tbody) return;
    if (!BatchAR.rows.length) {
      wrap.style.display = 'none';
      tbody.innerHTML = '';
      return;
    }
    wrap.style.display = 'block';
    // Порядок столбцов: # · БИН · Страхователь · ОКЭД · Класс · Кол-во сотр. ·
    // ГФОТ · Страх. сумма · Страх. Премия (до ПК) · ПК · Премия с ПК ·
    // Дата рег. · Гос. участие.
    tbody.innerHTML = BatchAR.rows.map((r, i) => {
      const cDiff = BatchAR._classDiff(r);
      const gDiff = BatchAR._govDiff(r);
      const classDiff = cDiff ? ' batch-cell--diff' : '';
      const govDiff = gDiff ? ' batch-cell--diff' : '';
      const rowDiff = (cDiff || gDiff) ? ' class="batch-row--diff"' : '';
      return `<tr data-idx="${i}"${rowDiff}>
        <td class="batch-c-num">${i + 1}</td>
        <td class="batch-c-bin">${r.bin}</td>
        <td class="batch-c-name" title="${ARForm._esc(r.insurerName)}">${ARForm._esc(r.insurerName)}</td>
        <td class="batch-c-oked">${BatchAR._okedCell(r)}</td>
        <td class="batch-c-class${classDiff}">${BatchAR._classCell(r)}</td>
        <td class="batch-c-num2">${ARForm._int(r.workers)}</td>
        <td class="batch-c-num2">${BatchAR._fmtMoney(r.gfot)}</td>
        <td class="batch-c-num2">${BatchAR._fmtMoney(r.insuranceSum)}</td>
        <td class="batch-c-num2">${BatchAR._fmtMoney(r.premiumBase)}</td>
        <td class="batch-c-center">${BatchAR._pkCell(r)}</td>
        <td class="batch-c-num2">${BatchAR._fmtMoney(r.premiumWithCoeff)}</td>
        <td class="batch-c-reg">${BatchAR._regCell(r)}</td>
        <td class="batch-c-gov${govDiff}">${BatchAR._govCell(r)}</td>
      </tr>`;
    }).join('');
  },

  // ПК: 1 (стандарт, зелёный) или 0,9 (со скидкой, синий).
  _pkCell(r) {
    const v = String(r.coeff).replace('.', ',');
    const cls = r.decision === 'discount' ? 'batch-pk batch-pk--discount' : 'batch-pk batch-pk--standard';
    const title = r.decision === 'discount' ? 'Принятие с понижающим коэффициентом' : 'Принятие со стандартным тарифом';
    return `<span class="${cls}" title="${title}">${v}</span>`;
  },

  // Расхождение класса: вычисленный по ОКЭД ≠ класс из выгрузки.
  _classDiff(r) {
    const comp = BatchAR._computedClass(r);
    return comp != null && String(comp) !== String(r.riskClass || '').trim();
  },

  // Расхождение гос. участия: вывод e-Qazyna (найден/не найден) ≠ выгрузка.
  _govDiff(r) {
    const eg = r.egov;
    if (!eg || eg.status !== 'done' || eg.found == null) return false;
    return eg.found !== !!r.govParticipation;
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
  _okedCell(r) {
    const top = ARForm._esc(r.oked || '—');
    let bottom = '';
    if (r.statgovStatus === 'loading') {
      bottom = '<span class="batch-sub batch-sub--load">⏳ statgov…</span>';
    } else {
      const list = BatchAR._okedList(r);
      if (list.length) bottom = `<span class="batch-sub">(${ARForm._esc(list.join(', '))})</span>`;
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
        bottom = `<span class="batch-sub ${diff ? 'batch-sub--diff' : ''}" title="${diff ? 'Макс. класс по ОКЭД не совпадает с выгрузкой' : 'классы по каждому ОКЭД'}">(${classes.join(', ')})</span>`;
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
  // По e-Qazyna: найден в реестре → «Да» (даже при доле 0%); не найден → «Нет».
  _govCell(r) {
    const reg = !!r.govParticipation;
    const top = reg
      ? '<span class="batch-gov-yes">Да</span>'
      : '<span class="batch-gov-no">—</span>';
    let bottom = '';
    const eg = r.egov;
    if (eg) {
      if (eg.status === 'loading') {
        bottom = '<span class="batch-sub batch-sub--load">⏳</span>';
      } else if (eg.status === 'error' || eg.found == null) {
        bottom = '<span class="batch-sub" title="e-Qazyna: нет данных">(н/д)</span>';
      } else {
        const diff = eg.found !== reg; // расхождение выгрузки и e-Qazyna
        const shareTxt = (eg.found && eg.share) ? ` · ${ARForm._esc(eg.share)}` : '';
        const verdict = eg.found ? 'Да' : 'Нет';
        const title = eg.found
          ? `e-Qazyna: найден в реестре гос. участия${eg.share ? ', доля ' + ARForm._esc(eg.share) : ''}`
          : 'e-Qazyna: не найден';
        bottom = `<span class="batch-sub ${diff ? 'batch-sub--diff' : ''}" title="${title}">(${verdict}${shareTxt})</span>`;
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
    const nameCell = tr.querySelector('.batch-c-name');
    if (nameCell) {
      nameCell.innerHTML = ARForm._esc(r.insurerName);
      nameCell.title = ARForm._esc(r.insurerName);
    }
    // Подсветка расхождений: отдельные ячейки + вся строка красным.
    const cDiff = BatchAR._classDiff(r);
    const gDiff = BatchAR._govDiff(r);
    tr.querySelector('.batch-c-class')?.classList.toggle('batch-cell--diff', cDiff);
    tr.querySelector('.batch-c-gov')?.classList.toggle('batch-cell--diff', gDiff);
    tr.classList.toggle('batch-row--diff', cDiff || gDiff);
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

  _fileName(row, taken) {
    const base = `АР ${row.bin}`;
    let name = `${base}.docx`;
    if (taken) {
      let k = 2;
      while (taken.has(name)) { name = `${base} (${k}).docx`; k++; }
      taken.add(name);
    }
    return name;
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
      const N = BatchAR.rows.length;
      for (let i = 0; i < N; i++) {
        const row = BatchAR.rows[i];
        if (txt) txt.textContent = `Генерация ${i + 1} из ${N} — АР ${row.bin}`;
        if (bar) bar.style.width = Math.round((i / N) * 100) + '%';
        const blob = await BatchAR._genBlob(row);
        // .docx уже сжат (zip) — храним без перекомпрессии (STORE) — быстрее.
        zip.file(BatchAR._fileName(row, taken), blob, { compression: 'STORE' });
        // Изредка уступаем поток UI (каждые 10 документов)
        if (i % 10 === 9) await new Promise(r => setTimeout(r, 0));
      }
      if (txt) txt.textContent = 'Упаковка ZIP…';
      if (bar) bar.style.width = '100%';
      const out = await zip.generateAsync({ type: 'blob' });
      const today = new Date();
      const stamp = `${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}.${today.getFullYear()}`;
      saveAs(out, `АР пакет ${stamp} (${N}).zip`);
      if (txt) txt.textContent = `Готово: ${N} документов в архиве`;
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
                ? `Сгенерировать Рекомендации АР (${BatchAR.rows.length})`
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
