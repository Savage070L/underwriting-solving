// batch-reader.js — парсер выгрузки «АндерРешение» (Рекомендация ДАиП) из АИС.
//
// На вход — .xlsx с одной строкой-заголовком (строка 1) и N строками решений.
// Колонки находятся ПО ТЕКСТУ заголовка (устойчиво к перестановке), с запасным
// вариантом по фиксированной букве колонки. Возвращаем массив объектов-строк,
// отфильтрованных по валидному 12-значному БИН/ИИН.
//
// Маппинг (по выгрузке «АндерРешение»):
//   Страхователь ← НаименованиеСтрахователя (C) · БИН Страхователя ← БИНСтрахователя (D)
//   Наименование ← Контрагент (E) · БИН ← БИНКонтрагента (F)
//   ОКЭД ← КодОКЭД (H) · Класс ← КлассПрофРиска (J)
//   Кол-во работников ← КоличествоРаботников (K)
//   ФОТ ← ФОТ (L) · Страх. сумма ← СтраховаяСумма (N)
//   Страх. премия ← СтраховаяПремия (R) · Премия с ПК = премия × ПК (по строке)
//   ПК ← ПоправочныйКоэффициент (P) · Гос. участие ← ГосУчастие (T)
//   Автор/менеджер ← Менеджер (U) · Номер договора ← НомерДоговора (B)
//   Регион ← Регион (G) · Деятельность ← ВидДеятельности (I) · Оплата ← ПорядокОплаты (X)
//   Срок действия ← НачПериодаДействия/КонПериодаДействия (V/W), «27.05.2026 0:00:00»
//
// Тариф = премия / страховая_сумма (Q/M) — самосогласован с классом.
// Дата договора вычисляется из номера договора (цифры [2..8) = ДД.ММ.ГГ).
// Решение: ПК=1 → standard, ПК<1 → discount.

