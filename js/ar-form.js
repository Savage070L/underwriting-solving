// ar-form.js — генератор заполненного Андеррайтерского решения (АР) в .docx,
// по форме листа «АРешение» из шаблона Андеррешение_ОСНС.XLS: три секции
// (Рекомендация ДАиП → Заключение по управлению рисками → Андеррайтинговое
// решение) с горизонтальной таблицей финансовых показателей.
//
// Документ редактируемый (настоящие таблицы/текст, не картинка) и компактный —
// вписан в одну A4-страницу (книжная ориентация, как в шаблоне). Строится через
// docx-библиотеку (та же, что для АР/Заключения), поэтому генерация быстрая.
//
// Источник данных — строка из BatchReader.parse(); официальное название/адрес
// берутся из statgov, если есть. Подписант — Джелкобаев Т.К.; № = номер договора.

const ARForm = {
  MONTHS_GEN: [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ],

  UNDERWRITER: 'Джелкобаев Т.К.',
  RISK_TEXT: 'Обязательное страхование работника от несчастного случая при исполнении им трудовых (служебных) обязанностей',
  CLASS_TEXT: 'Страхование от несчастных случаев',

  // Для HTML-таблицы превью (batch-ar.js)
  _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  // «12» июня 2026 г. (пусто → плейсхолдер бланка)
  _dateRu(d) {
    if (!(d instanceof Date) || isNaN(d)) return '«__» __________ 20__ г.';
    return `«${String(d.getDate()).padStart(2, '0')}» ${ARForm.MONTHS_GEN[d.getMonth()]} ${d.getFullYear()} г.`;
  },

  _money(v) {
    if (v == null || isNaN(v)) return '';
    const num = Math.round(Number(v) * 100) / 100;
    const parts = num.toFixed(2).split('.');
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return parts[1] === '00' ? intPart : intPart + ',' + parts[1];
  },

  _int(v) {
    if (v == null || isNaN(v)) return '';
    return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  },

  _pct(v) {
    if (v == null || isNaN(v)) return '';
    return (v * 100).toFixed(2).replace('.', ',') + '%';
  },

  _coeff(v) {
    if (v == null || isNaN(v)) return '1';
    return String(v).replace('.', ',');
  },

  decisionText(row) {
    return row.decision === 'discount'
      ? `принятие с понижающим коэффициентом (${ARForm._coeff(row.coeff)})`
      : 'принятие со стандартным тарифом';
  },

  // ===== Геометрия таблицы =====
  // A4 книжная: ширина 11906 twips. Поля 1 см (567) по бокам → usable ≈ 10772.
  // 9 колонок: метка + 8 данных. Итог = 10466 twips (помещается).
  COLS: [1700, 1096, 1096, 1096, 1096, 1096, 1096, 1096, 1094],
  get TOTAL() { return ARForm.COLS.reduce((a, b) => a + b, 0); },
  get DATA_W() { return ARForm.COLS.slice(1).reduce((a, b) => a + b, 0); }, // 8 колонок данных

  FONT: 'Times New Roman',
  SZ: 16,   // 8pt — тело
  SZ_TH: 13, // 6.5pt — заголовки финансовой таблицы (мелкие, чтобы влезли)

  // Строит docx.Document для одной строки реестра.
  _buildDoc(row, opts = {}) {
    const {
      Document, Paragraph, TextRun, Table, TableRow, TableCell,
      WidthType, BorderStyle, AlignmentType, VerticalAlign, TableLayoutType,
    } = docx;

    const FONT = ARForm.FONT, SZ = ARForm.SZ, SZ_TH = ARForm.SZ_TH;
    const COLS = ARForm.COLS;

    const thin = { style: BorderStyle.SINGLE, size: 1, color: '000000' };
    const borders = { top: thin, bottom: thin, left: thin, right: thin };
    const cellMargins = { top: 12, bottom: 12, left: 60, right: 60 };

    const run = (text, o = {}) => new TextRun({ text: String(text == null ? '' : text), font: FONT, size: SZ, ...o });
    const para = (children, o = {}) => new Paragraph({
      children: Array.isArray(children) ? children : [children],
      spacing: { before: 0, after: 0 }, ...o,
    });

    // Универсальная ячейка
    const cell = (children, { w, span, align, bold, size, valign } = {}) => new TableCell({
      children: (Array.isArray(children) ? children : [children]).map(c =>
        typeof c === 'string'
          ? para([run(c, { bold, size })], { alignment: align })
          : c),
      width: w != null ? { size: w, type: WidthType.DXA } : undefined,
      columnSpan: span,
      borders,
      margins: cellMargins,
      verticalAlign: valign || VerticalAlign.CENTER,
    });

    // Строка: метка (col0) + контент (span 8)
    const labelRow = (label, content, contentOpts = {}) => new TableRow({
      children: [
        cell(label, { w: COLS[0] }),
        cell(content, { w: ARForm.DATA_W, span: 8, ...contentOpts }),
      ],
    });

    // Заголовок секции: заголовок (span5) + № (span2) + от (span2)
    const sectionRow = (title, no, date) => new TableRow({
      children: [
        cell([para([run(title, { bold: true })])], { w: COLS[0] + COLS[1] + COLS[2] + COLS[3] + COLS[4], span: 5 }),
        cell([para([run('№ ' + (no || '____'))], { alignment: AlignmentType.CENTER })], { w: COLS[5] + COLS[6], span: 2 }),
        cell([para([run('от ' + date)], { alignment: AlignmentType.CENTER })], { w: COLS[7] + COLS[8], span: 2 }),
      ],
    });

    // Заголовки финансовой таблицы
    const FIN_HEADERS = [
      'ГФОТ (тг.)', 'Общая страховая сумма (тг.)', 'Класс проф. Риска',
      'Страховой тариф (%)', 'Общая страховая премия (тг.)',
      'Поправочный коэффициент (ПК)', 'Страховая премия с учетом ПК (тг.)',
      'Количество застрахованных',
    ];
    const finHeaderRow = () => new TableRow({
      children: [
        cell('', { w: COLS[0] }),
        ...FIN_HEADERS.map((h, i) => cell([para([run(h, { size: SZ_TH })], { alignment: AlignmentType.CENTER })], { w: COLS[i + 1] })),
      ],
    });
    const finDataRow = (label, vals) => new TableRow({
      children: [
        cell(label, { w: COLS[0] }),
        ...vals.map((v, i) => cell([para([run(v.text)], { alignment: v.align || AlignmentType.CENTER })], { w: COLS[i + 1] })),
      ],
    });
    const RIGHT = AlignmentType.RIGHT, CENTER = AlignmentType.CENTER;
    const finStrahRow = () => finDataRow('Страхователь', [
      { text: ARForm._money(row.gfot), align: RIGHT },
      { text: ARForm._money(row.insuranceSum), align: RIGHT },
      { text: row.riskClass, align: CENTER },
      { text: ARForm._pct(row.tariff), align: CENTER },
      { text: ARForm._money(row.premiumBase), align: RIGHT },
      { text: ARForm._coeff(row.coeff), align: CENTER },
      { text: ARForm._money(row.premiumWithCoeff), align: RIGHT },
      { text: ARForm._int(row.workers), align: CENTER },
    ]);
    const finFilialRow = () => finDataRow('Филиал*', [{}, {}, {}, {}, {}, {}, {}, {}].map(() => ({ text: '' })));

    // Данные
    const sg = row.statgov && !row.statgov.error ? row.statgov : null;
    const name = (sg && sg.name) || row.insurerName || '';
    const addr = (sg && sg.legalAddress) || '';
    const nameCell = addr ? `${name}, ${addr}` : name;
    const docNo = row.contractNumber || '';
    const docDate = ARForm._dateRu(row.dateContract);
    const period = `с ${ARForm._dateRu(row.periodFrom)} по ${ARForm._dateRu(row.periodTo)}`;
    const recText = `принять на страхование на указанных условиях — ${ARForm.decisionText(row)}`;
    const sigText = `${ARForm.UNDERWRITER}   _______________ Подпись`;

    const rows = [];

    // ===== СЕКЦИЯ 1: РЕКОМЕНДАЦИЯ ДАиП =====
    rows.push(sectionRow('РЕКОМЕНДАЦИЯ ДАиП', docNo, docDate));
    rows.push(labelRow('Страхователь', nameCell));
    rows.push(labelRow('БИН/ИИН', row.bin));
    rows.push(labelRow('Вид страхования', ARForm.RISK_TEXT));
    rows.push(labelRow('Класс страхования', ARForm.CLASS_TEXT));
    rows.push(finHeaderRow());
    rows.push(finStrahRow());
    rows.push(finFilialRow());
    rows.push(labelRow('Срок действия договора страхования', period));
    rows.push(labelRow('Информация о страховом агенте/Брокере', 'нет'));
    rows.push(labelRow('ДАиП рекомендовано:', recText));
    rows.push(labelRow('Андеррайтер:', sigText));

    // ===== СЕКЦИЯ 2: ЗАКЛЮЧЕНИЕ ПО УПРАВЛЕНИЮ РИСКАМИ =====
    rows.push(sectionRow('ЗАКЛЮЧЕНИЕ ПОДРАЗДЕЛЕНИЯ ПО УПРАВЛЕНИЮ РИСКАМИ', docNo, docDate));
    rows.push(labelRow('Класс профессионального риска', 'соответствует'));
    rows.push(labelRow('Страховой тариф', 'соответствует'));
    rows.push(labelRow('Источник данных по статистике страховых случаев Страхователя', 'Единая Страховая База Данных'));
    rows.push(labelRow('Риск-менеджер', 'ФИО / должность   _______________ Подпись'));

    // ===== СЕКЦИЯ 3: АНДЕРРАЙТИНГОВОЕ РЕШЕНИЕ =====
    rows.push(sectionRow('АНДЕРРАЙТИНГОВОЕ РЕШЕНИЕ', docNo, docDate));
    rows.push(labelRow('На основании Рекомендации', `№ ${docNo || '____'} от ${docDate}`));
    rows.push(labelRow('Страхователь', nameCell));
    rows.push(labelRow('БИН/ИИН', row.bin));
    rows.push(labelRow('Вид страхования', ARForm.RISK_TEXT));
    rows.push(labelRow('Класс страхования', ARForm.CLASS_TEXT));
    rows.push(finHeaderRow());
    rows.push(finStrahRow());
    rows.push(finFilialRow());
    rows.push(labelRow('Срок действия договора страхования', period));
    rows.push(labelRow('Информация о страховом агенте/Брокере', 'нет'));
    rows.push(labelRow('РЕШЕНИЕ:', recText));
    rows.push(labelRow('Андеррайтер:', sigText));

    const table = new Table({
      rows,
      width: { size: ARForm.TOTAL, type: WidthType.DXA },
      columnWidths: COLS,
      layout: TableLayoutType.FIXED,
      alignment: AlignmentType.CENTER,
    });

    const children = [table];
    // Сноска про филиал
    children.push(new Paragraph({
      spacing: { before: 60, after: 0 },
      children: [new TextRun({
        text: '* Указывается при наличии у Страхователя филиала (филиалов), осуществляющего (осуществляющих) отличную от страхователя деятельность.',
        font: FONT, size: 14, italics: true,
      })],
    }));
    // Алерт «моложе 3 лет» — печатаем на документе только если включено явно.
    if (opts.printAlert && row.youngAlert) {
      children.push(new Paragraph({
        spacing: { before: 40, after: 0 },
        children: [new TextRun({
          text: `⚠ Внимание: компания моложе 3 лет${row.ageYears != null ? ` (возраст ≈ ${row.ageYears.toFixed(1).replace('.', ',')} г.)` : ''}${row.decision === 'discount' ? ' — понижающий коэффициент может быть применён ошибочно' : ''}.`,
          font: FONT, size: 15, bold: true, color: 'B91C1C',
        })],
      }));
    }

    return new Document({
      styles: { default: { document: { run: { font: FONT, size: SZ } } } },
      sections: [{
        properties: {
          page: {
            size: { orientation: 'portrait' },
            margin: { top: 567, bottom: 567, left: 567, right: 567 },
          },
        },
        children,
      }],
    });
  },

  // Возвращает Blob (.docx) — для браузера.
  async buildDocx(row, opts = {}) {
    const doc = ARForm._buildDoc(row, opts);
    return docx.Packer.toBlob(doc);
  },
};

if (typeof window !== 'undefined') window.ARForm = ARForm;
if (typeof module !== 'undefined' && module.exports) module.exports = ARForm;
