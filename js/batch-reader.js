// batch-reader.js — парсер ежедневного реестра договоров ОСНС (выгрузка из АИС).
//
// На вход — .xlsx с одной строкой-заголовком (строка 1) и N строками договоров.
// Колонки находятся ПО ТЕКСТУ заголовка (устойчиво к перестановке), с запасным
// вариантом по фиксированной букве колонки (выгрузка стабильна). Возвращаем
// массив объектов-строк, отфильтрованных до ОСНС с валидным 12-значным БИН.
//
// Маппинг (подтверждён на реальной выгрузке):
//   БИН/ИИН (H) · Номер договора (D) · Страхователь (BR) · Дата договора (B)
//   Дата начала/окончания (K/L) · Страховая сумма (V) · ФОТ→ГФОТ (BY)
//   Количество объектов→работники (AL) · Класс проф риска (AK) · Код ОКЭД (AJ)
//   Вид деятельнсти Андеррайтеры (CA) · Поправочный Коэфициент (CM): 1|0,9
//   Страховая премия без коэф→премия (CU) · Страховая премия→с учётом ПК (W)
//   Не резидент (CD) · Страхователь с гос участием (DF) · Аф.лицо (E/F)
//   КлассСтрахования (S) — фильтр ОСНС · Основное подразделение (J)
//
// Тариф = премия_без_коэф / страховая_сумма (CU/V) — самосогласован с классом.
// Премия с учётом ПК (W) = CU × ПК. Решение: ПК=1 → standard, ПК=0,9 → discount.

