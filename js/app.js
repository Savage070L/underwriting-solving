// app.js — UI orchestration, file handling, BIN lookup, localStorage caching

const App = {
  // State
  zayavka: null,
  claims: null,
  binData: {         // auto-fetched by BIN
    legalAddress: null,
    govParticipation: null,
  },
  refData: {
    popravka: null,   // { riskRates: Map, adjustmentCoeffs: matrix }
    normativ: null,   // stored as raw arrayBuffer JSON
    ku: null,
    calculator: null, // array of activity objects
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
          App.populateActivityDropdown(result);
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
      }

      // Show preview
      App.showPreview();

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

    const items = [
      ['Страхователь', Utils.formatCompanyName(z.insurerName)],
      ['БИН', z.bin],
      ['Регион', z.region],
      ['Дата договора', z.periodFrom ? Utils.fmtDateShort(z.periodFrom) : (z.docDate ? Utils.fmtDateShort(z.docDate) : '-')],
      ['Деятельность', z.activity],
      ['Класс риска', z.riskClass],
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

    grid.innerHTML = items.map(([label, value]) =>
      `<div class="preview-item"><span class="pi-label">${label}:</span> <span class="pi-value">${value || '-'}</span></div>`
    ).join('');

    panel.classList.add('visible');
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
    const snapshot = {
      generatedAt: new Date().toISOString(),
      zayavka: {
        insurerName: z.insurerName || '',
        bin: z.bin || '',
        workers: z.workers || 0,
        riskClass: z.riskClass || '',
        oked: z.oked || '',
        activity: z.activity || '',
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
        baseTariff: App.refData.popravka.riskRates ? App.refData.popravka.riskRates.get(z.riskClass) : null,
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
      activity: (() => {
        const idx = document.getElementById('activityType').value;
        if (idx !== '' && App.refData.calculator) {
          return App.refData.calculator[parseInt(idx)] || null;
        }
        return null;
      })(),
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
    const snapshot = {
      generatedAt: new Date().toISOString(),
      zayavka: {
        insurerName: z.insurerName || '',
        bin: z.bin || '',
        workers: z.workers || 0,
        riskClass: z.riskClass || '',
        oked: z.oked || '',
        activity: z.activity || '',
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
        baseTariff: App.refData.popravka.riskRates ? App.refData.popravka.riskRates.get(z.riskClass) : null,
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
      activity: (() => {
        const idx = document.getElementById('activityType').value;
        if (idx !== '' && App.refData.calculator) {
          return App.refData.calculator[parseInt(idx)] || null;
        }
        return null;
      })(),
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

    // Get tariff from risk rates
    let tariff = null;
    if (App.refData.popravka && z.riskClass) {
      tariff = App.refData.popravka.riskRates.get(z.riskClass);
    }

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

    // Get selected activity from calculator
    let selectedActivity = null;
    const actIdx = document.getElementById('activityType').value;
    if (actIdx !== '' && App.refData.calculator) {
      selectedActivity = App.refData.calculator[parseInt(actIdx)];
    }

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

    return {
      ...z,
      docDate,
      docNumber,
      legalAddress: App.binData.legalAddress || '-',
      nonResident: document.getElementById('nonResident').checked,
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
    document.getElementById('ref-badge').textContent = `${count}/4 загружено`;
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

  populateActivityDropdown(activities) {
    const select = document.getElementById('activityType');
    select.innerHTML = '<option value="">— Выберите вид деятельности —</option>';
    activities.forEach((act, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = act.name;
      select.appendChild(opt);
    });
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
        App.populateActivityDropdown(App.refData.calculator);
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
    localStorage.removeItem('manual_verdict');
    App.refData = { popravka: null, normativ: null, ku: null, calculator: null };
    App._rawNormativBuffer = null;
    ['popravka', 'normativ', 'ku', 'calculator'].forEach(t => App.updateRefStatus(t, false));
    App.updateRefBadge();
    document.getElementById('activityType').innerHTML = '<option value="">— Загрузите калькулятор —</option>';
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
