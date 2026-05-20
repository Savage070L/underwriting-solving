// utils.js — Constants, formatting, and shared utilities

const Utils = {
  // ===== CONSTANTS =====

  // Legacy threshold (kept for backward compatibility)
  LIMIT_AS: 3000000000,

  // === New AS / Pravlenie / SD thresholds ===
  // АС: 2-10 млрд для классов 1-15, ИЛИ 1,5-10 млрд для классов 16-22
  // Правление: > 10 млрд И ≤ 25% активов компании
  // СД: страх. сумма > 25% активов компании
  LIMIT_AS_LOW_CLS_1_15: 2000000000,   // 2 млрд для классов 1–15
  LIMIT_AS_LOW_CLS_16_22: 1500000000,  // 1,5 млрд для классов 16–22
  LIMIT_AS_HIGH: 10000000000,          // 10 млрд верхняя граница АС
  LIMIT_SD_ASSETS_RATIO: 0.25,         // 25 % от активов — порог СД

  // Совет директоров (адресат СЗ на СД)
  SD_CHAIR_ROLE: 'Председатель Совета директоров',
  SD_CHAIR_NAME: 'М.К. Альжанов',

  // Кто подписывает СЗ
  DAIP_DIRECTOR_ROLE: 'Директор ДАиП',
  DAIP_DIRECTOR_NAME: 'Джелкобаев Т.К.',
  PRAVLENIE_CHAIR_ROLE: 'Председатель Правления',
  PRAVLENIE_CHAIR_NAME: 'Г. Амерходжаев',
  UPRAV_DIR_ROLE: 'Управляющий директор',
  UPRAV_DIR_NAME: 'Аринов Д.С.',

  // Underwriting Council members (6 people) — insurance sum <= 3 billion
  AS_MEMBERS: [
    ['Председатель Правления', 'Амерходжаев Г.Т.'],
    ['Заместитель председателя Правления, член Правления', 'Кныкова А.У.'],
    ['Управляющий директор', 'Уткин А.С.'],
    ['Руководитель Службы управления рисками', 'Осинцев Р.С.'],
    ['Управляющий директор', 'Аринов Д.С.'],
    ['Директор ДАиП', 'Джелкобаев Т.К.'],
  ],

  // Pravlenie members (3 people) — insurance sum > 3 billion
  PRAVLENIE_MEMBERS: [
    ['Председатель Правления', 'Амерходжаев Г.Т.'],
    ['Заместитель председателя Правления, член Правления', 'Кныкова А.У.'],
    ['Главный бухгалтер, член Правления', 'Керн Ю.П.'],
  ],

  PRAVLENIE_SECRETARY: 'Боева И.В.',
  AS_SECRETARY: 'Клейнбок О.И.',

  BENEFICIARY_TEXT:
    'Пострадавший работник (в случае его смерти – лицо, имеющее согласно  законам Республики Казахстан право на возмещение вреда в связи со смертью работника), а также Страхователь или иное лицо, возместившее Выгодоприобретателю причиненный вред в пределах объема ответственности Страховщика, и получившие право на страховую выплату',

  COVERAGE_TEXT:
    'Производственная травма, внезапное ухудшение здоровья или отравление работника, приведшее к установлению ему степени утраты профессиональной трудоспособности, профессиональному заболеванию либо смерти.',

  REINSURANCE_TEXT: 'передача риска в перестраховочный пул.',

  INSURANCE_TYPE:
    'Обязательное страхование работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей',

  // Covered risks boilerplate for Zaklyuchenie (rendered as a bulleted list)
  COVERED_RISKS: [
    'Возмещение расходов, вызванных повреждением здоровья работника в случае установления ему степени утраты профессиональной трудоспособности.',
    'Возмещение вреда, связанного с утратой заработка (дохода) работником в связи с установлением ему степени утраты профессиональной трудоспособности на срок один год и более, осуществляется в виде аннуитетных выплат в пользу работника в течение срока, равного сроку установления либо продления (переосвидетельствования) степени утраты профессиональной трудоспособности работника в соответствии с договором аннуитета.',
    'Возмещение вреда, связанного со смертью работника при наступлении несчастного случая, а также по причине ухудшения его здоровья вследствие произошедшего несчастного случая, осуществляется в виде аннуитетных выплат в пользу лиц, имеющих согласно законам Республики Казахстан право на возмещение вреда, в течение срока, установленного Гражданским кодексом Республики Казахстан.',
    'Расходы на погребение умершего работника.',
  ],

  ZAKL_BENEFICIARY_TAIL:
    ', в случае смерти работника – лицо, имеющее согласно Законам Республики Казахстан право на возмещение вреда, в связи со смертью работника, а также Страхователь или иное лицо, возместившее Выгодоприобретателю причиненный вред в пределах объема ответственности Страховщика, и получившие право на страховую выплату.',

  COMPANY_FULL_NAME: 'АО «Компания по страхованию жизни «Standard Life»',

  RUSSIAN_MONTHS: [
    'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
  ],

  // ===== FORMATTING FUNCTIONS =====

  // Format date as DD.MM.YYYY
  fmtDateShort(date) {
    if (!date) return '';
    if (!(date instanceof Date)) date = Utils.parseExcelDate(date);
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
  },

  // Format date as «DD» месяц YYYYг.
  fmtDateRu(date) {
    if (!date) return '';
    if (!(date instanceof Date)) date = Utils.parseExcelDate(date);
    const dd = String(date.getDate()).padStart(2, '0');
    const month = Utils.RUSSIAN_MONTHS[date.getMonth()];
    const yyyy = date.getFullYear();
    return `«${dd}» ${month} ${yyyy}г.`;
  },

  // Format date as DD.MM.YYYYг.
  fmtDateWithG(date) {
    return Utils.fmtDateShort(date) + 'г.';
  },

  // Format money: 58 830 248,00 тенге
  fmtMoney(value) {
    return Utils.fmtMoneyRaw(value) + ' тенге';
  },

  // Format money without "тенге" suffix (rounds to integer, shows ,00)
  fmtMoneyRaw(value) {
    if (value == null || isNaN(value)) return '-';
    // Сохраняем копейки из заявки: «5 313 852 043,57» (не округляем до целого).
    // Округление до 2 знаков — защита от float-noise.
    const num = Math.round(Number(value) * 100) / 100;
    const parts = num.toFixed(2).split('.');
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
    return intPart + ',' + parts[1];
  },

  // Format money with тг. suffix (rounds to integer, no decimals): "14 545 424 тг."
  fmtMoneyTg(value) {
    if (value == null || isNaN(value)) return '-';
    const num = Math.round(value);
    return String(num).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' тг.';
  },

  // Word for risk-class severity (используется в формулировке Заключения).
  // Классы 1–10 → низкая, 11–15 → средняя, 16–22 → высокая.
  riskClassWord(cls) {
    const n = parseInt(cls);
    if (!n) return 'низкая';
    if (n <= 10) return 'низкая';
    if (n <= 15) return 'средняя';
    return 'высокая';
  },

  // Format money in thousands: 81 996 037,00 тыс. тг.
  fmtMoneyThousands(value) {
    if (value == null || isNaN(value)) return '-';
    const num = Math.round(value * 100) / 100;
    const parts = num.toFixed(2).split('.');
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
    return intPart + ',' + parts[1] + ' тыс. тг.';
  },

  // Format percentage: 2,54%
  fmtPct(value) {
    if (value == null || isNaN(value)) return '-';
    const pct = (value * 100).toFixed(2).replace('.', ',');
    return pct + '%';
  },

  // Format percentage already in percent form: 18,45%
  fmtPctRaw(value) {
    if (value == null || isNaN(value)) return '-';
    return value.toFixed(2).replace('.', ',') + '%';
  },

  // Format coefficient: 0,9 or 1,0
  fmtCoeff(value) {
    if (value == null || isNaN(value)) return '-';
    return value.toFixed(1).replace('.', ',');
  },

  // Format integer with space grouping: 1 073
  fmtInteger(value) {
    if (value == null || isNaN(value)) return '-';
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  },

  // Parse Excel serial date number to JS Date
  // ===== Payment installment schedule =====
  // Returns array of Dates: 1st tranche = today+1, subsequent = +freq step,
  // continues until contract endDate (inclusive) or until safety cap.
  PAYMENT_FREQ_LABELS: {
    year: 'раз в год',
    halfYear: 'раз в полгода',
    quarter: 'раз в квартал',
    month: 'раз в месяц',
    week: 'раз в неделю',
    day: 'раз в день',
  },
  // Fixed annual cycle: standard number of tranches per year regardless of contract duration.
  PAYMENT_TRANCHE_COUNT: {
    year: 1,
    halfYear: 2,
    quarter: 4,
    month: 12,
    week: 52,
    day: 365,
  },
  calcPaymentTranches(frequency, periodFrom, periodTo, refDate) {
    const today = refDate ? new Date(refDate) : new Date();
    today.setHours(0, 0, 0, 0);
    const t1 = new Date(today);
    t1.setDate(t1.getDate() + 1);

    const advance = (d) => {
      const n = new Date(d);
      switch (frequency) {
        case 'year':     n.setFullYear(n.getFullYear() + 1); break;
        case 'halfYear': n.setMonth(n.getMonth() + 6); break;
        case 'quarter':  n.setMonth(n.getMonth() + 3); break;
        case 'month':    n.setMonth(n.getMonth() + 1); break;
        case 'week':     n.setDate(n.getDate() + 7); break;
        case 'day':      n.setDate(n.getDate() + 1); break;
        default:         n.setMonth(n.getMonth() + 1);
      }
      return n;
    };

    // Fixed annual count by frequency (full year cycle)
    const N = Utils.PAYMENT_TRANCHE_COUNT[frequency] || 12;
    const tranches = [t1];
    let cur = t1;
    while (tranches.length < N) {
      cur = advance(cur);
      tranches.push(cur);
    }
    return tranches;
  },

  // Format payment schedule for documents (compact for long lists)
  formatPaymentSchedule(tranches, frequency) {
    if (!tranches || !tranches.length) return '';
    const fmt = (d) => {
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      return `${dd}.${mm}.${d.getFullYear()}`;
    };
    const N = tranches.length;
    const freqLabel = Utils.PAYMENT_FREQ_LABELS[frequency] || frequency;
    // For ≤ 14 tranches list each; otherwise show first 3 + last + count
    if (N <= 14) {
      return tranches.map((d, i) => `${i + 1} транш — ${fmt(d)}`).join('; ');
    }
    const first = tranches.slice(0, 3).map((d, i) => `${i + 1} транш — ${fmt(d)}`);
    const last = `${N} транш — ${fmt(tranches[N - 1])}`;
    return `${first.join('; ')}; … ; ${last} (всего ${N} траншей, ${freqLabel})`;
  },

  parseExcelDate(value) {
    if (value instanceof Date) return value;
    if (typeof value === 'string') {
      // Try DD.MM.YYYY format
      const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
      if (match) {
        return new Date(parseInt(match[3]), parseInt(match[2]) - 1, parseInt(match[1]));
      }
      return new Date(value);
    }
    if (typeof value === 'number') {
      // Excel serial date (days since 1899-12-30)
      const epoch = new Date(1899, 11, 30);
      return new Date(epoch.getTime() + value * 86400000);
    }
    return null;
  },

  // Determine which collegial body approves this risk.
  // Signature: determineOrgan(insuranceSum, riskClass?, companyAssets?)
  // - 3 args → full logic: sd / pravlenie / as / standard
  // - 1 arg → legacy 3-billion threshold for backward compat
  determineOrgan(insuranceSum, riskClass, companyAssets) {
    if (riskClass != null || companyAssets != null) {
      return Utils.determineOrganNew(insuranceSum, riskClass, companyAssets);
    }
    return insuranceSum > Utils.LIMIT_AS ? 'pravlenie' : 'as';
  },

  // Determine decision text based on coefficients
  determineDecision(coeff, coeffDown) {
    const effective = (coeffDown != null && coeffDown !== 1 && coeffDown !== 0)
      ? (1 - coeffDown) : 1;
    if (effective < 1) return 'lowered';
    if (effective > 1) return 'raised';
    return 'standard';
  },

  // Get decision text in Russian
  getDecisionText(decision) {
    switch (decision) {
      case 'lowered': return 'пониженным коэффициентом';
      case 'raised': return 'повышенным коэффициентом';
      default: return 'стандартным коэффициентом';
    }
  },

  // ===== VERDICT (manual or auto-computed) =====
  VERDICT_LABELS: {
    accept_standard: 'Принятие со стандартным коэффициентом',
    accept_adjusted: 'Принятие с повышенным или пониженным коэффициентом',
    reject: 'Отклонение в соответствии со степенью риска',
    defer: 'Отложение страхования на определенный срок',
  },

  // Resolve a user-selected verdict ('auto' or one of the 4 statuses)
  // into a concrete verdict. 'auto' falls back to the coefficient-based decision.
  resolveVerdict(verdict, decision) {
    if (verdict && verdict !== 'auto' && Utils.VERDICT_LABELS[verdict]) {
      return verdict;
    }
    return decision === 'standard' ? 'accept_standard' : 'accept_adjusted';
  },

  isAcceptVerdict(verdict) {
    return verdict === 'accept_standard' || verdict === 'accept_adjusted';
  },

  // Get organ name in Russian (genitive case)
  getOrganName(organ) {
    switch (organ) {
      case 'pravlenie': return 'Правления';
      case 'sd': return 'Совета директоров';
      case 'as':
      default: return 'Андеррайтингового совета';
    }
  },

  // Get organ name for header
  getOrganNameHeader(organ) {
    switch (organ) {
      case 'pravlenie': return 'Правления';
      case 'sd': return 'Совета директоров';
      case 'as':
      default: return 'Андеррайтингового Совета';
    }
  },

  // ===== ОКЭД → класс риска + название деятельности =====
  // Алгоритм:
  // 1. Точное совпадение по полному ОКЭД (например '07101').
  // 2. Префиксное (например '07xxx' → начало '07'),
  //    но если конкретный ОКЭД упомянут в исключениях (col D),
  //    пропускаем эту строку и идём дальше.
  lookupOked(code, classifier) {
    if (!code || !classifier || !classifier.length) return null;
    const codeStr = String(code).trim().replace(/\s+/g, '');
    if (!codeStr) return null;
    // 1. Exact match
    const exact = classifier.find(e => !e.isPrefix && e.okedRaw === codeStr);
    if (exact) {
      return { cls: exact.cls, name: exact.name, source: 'exact', oked: codeStr };
    }
    // 2. Prefix match — skip rows where code is in exceptions
    for (const e of classifier) {
      if (!e.isPrefix || !e.prefix) continue;
      if (codeStr.startsWith(e.prefix)) {
        if (e.exceptions.includes(codeStr)) continue;
        return { cls: e.cls, name: e.name, source: 'prefix', oked: codeStr };
      }
    }
    return null;
  },

  // === Decision tree for which organ approves this risk ===
  // Returns: 'sd' | 'pravlenie' | 'as' | 'standard'
  // For backward compat: if only sumInsured passed, uses old 3-billion threshold
  determineOrganNew(sumInsured, riskClass, companyAssets) {
    if (!sumInsured) return 'standard';
    const cls = parseInt(riskClass) || 0;
    const ratio = companyAssets > 0 ? sumInsured / companyAssets : 0;
    // СД: если страховая сумма > 25% активов
    if (ratio > this.LIMIT_SD_ASSETS_RATIO) return 'sd';
    // Правление: > 10 млрд (не более 25 % активов — уже отсечено выше)
    if (sumInsured > this.LIMIT_AS_HIGH) return 'pravlenie';
    // АС: пороги зависят от класса риска
    if (cls >= 1 && cls <= 15 && sumInsured >= this.LIMIT_AS_LOW_CLS_1_15) return 'as';
    if (cls >= 16 && cls <= 22 && sumInsured >= this.LIMIT_AS_LOW_CLS_16_22) return 'as';
    // Если класс не известен, используем большую базу для АС
    if (cls === 0 && sumInsured >= this.LIMIT_AS_LOW_CLS_1_15) return 'as';
    return 'standard';
  },

  // Members + secretary by organ
  getOrganMembers(organ) {
    if (organ === 'pravlenie' || organ === 'sd') return this.PRAVLENIE_MEMBERS;
    return this.AS_MEMBERS;
  },

  getOrganSecretary(organ) {
    if (organ === 'pravlenie' || organ === 'sd') return this.PRAVLENIE_SECRETARY;
    return this.AS_SECRETARY;
  },

  // What documents need to be generated for the organ
  determineDocPackage(organ) {
    switch (organ) {
      case 'sd':        return ['ar', 'zakl', 'sz_pravlenie', 'sz_sd'];
      case 'pravlenie': return ['ar', 'zakl', 'sz_pravlenie'];
      case 'as':        return ['ar', 'zakl', 'protocol'];
      default:          return ['ar', 'zakl'];
    }
  },

  // Human-readable package label
  describeOrgan(organ) {
    switch (organ) {
      case 'sd': return 'Совет директоров (страх. сумма > 25 % активов)';
      case 'pravlenie': return 'Правление (страх. сумма > 10 млрд ₸)';
      case 'as': return 'Андеррайтинговый Совет (АС)';
      default: return 'Стандартная процедура (без коллегиального органа)';
    }
  },

  // Calculate contract duration in months
  calcDurationMonths(dateFrom, dateTo) {
    if (!dateFrom || !dateTo) return 12;
    const from = Utils.parseExcelDate(dateFrom);
    const to = Utils.parseExcelDate(dateTo);
    const months = (to.getFullYear() - from.getFullYear()) * 12 +
      (to.getMonth() - from.getMonth());
    return months || 12;
  },

  // Format company name properly: "Жасыл ел тараз тоо" → "ТОО «Жасыл Ел-Тараз»"
  formatCompanyName(raw) {
    if (!raw) return '';
    let name = raw.trim();
    // If already formatted with quotes «», return as is
    if (name.includes('«')) return name;
    // Handle quoted names like ТОО "RG GOLD" — оборачиваем от первой " до последней " в «»,
    // сохраняя ВСЁ содержимое между ними (включая внутренние "" — это правильно
    // по русской типографике: внешние ёлочки, внутренние лапки).
    if (name.includes('"')) {
      const firstQ = name.indexOf('"');
      const lastQ = name.lastIndexOf('"');
      if (firstQ >= 0 && lastQ > firstQ) {
        const before = name.substring(0, firstQ).trim();
        const inside = name.substring(firstQ + 1, lastQ).trim();
        const after = name.substring(lastQ + 1).trim();
        return [before, '«' + inside + '»', after].filter(Boolean).join(' ');
      }
    }
    // Detect prefix at start or end: "Жасыл ел тараз тоо" or "ТОО Жасыл ел тараз"
    const prefixes = ['ТОО', 'АО', 'ИП', 'ОАО', 'ЗАО', 'тоо', 'ао'];
    let prefix = '';
    let body = name;

    // Check end: "Жасыл ел тараз тоо"
    for (const p of prefixes) {
      const re = new RegExp(`\\s+${p}$`, 'i');
      if (re.test(name)) {
        prefix = p.toUpperCase();
        body = name.replace(re, '').trim();
        break;
      }
    }
    // Check start: "ТОО Жасыл ел тараз"
    if (!prefix) {
      for (const p of prefixes) {
        const re = new RegExp(`^${p}\\s+`, 'i');
        if (re.test(name)) {
          prefix = p.toUpperCase();
          body = name.replace(re, '').trim();
          break;
        }
      }
    }

    // Capitalize body words (title case) — always, even if mixed case
    if (body) {
      body = body.split(/(\s+|-)/g).map(word => {
        if (word.match(/^\s+$/) || word === '-') return word;
        // Keep all-uppercase acronyms (e.g. "RG GOLD", "АО")
        if (word.length >= 2 && word === word.toUpperCase() && /^[A-ZА-ЯЁ]+$/.test(word)) {
          return word;
        }
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }).join('');
    }

    if (prefix) {
      return `${prefix} «${body}»`;
    }
    return name;
  },

  // Adjustment coefficients lookup
  getAdjustmentCoeff(matrix, avgInjuries, totalEmployees) {
    if (!matrix || avgInjuries <= 0) return null;

    // Employee ranges
    const empRanges = [
      { max: 100, col: 0 },
      { max: 500, col: 1 },
      { max: 1000, col: 2 },
      { max: 10000, col: 3 },
      { max: 20000, col: 4 },
      { max: Infinity, col: 5 },
    ];

    // Injury ranges
    const injRanges = [
      { max: 9, row: 0 },
      { max: 19, row: 1 },
      { max: 49, row: 2 },
      { max: 99, row: 3 },
      { max: 199, row: 4 },
      { max: 299, row: 5 },
      { max: Infinity, row: 6 },
    ];

    let empCol = empRanges.find(r => totalEmployees <= r.max)?.col ?? 5;
    let injRow = injRanges.find(r => avgInjuries <= r.max)?.row ?? 6;

    const val = matrix[injRow]?.[empCol];
    return val != null ? val : null;
  },
};
