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
      hint.textContent = '— определяется по коэффициенту при скачивании';
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
          // Also do a default read (last row)
          App.refData.normativ = ExcelReader.readNormativ(buf);
          break;
        }
        case 'ku': {
          const result = ExcelReader.readKuPoKlassam(buf);
          App.refData.ku = result;
          localStorage.setItem('ref_ku', JSON.stringify(result));
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
          break;
        }
        case 'affiliated': {
          const result = ExcelReader.readAffiliatedList(buf);
          App.refData.affiliated = result;
          localStorage.setItem('ref_affiliated', JSON.stringify(result));
          break;
        }
      }
      App.updateRefStatus(type, true, file.name);
      App.updateRefBadge();
      App.updateButtons();
    } catch (e) {
      console.error(`Error loading ${type}:`, e);
      App.showMsg(`Ошибка загрузки ${file.name}: ${e.message}`, 'error');
    }
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
        if (statusZ && p.fileNames?.zayavka) statusZ.textContent = p.fileNames.zayavka + ' (из кэша)';
      }
      if (p.claims) {
        App.claims = p.claims;
        const zoneC = document.getElementById('zone-claims');
        if (zoneC) zoneC.classList.add('loaded');
        const statusC = document.getElementById('status-claims');
        if (statusC && p.fileNames?.claims) statusC.textContent = p.fileNames.claims + ' (из кэша)';
        document.getElementById('analytics-cta')?.classList.add('visible');
      }
      if (p.binData) App.binData = p.binData;
      if (App.zayavka) App.showPreview();
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

      // Update normativ with contract date (E21) or fallback to F3
      const effectiveDate = App.zayavka.periodFrom || App.zayavka.docDate;
      if (App._rawNormativBuffer && effectiveDate) {
        App.refData.normativ = ExcelReader.readNormativ(App._rawNormativBuffer, effectiveDate);
      }

      // Show/hide date fields
      const datesRow = document.getElementById('dates-row');
      if (!App.zayavka.periodFrom || !App.zayavka.periodTo) {
        datesRow.classList.add('visible');
      } else {
        datesRow.classList.remove('visible');
      }

      // Auto-lookup BIN for address and gov participation
      if (App.zayavka.bin) {
        App.autoLookupBIN(App.zayavka.bin);
        App.autoLookupStatGov(App.zayavka.bin);
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
    const items = [
      ['Страхователь', Utils.formatCompanyName(z.insurerName)],
      ['БИН', z.bin],
      ['Регион', z.region],
      ['Дата договора', z.periodFrom ? Utils.fmtDateShort(z.periodFrom) : (z.docDate ? Utils.fmtDateShort(z.docDate) : '-')],
      ['ОКЭД', resolved.oked || z.oked || '—'],
      ['Деятельность', resolved.activity || z.activity || '—'],
      ['Класс риска', resolved.riskClass || z.riskClass || '—'],
      ['Страховая сумма', Utils.fmtMoney(z.insuranceSum)],
      ['Работники', Utils.fmtInteger(z.workers)],
      ['Премия', Utils.fmtMoney(z.premiumBase)],
      ['Премия с поправкой', Utils.fmtMoney(z.premiumWithCoeff)],
      ['Коэффициент', z.coeff],
      ['Понижающий коэфф.', z.coeffDown],
      ['Порядок оплаты', z.paymentOrder],
      ['Юр. адрес', App.binData.legalAddress || '(поиск...)'],
      ['Гос. участие', App.binData.govParticipation || z.govParticipation || '(поиск...)'],
    ];

    let html = items.map(([label, value]) =>
      `<div class="preview-item"><span class="pi-label">${label}:</span> <span class="pi-value">${value || '-'}</span></div>`
    ).join('');

    // === Блок stat.gov.kz (через chrome extension) ===
    const sg = App.statgov;
    if (sg) {
      let sgBody = '';
      if (sg.loading) {
        sgBody = '<div class="pi-loading">Поиск в реестре stat.gov.kz…</div>';
      } else if (sg.error) {
        sgBody = `<div class="pi-warn">⚠ ${sg.error}</div>
                  <div class="pi-hint">Установи расширение «Standard Life — мост к stat.gov.kz» и войди в кабинет stat.gov.kz через ЭЦП.</div>`;
      } else if (sg.found === false) {
        sgBody = `<div class="pi-warn">БИН ${sg.bin || ''} не найден в реестре stat.gov.kz.</div>`;
      } else {
        const sgItems = [
          ['Наименование (реестр)', sg.name],
          ['Дата регистрации', sg.registrationDate],
          ['Осн. ОКЭД', `${sg.okedPrimaryCode || ''} — ${sg.okedPrimaryName || ''}`],
          ['Втор. ОКЭД', sg.okedSecondaryCode],
          ['КРП (с фил.)', `${sg.krpWithBranchesCode || ''} — ${sg.krpWithBranchesName || ''}`],
          ['КРП (без фил.)', `${sg.krpWithoutBranchesCode || ''} — ${sg.krpWithoutBranchesName || ''}`],
          ['КАТО', sg.kato],
          ['Юр. адрес (реестр)', sg.legalAddress],
          ['Руководитель', sg.headFullname],
          ['КФС', `${sg.kfsCode || ''} — ${sg.kfsName || ''}`],
          ['Сектор экономики', `${sg.sectorCode || ''} — ${sg.sectorName || ''}`],
        ];
        sgBody = sgItems
          .filter(([, v]) => v && v.replace(/[—\s-]/g, ''))
          .map(([l, v]) => `<div class="preview-item"><span class="pi-label">${l}:</span> <span class="pi-value">${v}</span></div>`)
          .join('');
      }
      html += `
        <div class="preview-section">
          <div class="preview-section-title">📋 stat.gov.kz (по БИН)</div>
          ${sgBody}
        </div>`;
    }

    grid.innerHTML = html;

    panel.classList.add('visible');
  },

  // ===== AUTO LOOKUP via Chrome extension (stat.gov.kz) =====
  // Требует установленного расширения «Standard Life — мост к stat.gov.kz».
  async autoLookupStatGov(bin) {
    App.statgov = { loading: true };
    App.showPreview();
    if (typeof StatGovClient === 'undefined') {
      App.statgov = { error: 'StatGovClient не подключён', loading: false };
      App.showPreview();
      return;
    }
    try {
      const data = await StatGovClient.lookup(bin);
      App.statgov = { ...data, loading: false };
    } catch (e) {
      App.statgov = { error: e.message, loading: false };
    }
    App.showPreview();
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

  // ===== OPEN ANALYTICS DASHBOARD =====
  openAnalytics() {
    if (!App.claims || !App.claims.analytics) {
      App.showMsg('Сначала загрузите историю убытков.', 'error');
      return;
    }
    const z = App.zayavka || {};
    const resolved = App._resolveOked();
    const effRiskClass = resolved.riskClass || z.riskClass;
    const snapshot = {
      generatedAt: new Date().toISOString(),
      zayavka: {
        insurerName: z.insurerName || '',
        bin: z.bin || '',
        workers: z.workers || 0,
        riskClass: effRiskClass || '',
        oked: resolved.oked || z.oked || '',
        activity: resolved.activity || z.activity || '',
        region: z.region || '',
        insuranceSum: z.insuranceSum || 0,
        premiumBase: z.premiumBase || 0,
        premiumWithCoeff: z.premiumWithCoeff || 0,
        periodFrom: z.periodFrom ? new Date(z.periodFrom).toISOString() : null,
        periodTo: z.periodTo ? new Date(z.periodTo).toISOString() : null,
        tariff: z.tariff || null,
        coeff: z.coeff || null,
        coeffDown: z.coeffDown || 0,
        paymentOrder: z.paymentOrder || '',
        docDate: z.docDate ? new Date(z.docDate).toISOString() : null,
        govParticipation: App.binData.govParticipation || z.govParticipation || '',
        legalAddress: App.binData.legalAddress || '',
      },
      verdict: document.getElementById('verdict') ? document.getElementById('verdict').value : 'auto',
      popravka: App.refData.popravka ? {
        baseTariff: App.refData.popravka.riskRates ? App.refData.popravka.riskRates.get(effRiskClass) : null,
        allTariffs: App.refData.popravka.riskRates ? Array.from(App.refData.popravka.riskRates.entries()).map(([cls, rate]) => ({ cls, rate })) : [],
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
    };
    localStorage.setItem('analytics_snapshot', JSON.stringify(snapshot));
    window.open('analytics.html', '_blank');
  },

  // ===== TOGGLE INLINE ANALYTICS (under "Файлы по кейсу") =====
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
    // Build/refresh snapshot before opening (same as openAnalytics)
    const z = App.zayavka || {};
    const resolved2 = App._resolveOked();
    const effRC = resolved2.riskClass || z.riskClass;
    const snapshot = {
      generatedAt: new Date().toISOString(),
      zayavka: {
        insurerName: z.insurerName || '',
        bin: z.bin || '',
        workers: z.workers || 0,
        riskClass: effRC || '',
        oked: resolved2.oked || z.oked || '',
        activity: resolved2.activity || z.activity || '',
        region: z.region || '',
        insuranceSum: z.insuranceSum || 0,
        premiumBase: z.premiumBase || 0,
        premiumWithCoeff: z.premiumWithCoeff || 0,
        periodFrom: z.periodFrom ? new Date(z.periodFrom).toISOString() : null,
        periodTo: z.periodTo ? new Date(z.periodTo).toISOString() : null,
        coeff: z.coeff || null,
        coeffDown: z.coeffDown || 0,
        paymentOrder: z.paymentOrder || '',
        docDate: z.docDate ? new Date(z.docDate).toISOString() : null,
        govParticipation: App.binData.govParticipation || z.govParticipation || '',
        legalAddress: App.binData.legalAddress || '',
        tariff: z.tariff || null,
      },
      verdict: document.getElementById('verdict') ? document.getElementById('verdict').value : 'auto',
      popravka: App.refData.popravka ? {
        baseTariff: App.refData.popravka.riskRates ? App.refData.popravka.riskRates.get(effRC) : null,
        allTariffs: App.refData.popravka.riskRates ? Array.from(App.refData.popravka.riskRates.entries()).map(([cls, rate]) => ({ cls, rate })) : [],
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
    };
    localStorage.setItem('analytics_snapshot', JSON.stringify(snapshot));
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

    // Get dates (from Excel or form)
    let periodFrom = z.periodFrom;
    let periodTo = z.periodTo;
    if (!periodFrom) {
      const val = document.getElementById('periodFrom').value;
      if (val) periodFrom = new Date(val);
    }
    if (!periodTo) {
      const val = document.getElementById('periodTo').value;
      if (val) periodTo = new Date(val);
    }

    // Apply ОКЭД override (manual input > zayavka). Resolves class+name via classifier.
    const resolved = App._resolveOked();
    const effectiveOked = resolved.oked;
    const effectiveRiskClass = resolved.riskClass;
    const effectiveActivity = resolved.activity;

    // Tariff resolution: prefer zayavka's manual value (D12), fall back to справочник.
    let tariff = (z.tariff != null && z.tariff !== '') ? Number(z.tariff) : null;
    if (tariff == null && App.refData.popravka && effectiveRiskClass) {
      tariff = App.refData.popravka.riskRates.get(effectiveRiskClass);
    }

    // Activity for death/injury rates — picked manually from dropdown (sourced from Лист2 of калькулятор).
    let selectedActivity = App._getSelectedActivity();

    // Document date = date of zayavka submission (F3 in Excel) — per AR template,
    // this is the date when the application was filed, NOT the contract start date.
    const docDate = z.docDate || periodFrom;

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

    return {
      ...z,
      oked: effectiveOked || z.oked,
      riskClass: effectiveRiskClass,
      activity: effectiveActivity,
      docDate,
      docNumber,
      legalAddress: App.binData.legalAddress || '-',
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
  // Manual ОКЭД input overrides zayavka. Lookup in classifier resolves class+name.
  _resolveOked() {
    const z = App.zayavka || {};
    const manual = (document.getElementById('okedInput')?.value || '').trim();
    const oked = manual || z.oked || '';
    let riskClass = z.riskClass;
    let activity = z.activity;
    let source = manual ? 'manual' : 'zayavka';
    if (oked && App.refData.classifier) {
      const found = Utils.lookupOked(oked, App.refData.classifier);
      if (found) {
        riskClass = found.cls;
        activity = found.name;
        source = manual ? 'manual+classifier' : 'zayavka+classifier';
      }
    }
    return { oked, riskClass, activity, source };
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
      return;
    }
    if (hint) hint.textContent = '— ручной ввод, перекрывает значение из заявки';
    if (!App.refData.classifier) {
      result.classList.add('visible', 'oked-result--missing');
      result.classList.remove('oked-result--found');
      result.innerHTML = '<span class="oked-warn">⚠ Загрузите справочник «Классификатор ОКЭД» для поиска класса и деятельности</span>';
      return;
    }
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
  },

  // ===== ACTIVITY DROPDOWN (filled from калькулятор Лист2) =====
  populateActivityDropdown() {
    const select = document.getElementById('activitySelect');
    if (!select) return;
    const list = App.refData.calculator || [];
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
    App.onActivityChange();
  },

  onActivityChange() {
    const select = document.getElementById('activitySelect');
    const result = document.getElementById('activity-result');
    if (!select) return;
    const idx = select.value;
    if (idx === '' || idx == null) {
      localStorage.removeItem('selected_activity_idx');
      if (result) {
        result.classList.remove('visible', 'oked-result--found');
        result.innerHTML = '';
      }
      return;
    }
    localStorage.setItem('selected_activity_idx', String(idx));
    const a = (App.refData.calculator || [])[Number(idx)];
    if (a && result) {
      const death = (a.deathRate || 0).toFixed(3).replace('.', ',');
      const injury = (a.injuryRate || 0).toFixed(3).replace('.', ',');
      result.classList.add('visible', 'oked-result--found');
      result.classList.remove('oked-result--missing');
      result.innerHTML = `
        <div class="oked-found-line">
          <span class="oked-label">Коэф. смерти:</span> <strong>${death}</strong> на 1 000 чел.
          &nbsp;&nbsp;<span class="oked-label">Коэф. травматизма:</span> <strong>${injury}</strong> на 1 000 чел.
        </div>`;
    }
  },

  _getSelectedActivity() {
    const idx = localStorage.getItem('selected_activity_idx');
    const list = App.refData.calculator || [];
    if (idx != null && list[Number(idx)]) {
      return list[Number(idx)];
    }
    return null;
  },

  // ===== CACHE MANAGEMENT =====
  restoreCache() {
    try {
      // Popravka
      const popravkaStr = localStorage.getItem('ref_popravka');
      if (popravkaStr) {
        const obj = JSON.parse(popravkaStr);
        App.refData.popravka = {
          riskRates: new Map(obj.riskRates),
          adjustmentCoeffs: obj.adjustmentCoeffs,
        };
        App.updateRefStatus('popravka', true, 'из кэша');
      }

      // Normativ raw buffer
      const normativBase64 = localStorage.getItem('ref_normativ_raw');
      if (normativBase64) {
        App._rawNormativBuffer = App._base64ToArrayBuffer(normativBase64);
        App.refData.normativ = ExcelReader.readNormativ(App._rawNormativBuffer);
        App.updateRefStatus('normativ', true, 'из кэша');
      }

      // KU
      const kuStr = localStorage.getItem('ref_ku');
      if (kuStr) {
        App.refData.ku = JSON.parse(kuStr);
        App.updateRefStatus('ku', true, 'из кэша');
      }

      // Calculator
      const calcStr = localStorage.getItem('ref_calculator');
      if (calcStr) {
        App.refData.calculator = JSON.parse(calcStr);
        App.updateRefStatus('calculator', true, 'из кэша');
        App.populateActivityDropdown();
      }

      // Classifier
      const classifierStr = localStorage.getItem('ref_classifier');
      if (classifierStr) {
        App.refData.classifier = JSON.parse(classifierStr);
        App.updateRefStatus('classifier', true, 'из кэша');
      }

      // Affiliated persons list
      const affiliatedStr = localStorage.getItem('ref_affiliated');
      if (affiliatedStr) {
        App.refData.affiliated = JSON.parse(affiliatedStr);
        App.updateRefStatus('affiliated', true, 'из кэша');
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