const BatchReader = {
  // Кандидаты заголовков (нормализованные: trim+lowercase+схлоп пробелов) и
  // запасная буква колонки. Первый точно совпавший заголовок выигрывает.
  // Заголовки поддерживают обе версии выгрузки (новую и прежнюю).
  FIELDS: {
    contractNumber: { headers: ['номердоговора'], col: 'B' },
    insurerNameSt:  { headers: ['наименованиестрахователя'], col: 'C' },
    binInsurer:     { headers: ['бинстрахователя'], col: 'D' },
    insurerName:    { headers: ['контрагент'], col: 'E' },
    // БИН для проверок — Контрагента; если в выгрузке нет колонки БИНКонтрагента
    // (сокращённый формат), берём БИН Страхователя.
    bin:            { headers: ['бинконтрагента', 'бинстрахователя'], col: 'F' },
    region:         { headers: ['регион'], col: 'G' },
    oked:           { headers: ['кодокэд', 'код окэд'], col: 'H' },
    activity:       { headers: ['виддеятельности'], col: 'I' },
    riskClass:      { headers: ['класспрофриска'], col: 'J' },
    workers:        { headers: ['количествоработников'], col: 'K' },
    gfot:           { headers: ['фот'], col: 'L' },
    insuranceSum:   { headers: ['страховаясумма'], col: 'N' },        // per-row (для документа АР)
    insuranceSumTotal: { headers: ['общаястраховаясумма'], col: 'M' }, // ИТОГ по договору (таблица/проверки)
    coeff:          { headers: ['поправочныйкоэффициент'], col: 'P' },
    // R (СтраховаяПремия) = премия С ПК (per-row, для документа). Премия ДО ПК = R/ПК.
    // Для таблицы/проверок берём ИТОГ по договору из «ОбщаяСтраховаяПремия» (premiumTotal).
    premiumWith:    { headers: ['страховаяпремия'], col: 'R' },
    premiumTotal:   { headers: ['общаястраховаяпремия'], col: 'Q' },
    govParticip:    { headers: ['госучастие'], col: 'T' },
    author:         { headers: ['менеджер', 'автор'], col: 'U' },
    paymentOrder:   { headers: ['порядокоплаты'], col: 'X' },
    // Срок действия — формат «27.05.2026 0:00:00» (парсится в _date).
    periodFrom:     { headers: ['начпериодадействия', 'дата начала срока действия'], col: 'V' },
    periodTo:       { headers: ['конпериодадействия', 'дата окончания срока действия'], col: 'W' },
  },

  _norm(s) {
    return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
  },

  // Буква колонки Excel → 0-based индекс ('A'→0, 'L'→11, 'T'→19).
  _colToIndex(letters) {
    let n = 0;
    for (const ch of String(letters).toUpperCase()) {
      n = n * 26 + (ch.charCodeAt(0) - 64);
    }
    return n - 1;
  },

  // Деньги: «21540000,00», «0,9», 85000 → number. NBSP/пробелы убираем, запятая→точка.
  _money(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    const s = String(v).replace(/[\s ]/g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  },

  _int(v) {
    const n = BatchReader._money(v);
    return n == null ? null : Math.round(n);
  },

  // «20.02.2026», «27.05.2026 0:00:00», serial → Date (через Utils.parseExcelDate).
  // У строки с датой-временем берём дату до пробела.
  _date(v) {
    if (v == null || v === '') return null;
    let val = v;
    if (typeof v === 'string') {
      const m = v.trim().match(/^\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}/);
      if (m) val = m[0];
    }
    if (typeof Utils === 'undefined' || !Utils.parseExcelDate) return null;
    const d = Utils.parseExcelDate(val);
    return (d && !isNaN(d)) ? d : null;
  },

  // Дата из номера договора: игнорируем все нецифровые символы, берём цифры.
  // [0..2) — код продукта (04 = ОСНС), [2..8) — дата в формате ДД.ММ.ГГ.
  // Пример: «T04290526080002» → цифры «04290526080002» → 29.05.2026.
  _contractDate(contractNumber) {
    const digits = String(contractNumber == null ? '' : contractNumber).replace(/\D/g, '');
    if (digits.length < 8) return null;
    const dd = parseInt(digits.slice(2, 4), 10);
    const mm = parseInt(digits.slice(4, 6), 10);
    const yy = parseInt(digits.slice(6, 8), 10);
    if (!dd || !mm || dd > 31 || mm > 12) return null;
    const d = new Date(2000 + yy, mm - 1, dd);
    return isNaN(d) ? null : d;
  },

  _isYes(v) {
    return BatchReader._norm(v) === 'да';
  },

  // Карта поле→индекс колонки по строке заголовков (сырой массив ячеек):
  // точное совпадение нормализованного заголовка, иначе запасная буква колонки.
  // Используется и в parse(), и при выгрузке ошибок (подсветка нужных колонок).
  resolveIdx(headerRowRaw) {
    const header = (headerRowRaw || []).map(BatchReader._norm);
    const idx = {};
    for (const [field, def] of Object.entries(BatchReader.FIELDS)) {
      let found = -1;
      for (const cand of def.headers) {
        const i = header.indexOf(cand);
        if (i !== -1) { found = i; break; }
      }
      // Сопоставляем СТРОГО по тексту заголовка. Запасную «букву колонки» НЕ
      // используем: у выгрузок разный набор колонок (в одних есть БИНКонтрагента/
      // КодОКЭД/ФОТ, в других — нет), и фиксированная буква хватала бы СОСЕДНЮЮ
      // не ту колонку. Нет заголовка → поле отсутствует (-1), проверка по нему не идёт.
      idx[field] = found;
    }
    return idx;
  },

  // Главный метод. arrayBuffer → { rows: [...], total, skipped }.
  parse(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
    if (!grid.length) return { rows: [], total: 0, skipped: 0 };

    // --- Заголовок: ищем строку с «бин» и «окэд» среди первых 5 ---
    let headerRow = 0;
    for (let r = 0; r < Math.min(5, grid.length); r++) {
      const norm = (grid[r] || []).map(BatchReader._norm);
      if (norm.some(h => h.includes('бин')) && norm.some(h => h.includes('окэд'))) {
        headerRow = r;
        break;
      }
    }
    // --- Резолвим индекс каждого поля: точный заголовок, иначе буква колонки ---
    const idx = BatchReader.resolveIdx(grid[headerRow] || []);

    const cell = (row, field) => {
      const i = idx[field];
      return (i != null && i >= 0 && i < row.length) ? row[i] : null;
    };

    const rows = [];
    let skipped = 0;
    for (let r = headerRow + 1; r < grid.length; r++) {
      const row = grid[r] || [];
      const binRaw = cell(row, 'bin');
      const bin = String(binRaw == null ? '' : binRaw).replace(/[\s ]/g, '').trim();

      // Пропускаем пустые строки
      const hasAny = row.some(v => v != null && String(v).trim() !== '');
      if (!hasAny) continue;

      // Фильтр: валидный 12-значный БИН/ИИН
      if (!/^\d{12}$/.test(bin)) {
        skipped++;
        continue;
      }

      const insuranceSum = BatchReader._money(cell(row, 'insuranceSum'));
      const coeff = BatchReader._money(cell(row, 'coeff'));
      const coeffNum = (coeff != null && coeff > 0) ? coeff : 1;
      // R (СтраховаяПремия) = премия С ПК (per-row). Премия ДО ПК = R / ПК —
      // для одиночных договоров совпадает с S «СтраховаяПремияСПК» (ФОТ×тариф),
      // для филиалов даёт корректную per-row премию (S там — ИТОГ по договору).
      const premiumWith = BatchReader._money(cell(row, 'premiumWith'));   // R, с ПК
      const premiumBase = (premiumWith != null)
        ? Math.round(premiumWith / coeffNum * 100) / 100                  // до ПК
        : null;
      const premiumWithCoeff = premiumWith;                              // с ПК (как в выгрузке)
      const tariff = (premiumBase != null && insuranceSum)
        ? premiumBase / insuranceSum
        : null;
      const isDiscount = (coeff != null && coeff < 1);
      // ИТОГ по договору (для таблицы/проверок). Если колонки нет — берём per-row.
      const insuranceSumTotalRaw = BatchReader._money(cell(row, 'insuranceSumTotal'));
      const premiumTotalRaw = BatchReader._money(cell(row, 'premiumTotal'));
      const insuranceSumTotal = insuranceSumTotalRaw != null ? insuranceSumTotalRaw : insuranceSum;
      const premiumTotal = premiumTotalRaw != null ? premiumTotalRaw : premiumWithCoeff;

      const name = String(cell(row, 'insurerName') || '').trim();
      const activity = String(cell(row, 'activity') || '').trim();
      const contractNumber = String(cell(row, 'contractNumber') || '').trim();

      rows.push({
        rowNum: r + 1,                       // человекочитаемый № строки Excel
        _raw: row,                           // исходные ячейки строки (для выгрузки превышений в оригинальном формате)
        bin,
        contractNumber,
        // Страхователь (C/D) — отдельная сторона договора. По БИН Страхователя
        // (а не Контрагента) проверяется возраст компании (≥3 лет для ПК).
        insurerNameSt: String(cell(row, 'insurerNameSt') || '').trim(),
        binInsurer: String(cell(row, 'binInsurer') == null ? '' : cell(row, 'binInsurer')).replace(/[\s ]/g, '').trim(),
        insurerName: name,
        excelName: name,                     // сохраняем исходное имя из выгрузки (Контрагент)
        author: String(cell(row, 'author') || '').trim(),   // андеррайтер-автор решения
        region: String(cell(row, 'region') || '').trim(),
        paymentOrder: String(cell(row, 'paymentOrder') || '').trim(),
        branch: '',
        // Дата договора — из номера договора (цифры [2..8) = ДД.ММ.ГГ).
        dateContract: BatchReader._contractDate(contractNumber),
        // Срок действия — из новых столбцов выгрузки (если есть), иначе null.
        periodFrom: BatchReader._date(cell(row, 'periodFrom')),
        periodTo: BatchReader._date(cell(row, 'periodTo')),
        insuranceSum,
        insuranceSumTotal,                   // ОбщаяСтраховаяСумма (ИТОГ по договору) — таблица/проверки
        premiumTotal,                        // ОбщаяСтраховаяПремия (ИТОГ с ПК) — таблица/проверки
        gfot: BatchReader._money(cell(row, 'gfot')),
        workers: BatchReader._int(cell(row, 'workers')),
        riskClass: String(cell(row, 'riskClass') ?? '').trim(),
        oked: String(cell(row, 'oked') || '').trim(),
        activity,
        tariff,
        premiumBase,
        coeff: coeff != null ? coeff : 1,
        premiumWithCoeff,
        decision: isDiscount ? 'discount' : 'standard',
        nonResident: false,
        govParticipation: BatchReader._isYes(cell(row, 'govParticip')),
        affiliated: false,
        // Заполняется фоновым statgov-лукапом:
        statgov: null,           // { name, legalAddress, registrationDate, ... } | { error }
        statgovStatus: 'pending',// 'pending' | 'loading' | 'done' | 'error' | 'skip'
        ageYears: null,          // возраст компании на сегодня (из даты регистрации)
        youngAlert: false,       // компания моложе порога (по умолчанию 3 года)
      });
    }

    // header — исходная строка заголовков (для выгрузки превышений в оригинальном формате).
    // idx — карта поле→индекс колонки (для подсветки ошибочных ячеек при выгрузке).
    return { rows, total: rows.length, skipped, header: grid[headerRow] || [], idx };
  },
};

if (typeof window !== 'undefined') window.BatchReader = BatchReader;
