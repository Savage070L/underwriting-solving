// ar-generator.js — Generate AR (Андеррайтинговое решение) .docx

const ARGenerator = {

  async generate(data) {
    const {
      Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
      AlignmentType, WidthType, BorderStyle, HeadingLevel,
      TableLayoutType, VerticalAlign, CheckBox,
    } = docx;

    const organ = Utils.determineOrgan(data.insuranceSum, data.riskClass, data.normativ?.fullAssetsTenge);
    const autoDecision = Utils.determineDecision(data.coeff, data.coeffDown);
    const verdict = Utils.resolveVerdict(data.verdict, autoDecision);
    // Decision (для текста «...со стандартным/пониженным/повышенным коэффициентом»)
    // привязан к вердикту:
    //   accept_standard → стандартный (форсируем coeffEffective=1)
    //   accept_adjusted → вычисленный (lowered/raised по coeff/coeffDown)
    //   reject/defer     → не используется (execution-line другая)
    const decision = (verdict === 'accept_standard')
      ? 'standard'
      : (verdict === 'accept_adjusted' ? autoDecision : autoDecision);
    const organName = Utils.getOrganName(organ);
    const organNameHeader = Utils.getOrganNameHeader(organ);
    // Правление и Совет директоров используют ОДИН состав (члены Правления):
    // в подписном блоке АР — «Члены Правления» и члены Правления даже при лимитах СД.
    const isPravlOrSd = (organ === 'pravlenie' || organ === 'sd');
    const members = isPravlOrSd ? Utils.PRAVLENIE_MEMBERS : Utils.AS_MEMBERS;
    const secretary = isPravlOrSd ? Utils.PRAVLENIE_SECRETARY : Utils.AS_SECRETARY;
    const secretaryTitle = isPravlOrSd
      ? 'Секретарь Правления:'
      : 'Секретарь Андеррайтингового Совета:';
    // Заголовок «Члены …»: для Правления и СД — «Правления»; для АС — «Андеррайтингового Совета».
    const membersHeader = isPravlOrSd ? 'Правления' : organNameHeader;
    const dateShort = Utils.fmtDateShort(data.docDate);
    const dateRu = Utils.fmtDateRu(data.docDate);

    // Coefficient + premium-with-PK строго следуют решению:
    //   accept_standard → 1.0 в row 14, «-» в row 16
    //   accept_adjusted → реальный коэффициент в 14, премия с ПК в 16
    //   reject/defer   → также показываем как «1.0» / «-» (стандартный фон)
    const useAdjusted = (verdict === 'accept_adjusted')
      && data.coeffDown != null && data.coeffDown !== 0;
    const coeffEffective = useAdjusted ? (1 - data.coeffDown) : 1;
    const premiumWithCoeffText = useAdjusted
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
      ['9. Статистика убытков за последние 3-х лет', (data.claims && data.claims.detailedSummary && data.claims.detailedSummary !== 'НС не было') ? data.claims.detailedSummary : (data.claimsSummary || 'НС не было')],
    ];

    // Row 10: merged header "УСЛОВИЯ СТРАХОВАНИЯ"
    // (handled separately)

    const rowData2 = [
      ['10. Срок действия договора страхования', `${duration} мес.`],
      // «Всего: 1 человек.», «Всего: 3 человека.», «Всего: 5 человек.»
      ['11. Количество работников', `Всего: ${Utils.pluralize(data.workers, 'человек', 'человека', 'человек')}.`],
      ['12. Общая страховая сумма:', `Всего: ${Utils.fmtMoney(data.insuranceSum)}`],
      ['13. Страховой тариф', tariffDisplay],
      ['14. Повышающий/понижающий коэффициент', Utils.fmtCoeff(coeffEffective)],
      ['15. Общая страховая премия:', Utils.fmtMoney(data.premiumBase)],
      ['16. Страховая премия с поправочным (понижающим) коэффициентом:', premiumWithCoeffText],
      ['17. Порядок и сроки уплаты страховой премии', data.paymentScheduleText || data.paymentOrder || '-'],
      ['18. Размер вознаграждения страхового агента', '-'],
      ['19. Ф.И.О.агента /\nнаименование страхового агентства', '-'],
      ['20. Страховые покрытия', Utils.COVERAGE_TEXT],
      ['21. Условия страхования (типовой договор без изменений или с изменениями)', 'Типовой договор'],
      ['22. Дополнительная информация (необходимая по данному виду страхования)', data.isAffiliated ? 'Аффилированное лицо' : '-'],
      ['23. Организация с государственным участием', data.govParticipation || '-'],
    ];

    // Row 25: merged header "УСЛОВИЯ ПЕРЕСТРАХОВАНИЯ"

    // Table column widths — must fit page (A4 11906 − 2×1134 margins = 9638 twips available)
    const COL_LEFT = 3720;
    const COL_RIGHT = 5918;
    const COL_TOTAL = COL_LEFT + COL_RIGHT;

    // Build regular rows
    const makeRow = (left, right) => new TableRow({
      children: [
        tc(cp(left), { width: { size: COL_LEFT, type: WidthType.DXA }, borders: tableBorders }),
        tc(cp(right), { width: { size: COL_RIGHT, type: WidthType.DXA }, borders: tableBorders }),
      ],
    });

    // Build merged header row
    const makeMergedRow = (text) => new TableRow({
      children: [
        new TableCell({
          children: [cpBold(text)],
          columnSpan: 2,
          width: { size: COL_TOTAL, type: WidthType.DXA },
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
      width: { size: COL_TOTAL, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      alignment: AlignmentType.CENTER,
    });

    // Build signature block — use invisible-border table with 3 columns
    // (name / signature line / date) so everything aligns vertically across rows.
    const noBorderStyle = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const noBorders = {
      top: noBorderStyle, bottom: noBorderStyle,
      left: noBorderStyle, right: noBorderStyle,
    };

    // Column widths sum to COL_TOTAL (≈ 9638)
    // Дата «« «DD» месяц YYYYг. » + NBSP внутри занимает до 1800 twips в TNR 8pt —
    // даём 2038 twips, чтобы строка не переносилась даже для длинных месяцев («сентября»).
    const SIG_COL_NAME = 5400;
    const SIG_COL_LINE = 2200;
    const SIG_COL_DATE = COL_TOTAL - SIG_COL_NAME - SIG_COL_LINE;

    const sigRow = (nameText) => new TableRow({
      children: [
        new TableCell({
          width: { size: SIG_COL_NAME, type: WidthType.DXA },
          borders: noBorders,
          children: [new Paragraph({
            children: [tr(nameText, { bold: false })],
            alignment: AlignmentType.LEFT,
          })],
        }),
        new TableCell({
          width: { size: SIG_COL_LINE, type: WidthType.DXA },
          borders: noBorders,
          children: [new Paragraph({
            children: [tr('___________________', { bold: false })],
            alignment: AlignmentType.CENTER,
          })],
        }),
        new TableCell({
          width: { size: SIG_COL_DATE, type: WidthType.DXA },
          borders: noBorders,
          children: [new Paragraph({
            children: [tr(dateRu, { bold: false })],
            alignment: AlignmentType.RIGHT,
          })],
        }),
      ],
    });

    const blankRow = () => new TableRow({
      children: [
        new TableCell({ width: { size: SIG_COL_NAME, type: WidthType.DXA }, borders: noBorders, children: [new Paragraph({ children: [] })] }),
        new TableCell({ width: { size: SIG_COL_LINE, type: WidthType.DXA }, borders: noBorders, children: [new Paragraph({ children: [] })] }),
        new TableCell({ width: { size: SIG_COL_DATE, type: WidthType.DXA }, borders: noBorders, children: [new Paragraph({ children: [] })] }),
      ],
    });

    const sigTableRows = [];
    for (const [role, name] of members) {
      sigTableRows.push(sigRow(`${role} – ${name}`));
      sigTableRows.push(blankRow());
    }

    const sigTable = new Table({
      rows: sigTableRows,
      width: { size: COL_TOTAL, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      alignment: AlignmentType.CENTER,
    });

    // Secretary block as a separate small table (same column structure)
    const secTableRows = [
      new TableRow({
        children: [
          new TableCell({
            width: { size: SIG_COL_NAME, type: WidthType.DXA },
            borders: noBorders,
            columnSpan: 3,
            children: [new Paragraph({
              children: [tr(secretaryTitle, { bold: false })],
              alignment: AlignmentType.LEFT,
            })],
          }),
        ],
      }),
      sigRow(secretary),
    ];
    const secTable = new Table({
      rows: secTableRows,
      width: { size: COL_TOTAL, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      alignment: AlignmentType.CENTER,
    });

    // Group header + tables into "signatureBlock" array referenced below
    const signatureParagraphs = [
      new Paragraph({
        children: [tr(`Члены ${membersHeader}: `, { bold: false })],
        alignment: AlignmentType.LEFT,
        spacing: { line: 360 },
      }),
      new Paragraph({ children: [] }),
      sigTable,
      new Paragraph({ children: [] }),
      secTable,
    ];

    // Execution section — branches by verdict.
    // Текст исполнения должен соответствовать тому, что выбрал пользователь
    // в чек-боксах «Принятие Андеррайтингового решения». Поэтому привязываемся
    // к verdict, а не к auto-decision (которое падает в 'standard' при coeffDown=0).
    let executionLine;
    if (verdict === 'reject') {
      executionLine = '- Отклонить риск в соответствии со степенью риска.';
    } else if (verdict === 'defer') {
      executionLine = '- Отложить страхование на определенный срок.';
    } else if (verdict === 'accept_standard') {
      executionLine = '- Принять на страхование риск со стандартным коэффициентом.';
    } else if (verdict === 'accept_adjusted') {
      // Если знаем направление по коэффициенту — конкретизируем («с пониженным»
      // или «с повышенным»). Иначе используем generic-формулировку из чек-бокса.
      if (autoDecision === 'lowered' || autoDecision === 'raised') {
        executionLine = `- Принять на страхование риск ${Utils.getDecisionText(autoDecision)}.`;
      } else {
        executionLine = '- Принять на страхование риск с повышенным или пониженным коэффициентом.';
      }
    } else {
      executionLine = `- Принять на страхование риск ${Utils.getDecisionText(decision)}.`;
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
            // A4 page is 11906 × 16838 twips. Symmetric margins to keep table centered.
            margin: {
              top: 720,    // 0.5 inch
              bottom: 720,
              left: 1134,  // ~2 cm
              right: 1134, // ~2 cm
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
