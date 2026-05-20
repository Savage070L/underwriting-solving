// app.js — UI orchestration, file handling, BIN lookup, localStorage caching

const App = {
  // State
  zayavka: null,
  claims: null,
  binData: {         // auto-fetched by BIN
    legalAddress: null,
    govParticipation: null,
  },
  statgov: null,     // auto-fetched from stat.gov.kz via chrome extension
  refData: {
    popravka: null,   // { riskRates: Map, adjustmentCoeffs: matrix }
    normativ: null,   // stored as raw arrayBuffer JSON
    ku: null,
    calculator: null, // array of activity objects
    classifier: null, // ОКЭД → класс риска + название деятельности
    affiliated: null, // [{ id: '12-digit', name }, ...]
  },
  _rawNormativBuffer: null, // keep raw buffer for date-dependent lookup

  // ===== INITIALIZATION =====
  init() {
    App.restoreCache();
    App._restoreCase();
    App.restoreVerdict();
    App.updateButtons();
  },

  // ===== VERDICT SELECTOR =====
  restoreVerdict() {
    const saved = localStorage.getItem('manual_verdict');
    const select = document.getElementById('verdict');
    if (saved && select) {
      select.value = saved;
    }
    App.updateVerdictHint();
  },

  onVerdictChange() {
    const v = document.getElementById('verdict').value;
    if (v && v !== 'auto') {
      localStorage.setItem('manual_verdict', v);
    } else {
      localStorage.removeItem('manual_verdict');
    }
    App.updateVerdictHint();
  },

  updateVerdictHint() {
    const select = document.getElementById('verdict');
    const hint = document.getElementById('verdict-hint');
    if (!select || !hint) return;
    const v = select.value;
    if (v === 'auto') {
      // Покажем что предложит auto-логика на текущих данных
      const z = App.zayavka;
      if (z && z.coeff != null) {
        const decision = Utils.determineDecision(z.coeff, z.coeffDown);
        const predicted = Utils.resolveVerdict('auto', decision);
        const label = Utils.VERDICT_LABELS[predicted] || '';
        hint.textContent = `— авто: «${label}»`;
      } else {
        hint.textContent = '— определяется по коэффициенту при скачивании';
      }
      hint.classList.remove('manual');
    } else {
      hint.textContent = '— ручной выбор андеррайтера';
      hint.classList.add('manual');
    }
  },

  // ===== REFERENCE FILE LOADING =====
  async loadRef(type, file) {
    if (!file) return;
    try {
      const buf = await App._readFile(file);
      switch (type) {
        case 'popravka': {
          const result = ExcelReader.readPopravochnyeKoeff(buf);
          App.refData.popravka = result;
          // Cache as JSON-serializable
          const cacheObj = {
            riskRates: Array.from(result.riskRates.entries()),
            adjustmentCoeffs: result.adjustmentCoeffs,
          };
          localStorage.setItem('ref_popravka', JSON.stringify(cacheObj));
          break;
        }
        case 'normativ': {
          // Store raw buffer as base64 for re-reading with docDate
          const base64 = App._arrayBufferToBase64(buf);
          localStorage.setItem('ref_normativ_raw', base64);
          App._rawNormativBuffer = buf;
          // Если заявка уже загружена — читаем с учётом её даты.
          // Иначе берём самую последнюю строку файла.
          const effDate = App.zayavka
            ? (App.zayavka.periodFrom || App.zayavka.docDate) : null;
          App.refData.normativ = ExcelReader.readNormativ(buf, effDate);
          // Перерисовать превью и кнопки (могут зависеть от активов компании)
          if (App.zayavka) App.showPreview();
          App.updateButtons();
          break;
        }
        case 'ku': {
          const result = ExcelReader.readKuPoKlassam(buf);
          App.refData.ku = result;
          localStorage.setItem('ref_ku', JSON.stringify(result));
          // Превью и документы используют ku.lossRatioWith / Without — перерисуем
          if (App.zayavka) App.showPreview();
          break;
        }
        case 'calculator': {
          const result = ExcelReader.readCalculator(buf);
          App.refData.calculator = result;
          localStorage.setItem('ref_calculator', JSON.stringify(result));
          App.populateActivityDropdown();
          break;
        }
        case 'classifier': {
          const result = ExcelReader.readOkedClassifier(buf);
          App.refData.classifier = result;
          localStorage.setItem('ref_classifier', JSON.stringify(result));
          App.onOkedChange(); // re-lookup if ОКЭД already entered
          App.renderCompanyOkeds();
          break;
        }
        case 'affiliated': {
          const result = ExcelReader.readAffiliatedList(buf);
          App.refData.affiliated = result;
          localStorage.setItem('ref_affiliated', JSON.stringify(result));
          break;
        }
      }
      // Сохраняем имя файла, чтобы показывать его и после перезагрузки.
      localStorage.setItem(`ref_${type}_name`, file.name);
      App.updateRefStatus(type, true, file.name);
      App.updateRefBadge();
      App.updateButtons();
    } catch (e) {
      console.error(`Error loading ${type}:`, e);
      App.showMsg(`Ошибка загрузки ${file.name}: ${e.message}`, 'error');
    }
  },

  // Очищает один справочник (по типу) — для кнопки ❌ на карточке.
  clearOneRef(type, ev) {
    if (ev) ev.stopPropagation();
    const keys = {
      popravka: 'ref_popravka',
      normativ: 'ref_normativ_raw',
      ku: 'ref_ku',
      calculator: 'ref_calculator',
      classifier: 'ref_classifier',
      affiliated: 'ref_affiliated',
    };
    if (!keys[type]) return;
    localStorage.removeItem(keys[type]);
    localStorage.removeItem(`ref_${type}_name`);
    App.refData[type] = null;
    if (type === 'normativ') App._rawNormativBuffer = null;
    if (type === 'calculator') {
      localStorage.removeItem('selected_activity_idx');
      App.populateActivityDropdown();
    }
    App.updateRefStatus(type, false);
    App.updateRefBadge();
    App.renderCompanyOkeds();
    App.onOkedChange();
    App.showMsg(`Справочник «${type}» очищен.`, 'success');
  },

  // Принудительное обновление: пересобирает stat.gov.kz, BIN-лукап, normativ
  // (с учётом текущего периода), превью, таблицу ОКЭДов, тариф и verdict-hint.
  // Excel-файлы (заявка, история убытков, справочники) уже распарсены и лежат в
  // памяти — их «обновление из источника» возможно только повторной загрузкой
  // через ❌ + drop, поэтому здесь обновляем только производные данные.
  refreshAll() {
    const bin = App.zayavka?.bin;
    if (!bin) {
      App.showMsg('Сначала загрузите заявку.', 'error');
      return;
    }
    // Re-read normativ с учётом текущего периода (если буфер сохранён)
    const effectiveDate = App.zayavka.periodFrom || App.zayavka.docDate;
    if (App._rawNormativBuffer && effectiveDate) {
      App.refData.normativ = ExcelReader.readNormativ(App._rawNormativBuffer, effectiveDate);
    }
    // Re-fetch внешних источников
    App.autoLookupStatGov(bin);
    App.autoLookupBIN(bin);
    // Перерендер UI
    App.showPreview();
    App.renderCompanyOkeds();
    App.onOkedChange();
    App.updateVerdictHint();
    App.updateButtons();
    App.showMsg('Данные обновлены: stat.gov.kz, БИН-лукап, превью, ОКЭДы, тариф.', 'success');
  },

  // Удаляет файл по кейсу (заявка ИЛИ история убытков).
  clearCaseFile(which, ev) {
    if (ev) ev.stopPropagation();
    if (which === 'zayavka') {
      App.zayavka = null;
      App.statgov = null;
      App.binData = { legalAddress: null, govParticipation: null };
      const zoneZ = document.getElementById('zone-zayavka');
      if (zoneZ) zoneZ.classList.remove('loaded');
      document.getElementById('status-zayavka').textContent = 'Загрузите .xlsm файл';
      document.getElementById('preview-panel')?.classList.remove('visible');
      document.getElementById('bin-status').innerHTML = '';
    } else if (which === 'claims') {
      App.claims = null;
      const zoneC = document.getElementById('zone-claims');
      if (zoneC) zoneC.classList.remove('loaded');
      document.getElementById('status-claims').textContent = 'Загрузите .xls файл';
      document.getElementById('analytics-cta')?.classList.remove('visible');
      document.getElementById('analytics-inline')?.classList.remove('is-open');
    }
    App._persistCase();
    App.updateButtons();
    App.showMsg('Файл удалён.', 'success');
  },

  // ===== CASE-FILE PERSISTENCE =====
  // Save parsed case data so navigation (e.g. "Назад к форме" from analytics) doesn't lose state.
  _persistCase() {
    try {
      const payload = {
        zayavka: App.zayavka ? App._zayavkaToJson(App.zayavka) : null,
        claims: App.claims || null,
        binData: App.binData || null,
        fileNames: {
          zayavka: document.getElementById('status-zayavka')?.textContent || '',
          claims: document.getElementById('status-claims')?.textContent || '',
        },
        savedAt: new Date().toISOString(),
      };
      localStorage.setItem('case_state', JSON.stringify(payload));
    } catch (e) { console.warn('Persist case failed:', e); }
  },
  _zayavkaToJson(z) {
    return {
      ...z,
      docDate: z.docDate ? new Date(z.docDate).toISOString() : null,
      periodFrom: z.periodFrom ? new Date(z.periodFrom).toISOString() : null,
      periodTo: z.periodTo ? new Date(z.periodTo).toISOString() : null,
    };
  },
  _restoreCase() {
    const raw = localStorage.getItem('case_state');
    if (!raw) return;
    try {
      const p = JSON.parse(raw);
      if (p.zayavka) {
        App.zayavka = {
          ...p.zayavka,
          docDate: p.zayavka.docDate ? new Date(p.zayavka.docDate) : null,
          periodFrom: p.zayavka.periodFrom ? new Date(p.zayavka.periodFrom) : null,
          periodTo: p.zayavka.periodTo ? new Date(p.zayavka.periodTo) : null,
        };
        const zoneZ = document.getElementById('zone-zayavka');
        if (zoneZ) zoneZ.classList.add('loaded');
        const statusZ = document.getElementById('status-zayavka');
        if (statusZ && p.fileNames?.zayavka) statusZ.textContent = p.fileNames.zayavka.replace(/\s*\(из кэша\)$/, '');
      }
      if (p.claims) {
        App.claims = p.claims;
        const zoneC = document.getElementById('zone-claims');
        if (zoneC) zoneC.classList.add('loaded');
        const statusC = document.getElementById('status-claims');
        if (statusC && p.fileNames?.claims) {
          // Очистим хвосты «(из кэша)» и «(N НС за 3 года)», пересоберём текст
          const baseName = p.fileNames.claims
            .replace(/\s*\(из кэша\)$/, '')
            .replace(/\s*\(\d+\s*НС\s*за\s*\d+\s*года?\)\s*$/i, '');
          const total = App.claims?.totalClaims || 0;
          statusC.textContent = `${baseName} (${total} НС за 3 года)`.trim();
        }
        document.getElementById('analytics-cta')?.classList.add('visible');
      }
      if (p.binData) App.binData = p.binData;
      if (App.zayavka) {
        App._fillDateInputs();
        App.showPreview();
        // Если БИН уже известен — попытаться (фоном) перезагрузить statgov из расширения.
        if (App.zayavka.bin) App.autoLookupStatGov(App.zayavka.bin);
      }
    } catch (e) { console.warn('Restore case failed:', e); }
  },
  clearCaseCache() {
    localStorage.removeItem('case_state');
    App.zayavka = null;
    App.claims = null;
    App.binData = { legalAddress: null, govParticipation: null };
    const zZ = document.getElementById('zone-zayavka');
    const zC = document.getElementById('zone-claims');
    if (zZ) zZ.classList.remove('loaded');
    if (zC) zC.classList.remove('loaded');
    document.getElementById('status-zayavka').textContent = 'Загрузите .xlsm файл';
    document.getElementById('status-claims').textContent = 'Загрузите .xls файл';
    document.getElementById('analytics-cta')?.classList.remove('visible');
    document.getElementById('analytics-inline')?.classList.remove('is-open');
    document.getElementById('preview-panel')?.classList.remove('visible');
    document.getElementById('bin-status').innerHTML = '';
    App.updateButtons();
    App.showMsg('Файлы кейса очищены.', 'success');
  },

  // ===== ZAYAVKA LOADING =====
  async loadZayavka(file) {
    if (!file) return;
    try {
      const buf = await App._readFile(file);
      App.zayavka = ExcelReader.readZayavka(buf);

      // Период страхования всегда: F3 + 1 день → F3 + 1 год.
      // Продукт ОСНС заключается строго на год; E21/G21 в заявке менеджеры
      // часто не заполняют — игнорируем и считаем от даты подачи заявления.
      if (App.zayavka.docDate) {
        const { from, to } = App._computePeriodFromDocDate(App.zayavka.docDate);
        App.zayavka.periodFrom = from;
        App.zayavka.periodTo = to;
      }

      // Заполняем UI-инпуты вычисленными датами (пользователь может изменить).
      App._fillDateInputs();

      // Update normativ with contract date (теперь всегда есть, если F3 заполнен)
      const effectiveDate = App.zayavka.periodFrom || App.zayavka.docDate;
      if (App._rawNormativBuffer && effectiveDate) {
        App.refData.normativ = ExcelReader.readNormativ(App._rawNormativBuffer, effectiveDate);
      }

      // Auto-lookup BIN for address and gov participation
      if (App.zayavka.bin) {
        App.autoLookupBIN(App.zayavka.bin);
        App.autoLookupStatGov(App.zayavka.bin);
        // statsnet — отдельно, дольше (открывает background-вкладки)
        App.autoLookupStatsnet(App.zayavka.bin);
      }

      // Show preview
      App.showPreview();

      // Refresh ОКЭД hint with the value loaded from zayavka
      App.onOkedChange();

      // Sync payment order from zayavka D19 → form dropdown
      const poSelect = document.getElementById('paymentOrder');
      if (poSelect && App.zayavka.paymentOrder) {
        const raw = String(App.zayavka.paymentOrder).trim();
        if (/рассроч/i.test(raw)) {
          poSelect.value = 'В рассрочку';
        } else {
          poSelect.value = 'Единовременно';
        }
        App.onPaymentChange();
      }

      // Update upload status
      const zone = document.getElementById('zone-zayavka');
      zone.classList.add('loaded');
      document.getElementById('status-zayavka').textContent = `${file.name}`;

      App._persistCase();
      App.updateButtons();
      App.updateVerdictHint();
    } catch (e) {
      console.error('Error loading zayavka:', e);
      App.showMsg(`Ошибка загрузки заявки: ${e.message}`, 'error');
    }
  },

  // ===== CLAIMS LOADING =====
  async loadClaims(file) {
    if (!file) return;
    try {
      const buf = await App._readFile(file);
      App.claims = ExcelReader.readClaimsHistory(buf);

      const zone = document.getElementById('zone-claims');
      zone.classList.add('loaded');
      document.getElementById('status-claims').textContent =
        `${file.name} (${App.claims.totalClaims} НС за 3 года)`;

      document.getElementById('analytics-cta').classList.add('visible');

      App._persistCase();
      App.updateButtons();
    } catch (e) {
      console.error('Error loading claims:', e);
      App.showMsg(`Ошибка загрузки истории убытков: ${e.message}`, 'error');
    }
  },

  // ===== PREVIEW =====
  showPreview() {
    const z = App.zayavka;
    if (!z) return;
    const panel = document.getElementById('preview-panel');
    const grid = document.getElementById('preview-grid');

    const resolved = App._resolveOked();

    // === Источник истины: stat.gov.kz (если доступен), иначе — заявка ===
    const sg = (App.statgov && !App.statgov.loading && !App.statgov.error && App.statgov.found !== false)
      ? App.statgov : null;

    // Активные значения для документов (через _resolveOked)
    const effOked = resolved.oked || z.oked || '';
    const effClass = resolved.riskClass || z.riskClass;
    const effTariff = App._resolveTariff ? App._resolveTariff(effClass) : null;

    // Имя деятельности для активного ОКЭДа: если primary statgov — okedPrimaryName,
    // иначе из classifier через _collectCompanyOkeds
    let effActivityName = resolved.activity;
    if (sg && effOked === sg.okedPrimaryCode && sg.okedPrimaryName) {
      effActivityName = sg.okedPrimaryName;
    } else if (App._collectCompanyOkeds) {
      const co = App._collectCompanyOkeds().find(o => o.code === effOked);
      if (co && co.name) effActivityName = co.name;
    }

    // ========== СЕКЦИЯ 1: Страхователь ==========
    const insurerName = sg?.name ? Utils.formatCompanyName(sg.name) : Utils.formatCompanyName(z.insurerName);
    const sec1 = [
      ['БИН', z.bin],
      ['Наименование', insurerName],
      sg?.registrationDate ? ['Дата регистрации', sg.registrationDate] : null,
      sg?.headFullname ? ['ФИО руководителя', sg.headFullname] : null,
      ['КАТО', sg?.kato || '—'],
      ['Юридический адрес', sg?.legalAddress || App.binData.legalAddress || '(поиск...)'],
    ].filter(Boolean);

    // ========== СЕКЦИЯ 2: Деятельность ==========
    const sec2 = [
      ['Основной код ОКЭД', sg?.okedPrimaryCode || effOked || '—'],
      ['Наименование вида экономической деятельности', effActivityName || '—'],
    ];
    if (sg?.okedSecondaryCodes && sg.okedSecondaryCodes.length) {
      sec2.push(['Вторичный код ОКЭД', sg.okedSecondaryCodes.join(', ')]);
    } else if (sg?.okedSecondaryCode) {
      sec2.push(['Вторичный код ОКЭД', sg.okedSecondaryCode]);
    }
    sec2.push(['Активный ОКЭД для документов', effOked || '—']);
    sec2.push(['Класс риска', effClass || '—']);
    sec2.push(['Страховой тариф', effTariff != null ? Utils.fmtPct(effTariff) : '—']);

    // ========== СЕКЦИЯ 3: Размер и собственность ==========
    const sec3 = [];
    if (sg?.krpWithBranchesCode) sec3.push(['Код КРП (с учётом филиалов)', sg.krpWithBranchesCode]);
    if (sg?.krpWithBranchesName) sec3.push(['Наименование КРП', sg.krpWithBranchesName]);
    if (sg?.krpWithoutBranchesCode) sec3.push(['Код КРП (без учёта филиалов)', sg.krpWithoutBranchesCode]);
    if (sg?.krpWithoutBranchesName) sec3.push(['Наименование КРП', sg.krpWithoutBranchesName]);
    if (sg?.kfsCode) sec3.push(['Код КФС', sg.kfsCode]);
    if (sg?.kfsName) sec3.push(['Наименование КФС', sg.kfsName]);
    if (sg?.sectorCode) sec3.push(['Код сектора экономики', sg.sectorCode]);
    if (sg?.sectorName) sec3.push(['Наименование сектора экономики', sg.sectorName]);
    sec3.push(['Гос. участие', App.binData.govParticipation || z.govParticipation || '(поиск...)']);

    // ========== СЕКЦИЯ 4: Параметры договора ==========
    const sec4 = [
      ['Регион', z.region || '—'],
      ['Дата заявки', z.docDate ? Utils.fmtDateShort(z.docDate) : '—'],
      ['Период страхования', (z.periodFrom && z.periodTo)
        ? `${Utils.fmtDateShort(z.periodFrom)} — ${Utils.fmtDateShort(z.periodTo)}` : '—'],
      ['Работники', Utils.fmtInteger(z.workers)],
      ['Страховая сумма', Utils.fmtMoney(z.insuranceSum)],
      ['Премия', Utils.fmtMoney(z.premiumBase)],
      ['Премия с поправкой', Utils.fmtMoney(z.premiumWithCoeff)],
      ['Порядок оплаты', z.paymentOrder],
    ];

    const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const renderItems = (rows) => rows.map(([l, v]) => {
      const display = (v == null || v === '') ? '—' : v;
      const canCopy = display !== '—' && display !== '(поиск...)';
      const copyBtn = canCopy
        ? `<button class="pi-copy" title="Скопировать" onclick="App.copyToClipboard('${escAttr(display)}', this)">⧉</button>`
        : '';
      return `<div class="preview-item">
        <span class="pi-label">${l}:</span>
        <span class="pi-value">${display}</span>
        ${copyBtn}
      </div>`;
    }).join('');

    const renderSection = (title, rows) => `
      <div class="preview-section">
        <div class="preview-section-title">${title}</div>
        ${renderItems(rows)}
      </div>`;

    // Статус-плашка stat.gov.kz (отдельно, если loading/error/not-found)
    let sgStatus = '';
    if (App.statgov?.loading) {
      sgStatus = `<div class="preview-section"><div class="pi-loading">Поиск в реестре stat.gov.kz…</div></div>`;
    } else if (App.statgov?.error) {
      sgStatus = `<div class="preview-section"><div class="pi-warn">⚠ ${App.statgov.error}</div>
        <div class="pi-hint">Установи расширение «Standard Life — мост к stat.gov.kz» и войди в кабинет через ЭЦП.</div></div>`;
    } else if (App.statgov?.found === false) {
      sgStatus = `<div class="preview-section"><div class="pi-warn">БИН ${App.statgov.bin || ''} не найден в реестре stat.gov.kz.</div></div>`;
    }

    grid.innerHTML =
      renderSection('Страхователь', sec1) +
      renderSection('Деятельность', sec2) +
      renderSection('Размер и собственность', sec3) +
      renderSection('Параметры договора', sec4) +
      sgStatus;

    panel.classList.add('visible');
  },

  // Открывает выбранный AI-сервис с пред-заполненным промптом про компанию.
  // service: 'chatgpt' | 'gemini' | 'perplexity'
  // Имя приоритетно из stat.gov.kz, fallback на заявку. Промпт также копируется
  // в буфер обмена — если сервис не подхватит ?q=, можно вставить Cmd+V.
  copyAskAiPrompt(service, btn) {
    const z = App.zayavka || {};
    const bin = z.bin || '';
    if (!bin) {
      App.showMsg('Сначала загрузите заявку — нужен БИН/ИИН.', 'error');
      return;
    }
    const sg = (App.statgov && !App.statgov.loading && !App.statgov.error && App.statgov.found !== false) ? App.statgov : null;
    const name = (sg?.name) || z.insurerName || '(имя не известно)';
    const prompt =
      `Расскажи кратко о компании. Наименование: ${name}, БИН: ${bin}. ` +
      `Максимум 4-5 предложений как один абзац — чем они занимаются, ` +
      `вид деятельности, регион, размер. Используй веб-поиск.`;
    const enc = encodeURIComponent(prompt);
    let url = '';
    switch (service) {
      case 'chatgpt':
        // hints=search активирует режим веб-поиска
        url = `https://chatgpt.com/?hints=search&q=${enc}`;
        break;
      case 'gemini':
        // Gemini не поддерживает ?q= параметр — открываем главную, промпт в буфере.
        url = 'https://gemini.google.com/app';
        break;
      case 'perplexity':
        url = `https://www.perplexity.ai/?q=${enc}`;
        break;
      default:
        url = `https://chatgpt.com/?hints=search&q=${enc}`;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    App.copyToClipboard(prompt, btn);
  },

  // Копирует значение в буфер обмена. Показывает анимацию на кнопке.
  copyToClipboard(text, btn) {
    const decoded = String(text).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const showOk = () => {
      if (!btn) return;
      const orig = btn.textContent;
      btn.textContent = '✓';
      btn.classList.add('pi-copy--ok');
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove('pi-copy--ok');
      }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(decoded).then(showOk).catch(() => {
        // Fallback на устаревший API
        const ta = document.createElement('textarea');
        ta.value = decoded;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); showOk(); } catch (e) {}
        document.body.removeChild(ta);
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = decoded;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); showOk(); } catch (e) {}
      document.body.removeChild(ta);
    }
  },

  // ===== DATES (F3 + период страхования) =====
  _computePeriodFromDocDate(docDate) {
    const d = new Date(docDate);
    const from = new Date(d);
    from.setDate(from.getDate() + 1);
    const to = new Date(from);
    to.setFullYear(to.getFullYear() + 1);
    return { from, to };
  },

  // Превращает Date в yyyy-mm-dd (формат HTML date input).
  _dateToInputValue(d) {
    if (!d) return '';
    const dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt)) return '';
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  },

  _fillDateInputs() {
    const z = App.zayavka;
    if (!z) return;
    const inFrom = document.getElementById('periodFrom');
    const inTo = document.getElementById('periodTo');
    if (inFrom) inFrom.value = App._dateToInputValue(z.periodFrom);
    if (inTo) inTo.value = App._dateToInputValue(z.periodTo);
  },

  // Ручной триггер statsnet-лукапа (кнопка рядом с dropdown «Вид деятельности»).
  async manualStatsnetLookup(btn) {
    const bin = App.zayavka?.bin;
    if (!bin) {
      App.showMsg('Сначала загрузите заявку — нужен БИН.', 'error');
      return;
    }
    if (btn) {
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = '⏳ Ищем…';
      try {
        await App.autoLookupStatsnet(bin);
        if (App.statsnet?.found && App.statsnet?.industry) {
          App.showMsg(`Отрасль найдена: «${App.statsnet.industry}»`, 'success');
        } else if (App.statsnet?.error) {
          App.showMsg(App.statsnet.error, 'error');
        } else {
          App.showMsg('Отрасль на statsnet не найдена.', 'error');
        }
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    } else {
      await App.autoLookupStatsnet(bin);
    }
  },

  // ===== AUTO LOOKUP via Chrome extension (statsnet.co — «Отрасль») =====
  // Открывает background-вкладку с Яндекс-поиском, находит ссылку на statsnet,
  // парсит «Отрасль», закрывает вкладку. Если «Отрасль» совпадает с одной из
  // 17 категорий калькулятора — выставляет её в dropdown «Вид деятельности»
  // (только если пользователь не сделал ручной выбор для этого ОКЭДа).
  async autoLookupStatsnet(bin) {
    App.statsnet = { loading: true };
    if (typeof StatGovClient === 'undefined') {
      App.statsnet = { error: 'Расширение не подключено', loading: false };
      return;
    }
    try {
      const data = await StatGovClient.lookupStatsnet(bin);
      App.statsnet = { ...data, loading: false };
      // Применяем «Отрасль» к dropdown, если совпадает с категорией калькулятора
      if (data?.found && data.industry) {
        App._applyStatsnetIndustry(data.industry);
      }
    } catch (e) {
      App.statsnet = { error: e.message, loading: false };
    }
    App.showPreview();
  },

  // Прямое сравнение «Отрасль» из statsnet с категориями калькулятора.
  // Если найдено — выставляем в dropdown и помечаем как auto (overrideable вручную).
  _applyStatsnetIndustry(industry) {
    if (!industry) return;
    const norm = (s) => String(s || '').toLowerCase()
      .replace(/[«»"',.()]/g, '')
      .replace(/\s+/g, ' ').trim();
    const target = norm(industry);
    const activities = App._calcActivities ? App._calcActivities() : [];
    const idx = activities.findIndex(a => norm(a.name) === target);
    if (idx < 0) return; // нет точного совпадения — оставим текущий выбор
    // Не перезаписываем ручной выбор пользователя
    const resolved = App._resolveOked();
    if (resolved.oked && localStorage.getItem('manual_activity_for_oked') === resolved.oked) {
      return;
    }
    // Применяем
    const select = document.getElementById('activitySelect');
    if (select) {
      select.value = String(idx);
      localStorage.setItem('selected_activity_idx', String(idx));
      App._activityAutoForOked = resolved.oked; // пометка «авто»
    }
    App._renderActivityHint();
  },

  // ===== AUTO LOOKUP via Chrome extension (stat.gov.kz) =====
  // Требует установленного расширения «Standard Life — мост к stat.gov.kz».
  async autoLookupStatGov(bin) {
    App.statgov = { loading: true };
    App.showPreview();
    App.renderCompanyOkeds();
    if (typeof StatGovClient === 'undefined') {
      App.statgov = { error: 'StatGovClient не подключён', loading: false };
      App.showPreview();
      App.renderCompanyOkeds();
      return;
    }
    try {
      const data = await StatGovClient.lookup(bin);
      App.statgov = { ...data, loading: false };
    } catch (e) {
      App.statgov = { error: e.message, loading: false };
    }
    App.showPreview();
    App.renderCompanyOkeds();
    // После того как statgov загружен, _resolveOked() начнёт возвращать max-class ОКЭД —
    // пересинхронизируем hint и автовыбор вида деятельности.
    App.onOkedChange();
  },

  // Рендерит таблицу «ОКЭДы компании» под полем «Номер АР».
  renderCompanyOkeds() {
    const section = document.getElementById('company-okeds-section');
    const tbody = document.getElementById('company-okeds-body');
    if (!section || !tbody) return;
    const list = App._collectCompanyOkeds();
    if (!list.length) {
      section.style.display = 'none';
      tbody.innerHTML = '';
      return;
    }
    section.style.display = '';
    const resolved = App._resolveOked();
    const activeOked = resolved.oked;
    const fmtNum = (v) => v != null ? Number(v).toFixed(3).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',') : '—';
    const fmtTariff = (v) => v != null ? (v * 100).toFixed(2).replace('.', ',') + '%' : '—';
    tbody.innerHTML = list.map(o => {
      const isActive = o.code === activeOked;
      const cls = isActive ? 'active' : '';
      const badge = isActive ? '<span class="oked-active-badge">активный</span>' : '';
      return `<tr class="${cls}">
        <td><strong>${o.code}</strong> ${badge}</td>
        <td>${o.name || '<span class="muted">— нет в классификаторе</span>'}</td>
        <td>${fmtNum(o.deathRate)}</td>
        <td>${fmtNum(o.injuryRate)}</td>
        <td>${o.riskClass != null ? '<strong>' + o.riskClass + '</strong>' : '—'}</td>
        <td>${fmtTariff(o.tariff)}</td>
        <td>${o.kind === 'primary' ? 'осн.' : 'втор.'}</td>
      </tr>`;
    }).join('');
  },

  // ===== AUTO BIN LOOKUP via Cloudflare Worker proxy =====
  // Change this URL after deploying the worker
  WORKER_URL: 'https://bin-lookup.toibaev-kuanysh-617.workers.dev',

  async autoLookupBIN(bin) {
    const statusEl = document.getElementById('bin-status');
    statusEl.innerHTML = '<span class="bin-loading">Поиск по БИН ' + bin + '...</span>';

    // Reset
    App.binData = { legalAddress: null, govParticipation: null };

    try {
      const resp = await fetch(App.WORKER_URL + '?bin=' + bin);
      if (!resp.ok) throw new Error('Worker returned ' + resp.status);

      const data = await resp.json();

      // Address from pk.uchet.kz
      if (data.address && data.address.address) {
        App.binData.legalAddress = data.address.address;
      }

      // Gov participation from e-Qazyna
      if (data.gov) {
        if (data.gov.found === false) {
          App.binData.govParticipation = 'Нет';
        } else if (data.gov.share) {
          App.binData.govParticipation = data.gov.share;
        } else if (data.gov.found) {
          App.binData.govParticipation = 'Да (доля не определена)';
        }
      }
    } catch (e) {
      console.warn('BIN lookup failed:', e.message);
    }

    // Update status display
    const parts = [];
    if (App.binData.legalAddress) {
      parts.push('<span class="bin-ok">Адрес: ' + App.binData.legalAddress + '</span>');
    } else {
      parts.push('<span class="bin-warn">Адрес не найден (проверьте Worker URL)</span>');
    }
    if (App.binData.govParticipation !== null) {
      parts.push('<span class="bin-ok">Гос. участие: ' + App.binData.govParticipation + '</span>');
    } else {
      parts.push('<span class="bin-warn">Гос. участие: не определено</span>');
    }
    statusEl.innerHTML = parts.join('<br>');

    // Refresh preview with new data
    App.showPreview();
  },

  // Собирает snapshot для аналитики на основе ВСЕХ актуальных значений:
  // ручной ОКЭД, выбранный вид деятельности, переопределённый тариф/период,
  // statgov-данные (имя, ОКЭДы компании, КРП, КФС, ...).
  _buildAnalyticsSnapshot() {
    const z = App.zayavka || {};
    const resolved = App._resolveOked();
    const effOked = resolved.oked || z.oked || '';
    const effRC = resolved.riskClass || z.riskClass;
    // Активный тариф с учётом ручных корректировок
    const effTariff = App._resolveTariff ? App._resolveTariff(effRC) : null;
    // Деятельность: для primary statgov — точное название из реестра
    const sg = (App.statgov && !App.statgov.loading && !App.statgov.error && App.statgov.found !== false)
      ? App.statgov : null;
    let effActivity = resolved.activity;
    if (sg && effOked === sg.okedPrimaryCode && sg.okedPrimaryName) {
      effActivity = sg.okedPrimaryName;
    }
    // Даты — приоритет инпутов формы
    const periodFromInput = document.getElementById('periodFrom')?.value;
    const periodToInput = document.getElementById('periodTo')?.value;
    const periodFrom = periodFromInput ? new Date(periodFromInput) : z.periodFrom;
    const periodTo = periodToInput ? new Date(periodToInput) : z.periodTo;
    // Имя и адрес — приоритет statgov
    const insurerName = (sg && sg.name) || z.insurerName || '';
    const legalAddress = (sg && sg.legalAddress) || App.binData.legalAddress || '';

    return {
      generatedAt: new Date().toISOString(),
      zayavka: {
        insurerName,
        bin: z.bin || '',
        workers: z.workers || 0,
        riskClass: effRC || '',
        oked: effOked,
        activity: effActivity || '',
        region: z.region || '',
        insuranceSum: z.insuranceSum || 0,
        premiumBase: z.premiumBase || 0,
        premiumWithCoeff: z.premiumWithCoeff || 0,
        periodFrom: periodFrom ? new Date(periodFrom).toISOString() : null,
        periodTo: periodTo ? new Date(periodTo).toISOString() : null,
        tariff: effTariff,                 // ← пересчитанный тариф, не сырой z.tariff
        coeff: z.coeff || null,
        coeffDown: z.coeffDown || 0,
        paymentOrder: z.paymentOrder || '',
        docDate: z.docDate ? new Date(z.docDate).toISOString() : null,
        govParticipation: App.binData.govParticipation || z.govParticipation || '',
        legalAddress,
        // Источники активного ОКЭДа (manual / statgov-max-class / zayavka)
        okedSource: resolved.source || 'unknown',
      },
      verdict: document.getElementById('verdict')?.value || 'auto',
      popravka: App.refData.popravka ? {
        baseTariff: App.refData.popravka.riskRates ? App.refData.popravka.riskRates.get(effRC) : null,
        allTariffs: App.refData.popravka.riskRates
          ? Array.from(App.refData.popravka.riskRates.entries()).map(([cls, rate]) => ({ cls, rate }))
          : [],
      } : null,
      analytics: App.claims.analytics,
      normativ: App.refData.normativ ? {
        date: App.refData.normativ.date,
        fullAssetsTenge: App.refData.normativ.fullAssetsTenge,
        fullAssets: App.refData.normativ.fullAssets,
        portfolioShare: App.refData.normativ.portfolioShare,
      } : null,
      ku: App.refData.ku ? {
        lossRatioWith: App.refData.ku.lossRatioWith,
        lossRatioWithout: App.refData.ku.lossRatioWithout,
      } : null,
      activity: App._getSelectedActivity(),
      // Новое: statgov + ОКЭДы компании
      statgov: sg ? {
        name: sg.name,
        bin: sg.bin,
        registrationDate: sg.registrationDate,
        legalAddress: sg.legalAddress,
        headFullname: sg.headFullname,
        okedPrimaryCode: sg.okedPrimaryCode,
        okedPrimaryName: sg.okedPrimaryName,
        okedSecondaryCodes: sg.okedSecondaryCodes || [],
        krpWithBranchesCode: sg.krpWithBranchesCode,
        krpWithBranchesName: sg.krpWithBranchesName,
        krpWithoutBranchesCode: sg.krpWithoutBranchesCode,
        krpWithoutBranchesName: sg.krpWithoutBranchesName,
        kato: sg.kato,
        kfsCode: sg.kfsCode,
        kfsName: sg.kfsName,
        sectorCode: sg.sectorCode,
        sectorName: sg.sectorName,
      } : null,
      companyOkeds: App._collectCompanyOkeds ? App._collectCompanyOkeds() : [],
    };
  },

  // ===== OPEN ANALYTICS DASHBOARD =====
  openAnalytics() {
    if (!App.claims || !App.claims.analytics) {
      App.showMsg('Сначала загрузите историю убытков.', 'error');
      return;
    }
    localStorage.setItem('analytics_snapshot', JSON.stringify(App._buildAnalyticsSnapshot()));
    window.open('analytics.html', '_blank');
  },

  // ===== TOGGLE INLINE ANALYTICS =====
  toggleInlineAnalytics() {
    if (!App.claims || !App.claims.analytics) {
      App.showMsg('Сначала загрузите историю убытков.', 'error');
      return;
    }
    const container = document.getElementById('analytics-inline');
    const hint = document.getElementById('inline-hint');
    const iframe = document.getElementById('analytics-iframe');
    if (container.classList.contains('is-open')) {
      container.classList.remove('is-open');
      hint.textContent = '↓ развернуть';
      return;
    }
    localStorage.setItem('analytics_snapshot', JSON.stringify(App._buildAnalyticsSnapshot()));
    iframe.src = 'analytics.html#inline=1&t=' + Date.now(); // force reload via hash
    container.classList.add('is-open');
    hint.textContent = '↑ свернуть';
    setTimeout(() => container.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  },

  // ===== GENERATE AR =====
  async generateAR() {
    try {
      const data = App._collectData();
      if (!data) return;

      const blob = await ARGenerator.generate(data);
      const fileName = `АР ${Utils.formatCompanyName(data.insurerName)}.docx`;
      saveAs(blob, fileName);
      App.showMsg(`${fileName} сформирован!`, 'success');
    } catch (e) {
      console.error('AR generation error:', e);
      App.showMsg(`Ошибка генерации АР: ${e.message}`, 'error');
    }
  },

  // ===== GENERATE ZAKLYUCHENIE =====
  async generateZakl() {
    try {
      const data = App._collectData();
      if (!data) return;

      const blob = await ZaklGenerator.generate(data);
      const fileName = `заключение ${Utils.formatCompanyName(data.insurerName)}.docx`;
      saveAs(blob, fileName);
      App.showMsg(`${fileName} сформирован!`, 'success');
    } catch (e) {
      console.error('Zakl generation error:', e);
      App.showMsg(`Ошибка генерации Заключения: ${e.message}`, 'error');
    }
  },

  // ===== GENERATE PROTOCOL =====
  async generateProtocol() {
    try {
      const data = App._collectData();
      if (!data) return;

      const blob = await ProtocolGenerator.generate(data);
      const fileName = `протокол ${Utils.formatCompanyName(data.insurerName)}.docx`;
      saveAs(blob, fileName);
      App.showMsg(`${fileName} сформирован!`, 'success');
    } catch (e) {
      console.error('Protocol generation error:', e);
      App.showMsg(`Ошибка генерации Протокола: ${e.message}`, 'error');
    }
  },

  // ===== GENERATE СЗ на Правление =====
  async generateSzPravlenie() {
    try {
      const data = App._collectData();
      if (!data) return;
      const blob = await SZGenerator.generate(data, 'pravlenie');
      const fileName = `СЗ на Правление ${Utils.formatCompanyName(data.insurerName)}.docx`;
      saveAs(blob, fileName);
      App.showMsg(`${fileName} сформирован!`, 'success');
    } catch (e) {
      console.error('СЗ на Правление generation error:', e);
      App.showMsg(`Ошибка генерации СЗ на Правление: ${e.message}`, 'error');
    }
  },

  // ===== GENERATE СЗ на СД =====
  async generateSzSd() {
    try {
      const data = App._collectData();
      if (!data) return;
      const blob = await SZGenerator.generate(data, 'sd');
      const fileName = `СЗ на СД ${Utils.formatCompanyName(data.insurerName)}.docx`;
      saveAs(blob, fileName);
      App.showMsg(`${fileName} сформирован!`, 'success');
    } catch (e) {
      console.error('СЗ на СД generation error:', e);
      App.showMsg(`Ошибка генерации СЗ на СД: ${e.message}`, 'error');
    }
  },

  // ===== COLLECT ALL DATA =====
  _collectData() {
    const z = App.zayavka;
    if (!z) {
      App.showMsg('Загрузите заявку на андеррайтинг.', 'error');
      return null;
    }

    const docNumber = document.getElementById('docNumber').value.trim();
    if (!docNumber) {
      App.showMsg('Укажите номер документа.', 'error');
      return null;
    }

    // Tariff: prefer the value entered manually in заявка (D12).
    // Only fall back to справочник (по риск-классу) when zayavka has no tariff.
    // Note: effective risk class is resolved further below via _resolveOked();
    // the справочник lookup happens after we know it.

    // Даты: docDate = F3 из заявки (для шапки документа).
    // Период страхования: приоритет на UI-инпуты (ручной ввод), fallback на
    // App.zayavka.periodFrom/periodTo, которые в loadZayavka уже вычислены как
    // F3 + 1 день / F3 + 1 год.
    const periodFromInput = document.getElementById('periodFrom')?.value;
    const periodToInput = document.getElementById('periodTo')?.value;
    const docDate = z.docDate || null;
    let periodFrom = periodFromInput ? new Date(periodFromInput) : z.periodFrom;
    let periodTo = periodToInput ? new Date(periodToInput) : z.periodTo;
    if (docDate && (!periodFrom || !periodTo)) {
      const p = App._computePeriodFromDocDate(docDate);
      if (!periodFrom) periodFrom = p.from;
      if (!periodTo) periodTo = p.to;
    }

    // Apply ОКЭД override (manual input > zayavka). Resolves class+name via classifier.
    const resolved = App._resolveOked();
    const effectiveOked = resolved.oked;
    const effectiveRiskClass = resolved.riskClass;
    const effectiveActivity = resolved.activity;

    // Тариф «связан» с активным ОКЭДом — см. _resolveTariff().
    const tariff = App._resolveTariff(effectiveRiskClass);

    // Activity for death/injury rates — picked manually from dropdown (sourced from Лист2 of калькулятор).
    let selectedActivity = App._getSelectedActivity();

    // docDate уже определён выше из инпута (или z.docDate). На случай отсутствия —
    // используем periodFrom как fallback.
    const effectiveDocDate = docDate || periodFrom;
    // Перетираем z.docDate, чтобы итоговый объект (через ...z потом docDate) был
    // согласован с тем, что показывает UI.
    z.docDate = effectiveDocDate;

    // If there were any claims (НС > 0), discount does not apply
    const claimsCount = App.claims ? App.claims.totalClaims : 0;
    const effectiveCoeffDown = claimsCount > 0 ? 0 : z.coeffDown;

    // Recalculate premium with adjusted coefficient if needed
    let premiumWithCoeff = z.premiumWithCoeff;
    if (claimsCount > 0 && z.premiumBase) {
      // No discount — premium stays at base
      premiumWithCoeff = z.premiumBase;
    }

    // Check if страхователь is affiliated (BIN/IIN match)
    let isAffiliated = false;
    let affiliatedEntry = null;
    if (z.bin && App.refData.affiliated) {
      const cleanBin = String(z.bin).trim().replace(/\s+/g, '');
      affiliatedEntry = App.refData.affiliated.find(e => e.id === cleanBin) || null;
      isAffiliated = !!affiliatedEntry;
    }

    // Payment schedule (form takes priority over zayavka D19)
    const formOrder = document.getElementById('paymentOrder')?.value || 'Единовременно';
    const formFreq = document.getElementById('paymentFrequency')?.value || 'month';
    let paymentOrderEff = formOrder;
    let paymentFreqEff = null;
    let paymentTranches = null;
    let paymentScheduleText = paymentOrderEff;
    if (paymentOrderEff === 'В рассрочку') {
      paymentFreqEff = formFreq;
      paymentTranches = Utils.calcPaymentTranches(formFreq, periodFrom, periodTo);
      paymentScheduleText = `В рассрочку (${Utils.PAYMENT_FREQ_LABELS[formFreq]}): ${Utils.formatPaymentSchedule(paymentTranches, formFreq)}`;
    }

    // Источник имени, юр. адреса, региона и деятельности: stat.gov.kz (реестр)
    // считаем наиболее достоверным. Заявка / pk.uchet.kz — fallback.
    const sg = (App.statgov && !App.statgov.loading && !App.statgov.error && App.statgov.found !== false)
      ? App.statgov : null;
    const insurerName = (sg && sg.name) || z.insurerName;
    const legalAddress = (sg && sg.legalAddress) || App.binData.legalAddress || '-';
    const headFullname = (sg && sg.headFullname) || null;

    // Регион: заявка E3 → первая часть юр. адреса из stat.gov.kz.
    // Адрес: «ТУРКЕСТАНСКАЯ ОБЛАСТЬ, ТУРКЕСТАН Г.А., ...» — берём до запятой.
    let region = z.region;
    if ((!region || region === '-') && sg && sg.legalAddress) {
      const firstPart = String(sg.legalAddress).split(',')[0].trim();
      if (firstPart) region = firstPart;
    }

    // Деятельность: для активного ОКЭДа, если это primary stat.gov.kz —
    // берём statgov-имя (специфичное), иначе fallback на classifier name.
    let activity = effectiveActivity;
    if (sg && effectiveOked && effectiveOked === sg.okedPrimaryCode && sg.okedPrimaryName) {
      activity = sg.okedPrimaryName;
    }

    return {
      ...z,
      insurerName,
      region,
      oked: effectiveOked || z.oked,
      riskClass: effectiveRiskClass,
      activity,
      docDate: effectiveDocDate,
      docNumber,
      legalAddress,
      headFullname,
      statgov: sg, // полный объект — для генераторов, которые захотят что-то ещё
      nonResident: document.getElementById('nonResident').checked,
      isAffiliated,
      affiliatedName: affiliatedEntry ? affiliatedEntry.name : null,
      paymentOrder: paymentOrderEff,
      paymentFrequency: paymentFreqEff,
      paymentTranches: paymentTranches ? paymentTranches.map(d => d.toISOString()) : null,
      paymentScheduleText,
      periodFrom,
      periodTo,
      coeffDown: effectiveCoeffDown,
      premiumWithCoeff,
      tariff,
      claims: App.claims,
      claimsSummary: App.claims ? App.claims.summaryText : 'НС не было',
      normativ: App.refData.normativ,
      ku: App.refData.ku,
      selectedActivity,
      riskText: document.getElementById('riskText').value.trim(),
      govParticipation: App.binData.govParticipation || z.govParticipation || '-',
      verdict: document.getElementById('verdict').value,
    };
  },

  // ===== UI HELPERS =====
  updateRefStatus(type, loaded, fileName) {
    const zone = document.getElementById(`zone-${type}`);
    const status = document.getElementById(`status-${type}`);
    if (loaded) {
      zone.classList.add('loaded');
      status.textContent = fileName || 'Загружен';
    } else {
      zone.classList.remove('loaded');
      status.textContent = 'Не загружен';
    }
  },

  updateRefBadge() {
    let count = 0;
    if (App.refData.popravka) count++;
    if (App.refData.normativ) count++;
    if (App.refData.ku) count++;
    if (App.refData.calculator) count++;
    if (App.refData.classifier) count++;
    if (App.refData.affiliated) count++;
    document.getElementById('ref-badge').textContent = `${count}/6 загружено`;
  },

  updateButtons() {
    const hasZayavka = !!App.zayavka;
    document.getElementById('btnAR').disabled = !hasZayavka;
    document.getElementById('btnZakl').disabled = !hasZayavka;
    const btnProto = document.getElementById('btnProtocol');
    const btnSzPr = document.getElementById('btnSzPravlenie');
    const btnSzSd = document.getElementById('btnSzSd');

    // Determine organ from current data
    let organ = null;
    let pkg = ['ar', 'zakl'];
    if (hasZayavka) {
      const assets = App.refData.normativ?.fullAssetsTenge || 0;
      organ = Utils.determineOrgan(
        App.zayavka.insuranceSum,
        App.zayavka.riskClass,
        assets,
      );
      pkg = Utils.determineDocPackage(organ);
    }

    if (btnProto) btnProto.disabled = !hasZayavka || !pkg.includes('protocol');
    if (btnSzPr) btnSzPr.disabled = !hasZayavka || !pkg.includes('sz_pravlenie');
    if (btnSzSd) btnSzSd.disabled = !hasZayavka || !pkg.includes('sz_sd');

    // Show/hide buttons depending on package
    const setHidden = (el, hide) => { if (el) el.style.display = hide ? 'none' : ''; };
    setHidden(btnProto, !pkg.includes('protocol'));
    setHidden(btnSzPr, !pkg.includes('sz_pravlenie'));
    setHidden(btnSzSd, !pkg.includes('sz_sd'));

    // Update organ-banner with determined body
    const banner = document.getElementById('organ-banner');
    if (banner) {
      if (organ && organ !== 'standard') {
        banner.style.display = 'block';
        banner.className = 'organ-banner organ-banner--' + organ;
        const descr = Utils.describeOrgan(organ);
        const pkgNames = pkg.map(p => ({
          ar: 'АР', zakl: 'Заключение', protocol: 'Протокол',
          sz_pravlenie: 'СЗ на Правление', sz_sd: 'СЗ на СД',
        }[p])).join(' · ');
        banner.innerHTML = `<strong>Определён орган:</strong> ${descr}<br><span class="ob-pkg">Пакет документов: ${pkgNames}</span>`;
      } else if (organ === 'standard' && hasZayavka) {
        banner.style.display = 'block';
        banner.className = 'organ-banner organ-banner--standard';
        banner.innerHTML = `<strong>Стандартная процедура.</strong> <span class="ob-pkg">Достаточно АР и Заключения</span>`;
      } else {
        banner.style.display = 'none';
      }
    }
  },

  showMsg(text, type) {
    const el = document.getElementById('msg');
    el.textContent = text;
    el.className = `msg ${type}`;
    setTimeout(() => { el.className = 'msg'; }, 5000);
  },

  // ===== Resolve effective ОКЭД, риск-класс и название деятельности =====
  // Приоритет:
  //   1. Manual ОКЭД из инпута (явное намерение оператора)
  //   2. ОКЭД с максимальным классом среди всех ОКЭДов компании из stat.gov.kz
  //      (основной + все вторичные), если они есть и классификатор загружен
  //   3. ОКЭД из заявки
  _resolveOked() {
    const z = App.zayavka || {};
    const manual = (document.getElementById('okedInput')?.value || '').trim();
    let oked = manual;
    let source = 'manual';

    if (!oked) {
      const company = App._collectCompanyOkeds();
      const withCls = company.filter(o => o.riskClass != null);
      if (withCls.length > 0) {
        withCls.sort((a, b) => b.riskClass - a.riskClass);
        oked = withCls[0].code;
        source = 'statgov-max-class';
      }
    }

    if (!oked) {
      oked = z.oked || '';
      source = oked ? 'zayavka' : 'empty';
    }

    let riskClass = z.riskClass;
    let activity = z.activity;
    if (oked && App.refData.classifier) {
      const found = Utils.lookupOked(oked, App.refData.classifier);
      if (found) {
        riskClass = found.cls;
        activity = found.name;
        source += '+classifier';
      }
    }
    return { oked, riskClass, activity, source };
  },

  // Собирает список всех ОКЭДов компании из stat.gov.kz и обогащает
  // классификатором (класс, тариф) + калькулятором (смертность, травматизм).
  // Возвращает: [{code, kind: 'primary'|'secondary', name, riskClass, deathRate, injuryRate, tariff}, ...]
  _collectCompanyOkeds() {
    const sg = App.statgov;
    if (!sg || sg.loading || sg.error || sg.found === false) return [];
    const items = [];
    if (sg.okedPrimaryCode) {
      items.push({ code: String(sg.okedPrimaryCode), kind: 'primary' });
    }
    const seen = new Set([sg.okedPrimaryCode].filter(Boolean).map(String));
    for (const code of sg.okedSecondaryCodes || []) {
      const c = String(code);
      if (seen.has(c)) continue;
      seen.add(c);
      items.push({ code: c, kind: 'secondary' });
    }
    const okedMap = App._calcOkedMap ? App._calcOkedMap() : {};
    const classifier = App.refData.classifier || [];
    return items.map(it => {
      // Калькулятор (Лист3) даёт смерть/травму/класс/тариф per-OKED — приоритет.
      const calc = okedMap[it.code]; // объект { activityName, deathRate, injuryRate, riskClass, tariff }
      // Классификатор — fallback по имени деятельности и тарифу.
      const clsLookup = Utils.lookupOked(it.code, classifier);
      const classifierEntry = classifier.find(e => !e.isPrefix && e.okedRaw === it.code);
      return {
        code: it.code,
        kind: it.kind,
        name: clsLookup?.name || calc?.okedName || null,
        riskClass: (calc?.riskClass != null ? calc.riskClass : null) ?? clsLookup?.cls ?? null,
        deathRate: calc?.deathRate ?? null,
        injuryRate: calc?.injuryRate ?? null,
        tariff: (calc?.tariff != null ? calc.tariff : null) ?? classifierEntry?.tariff ?? null,
        activityName: calc?.activityName || null,
      };
    });
  },

  // ===== PAYMENT ORDER + FREQUENCY HANDLERS =====
  onPaymentChange() {
    const order = document.getElementById('paymentOrder')?.value || 'Единовременно';
    const wrap = document.getElementById('payment-frequency-wrap');
    const preview = document.getElementById('payment-preview');
    if (!wrap) return;
    if (order === 'В рассрочку') {
      wrap.style.display = '';
      const freq = document.getElementById('paymentFrequency')?.value || 'month';
      const z = App.zayavka || {};
      const tranches = Utils.calcPaymentTranches(freq, z.periodFrom, z.periodTo);
      const list = Utils.formatPaymentSchedule(tranches, freq);
      if (preview) {
        const lines = list.split(';').map(s => s.trim()).filter(Boolean);
        preview.innerHTML = lines.length <= 14
          ? lines.map(l => `<div class="pp-line">${l}</div>`).join('')
          : `<div class="pp-line">${list}</div>`;
      }
    } else {
      wrap.style.display = 'none';
      if (preview) preview.innerHTML = '';
    }
  },

  // ===== ОКЭД INPUT HANDLER =====
  onOkedChange() {
    const input = document.getElementById('okedInput');
    const hint = document.getElementById('oked-hint');
    const result = document.getElementById('oked-result');
    if (!input || !result) return;
    const code = input.value.trim();
    if (!code) {
      // Empty — fall back to zayavka
      result.innerHTML = '';
      result.classList.remove('visible', 'oked-result--found', 'oked-result--missing');
      if (hint) hint.textContent = App.zayavka
        ? `— пусто, используется ОКЭД из заявки (${App.zayavka.oked || '—'})`
        : '— пусто, используется ОКЭД из заявки';
    } else if (!App.refData.classifier) {
      if (hint) hint.textContent = '— ручной ввод, перекрывает значение из заявки';
      result.classList.add('visible', 'oked-result--missing');
      result.classList.remove('oked-result--found');
      result.innerHTML = '<span class="oked-warn">⚠ Загрузите справочник «Классификатор ОКЭД» для поиска класса и деятельности</span>';
    } else {
      if (hint) hint.textContent = '— ручной ввод, перекрывает значение из заявки';
      const found = Utils.lookupOked(code, App.refData.classifier);
      if (found) {
        result.classList.add('visible', 'oked-result--found');
        result.classList.remove('oked-result--missing');
        const sourceTag = found.source === 'exact'
          ? '<span class="oked-source oked-source--exact">точное совпадение</span>'
          : '<span class="oked-source oked-source--prefix">по префиксу</span>';
        result.innerHTML = `
          <div class="oked-found-line">
            <span class="oked-label">Класс риска:</span>
            <strong class="oked-cls">${found.cls}</strong>
            ${sourceTag}
          </div>
          <div class="oked-found-line">
            <span class="oked-label">Деятельность:</span>
            <strong class="oked-name">${found.name}</strong>
          </div>`;
      } else {
        result.classList.add('visible', 'oked-result--missing');
        result.classList.remove('oked-result--found');
        result.innerHTML = `<span class="oked-warn">⚠ ОКЭД «${code}» не найден в классификаторе</span>`;
      }
    }
    // После определения эффективного ОКЭДа — auto-выбор activity, всегда.
    // Resolved ОКЭД может быть из заявки даже когда ручной инпут пуст.
    App._autoSelectActivityByOked();
    App._renderActivityHint();
    App.renderCompanyOkeds();
  },

  // ===== ACTIVITY DROPDOWN =====
  // Структура App.refData.calculator:
  //   { activities: [{ name, deathRate, injuryRate }, ...], okedMap: { '07298': 'имя', ... } }
  // Backward-compat: если в кэше лежит массив — оборачиваем.
  _calcActivities() {
    const c = App.refData.calculator;
    if (!c) return [];
    if (Array.isArray(c)) return c;
    return c.activities || [];
  },
  _calcOkedMap() {
    const c = App.refData.calculator;
    if (!c || Array.isArray(c)) return {};
    return c.okedMap || {};
  },

  // Trackers
  _activityAutoForOked: null,  // ОКЭД, для которого dropdown был выставлен авто
  _lastResolvedOked: null,     // последний resolved ОКЭД (для UI и сравнений)

  populateActivityDropdown() {
    const select = document.getElementById('activitySelect');
    if (!select) return;
    const list = App._calcActivities();
    if (!list.length) {
      select.innerHTML = '<option value="">— загрузите справочник «Калькулятор рентабельности» —</option>';
      return;
    }
    const prev = localStorage.getItem('selected_activity_idx');
    const opts = ['<option value="">— не выбрано —</option>'];
    list.forEach((a, i) => {
      const death = (a.deathRate || 0).toFixed(3).replace('.', ',');
      const injury = (a.injuryRate || 0).toFixed(3).replace('.', ',');
      opts.push(`<option value="${i}">${a.name} (смерть ${death} / травма ${injury})</option>`);
    });
    select.innerHTML = opts.join('');
    if (prev != null && list[Number(prev)]) {
      select.value = prev;
    }
    // Auto-detect по ОКЭД (если ОКЭД уже известен и не было ручного выбора).
    App._autoSelectActivityByOked();
    App._renderActivityHint();
  },

  // user-driven event (onchange="App.onActivityChange()" в html)
  onActivityChange() {
    const select = document.getElementById('activitySelect');
    if (!select) return;
    const idx = select.value;
    if (idx === '' || idx == null) {
      localStorage.removeItem('selected_activity_idx');
      localStorage.removeItem('manual_activity_for_oked');
      App._activityAutoForOked = null;
    } else {
      localStorage.setItem('selected_activity_idx', String(idx));
      // Если пользователь сам поменял — помечаем как ручной для текущего ОКЭДа.
      if (App._lastResolvedOked) {
        localStorage.setItem('manual_activity_for_oked', App._lastResolvedOked);
      }
      App._activityAutoForOked = null;
    }
    App._renderActivityHint();
  },

  _renderActivityHint() {
    const select = document.getElementById('activitySelect');
    const result = document.getElementById('activity-result');
    if (!select || !result) return;
    const idx = select.value;
    if (idx === '' || idx == null) {
      result.classList.remove('visible', 'oked-result--found');
      result.innerHTML = '';
      return;
    }
    const a = App._calcActivities()[Number(idx)];
    if (!a) return;

    // Контекст по самой компании: ОКЭД-название (из stat.gov.kz если активный
    // ОКЭД совпадает с primary; иначе из ОКЭД-classifier через _collectCompanyOkeds),
    // класс риска, тариф.
    const resolved = App._resolveOked ? App._resolveOked() : {};
    const oked = resolved.oked || '—';
    let okedName = resolved.activity || '—';
    const sg = App.statgov && !App.statgov.loading && !App.statgov.error ? App.statgov : null;
    if (sg && resolved.oked === sg.okedPrimaryCode && sg.okedPrimaryName) {
      // Для primary берём специфичное название из stat.gov.kz
      okedName = sg.okedPrimaryName;
    } else {
      // Для secondary или ручного — ищем имя через _collectCompanyOkeds (он сам
      // соберёт name из classifier).
      const company = App._collectCompanyOkeds ? App._collectCompanyOkeds() : [];
      const found = company.find(o => o.code === resolved.oked);
      if (found && found.name) okedName = found.name;
    }
    const riskClass = resolved.riskClass || '—';
    const tariff = App._resolveTariff(resolved.riskClass);
    const tariffStr = tariff != null ? Utils.fmtPct(tariff) : '—';

    const isAuto = App._isAutoActivityForOked(resolved.oked);
    const sourceTag = isAuto
      ? '<span class="oked-source oked-source--exact">авто по ОКЭД</span>'
      : '<span class="oked-source oked-source--prefix">выбрано вручную</span>';

    result.classList.add('visible', 'oked-result--found');
    result.classList.remove('oked-result--missing');
    result.innerHTML = `
      <div class="oked-found-line">
        <span class="oked-label">ОКЭД ${oked}:</span> <strong>${okedName}</strong>
      </div>
      <div class="oked-found-line">
        <span class="oked-label">Класс риска:</span> <strong>${riskClass}</strong>
        &nbsp;&nbsp;<span class="oked-label">Тариф:</span> <strong>${tariffStr}</strong>
        &nbsp;&nbsp;${sourceTag}
      </div>`;
  },

  // Auto-detect = true, если для текущего ОКЭДа нет manual marker в localStorage
  // И в окед-маппинге калькулятора этот ОКЭД присутствует.
  _isAutoActivityForOked(oked) {
    if (!oked) return false;
    const okedMap = App._calcOkedMap();
    if (!okedMap[oked]) return false;
    return localStorage.getItem('manual_activity_for_oked') !== oked;
  },

  // Тариф «связан» с активным ОКЭДом.
  // Если ОКЭД остался из заявки (source = 'zayavka') — используем z.tariff (D12).
  // Если ОКЭД изменился (manual, statgov-max-class, override) — пересчитываем
  // через справочник/классификатор по новому классу.
  _resolveTariff(riskClass) {
    const z = App.zayavka || {};
    const resolved = App._resolveOked ? App._resolveOked() : { source: 'zayavka' };
    const okedFromZayavka = resolved.source && resolved.source.startsWith('zayavka');

    if (okedFromZayavka && z.tariff != null && z.tariff !== '') {
      const t = Number(z.tariff);
      if (Number.isFinite(t)) return t;
    }
    if (App.refData.popravka && App.refData.popravka.riskRates && riskClass) {
      const t = App.refData.popravka.riskRates.get(riskClass);
      if (Number.isFinite(t)) return t;
    }
    if (App.refData.classifier && resolved.oked) {
      const entry = App.refData.classifier.find(e => !e.isPrefix && e.okedRaw === String(resolved.oked));
      if (entry && Number.isFinite(entry.tariff)) return entry.tariff;
    }
    // Last-resort fallback на z.tariff если ничего не нашли
    if (z.tariff != null && z.tariff !== '') {
      const t = Number(z.tariff);
      if (Number.isFinite(t)) return t;
    }
    return null;
  },

  _getSelectedActivity() {
    const idx = localStorage.getItem('selected_activity_idx');
    const list = App._calcActivities();
    if (idx != null && list[Number(idx)]) {
      return list[Number(idx)];
    }
    return null;
  },

  // Авто-выбор activity по ОКЭД (если есть маппинг в калькуляторе).
  // НЕ трогает выбор, если для текущего ОКЭДа уже был ручной (manual_activity_for_oked).
  _autoSelectActivityByOked() {
    const select = document.getElementById('activitySelect');
    if (!select) return;
    const okedMap = App._calcOkedMap();
    const list = App._calcActivities();
    if (!list.length) return;

    const resolved = App._resolveOked ? App._resolveOked() : { oked: null };
    const oked = resolved.oked;
    App._lastResolvedOked = oked;
    if (!oked || !okedMap[oked]) return;

    // Если для этого ОКЭДа уже был ручной выбор — не перезаписываем.
    if (localStorage.getItem('manual_activity_for_oked') === oked) {
      // Но если он раньше был auto, сейчас уже не auto — снять метку.
      App._activityAutoForOked = null;
      return;
    }

    // okedMap[oked] — это объект { activityName, ... } после миграции на Лист3
    const entry = okedMap[oked];
    const name = (entry && typeof entry === 'object') ? entry.activityName : entry; // обр. совм. со строкой
    const idx = list.findIndex(a => a.name === name);
    if (idx >= 0) {
      select.value = String(idx);
      localStorage.setItem('selected_activity_idx', String(idx));
      App._activityAutoForOked = oked;
    }
  },

  // ===== CACHE MANAGEMENT =====
  restoreCache() {
    try {
      const nameOf = (t) => localStorage.getItem(`ref_${t}_name`) || 'Загружен';
      // Popravka
      const popravkaStr = localStorage.getItem('ref_popravka');
      if (popravkaStr) {
        const obj = JSON.parse(popravkaStr);
        App.refData.popravka = {
          riskRates: new Map(obj.riskRates),
          adjustmentCoeffs: obj.adjustmentCoeffs,
        };
        App.updateRefStatus('popravka', true, nameOf('popravka'));
      }

      // Normativ raw buffer
      const normativBase64 = localStorage.getItem('ref_normativ_raw');
      if (normativBase64) {
        App._rawNormativBuffer = App._base64ToArrayBuffer(normativBase64);
        App.refData.normativ = ExcelReader.readNormativ(App._rawNormativBuffer);
        App.updateRefStatus('normativ', true, nameOf('normativ'));
      }

      // KU
      const kuStr = localStorage.getItem('ref_ku');
      if (kuStr) {
        App.refData.ku = JSON.parse(kuStr);
        App.updateRefStatus('ku', true, nameOf('ku'));
      }

      // Calculator
      const calcStr = localStorage.getItem('ref_calculator');
      if (calcStr) {
        App.refData.calculator = JSON.parse(calcStr);
        App.updateRefStatus('calculator', true, nameOf('calculator'));
        App.populateActivityDropdown();
      }

      // Classifier
      const classifierStr = localStorage.getItem('ref_classifier');
      if (classifierStr) {
        App.refData.classifier = JSON.parse(classifierStr);
        App.updateRefStatus('classifier', true, nameOf('classifier'));
      }

      // Affiliated persons list
      const affiliatedStr = localStorage.getItem('ref_affiliated');
      if (affiliatedStr) {
        App.refData.affiliated = JSON.parse(affiliatedStr);
        App.updateRefStatus('affiliated', true, nameOf('affiliated'));
      }

      App.updateRefBadge();
    } catch (e) {
      console.error('Cache restore error:', e);
    }
  },

  clearCache() {
    localStorage.removeItem('ref_popravka');
    localStorage.removeItem('ref_normativ_raw');
    localStorage.removeItem('ref_ku');
    localStorage.removeItem('ref_calculator');
    localStorage.removeItem('ref_classifier');
    localStorage.removeItem('ref_affiliated');
    localStorage.removeItem('manual_verdict');
    localStorage.removeItem('selected_activity_idx');
    ['popravka', 'normativ', 'ku', 'calculator', 'classifier', 'affiliated']
      .forEach(t => localStorage.removeItem(`ref_${t}_name`));
    localStorage.removeItem('manual_activity_for_oked');
    App.refData = { popravka: null, normativ: null, ku: null, calculator: null, classifier: null, affiliated: null };
    App._rawNormativBuffer = null;
    ['popravka', 'normativ', 'ku', 'calculator', 'classifier', 'affiliated'].forEach(t => App.updateRefStatus(t, false));
    App.updateRefBadge();
    App.populateActivityDropdown();
    const verdictSel = document.getElementById('verdict');
    if (verdictSel) verdictSel.value = 'auto';
    App.updateVerdictHint();
    App.showMsg('Кэш очищен.', 'success');
  },

  // ===== FILE UTILS =====
  _readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(new Uint8Array(e.target.result));
      reader.onerror = () => reject(new Error('Ошибка чтения файла'));
      reader.readAsArrayBuffer(file);
    });
  },

  _arrayBufferToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  },

  _base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  },
};

// Initialize on load
document.addEventListener('DOMContentLoaded', App.init);
