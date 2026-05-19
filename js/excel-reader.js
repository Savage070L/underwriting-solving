// excel-reader.js — All Excel file parsing functions

const ExcelReader = {

  // Helper: get cell value from sheet, handling merged cells
  _cell(sheet, ref) {
    const cell = sheet[ref];
    if (!cell) return null;
    return cell.v;
  },

  // Helper: get cell as string
  _cellStr(sheet, ref) {
    const v = ExcelReader._cell(sheet, ref);
    if (v == null) return '';
    return String(v).trim();
  },

  // Helper: get cell as number
  _cellNum(sheet, ref) {
    const v = ExcelReader._cell(sheet, ref);
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    const parsed = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
    return isNaN(parsed) ? null : parsed;
  },

  // Helper: get cell as date
  _cellDate(sheet, ref) {
    const cell = sheet[ref];
    if (!cell) return null;
    if (cell.t === 'd') return cell.v; // already a Date
    if (cell.t === 'n' && cell.v) return Utils.parseExcelDate(cell.v);
    if (cell.t === 's' && cell.v) return Utils.parseExcelDate(cell.v);
    return null;
  },

  // ===== READ AFFILIATED PERSONS LIST =====
  // Extracts ИИН/БИН (12-digit IDs) and names from the "Список афф. лиц" xlsx.
  // Handles both individuals (col C: "DATE, ИИН") and legal entities (col C: "№ ... ; БИН ; ...").
  // Returns array of unique entries: { id: '12-digit string', name: 'name from col B' }
  readAffiliatedList(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
    const seen = new Set();
    const entries = [];
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (!row || row.length < 3) continue;
      const name = row[1];
      const cValue = row[2];
      if (!name || !cValue) continue;
      const nameStr = String(name).trim();
      const cStr = String(cValue);
      // Match 12-digit ID (ИИН/БИН) — works for both formats
      const matches = cStr.match(/\b(\d{12})\b/g);
      if (!matches) continue;
      for (const id of matches) {
        if (seen.has(id)) continue;
        seen.add(id);
        entries.push({ id, name: nameStr });
      }
    }
    return entries;
  },

  // ===== READ ОКЭД CLASSIFIER (with exceptions) =====
  // Returns array of entries: { cls, okedRaw, isPrefix, prefix, name, exceptions: [] }
  readOkedClassifier(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
    const entries = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row || row.length < 2) continue;
      const cls = row[0];
      const oked = row[1];
      const name = row[2];
      const exclStr = row[3];
      if (cls == null || !oked) continue;
      const okedStr = String(oked).trim();
      const exceptions = exclStr
        ? String(exclStr).split(/[,;]/).map(s => s.trim()).filter(Boolean)
        : [];
      const isPrefix = /x{2,}$/i.test(okedStr);
      const prefix = isPrefix ? okedStr.replace(/x+$/i, '') : null;
      entries.push({
        cls: parseInt(cls) || 0,
        okedRaw: okedStr,
        isPrefix,
        prefix,
        name: String(name || '').trim(),
        exceptions,
      });
    }
    return entries;
  },

  // ===== READ ZAYAVKA (underwriting application) =====
  readZayavka(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
    // Find the right sheet
    let sheetName = wb.SheetNames.find(n =>
      n.toLowerCase().includes('заявка') || n.toLowerCase().includes('андерр')
    );
    if (!sheetName) sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];

    const insurerName = ExcelReader._cellStr(ws, 'D8');
    const bin = ExcelReader._cellStr(ws, 'G8');
    const region = ExcelReader._cellStr(ws, 'E3');
    const docDate = ExcelReader._cellDate(ws, 'F3');
    const insuranceType = ExcelReader._cellStr(ws, 'A7');
    const activity = ExcelReader._cellStr(ws, 'D10');
    const riskClass = ExcelReader._cellNum(ws, 'D11');
    const tariff = ExcelReader._cellNum(ws, 'D12');
    const insuranceSum = ExcelReader._cellNum(ws, 'D13');
    const workers = ExcelReader._cellNum(ws, 'D14');
    const coeff = ExcelReader._cellNum(ws, 'D15');
    const coeffDown = ExcelReader._cellNum(ws, 'D16');
    const premiumBase = ExcelReader._cellNum(ws, 'D17');
    const premiumWithCoeff = ExcelReader._cellNum(ws, 'D18');
    const paymentOrder = ExcelReader._cellStr(ws, 'D19');
    const govParticipation = ExcelReader._cellStr(ws, 'D20');
    const periodFrom = ExcelReader._cellDate(ws, 'E21');
    const periodTo = ExcelReader._cellDate(ws, 'G21');
    const oked = ExcelReader._cellStr(ws, 'D9');

    return {
      insurerName,
      bin,
      region,
      docDate,
      insuranceType: insuranceType || Utils.INSURANCE_TYPE,
      activity,
      riskClass,
      tariff,
      insuranceSum,
      workers,
      coeff,
      coeffDown,
      premiumBase,
      premiumWithCoeff,
      paymentOrder,
      govParticipation,
      periodFrom,
      periodTo,
      oked,
    };
  },

  // ===== READ CLAIMS HISTORY =====
  // Parses BOTH "Общая информация" and "Детализированная информация" sheets,
  // deduplicates by (company, claim_number), computes full analytics.
  readClaimsHistory(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });

    // ---- Parse "Общая информация" ----
    let obshchayaName = wb.SheetNames.find(n => n.toLowerCase().includes('общая'));
    if (!obshchayaName) obshchayaName = wb.SheetNames[0];
    const wsO = wb.Sheets[obshchayaName];
    const rangeO = XLSX.utils.sheet_to_json(wsO, { header: 1, raw: true });

    // ---- Find header row ----
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rangeO.length, 10); i++) {
      const row = rangeO[i];
      if (row && row[0] && String(row[0]).includes('Страховая компания')) {
        headerIdx = i; break;
      }
    }
    if (headerIdx === -1) headerIdx = 4;

    const parseDmy = (s) => {
      if (!s) return null;
      const m = String(s).trim().match(/^(\d{2})\.(\d{2})\.(\d{4})/);
      if (!m) return null;
      return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
    };

    // ---- Build map of cases keyed by (company, claim_number) ----
    const cases = new Map();
    const getCase = (company, num) => {
      const key = `${company}||${num}`;
      let c = cases.get(key);
      if (!c) {
        c = {
          company, num,
          dateSk: null, dateEntered: null,
          payDates: [], sum: 0, nPayouts: 0,
          types: new Set(), flags: new Set(),
          recognized: false, rejected: false, paidAny: false, rznu: false,
        };
        cases.set(key, c);
      }
      return c;
    };

    // From "Общая" — date + payout flag (single row per claim, sometimes duplicated)
    for (let i = headerIdx + 1; i < rangeO.length; i++) {
      const row = rangeO[i];
      if (!row || !row[0] || !row[1]) continue;
      const company = String(row[0]).trim();
      const num = String(row[1]).trim();
      const c = getCase(company, num);
      const d = parseDmy(row[2]);
      if (d && (!c.dateSk || d < c.dateSk)) c.dateSk = d;
      if (String(row[4] || '').trim() === 'Да') c.paidAny = true;
    }

    // ---- Parse "Детализированная информация" ----
    const detName = wb.SheetNames.find(n => n.toLowerCase().includes('детализ'));
    if (detName) {
      const wsD = wb.Sheets[detName];
      const rangeD = XLSX.utils.sheet_to_json(wsD, { header: 1, raw: true });
      let detHeaderIdx = -1;
      for (let i = 0; i < Math.min(rangeD.length, 10); i++) {
        const row = rangeD[i];
        if (row && row[0] && String(row[0]).includes('Страховая компания')) {
          detHeaderIdx = i; break;
        }
      }
      if (detHeaderIdx === -1) detHeaderIdx = 4;
      const dataStart = detHeaderIdx + 3; // skip sub-headers R5, R6
      for (let i = dataStart; i < rangeD.length; i++) {
        const row = rangeD[i];
        if (!row || !row[0] || !row[1]) continue;
        const company = String(row[0]).trim();
        const num = String(row[1]).trim();
        const c = getCase(company, num);
        const d = parseDmy(row[2]);
        if (d && (!c.dateSk || d < c.dateSk)) c.dateSk = d;
        const de = parseDmy(String(row[3] || '').slice(0, 10));
        if (de && (!c.dateEntered || de < c.dateEntered)) c.dateEntered = de;
        const t = String(row[4] || '').trim();
        if (t) c.types.add(t);
        const dPay = parseDmy(row[5]);
        if (dPay) c.payDates.push(dPay);
        const s = row[6];
        if (typeof s === 'number' && s > 0) { c.sum += s; c.nPayouts++; }
        if (String(row[8] || '').trim() === 'Да') c.rznu = true;
        const rs = String(row[9] || '').trim();
        if (rs) c.rawStatus = rs;
        if (rs === 'Случай признан страховым') c.recognized = true;
        if (rs === 'Недоказанность наступления страхового случая') c.rejected = true;
        if (String(row[21] || '').trim() === 'Да') c.paidAny = true;
        for (let col = 11; col <= 20; col++) {
          const v = String(row[col] || '').trim();
          if (v && v.toLowerCase() !== 'false') c.flags.add(col);
        }
      }
    }

    const allCases = Array.from(cases.values());
    const now = new Date();
    const cutoff3y = new Date(now.getFullYear() - 3, now.getMonth(), now.getDate());

    // ============ Compute analytics ============
    const within3y = allCases.filter(c => c.dateSk && c.dateSk >= cutoff3y);
    const recognized3y = within3y.filter(c => c.recognized);
    const paid3y = within3y.filter(c => c.paidAny);

    // --- Recognition stats (3y) ---
    const recognition = {
      filed: within3y.length,
      recognized: recognized3y.length,
      rejected: within3y.filter(c => c.rejected).length,
      pending: within3y.filter(c => !c.recognized && !c.rejected).length,
      paid: paid3y.length,
      rznu: within3y.filter(c => c.rznu).length,
    };

    // --- Lifetime stats ---
    const lifetime = {
      total: allCases.length,
      recognized: allCases.filter(c => c.recognized).length,
      rejected: allCases.filter(c => c.rejected).length,
      pending: allCases.filter(c => !c.recognized && !c.rejected).length,
      paid: allCases.filter(c => c.paidAny).length,
      rznu: allCases.filter(c => c.rznu).length,
    };

    // --- By year (3y) ---
    const yearMap = new Map();
    for (const c of recognized3y) {
      if (!c.dateSk) continue;
      const y = c.dateSk.getFullYear();
      let bucket = yearMap.get(y);
      if (!bucket) {
        bucket = { year: y, cases: 0, paid: 0, sum: 0, death: 0, uptHigh: 0 };
        yearMap.set(y, bucket);
      }
      bucket.cases++;
      if (c.paidAny) bucket.paid++;
      bucket.sum += c.sum;
      if (c.flags.has(11) || c.flags.has(19)) bucket.death++;
      if (c.flags.has(13) || c.flags.has(14) || c.flags.has(15)) bucket.uptHigh++;
    }
    const byYear = Array.from(yearMap.values()).sort((a, b) => a.year - b.year);

    // --- Severity buckets (3y recognized) ---
    const sev = {
      death: { count: 0, sum: 0, label: 'Смерть' },
      upt90: { count: 0, sum: 0, label: 'УПТ 90–100 %' },
      upt60: { count: 0, sum: 0, label: 'УПТ 60–89 %' },
      upt30: { count: 0, sum: 0, label: 'УПТ 30–59 %' },
      uptLow: { count: 0, sum: 0, label: 'УПТ менее 30 %' },
      earnLoss: { count: 0, sum: 0, label: 'Утрата заработка' },
      other: { count: 0, sum: 0, label: 'Иное / не классифиц.' },
    };
    for (const c of recognized3y) {
      if (c.flags.has(11) || c.flags.has(19)) {
        sev.death.count++; sev.death.sum += c.sum;
      } else if (c.flags.has(15)) {
        sev.upt90.count++; sev.upt90.sum += c.sum;
      } else if (c.flags.has(14)) {
        sev.upt60.count++; sev.upt60.sum += c.sum;
      } else if (c.flags.has(13)) {
        sev.upt30.count++; sev.upt30.sum += c.sum;
      } else if (c.flags.has(12)) {
        sev.uptLow.count++; sev.uptLow.sum += c.sum;
      } else if (c.flags.has(16) || c.flags.has(17)) {
        sev.earnLoss.count++; sev.earnLoss.sum += c.sum;
      } else {
        sev.other.count++; sev.other.sum += c.sum;
      }
    }

    // --- By insurer (3y recognized) ---
    const insMap = new Map();
    for (const c of recognized3y) {
      let b = insMap.get(c.company);
      if (!b) {
        b = { name: c.company, count: 0, sum: 0 };
        insMap.set(c.company, b);
      }
      b.count++;
      b.sum += c.sum;
    }
    const byInsurer = Array.from(insMap.values())
      .map(b => ({ ...b, avgPayment: b.count > 0 ? b.sum / b.count : 0 }))
      .sort((a, b) => b.count - a.count);

    // --- By quarter (3y recognized) ---
    const byQuarter = [
      { q: 1, label: 'Q1 (янв-мар)', cases: 0, sum: 0 },
      { q: 2, label: 'Q2 (апр-июн)', cases: 0, sum: 0 },
      { q: 3, label: 'Q3 (июл-сен)', cases: 0, sum: 0 },
      { q: 4, label: 'Q4 (окт-дек)', cases: 0, sum: 0 },
    ];
    for (const c of recognized3y) {
      if (!c.dateSk) continue;
      const q = Math.floor(c.dateSk.getMonth() / 3);
      byQuarter[q].cases++;
      byQuarter[q].sum += c.sum;
    }

    // --- Financial distribution ---
    const sums = recognized3y.filter(c => c.sum > 0).map(c => c.sum).sort((a, b) => a - b);
    const percentile = (arr, p) => {
      if (arr.length === 0) return 0;
      const idx = Math.min(Math.floor(arr.length * p), arr.length - 1);
      return arr[idx];
    };
    const finance = {
      paidCount: sums.length,
      sumTotal: sums.reduce((a, b) => a + b, 0),
      avg: sums.length > 0 ? sums.reduce((a, b) => a + b, 0) / sums.length : 0,
      min: sums.length > 0 ? sums[0] : 0,
      p25: percentile(sums, 0.25),
      median: percentile(sums, 0.5),
      p75: percentile(sums, 0.75),
      p90: percentile(sums, 0.9),
      p99: percentile(sums, 0.99),
      max: sums.length > 0 ? sums[sums.length - 1] : 0,
    };

    // --- Settlement time ---
    const delays = [];
    for (const c of recognized3y) {
      if (c.dateSk && c.payDates.length > 0) {
        const first = c.payDates.reduce((min, d) => d < min ? d : min, c.payDates[0]);
        const days = Math.floor((first - c.dateSk) / (1000 * 60 * 60 * 24));
        if (days >= 0) delays.push(days);
      }
    }
    delays.sort((a, b) => a - b);
    const settlement = {
      count: delays.length,
      avg: delays.length > 0 ? delays.reduce((a, b) => a + b, 0) / delays.length : 0,
      median: percentile(delays, 0.5),
      max: delays.length > 0 ? delays[delays.length - 1] : 0,
      buckets: {
        to30: delays.filter(d => d <= 30).length,
        to90: delays.filter(d => d > 30 && d <= 90).length,
        to180: delays.filter(d => d > 90 && d <= 180).length,
        to365: delays.filter(d => d > 180 && d <= 365).length,
        over365: delays.filter(d => d > 365).length,
      },
    };

    // --- Reporting lag (date SK → date entered) ---
    const lags = [];
    for (const c of recognized3y) {
      if (c.dateSk && c.dateEntered) {
        const days = Math.floor((c.dateEntered - c.dateSk) / (1000 * 60 * 60 * 24));
        if (days >= 0) lags.push(days);
      }
    }
    lags.sort((a, b) => a - b);
    const reportingLag = {
      count: lags.length,
      avg: lags.length > 0 ? lags.reduce((a, b) => a + b, 0) / lags.length : 0,
      median: percentile(lags, 0.5),
      max: lags.length > 0 ? lags[lags.length - 1] : 0,
    };

    // --- Annuity load ---
    const annuityDist = {};
    for (const c of recognized3y) {
      if (c.nPayouts > 0) {
        annuityDist[c.nPayouts] = (annuityDist[c.nPayouts] || 0) + 1;
      }
    }
    const annuity = {
      distribution: annuityDist,
      withMultiple: recognized3y.filter(c => c.nPayouts > 1).length,
    };

    // --- Types of risk (col 4) ---
    const typeMap = new Map();
    for (const c of recognized3y) {
      for (const t of c.types) {
        typeMap.set(t, (typeMap.get(t) || 0) + 1);
      }
    }
    const byType = Array.from(typeMap.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);

    // --- Last 12 months ---
    const cutoff12m = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    const last12 = recognized3y.filter(c => c.dateSk && c.dateSk >= cutoff12m);
    const last12Stats = {
      cases: last12.length,
      sum: last12.reduce((a, b) => a + b.sum, 0),
    };

    // --- By month (last 24 months) ---
    const cutoff24m = new Date(now.getFullYear(), now.getMonth() - 23, 1);
    const monthMap = new Map();
    for (let i = 0; i < 24; i++) {
      const d = new Date(cutoff24m.getFullYear(), cutoff24m.getMonth() + i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthMap.set(key, { ym: key, year: d.getFullYear(), month: d.getMonth() + 1, cases: 0, sum: 0, death: 0 });
    }
    for (const c of recognized3y) {
      if (!c.dateSk || c.dateSk < cutoff24m) continue;
      const key = `${c.dateSk.getFullYear()}-${String(c.dateSk.getMonth() + 1).padStart(2, '0')}`;
      const b = monthMap.get(key);
      if (b) {
        b.cases++;
        b.sum += c.sum;
        if (c.flags.has(11) || c.flags.has(19)) b.death++;
      }
    }
    const byMonth = Array.from(monthMap.values());

    // --- Largest payouts (3y recognized) — keep top 30 for table, top 10 for cards ---
    const allLargest = recognized3y
      .filter(c => c.sum > 0)
      .map(c => ({
        company: c.company,
        num: c.num,
        date: c.dateSk ? c.dateSk.toISOString() : null,
        sum: c.sum,
        types: Array.from(c.types).slice(0, 1)[0] || '',
        isDeath: c.flags.has(11) || c.flags.has(19),
        isUpt: c.flags.has(13) || c.flags.has(14) || c.flags.has(15),
      }))
      .sort((a, b) => b.sum - a.sum);
    const topLargest = allLargest.slice(0, 10);
    const top30 = allLargest.slice(0, 30);

    // --- Mean Time Between Losses (MTBL) — gap between consecutive claims ---
    const sortedDates = recognized3y
      .filter(c => c.dateSk).map(c => c.dateSk).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < sortedDates.length; i++) {
      gaps.push((sortedDates[i] - sortedDates[i - 1]) / (1000 * 60 * 60 * 24));
    }
    const mtbl = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;

    // --- Severity × Year pivot ---
    const sevByYear = {};
    for (const c of recognized3y) {
      if (!c.dateSk) continue;
      const y = c.dateSk.getFullYear();
      if (!sevByYear[y]) sevByYear[y] = { death: 0, uptHigh: 0, annuity: 0, other: 0, sumDeath: 0, sumUptHigh: 0, sumAnnuity: 0, sumOther: 0 };
      if (c.flags.has(11) || c.flags.has(19)) { sevByYear[y].death++; sevByYear[y].sumDeath += c.sum; }
      else if (c.flags.has(13) || c.flags.has(14) || c.flags.has(15)) { sevByYear[y].uptHigh++; sevByYear[y].sumUptHigh += c.sum; }
      else if (c.flags.has(16) || c.flags.has(17)) { sevByYear[y].annuity++; sevByYear[y].sumAnnuity += c.sum; }
      else { sevByYear[y].other++; sevByYear[y].sumOther += c.sum; }
    }
    const severityByYear = Object.entries(sevByYear)
      .map(([y, d]) => ({ year: parseInt(y), ...d }))
      .sort((a, b) => a.year - b.year);

    // --- Frequency-Severity decomposition ---
    const freqSeverity = {
      frequency: recognized3y.length / 3,
      severity: finance.avg,
      pureLoss: (recognized3y.length / 3) * finance.avg,
      // CV = std/mean of payments
      cv: 0,
    };
    if (sums.length > 1) {
      const mean = finance.avg;
      const variance = sums.reduce((s, v) => s + (v - mean) ** 2, 0) / sums.length;
      freqSeverity.cv = Math.sqrt(variance) / mean;
    }

    // --- Death cases (3y recognized) — list with details ---
    const deathCases = recognized3y
      .filter(c => c.flags.has(11) || c.flags.has(19))
      .map(c => ({
        company: c.company,
        num: c.num,
        date: c.dateSk ? c.dateSk.toISOString() : null,
        sum: c.sum,
      }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    // --- Per-insurer detailed (recognition rate, avg settlement) ---
    const insDetailedMap = new Map();
    for (const c of within3y) {
      const k = c.company;
      let b = insDetailedMap.get(k);
      if (!b) {
        b = { name: k, filed: 0, recognized: 0, rejected: 0, paid: 0, sum: 0,
              settlementSum: 0, settlementCount: 0, deathCount: 0, uptHighCount: 0 };
        insDetailedMap.set(k, b);
      }
      b.filed++;
      if (c.recognized) {
        b.recognized++;
        b.sum += c.sum;
        if (c.flags.has(11) || c.flags.has(19)) b.deathCount++;
        if (c.flags.has(13) || c.flags.has(14) || c.flags.has(15)) b.uptHighCount++;
        if (c.dateSk && c.payDates.length > 0) {
          const first = c.payDates.reduce((min, d) => d < min ? d : min, c.payDates[0]);
          const days = Math.floor((first - c.dateSk) / (1000 * 60 * 60 * 24));
          if (days >= 0) { b.settlementSum += days; b.settlementCount++; }
        }
      }
      if (c.rejected) b.rejected++;
      if (c.paidAny) b.paid++;
    }
    const insurerDetailed = Array.from(insDetailedMap.values())
      .map(b => ({
        ...b,
        recogRate: b.filed > 0 ? 100 * b.recognized / b.filed : 0,
        avgSettlement: b.settlementCount > 0 ? b.settlementSum / b.settlementCount : 0,
        avgPayment: b.recognized > 0 ? b.sum / b.recognized : 0,
      }))
      .sort((a, b) => b.recognized - a.recognized);

    // --- YoY growth indicators ---
    const yoYGrowth = [];
    for (let i = 1; i < byYear.length; i++) {
      const prev = byYear[i - 1];
      const cur = byYear[i];
      yoYGrowth.push({
        year: cur.year,
        casesDelta: prev.cases > 0 ? 100 * (cur.cases - prev.cases) / prev.cases : null,
        sumDelta: prev.sum > 0 ? 100 * (cur.sum - prev.sum) / prev.sum : null,
      });
    }

    // --- Sum total over 3 years ---
    const sumTotal3y = recognized3y.reduce((a, c) => a + c.sum, 0);
    const avgFreq = recognized3y.length / 3;
    const avgSumPerYear = sumTotal3y / 3;

    // --- HHI (Herfindahl-Hirschman) for insurer concentration ---
    let hhi = 0;
    const totalIns = recognized3y.length;
    if (totalIns > 0) {
      for (const b of byInsurer) {
        const share = b.count / totalIns;
        hhi += share * share * 10000;
      }
    }
    // HHI bands: <1500 фрагментирован, 1500-2500 умеренный, >2500 высокий, >5000 крайне высокий
    let hhiBand;
    if (hhi < 1500) hhiBand = 'low';
    else if (hhi < 2500) hhiBand = 'moderate';
    else if (hhi < 5000) hhiBand = 'high';
    else hhiBand = 'extreme';

    // --- Tail concentration (top 10% cases by sum / total) ---
    const sumsDesc = recognized3y.filter(c => c.sum > 0).map(c => c.sum).sort((a, b) => b - a);
    const top10Count = Math.max(1, Math.floor(sumsDesc.length * 0.1));
    const top10Sum = sumsDesc.slice(0, top10Count).reduce((a, b) => a + b, 0);
    const tailConcentration = sumsDesc.length > 0
      ? 100 * top10Sum / sumsDesc.reduce((a, b) => a + b, 0)
      : 0;

    // --- Catastrophic events (single payouts >= 50M) ---
    const catastrophicThreshold = 50000000;
    const catastrophicCount = recognized3y.filter(c => c.sum >= catastrophicThreshold).length;
    const catastrophicSum = recognized3y.filter(c => c.sum >= catastrophicThreshold)
      .reduce((a, c) => a + c.sum, 0);

    // --- Longest streak without death (days between consecutive death cases) ---
    const deathDates = recognized3y
      .filter(c => (c.flags.has(11) || c.flags.has(19)) && c.dateSk)
      .map(c => c.dateSk).sort((a, b) => a - b);
    let longestNoDeathStreak = 0;
    for (let i = 1; i < deathDates.length; i++) {
      const gap = Math.floor((deathDates[i] - deathDates[i - 1]) / (1000 * 60 * 60 * 24));
      if (gap > longestNoDeathStreak) longestNoDeathStreak = gap;
    }
    // Edge: trailing gap from last death to now
    if (deathDates.length > 0) {
      const trailing = Math.floor((now - deathDates[deathDates.length - 1]) / (1000 * 60 * 60 * 24));
      if (trailing > longestNoDeathStreak) longestNoDeathStreak = trailing;
    }

    // --- Per-worker / per-capita metrics ---
    // These are derived in the front-end with actual worker count.

    const concentration = {
      hhi,
      hhiBand,
      tailConcentration,
      top10Sum,
      top10Count,
      catastrophicCount,
      catastrophicSum,
      catastrophicThreshold,
      longestNoDeathStreak,
    };

    // --- Status distribution (all distinct values in column 9 "Результат") ---
    const statusMap = new Map();
    for (const c of within3y) {
      const key = c.rawStatus || '(пусто — в стадии рассмотрения)';
      statusMap.set(key, (statusMap.get(key) || 0) + 1);
    }
    const statusDistribution = Array.from(statusMap.entries())
      .map(([status, count]) => ({ status, count, share: 100 * count / Math.max(within3y.length, 1) }))
      .sort((a, b) => b.count - a.count);

    // --- Insurer × Year evolution matrix ---
    const insYearMap = new Map();
    for (const c of recognized3y) {
      if (!c.dateSk) continue;
      const y = c.dateSk.getFullYear();
      const key = c.company + '||' + y;
      let b = insYearMap.get(key);
      if (!b) { b = { company: c.company, year: y, count: 0, sum: 0 }; insYearMap.set(key, b); }
      b.count++;
      b.sum += c.sum;
    }
    const insurerByYear = Array.from(insYearMap.values()).sort((a, b) => a.year - b.year);

    // --- Legacy fields for backward compatibility ---
    const companyCounts = {};
    const companySums = {};
    for (const c of recognized3y) {
      companyCounts[c.company] = (companyCounts[c.company] || 0) + 1;
      companySums[c.company] = (companySums[c.company] || 0) + (c.sum || 0);
    }
    let mainCompany = '';
    let maxCount = 0;
    for (const [company, count] of Object.entries(companyCounts)) {
      if (count > maxCount) { maxCount = count; mainCompany = company; }
    }
    const fmtTg = (v) => String(Math.round(v || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' тг.';
    let summaryText = 'НС не было';
    if (recognized3y.length > 0) {
      let cf = mainCompany;
      if (!cf.startsWith('АО')) cf = `АО «КСЖ «${mainCompany}»`;
      summaryText = `${recognized3y.length} НС в ${cf} (${fmtTg(companySums[mainCompany])})`;
    }
    const detailedParts = [];
    for (const [company, count] of Object.entries(companyCounts)) {
      let cf = company;
      if (!cf.startsWith('АО')) cf = `АО «КСЖ «${company}»`;
      detailedParts.push(`${count} НС в ${cf} (${fmtTg(companySums[company])})`);
    }

    return {
      // Backward-compat (used by current generators)
      totalClaims: recognized3y.length,
      companyCounts,
      mainCompany,
      summaryText,
      detailedSummary: detailedParts.join(', ') || 'НС не было',
      allClaims: recognized3y.map(c => ({ company: c.company, date: c.dateSk })),

      // Rich analytics
      analytics: {
        cutoffDate: cutoff3y.toISOString(),
        reportDate: now.toISOString(),
        lifetime,
        recognition,
        sumTotal3y,
        avgFreq,
        avgSumPerYear,
        last12: last12Stats,
        byYear,
        byQuarter,
        byMonth,
        bySeverity: sev,
        byInsurer,
        insurerDetailed,
        byType,
        finance,
        settlement,
        reportingLag,
        annuity,
        topLargest,
        top30,
        mtbl,
        severityByYear,
        freqSeverity,
        deathCases,
        yoYGrowth,
        concentration,
        statusDistribution,
        insurerByYear,
      },
    };
  },

  // ===== READ RISK RATES =====
  readRiskRates(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const ws = wb.Sheets['risk_rates']
            || wb.Sheets[wb.SheetNames.find(n => /тариф|risk[\s_]*rate|класс/i.test(n))]
            || wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });

    // Build dense lowercase representation of a row (sparse arrays cause issues with some/findIndex)
    const lowerCells = (row) => {
      const out = [];
      const len = row ? row.length : 0;
      for (let j = 0; j < len; j++) out[j] = String(row[j] || '').toLowerCase();
      return out;
    };

    // 1. Find header row — needs «класс» AND «тариф» in SEPARATE cells (not in a title line).
    let headerIdx = -1;
    for (let i = 0; i < Math.min(data.length, 10); i++) {
      const lowers = lowerCells(data[i]);
      if (!lowers.length) continue;
      const hasClass = lowers.some(s => s.includes('класс'));
      const hasTariff = lowers.some(s => /тариф|ставк|rate/.test(s));
      // Require at least 2 distinct cells with these labels (otherwise it's a single title line)
      const distinctLabels = lowers.filter(s => s.includes('класс') || /тариф|ставк|rate/.test(s)).length;
      if (hasClass && hasTariff && distinctLabels >= 2) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx === -1) headerIdx = 1; // fallback to row 2 (0-indexed 1)

    // 2. From headers detect which column has class, which has tariff
    let classCol = 0, tariffCol = 1;
    const hdr = lowerCells(data[headerIdx]);
    hdr.forEach((s, idx) => {
      if (s.includes('класс')) classCol = idx;
      else if (/тариф|ставк|rate/.test(s)) tariffCol = idx;
    });

    // 3. Read all data rows until empty: class is a positive integer, tariff is a small number
    const rates = new Map();
    for (let i = headerIdx + 1; i < data.length; i++) {
      const row = data[i];
      if (!row) continue;
      const clsVal = row[classCol];
      const rateVal = row[tariffCol];
      if (clsVal == null || rateVal == null) continue;
      const cls = parseInt(clsVal, 10);
      const rate = Number(rateVal);
      if (!cls || !Number.isFinite(rate)) continue;
      rates.set(cls, rate);
    }
    return rates;
  },

  // ===== READ ADJUSTMENT COEFFICIENTS =====
  // Resilient: finds the header row by label «Среднегодовое количество
  // пострадавших работников» (or similar), then reads the matrix dynamically.
  // Works even if rows/columns added or removed.
  readAdjustmentCoeffs(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const ws = wb.Sheets['adjustment_coeffs']
            || wb.Sheets[wb.SheetNames.find(n => /поправоч|adjust/i.test(n))]
            || wb.Sheets[wb.SheetNames[1]]
            || wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });

    // 1. Find the header label «Среднегодовое количество пострадавших»
    let labelRow = -1, labelCol = -1;
    for (let i = 0; i < Math.min(data.length, 10); i++) {
      const row = data[i];
      if (!row) continue;
      const len = row.length || 0;
      for (let j = 0; j < len; j++) {
        const s = String(row[j] || '').toLowerCase();
        if (s.includes('среднегодов') && (s.includes('пострадав') || s.includes('работник'))) {
          labelRow = i;
          labelCol = j;
          break;
        }
      }
      if (labelRow >= 0) break;
    }
    if (labelRow === -1) {
      // Fallback: assume the legacy layout (rows 3-9, cols 1-6)
      const matrix = [];
      for (let i = 3; i <= 9; i++) {
        const row = data[i];
        if (!row) continue;
        const matRow = [];
        for (let j = 1; j <= 6; j++) matRow.push(row[j] != null ? Number(row[j]) : null);
        matrix.push(matRow);
      }
      return matrix;
    }

    // 2. The actual numeric matrix starts 2 rows below (after subheader with ranges).
    //    Numeric columns are to the right of labelCol.
    //    Detect dimensions dynamically.
    const matrixStartRow = labelRow + 2;
    const matrix = [];
    for (let i = matrixStartRow; i < data.length; i++) {
      const row = data[i];
      if (!row || row[labelCol] == null) break; // stop at first empty label
      const matRow = [];
      for (let j = labelCol + 1; j < row.length; j++) {
        const v = row[j];
        if (v == null) { matRow.push(null); continue; }
        const n = Number(v);
        matRow.push(Number.isFinite(n) ? n : null);
      }
      // Trim trailing nulls
      while (matRow.length && matRow[matRow.length - 1] == null) matRow.pop();
      if (matRow.length) matrix.push(matRow);
    }
    return matrix;
  },

  // ===== READ NORMATIV =====
  readNormativ(arrayBuffer, docDate) {
    const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
    const ws = wb.Sheets['Лист1'] || wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, cellDates: true });

    // Find the row with date strictly before the docDate month
    // Or if no docDate, use the last row
    let bestRow = null;
    let bestDate = null;

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row || !row[0] || !row[3]) continue;

      let rowDate = row[0];
      if (!(rowDate instanceof Date)) {
        rowDate = Utils.parseExcelDate(rowDate);
      }
      if (!rowDate) continue;

      if (docDate) {
        const targetDate = Utils.parseExcelDate(docDate);
        // Use the row from at least 1 full month before the document date
        // (the previous month's finalized data)
        const targetMonth = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
        if (rowDate < targetMonth) {
          if (!bestDate || rowDate > bestDate) {
            bestDate = rowDate;
            bestRow = row;
          }
        }
      } else {
        // Just take the last row with data
        bestRow = row;
        bestDate = rowDate;
      }
    }

    if (!bestRow) {
      // Fallback: last row with data
      for (let i = data.length - 1; i >= 1; i--) {
        if (data[i] && data[i][3]) {
          bestRow = data[i];
          bestDate = data[i][0] instanceof Date ? data[i][0] : Utils.parseExcelDate(data[i][0]);
          break;
        }
      }
    }

    if (!bestRow) return null;

    const assets25pct = Number(bestRow[3]); // Column D (0-indexed 3), in thousands tenge
    const portfolioShare = Number(bestRow[4]); // Column E (0-indexed 4), decimal
    const fullAssets = assets25pct / 0.25; // Full assets in thousands tenge

    return {
      date: bestDate,
      assets25pct,
      portfolioShare,
      fullAssets,
      fullAssetsTenge: fullAssets * 1000, // Convert to tenge
    };
  },

  // ===== READ KU PO KLASSAM =====
  // Resilient: dynamically locates the «Итого» row and the columns containing
  // КУ values (percentage-like numbers in 0..200 range, last two such columns).
  // Handles both: ('КУ по классам' sheet preferred), or any sheet with 'КУ' in name.
  readKuPoKlassam(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    // 1. Find the right sheet
    let ws = wb.Sheets['КУ по классам']
          || wb.Sheets[wb.SheetNames.find(n => /ку\s+по\s+классам/i.test(n))]
          || wb.Sheets[wb.SheetNames.find(n => n.toLowerCase().includes('ку'))]
          || wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });

    // 2. Find «Итого» row by label in col A
    let itogoRow = null;
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (!row || !row[0]) continue;
      const label = String(row[0]).trim().toLowerCase();
      if (label === 'итого' || label === 'итого:') {
        itogoRow = row;
        break;
      }
    }
    if (!itogoRow) {
      return { lossRatioWith: 0, lossRatioWithout: 0 };
    }

    // 3. Find the two КУ values: typically last two cells that look like percentages
    //    (0 < value < 200). Pick from right end of the row.
    const percentLike = [];
    for (let c = itogoRow.length - 1; c >= 0; c--) {
      const v = Number(itogoRow[c]);
      if (Number.isFinite(v) && v > 0 && v < 200) {
        percentLike.unshift({ col: c, val: v });
      }
      if (percentLike.length >= 4) break; // collect enough candidates
    }

    // 4. From the candidates, the LAST two adjacent ones are typically КУ_with and КУ_without.
    //    For our file: H26 (col 7) = lossRatioWith, I26 (col 8) = lossRatioWithout.
    //    Default: try cols H/I (7/8) first; if missing, fall back to percentLike pairs.
    let lossRatioWith = Number(itogoRow[7]);
    let lossRatioWithout = Number(itogoRow[8]);
    if (!Number.isFinite(lossRatioWith) || lossRatioWith === 0 ||
        !Number.isFinite(lossRatioWithout) || lossRatioWithout === 0) {
      // Use the rightmost percent-like pair as КУ values
      if (percentLike.length >= 2) {
        lossRatioWith = percentLike[percentLike.length - 2].val;
        lossRatioWithout = percentLike[percentLike.length - 1].val;
      }
    }

    return {
      lossRatioWith: lossRatioWith || 0,
      lossRatioWithout: lossRatioWithout || 0,
    };
  },

  // ===== READ CALCULATOR (rentabelnost) =====
  // Resilient: finds header by labels («Вид деятельности», «смерть», «травма»),
  // detects column positions dynamically, then reads data rows.
  readCalculator(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    // Try to find sheet with activity data (typically "Лист2")
    let ws = null;
    for (const sn of wb.SheetNames) {
      const candidate = wb.Sheets[sn];
      const sample = XLSX.utils.sheet_to_json(candidate, { header: 1, raw: true });
      // Look for header containing "вид деятельности"
      for (let i = 0; i < Math.min(sample.length, 10); i++) {
        const row = sample[i];
        if (!row) continue;
        if (row.some(c => /вид\s+деятельност/i.test(String(c || '')))) {
          ws = candidate;
          break;
        }
      }
      if (ws) break;
    }
    if (!ws) ws = wb.Sheets['Лист2'] || wb.Sheets[wb.SheetNames[1]] || wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });

    // Find header row + column indexes for name/death/injury
    // Defensive: build dense array (sparse arrays cause findIndex to pass undefined)
    const cellLowerArr = (row) => {
      const out = [];
      const len = row ? row.length : 0;
      for (let j = 0; j < len; j++) out[j] = String(row[j] || '').toLowerCase();
      return out;
    };
    let headerIdx = -1, nameCol = 0, deathCol = 1, injuryCol = 2;
    for (let i = 0; i < Math.min(data.length, 10); i++) {
      const row = data[i];
      if (!row) continue;
      const lowers = cellLowerArr(row);
      const nameIdx = lowers.findIndex(s => s.includes('вид') && s.includes('деятельност'));
      const deathIdx = lowers.findIndex(s => s.includes('смерт'));
      const injuryIdx = lowers.findIndex(s => s.includes('травм'));
      if (nameIdx >= 0 && (deathIdx >= 0 || injuryIdx >= 0)) {
        headerIdx = i;
        nameCol = nameIdx;
        if (deathIdx >= 0) deathCol = deathIdx;
        if (injuryIdx >= 0) injuryCol = injuryIdx;
        break;
      }
    }
    if (headerIdx === -1) headerIdx = 2; // fallback to legacy row 3

    const activities = [];
    for (let i = headerIdx + 1; i < data.length; i++) {
      const row = data[i];
      if (!row || !row[nameCol]) continue;
      const name = String(row[nameCol]).trim();
      if (!name) continue;
      // Skip rows that look like sub-totals/footers
      if (/^итого|всего/i.test(name)) continue;
      let deathRate = row[deathCol];
      let injuryRate = row[injuryCol];
      if (typeof deathRate === 'string' && /нет|—|-/.test(deathRate)) deathRate = 0;
      else deathRate = Number(deathRate) || 0;
      if (typeof injuryRate === 'string' && /нет|—|-/.test(injuryRate)) injuryRate = 0;
      else injuryRate = Number(injuryRate) || 0;
      activities.push({ name, deathRate, injuryRate });
    }
    return activities;
  },

  // ===== READ POPRAVOCHNYE KOEFFICIENTY (full file — both sheets) =====
  readPopravochnyeKoeff(arrayBuffer) {
    const riskRates = ExcelReader.readRiskRates(arrayBuffer);
    const adjustmentCoeffs = ExcelReader.readAdjustmentCoeffs(arrayBuffer);
    return { riskRates, adjustmentCoeffs };
  },
};
