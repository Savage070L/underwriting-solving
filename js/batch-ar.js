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

  // JSZip грузим по требованию (для пакета). docx/FileSaver уже подключены.
  CDN: {
    jszip: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  },

  STATGOV_CONCURRENCY: 2,

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
    return (window.App && App._getLimit) ? (App._getLimit('minCompanyAgeYears') || 3) : 3;
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

  _fmtMoney(v) {
    if (v == null || isNaN(v)) return '—';
    return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
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
    tbody.innerHTML = BatchAR.rows.map((r, i) => {
      const sgBadge = BatchAR._statgovBadge(r);
      const decision = r.decision === 'discount'
        ? `<span class="batch-tag batch-tag--discount">скидка ${String(r.coeff).replace('.', ',')}</span>`
        : `<span class="batch-tag batch-tag--standard">стандарт</span>`;
      const alert = r.youngAlert
        ? `<span class="batch-alert" title="Компания моложе ${BatchAR._youngThreshold()} лет — коэффициент мог быть проставлен ошибочно">⚠ моложе 3 лет${r.ageYears != null ? ` (${r.ageYears.toFixed(1).replace('.', ',')} г.)` : ''}</span>`
        : '';
      const rowCls = r.youngAlert ? 'batch-row--alert' : '';
      return `<tr class="${rowCls}" data-idx="${i}">
        <td class="batch-c-num">${i + 1}</td>
        <td class="batch-c-bin">${r.bin}</td>
        <td class="batch-c-name" title="${ARForm._esc(r.insurerName)}">${ARForm._esc(r.insurerName)}${alert}</td>
        <td class="batch-c-center">${ARForm._esc(r.riskClass)}</td>
        <td class="batch-c-num2">${BatchAR._fmtMoney(r.insuranceSum)}</td>
        <td class="batch-c-num2">${BatchAR._fmtMoney(r.premiumWithCoeff)}</td>
        <td class="batch-c-center">${decision}</td>
        <td class="batch-c-sg">${sgBadge}</td>
        <td class="batch-c-act"><button class="batch-pdf-btn" onclick="BatchAR.generateOne(${i}, this)">Word</button></td>
      </tr>`;
    }).join('');
  },

  _statgovBadge(r) {
    switch (r.statgovStatus) {
      case 'loading': return '<span class="batch-sg batch-sg--load">⏳ statgov…</span>';
      case 'done':    return '<span class="batch-sg batch-sg--ok">✓ ' + ARForm._esc((r.statgov && r.statgov.registrationDate) ? 'рег. ' + Utils.fmtDateShort(r.statgov.registrationDate) : 'найдено') + '</span>';
      case 'error':   return '<span class="batch-sg batch-sg--err" title="' + ARForm._esc(r.statgov && r.statgov.error || '') + '">— н/д</span>';
      case 'skip':    return '<span class="batch-sg">—</span>';
      default:        return '<span class="batch-sg batch-sg--wait">ожидает</span>';
    }
  },

  // Обновить одну строку таблицы (после statgov), не перерисовывая всю.
  _refreshRow(i) {
    const tr = document.querySelector(`#batch-tbody tr[data-idx="${i}"]`);
    if (!tr) return;
    const r = BatchAR.rows[i];
    const sgCell = tr.querySelector('.batch-c-sg');
    if (sgCell) sgCell.innerHTML = BatchAR._statgovBadge(r);
    const nameCell = tr.querySelector('.batch-c-name');
    if (nameCell) {
      const alert = r.youngAlert
        ? `<span class="batch-alert" title="Компания моложе ${BatchAR._youngThreshold()} лет — коэффициент мог быть проставлен ошибочно">⚠ моложе 3 лет${r.ageYears != null ? ` (${r.ageYears.toFixed(1).replace('.', ',')} г.)` : ''}</span>`
        : '';
      nameCell.innerHTML = `${ARForm._esc(r.insurerName)}${alert}`;
      nameCell.title = ARForm._esc(r.insurerName);
    }
    tr.classList.toggle('batch-row--alert', !!r.youngAlert);
  },

  // ===== Фоновый statgov по всем БИНам =====
  async startStatgov() {
    if (BatchAR._statgovRunning) return;
    if (typeof StatGovClient === 'undefined') {
      BatchAR.rows.forEach((r, i) => { r.statgovStatus = 'skip'; BatchAR._refreshRow(i); });
      return;
    }
    // Проверяем доступность расширения (без него лукапы бессмысленны).
    const ping = await StatGovClient.ping(1800).catch(() => ({ ok: false }));
    if (!ping.ok) {
      BatchAR.rows.forEach((r, i) => { r.statgovStatus = 'skip'; BatchAR._refreshRow(i); });
      const note = document.getElementById('batch-statgov-note');
      if (note) note.style.display = '';
      return;
    }
    BatchAR._statgovRunning = true;
    const queue = BatchAR.rows.map((_, i) => i);
    const threshold = BatchAR._youngThreshold();

    const worker = async () => {
      while (queue.length) {
        const i = queue.shift();
        const r = BatchAR.rows[i];
        r.statgovStatus = 'loading';
        BatchAR._refreshRow(i);
        try {
          const data = await StatGovClient.lookup(r.bin);
          r.statgov = data || {};
          r.statgovStatus = 'done';
          if (data && data.name && !r.statgov.error) r.insurerName = data.name;
          const reg = data && data.registrationDate;
          if (reg) {
            const age = Utils.companyAgeYears(reg, new Date());
            r.ageYears = age;
            r.youngAlert = (age != null && age < threshold);
          }
        } catch (e) {
          r.statgov = { error: e.message };
          r.statgovStatus = 'error';
        }
        BatchAR._refreshRow(i);
        BatchAR._updateAlertSummary();
      }
    };
    const n = Math.max(1, BatchAR.STATGOV_CONCURRENCY);
    await Promise.all(Array.from({ length: n }, worker));
    BatchAR._statgovRunning = false;
  },

  _updateAlertSummary() {
    const el = document.getElementById('batch-alert-summary');
    if (!el) return;
    const young = BatchAR.rows.filter(r => r.youngAlert);
    if (!young.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
    const withDiscount = young.filter(r => r.decision === 'discount').length;
    el.style.display = '';
    el.innerHTML = `⚠ Молодых компаний (моложе ${BatchAR._youngThreshold()} лет): <b>${young.length}</b>` +
      (withDiscount ? `, из них со скидкой (ПК&lt;1): <b>${withDiscount}</b> — проверьте, скидка могла быть применена ошибочно.` : '.');
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

  // ===== Скачать .docx одной строки =====
  async generateOne(i, btn) {
    const row = BatchAR.rows[i];
    if (!row) return;
    const prev = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      const blob = await BatchAR._genBlob(row);
      saveAs(blob, BatchAR._fileName(row));
      if (btn) { btn.textContent = '✓'; setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1200); }
    } catch (e) {
      console.error('DOCX generate error:', e);
      App.showMsg && App.showMsg('Ошибка генерации документа: ' + e.message, 'error');
      if (btn) { btn.textContent = prev; btn.disabled = false; }
    }
  },

  // ===== Сгенерировать все → ZIP =====
  async generateAll(btn) {
    if (BatchAR._busy || !BatchAR.rows.length) return;
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
      btnAll.disabled = BatchAR._busy || !BatchAR.rows.length;
      btnAll.textContent = BatchAR._busy
        ? 'Генерация…'
        : `Сгенерировать все PDF${BatchAR.rows.length ? ` (${BatchAR.rows.length}) → ZIP` : ''}`;
    }
    const btnClear = document.getElementById('batch-clear');
    if (btnClear) btnClear.style.display = BatchAR.rows.length ? '' : 'none';
  },

  async clear() {
    const ok = window.App && App.confirmDialog
      ? await App.confirmDialog({ title: 'Очистить загруженный реестр?', text: 'Список договоров и сгенерированные данные будут сброшены.', confirmLabel: 'Очистить' })
      : confirm('Очистить реестр?');
    if (!ok) return;
    BatchAR.rows = [];
    BatchAR._statgovRunning = false;
    const zone = document.getElementById('zone-batch');
    if (zone) zone.classList.remove('loaded');
    const input = document.getElementById('batch-file-input');
    if (input) input.value = '';
    const statusEl = document.getElementById('batch-status');
    if (statusEl) statusEl.textContent = 'Файл не загружен';
    document.getElementById('batch-alert-summary')?.setAttribute('style', 'display:none');
    document.getElementById('batch-statgov-note')?.setAttribute('style', 'display:none');
    BatchAR.renderTable();
    BatchAR._updateControls();
  },
};

if (typeof window !== 'undefined') window.BatchAR = BatchAR;
