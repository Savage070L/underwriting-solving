// ar-generator.js — Generate AR (Андеррайтинговое решение) .docx

const ARGenerator = {

  async generate(data) {
    const {
      Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
      AlignmentType, WidthType, BorderStyle, HeadingLevel,
      TableLayoutType, VerticalAlign, CheckBox,
    } = docx;

    const organ = Utils.determineOrgan(data.insuranceSum);
    const decision = Utils.determineDecision(data.coeff, data.coeffDown);
    const verdict = Utils.resolveVerdict(data.verdict, decision);
    const organName = Utils.getOrganName(organ);
    const organNameHeader = Utils.getOrganNameHeader(organ);
    const members = organ === 'pravlenie' ? Utils.PRAVLENIE_MEMBERS : Utils.AS_MEMBERS;
    const secretary = organ === 'pravlenie' ? Utils.PRAVLENIE_SECRETARY : Utils.AS_SECRETARY;
    const secretaryTitle = organ === 'pravlenie'
      ? 'Секретарь Правления:'
      : 'Секретарь Андеррайтингового Совета:';
    const dateShort = Utils.fmtDateShort(data.docDate);
    const dateRu = Utils.fmtDateRu(data.docDate);

    // Determine premium with coefficient display
    const coeffEffective = (data.coeffDown != null && data.coeffDown !== 0)
      ? (1 - data.coeffDown) : 1;
    const premiumWithCoeffText = coeffEffective !== 1
      ? Utils.fmtMoney(data.premiumWithCoeff)
      : '-';

    // Build residency text
    const residency = data.nonResident ? 'нерезидент' : 'резидент';

    // Company name formatting
    const companyName = Utils.formatCompanyName(data.insurerName);

    // Contract duration
    const duration = Utils.calcDurationMonths(data.periodFrom, data.periodTo);

    // Tariff
    const tariffDisplay = data.tariff
      ? Utils.fmtPct(data.tariff)
      : '-';

    // Build address line for row 2
    const addressParts = [companyName, 'РК'];
    if (data.legalAddress && data.legalAddress !== '-') {
      addressParts.push(data.legalAddress);
    }
    addressParts.push(`БИН ${data.bin}`);
    addressParts.push(`Признак резидентства – ${residency}.`);
    const addressLine = addressParts.join(', ');

    // Row 7: reason text
    const reasonText = `Страховая сумма в рамках лимита ${organName} Компании\n№ ${data.docNumber} от ${dateShort}г.`;

    // Decision options — driven by verdict (manual selection or auto-resolved)
    const decisionOptions = [
      { text: 'Принятие со стандартным коэффициентом', checked: verdict === 'accept_standard' },
      { text: 'Принятие с повышенным или пониженным коэффициентом', checked: verdict === 'accept_adjusted' },
      { text: 'Отклонение в соответствии со степенью риска', checked: verdict === 'reject' },
      { text: 'Отложение страхования на определенный срок', checked: verdict === 'defer' },
    ];

    // Font defaults
    const FONT = 'Times New Roman';
    const SIZE = 16; // 8pt in half-points

    // Helper: create a text run
    const tr = (text, opts = {}) => new TextRun({
      text,
      font: FONT,
      size: SIZE,
      ...opts,
    });

    // Helper: create table cell
    const tc = (children, opts = {}) => new TableCell({
      children: Array.isArray(children) ? children : [children],
      verticalAlign: VerticalAlign.CENTER,
      ...opts,
    });

    // Helper: cell paragraph
    const cp = (text, opts = {}) => new Paragraph({
      children: [tr(text)],
      alignment: AlignmentType.JUSTIFIED,
      ...opts,
    });

    // Helper: cell paragraph with bold
    const cpBold = (text, opts = {}) => new Paragraph({
      children: [tr(text, { bold: true })],
      alignment: AlignmentType.CENTER,
      ...opts,
    });

    // Table border style
    const thinBorder = {
      style: BorderStyle.SINGLE,
      size: 1,
      color: '000000',
    };
    const tableBorders = {
      top: thinBorder,
      bottom: thinBorder,
      left: thinBorder,
      right: thinBorder,
    };

    // Build the 26-row table
    const tableRows = [];

    // Row data: [leftText, rightContent]
    const rowData = [
      ['1.Информация о Страхователе', companyName],
      ['Регион', data.region || '-'],
      ['2. Страхователь (наименование, ФИО, реквизиты)', addressLine],
      ['3. Застрахованный (ые) (ФИО)', companyName],
      ['4. Выгодоприобретатель (ФИО)', Utils.BENEFICIARY_TEXT],
      ['5. Вид страхования', Utils.INSURANCE_TYPE],
      ['6. Вид экономической деятельности', data.activity || '-'],
      ['7. Причина вынесения на рассмотрение/\n№ и дата рекомендации\nДепартамента андеррайтинга и перестрахования', reasonText],
      ['8. Класс профессионального риска', String(data.riskClass || '-')],
      ['9. Статистика убытков за последние 3-х лет', data.claimsSummary || 'НС не было'],
    ];

    // Row 10: merged header "УСЛОВИЯ СТРАХОВАНИЯ"
    // (handled separately)

    const rowData2 = [
      ['10. Срок действия договора страхования', `${duration} мес.`],
      ['11. Количество работников', `Всего: ${Utils.fmtInteger(data.workers)} человек.`],
      ['12. Общая страховая сумма:', `Всего: ${Utils.fmtMoney(data.insuranceSum)}`],
      ['13. Страховой тариф', tariffDisplay],
      ['14. Повышающий/понижающий коэффициент', Utils.fmtCoeff(coeffEffective)],
      ['15. Общая страховая премия:', Utils.fmtMoney(data.premiumBase)],
      ['16. Страховая премия с поправочным (понижающим) коэффициентом:', premiumWithCoeffText],
      ['17. Порядок и сроки уплаты страховой премии', `Единовременно    В рассрочку: ${data.paymentOrder === 'Единовременно' ? '' : data.paymentOrder || ''}`],
      ['18. Размер вознаграждения страхового агента', '-'],
      ['19. Ф.И.О.агента /\nнаименование страхового агентства', '-'],
      ['20. Страховые покрытия', Utils.COVERAGE_TEXT],
      ['21. Условия страхования (типовой договор без изменений или с изменениями)', 'Укажите:\n   Типовой договор                Измененный договор'],
      ['22. Дополнительная информация (необходимая по данному виду страхования)', '-'],
      ['23. Организация с государственным участием', data.govParticipation || '-'],
    ];

    // Row 25: merged header "УСЛОВИЯ ПЕРЕСТРАХОВАНИЯ"

    // Build regular rows
    const makeRow = (left, right) => new TableRow({
      children: [
        tc(cp(left), { width: { size: 3964, type: WidthType.DXA }, borders: tableBorders }),
        tc(cp(right), { width: { size: 6296, type: WidthType.DXA }, borders: tableBorders }),
      ],
    });

    // Build merged header row
    const makeMergedRow = (text) => new TableRow({
      children: [
        new TableCell({
          children: [cpBold(text)],
          columnSpan: 2,
          width: { size: 10260, type: WidthType.DXA },
          borders: tableBorders,
        }),
      ],
    });

    // Add first 10 rows
    for (const [left, right] of rowData) {
      tableRows.push(makeRow(left, right));
    }

    // Row 10: merged "УСЛОВИЯ СТРАХОВАНИЯ"
    tableRows.push(makeMergedRow('УСЛОВИЯ СТРАХОВАНИЯ'));

    // Add rows 11-24
    for (const [left, right] of rowData2) {
      tableRows.push(makeRow(left, right));
    }

    // Row 25: merged "УСЛОВИЯ ПЕРЕСТРАХОВАНИЯ"
    tableRows.push(makeMergedRow(`УСЛОВИЯ ПЕРЕСТРАХОВАНИЯ – ${Utils.REINSURANCE_TEXT}`));

    const mainTable = new Table({
      rows: tableRows,
      width: { size: 10260, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
    });

    // Build signature block paragraphs
    const signatureParagraphs = [];

    // Members header
    signatureParagraphs.push(new Paragraph({
      children: [tr(`Члены ${organNameHeader}: `, { bold: false })],
      alignment: AlignmentType.JUSTIFIED,
      spacing: { line: 360 },
    }));

    signatureParagraphs.push(new Paragraph({ children: [] }));

    // Each member: name + signature + date on one line
    for (const [role, name] of members) {
      signatureParagraphs.push(new Paragraph({
        children: [
          tr(`${role} – ${name}`, { bold: false }),
          tr('       ___________________       ', { bold: false }),
          tr(dateRu, { bold: false }),
        ],
        alignment: AlignmentType.JUSTIFIED,
        spacing: { line: 360 },
      }));
      signatureParagraphs.push(new Paragraph({ children: [] }));
    }

    // Secretary
    signatureParagraphs.push(new Paragraph({
      children: [tr(secretaryTitle, { bold: false })],
      alignment: AlignmentType.JUSTIFIED,
      spacing: { line: 360 },
    }));
    signatureParagraphs.push(new Paragraph({
      children: [
        tr(secretary, { bold: false }),
        tr('                                                             ', { bold: false }),
      ],
      alignment: AlignmentType.JUSTIFIED,
      spacing: { line: 360 },
    }));
    signatureParagraphs.push(new Paragraph({
      children: [
        tr('___________________                                        ', { bold: false }),
        tr(dateRu, { bold: false }),
      ],
      alignment: AlignmentType.JUSTIFIED,
      spacing: { line: 360 },
    }));

    // Execution section — branches by verdict
    let executionLine;
    if (verdict === 'reject') {
      executionLine = '- Отклонить риск в соответствии со степенью риска.';
    } else if (verdict === 'defer') {
      executionLine = '- Отложить страхование на определенный срок.';
    } else {
      executionLine = `- Принять на страхование риск с ${Utils.getDecisionText(decision)}.`;
    }
    const executionParagraphs = [
      new Paragraph({ children: [] }),
      new Paragraph({
        children: [tr('Исполнение Андеррайтингового решения:', { bold: false })],
      }),
      new Paragraph({
        children: [
          tr(executionLine, { bold: false }),
        ],
      }),
    ];

    // Decision checkboxes
    const checkboxParagraphs = [
      new Paragraph({ children: [] }),
      new Paragraph({
        children: [tr('Принятие Андеррайтингового решения:', { bold: false })],
      }),
    ];

    for (const opt of decisionOptions) {
      const checkChar = opt.checked ? '\u2611' : '\u2610';
      checkboxParagraphs.push(new Paragraph({
        children: [tr(` ${checkChar} ${opt.text}`, { bold: false })],
        indent: { left: 720 },
      }));
    }

    // Assemble document
    const doc = new Document({
      sections: [{
        properties: {
          page: {
            margin: {
              top: 504,    // ~0.35 inch in twentieths of a point
              bottom: 710,
              left: 1701,
              right: 850,
            },
          },
        },
        children: [
          // Title
          new Paragraph({
            children: [tr(`Андеррайтинговое решение № ${data.docNumber}`)],
            alignment: AlignmentType.CENTER,
          }),
          // Date
          new Paragraph({
            children: [tr(`  Дата ${dateShort} г.`)],
            alignment: AlignmentType.RIGHT,
          }),
          new Paragraph({ children: [] }),
          // Table
          mainTable,
          // Decision checkboxes
          ...checkboxParagraphs,
          // Signature block
          new Paragraph({ children: [] }),
          ...signatureParagraphs,
          // Execution
          ...executionParagraphs,
        ],
      }],
    });

    const blob = await Packer.toBlob(doc);
    return blob;
  },
};
