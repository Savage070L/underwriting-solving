// utils.js — Constants, formatting, and shared utilities

const Utils = {
  // ===== CONSTANTS =====

  // Threshold for Pravlenie vs Underwriting Council (3 billion tenge)
  LIMIT_AS: 3000000000,

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

  // Covered risks boilerplate for Zaklyuchenie
  COVERED_RISKS: [
    'Возмещение вреда, связанного с утратой заработка (дохода) работником в связи с установлением ему степени утраты профессиональной трудоспособности на срок не менее одного года;',
    'Возмещение расходов на выплату единовременной страховой выплаты (аннуитет) в связи с установлением степени утраты профессиональной трудоспособности;',
    'Возмещение расходов, вызванных повреждением здоровья, - на медицинскую помощь (за исключением проведения профилактических прививок и добровольного медицинского страхования); на дополнительное питание; на приобретение лекарств; на протезирование; на посторонний уход; на санаторно-курортное лечение, включая оплату проезда работника, а при необходимости и сопровождающего его лица, к месту лечения и обратно; на приобретение специальных транспортных средств; на подготовку к другой профессии в соответствии с законами Республики Казахстан;',
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
    const num = Math.round(value); // round to integer like templates
    const parts = num.toFixed(2).split('.');
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
    return intPart + ',' + parts[1];
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

  // Determine organ: "pravlenie" if sum > 3 billion, else "as"
  determineOrgan(insuranceSum) {
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
    return organ === 'pravlenie' ? 'Правления' : 'Андеррайтингового совета';
  },

  // Get organ name for header
  getOrganNameHeader(organ) {
    return organ === 'pravlenie' ? 'Правления' : 'Андеррайтингового Совета';
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
    // Handle quoted names like ТОО "RG GOLD"
    if (name.includes('"')) {
      name = name.replace(/"/g, match => '«').replace(/"/g, '»');
      // Fix: replace pairs
      let count = 0;
      name = name.replace(/«/g, () => (count++ % 2 === 0) ? '«' : '»');
      // Simpler: just replace first " with « and second with »
      name = raw.trim();
      const parts = name.split('"');
      if (parts.length >= 3) {
        // e.g. ТОО "RG GOLD" -> parts = ['ТОО ', 'RG GOLD', '']
        return `${parts[0].trim()} «${parts[1]}»`;
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