const BatchReader = {
  // Кандидаты заголовков (нормализованные: trim+lowercase+схлоп пробелов) и
  // запасная буква колонки. Первый точно совпавший заголовок выигрывает.
  FIELDS: {
    bin:            { headers: ['бин / иин', 'бин/иин', 'бин', 'иин'], col: 'H' },
    contractNumber: { headers: ['номер договора'], col: 'D' },
    insurerName:    { headers: ['страхователь'], col: 'BR' },
    insurerNameAlt: { headers: ['контрагент полное наименование'], col: 'CB' },
    dateContract:   { headers: ['дата договора'], col: 'B' },
    periodFrom:     { headers: ['дата начала срока действия'], col: 'K' },
    periodTo:       { headers: ['дата окончания срока действия'], col: 'L' },
    insuranceSum:   { headers: ['страховая сумма'], col: 'V' },
    premiumWith:    { headers: ['страховая премия'], col: 'W' },
    premiumBase:    { headers: ['страховая премия без коэф'], col: 'CU' },
    coeff:          { headers: ['поправочный коэфициент', 'поправочный коэффициент'], col: 'CM' },
    workers:        { headers: ['количество объектов'], col: 'AL' },
    gfot:           { headers: ['фот'], col: 'BY' },
    activity:       { headers: ['вид деятельнсти андеррайтеры', 'вид деятельности андеррайтеры'], col: 'CA' },
    activityAlt:    { headers: ['вид деятельности'], col: 'AI' },
    oked:           { headers: ['код окэд'], col: 'AJ' },
    riskClass:      { headers: ['класс проф риска'], col: 'AK' },
    nonResident:    { headers: ['не резидент'], col: 'CD' },
    govParticip:    { headers: ['страхователь с гос участием'], col: 'DF' },
    affiliatedA:    { headers: ['аф. лицо', 'аф.лицо'], col: 'E' },
    affiliatedB:    { headers: ['аффилированный контрагент'], col: 'F' },
    insuranceClass: { headers: ['классстрахования', 'класс страхования'], col: 'S' },
    branch:         { headers: ['основное подразделение'], col: 'J' },
  },

  _norm(s) {
    return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
  },

  // Буква колонки Excel → 0-based индекс ('A'→0, 'AL'→37, 'CM'→90).
  _colToIndex(letters) {
    let n = 0;
    for (const ch of String(letters).toUpperCase()) {
      n = n * 26 + (ch.charCodeAt(0) - 64);
    }
    return n - 1;
  },

  // Деньги: «12 703 259», «0,9», 85000 → number. NBSP/пробелы убираем, запятая→точка.
  _money(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    const s = String(v).replace(/[\s ]/g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  },

  _int(v) {
    const n = BatchReader._money(v);
    return n == null ? null : Math.round(n);
  },

  // «20.02.2026» → Date (через Utils.parseExcelDate, понимает DD.MM.YYYY и serial).
  _date(v) {
    if (v == null || v === '') return null;
    const d = Utils.parseExcelDate(v);
    return (d && !isNaN(d)) ? d : null;
  },

  _isYes(v) {
    return BatchReader._norm(v) === 'да';
  },

  // Главный метод. arrayBuffer → { rows: [...], total, skipped }.
  parse(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
    if (!grid.length) return { rows: [], total: 0, skipped: 0 };

    // --- Заголовок: ищем строку с «бин» и «страховая сумма» среди первых 5 ---
    let headerRow = 0;
    for (let r = 0; r < Math.min(5, grid.length); r++) {
      const norm = (grid[r] || []).map(BatchReader._norm);
      if (norm.some(h => h.includes('бин')) && norm.some(h => h.includes('страховая сумма'))) {
        headerRow = r;
        break;
      }
    }
    const header = (grid[headerRow] || []).map(BatchReader._norm);

    // --- Резолвим индекс каждого поля: точный заголовок, иначе буква колонки ---
    const idx = {};
    for (const [field, def] of Object.entries(BatchReader.FIELDS)) {
      let found = -1;
      for (const cand of def.headers) {
        const i = header.indexOf(cand);
        if (i !== -1) { found = i; break; }
      }
      idx[field] = (found !== -1) ? found : BatchReader._colToIndex(def.col);
    }

    const cell = (row, field) => {
      const i = idx[field];
      return (i != null && i < row.length) ? row[i] : null;
    };

    const rows = [];
    let skipped = 0;
    for (let r = headerRow + 1; r < grid.length; r++) {
      const row = grid[r] || [];
      const binRaw = cell(row, 'bin');
      const bin = String(binRaw == null ? '' : binRaw).replace(/[\s ]/g, '').trim();
      const sClass = BatchReader._norm(cell(row, 'insuranceClass'));

      // Пропускаем пустые строки
      const hasAny = row.some(v => v != null && String(v).trim() !== '');
      if (!hasAny) continue;

      // Фильтр: только ОСНС (несчастные случаи) + валидный 12-значный БИН
      const isOsns = sClass.includes('несчаст') || sClass.includes('н.с');
      if (!/^\d{12}$/.test(bin) || (sClass && !isOsns)) {
        skipped++;
        continue;
      }

      const insuranceSum = BatchReader._money(cell(row, 'insuranceSum'));
      const premiumBase = BatchReader._money(cell(row, 'premiumBase'));
      const premiumWith = BatchReader._money(cell(row, 'premiumWith'));
      const coeff = BatchReader._money(cell(row, 'coeff'));
      const tariff = (premiumBase != null && insuranceSum)
        ? premiumBase / insuranceSum
        : null;
      const isDiscount = (coeff != null && coeff < 1);

      const name = String(cell(row, 'insurerName') || cell(row, 'insurerNameAlt') || '').trim();
      const activity = String(cell(row, 'activity') || cell(row, 'activityAlt') || '').trim();
      const affiliated = BatchReader._isYes(cell(row, 'affiliatedA'))
        || BatchReader._isYes(cell(row, 'affiliatedB'));

      rows.push({
        rowNum: r + 1,                       // человекочитаемый № строки Excel
        bin,
        contractNumber: String(cell(row, 'contractNumber') || '').trim(),
        insurerName: name,
        excelName: name,                     // сохраняем исходное имя из реестра
        branch: String(cell(row, 'branch') || '').trim(),
        dateContract: BatchReader._date(cell(row, 'dateContract')),
        periodFrom: BatchReader._date(cell(row, 'periodFrom')),
        periodTo: BatchReader._date(cell(row, 'periodTo')),
        insuranceSum,
        gfot: BatchReader._money(cell(row, 'gfot')),
        workers: BatchReader._int(cell(row, 'workers')),
        riskClass: String(cell(row, 'riskClass') || '').trim(),
        oked: String(cell(row, 'oked') || '').trim(),
        activity,
        tariff,
        premiumBase,
        coeff: coeff != null ? coeff : 1,
        premiumWithCoeff: premiumWith,
        decision: isDiscount ? 'discount' : 'standard',
        nonResident: BatchReader._isYes(cell(row, 'nonResident')),
        govParticipation: BatchReader._isYes(cell(row, 'govParticip')),
        affiliated,
        // Заполняется фоновым statgov-лукапом:
        statgov: null,           // { name, legalAddress, registrationDate, ... } | { error }
        statgovStatus: 'pending',// 'pending' | 'loading' | 'done' | 'error' | 'skip'
        ageYears: null,          // возраст компании на сегодня (из даты регистрации)
        youngAlert: false,       // компания моложе порога (по умолчанию 3 года)
      });
    }

    return { rows, total: rows.length, skipped };
  },
};

if (typeof window !== 'undefined') window.BatchReader = BatchReader;
