// sz-generator.js — Generates Служебная Записка (СЗ) addressed to Правление or СД.
// Табличный формат: левая колонка — инструкции/ярлыки, правая — ответы.

const SZGenerator = {

  MONTHS_NOM: [
    'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
  ],

  /**
   * @param {Object} data — common data object (same shape as for AR/Zakl)
   * @param {'pravlenie'|'sd'} mode — recipient: chair of Правление or Совет директоров
   */
  async generate(data, mode) {
    const { Document, Packer, Paragraph, TextRun, AlignmentType,
            Table, TableRow, TableCell, WidthType, BorderStyle,
            TableLayoutType, VerticalAlign, TabStopType } = docx;

    const FONT = 'Times New Roman';
    const SIZE = 24; // 12pt

    const tr = (text, opts = {}) => new TextRun({ text, font: FONT, size: SIZE, ...opts });
    const trB = (text, opts = {}) => tr(text, { bold: true, ...opts });
    const emptyP = () => new Paragraph({ children: [tr('')] });

    // Date helpers
    const docDate = data.docDate ? new Date(data.docDate) : new Date();
    const dayDot = String(docDate.getDate()).padStart(2, '0');
    const monthDot = String(docDate.getMonth() + 1).padStart(2, '0');
    const year = docDate.getFullYear();
    const dateDot = `${dayDot}.${monthDot}.${year}г.`;

    const companyName = Utils.formatCompanyName(data.insurerName);
    const docNumber = data.docNumber || '—';

    // Recipient block
    const isPravlenie = (mode === 'pravlenie');
    const recipientRole = isPravlenie
      ? 'Председателю Правления'
      : 'Председателю Совета директоров';
    const fixedRecipientName = isPravlenie ? 'Амерходжаеву Г.Т.' : Utils.SD_CHAIR_NAME;

    const subject = isPravlenie
      ? 'О вынесении на рассмотрение Правления решения о заключении сделки (договора ОСРНС)'
      : 'О заключении c аффилированным лицом (договор ОСРНС)';

    const projectDecision = isPravlenie
      ? `Рассмотреть и утвердить Правлением заключение договора обязательного страхования работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей сделки с компанией – ${companyName}.`
      : `Заключить договор обязательного страхования работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей с ${companyName}, в соответствии с заключением (рекомендацией) департамента андеррайтинга и перестрахования № ${docNumber} от ${dateDot}`;

    const approverRole = isPravlenie ? Utils.UPRAV_DIR_ROLE : Utils.PRAVLENIE_CHAIR_ROLE;
    const approverName = isPravlenie ? Utils.UPRAV_DIR_NAME : Utils.PRAVLENIE_CHAIR_NAME;

    // ============ Table column widths ============
    // A4 - 2×1134 twip margins ≈ 9638 usable.
    const COL_TOTAL = 9638;
    const COL_LEFT = 3000;
    const COL_RIGHT = COL_TOTAL - COL_LEFT;

    // Borders
    const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: '000000' };
    const borders = {
      top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder,
    };

    // Helper: cell with paragraphs
    const cell = (paragraphs, width) => new TableCell({
      children: Array.isArray(paragraphs) ? paragraphs : [paragraphs],
      width: { size: width, type: WidthType.DXA },
      borders,
      verticalAlign: VerticalAlign.TOP,
      margins: { top: 80, bottom: 80, left: 110, right: 110 },
    });

    const justifyP = (children) => new Paragraph({
      children: Array.isArray(children) ? children : [children],
      alignment: AlignmentType.JUSTIFIED,
    });

    // ============ Body lines for the 2nd row (details) ============
    const claimsLine = (data.claims && data.claims.detailedSummary && data.claims.detailedSummary !== 'НС не было')
      ? data.claims.detailedSummary
      : (data.claimsSummary || 'НС не было');
    const premWithCoeff = data.premiumWithCoeff && data.premiumWithCoeff !== data.premiumBase
      ? Utils.fmtMoney(data.premiumWithCoeff) : '-';

    const detailLine = (label, value) => justifyP([trB(`${label}: `), tr(String(value))]);
    const detailParas = [
      detailLine('Страхователь', companyName),
      detailLine('Класс риска', `– ${data.riskClass || '—'}`),
      detailLine('Вид деятельности страхователя', `«${data.activity || '—'}»`),
      detailLine('Страховая сумма', Utils.fmtMoney(data.insuranceSum)),
      detailLine('Количество работников', Utils.fmtInteger(data.workers)),
      detailLine('Страховая премия', Utils.fmtMoney(data.premiumBase)),
      detailLine('Страховая премия с учетом ПК', premWithCoeff),
      detailLine('Оплата', data.paymentOrder || '—'),
      detailLine('Статистика НС за последние 3-х лет', claimsLine),
      detailLine('Организация с государственным участием', `– ${data.govParticipation || '—'}`),
    ];

    // ============ Build the main table ============
    const makeRow = (leftText, rightParas) => new TableRow({
      children: [
        cell(justifyP(tr(leftText)), COL_LEFT),
        cell(rightParas, COL_RIGHT),
      ],
    });

    const mainTable = new Table({
      rows: [
        makeRow(
          'Укажите формулировку вопроса включаемого в повестку дня заседания.',
          justifyP(trB(subject))
        ),
        makeRow(
          'Коротко дайте пояснения по предлагаемому вопросу повестки дня.',
          detailParas
        ),
        makeRow(
          'Укажите проект решения по вопросу повестки.',
          justifyP(tr(projectDecision))
        ),
        new TableRow({
          children: [
            cell(justifyP(tr('Докладчик:')), COL_LEFT),
            cell(justifyP(tr(Utils.DAIP_DIRECTOR_NAME)), COL_RIGHT),
          ],
        }),
        new TableRow({
          children: [
            cell(justifyP(tr('Приложения')), COL_LEFT),
            cell([
              justifyP(tr(`Андеррайтинговое решение № ${docNumber} от ${dateDot}`)),
              justifyP(tr(`Заключение ДАиП от ${dateDot}`)),
            ], COL_RIGHT),
          ],
        }),
      ],
      width: { size: COL_TOTAL, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      alignment: AlignmentType.CENTER,
    });

    // ============ Signature block (after table) ============
    const tabRight = COL_TOTAL;
    const sigLine = (left, right) => new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: tabRight }],
      children: [trB(left), trB('\t'), trB(right)],
    });

    // ============ Compose final paragraphs ============
    const paragraphs = [
      // Recipient (right-aligned)
      new Paragraph({
        children: [trB(recipientRole)],
        alignment: AlignmentType.RIGHT,
      }),
      new Paragraph({
        children: [trB(fixedRecipientName)],
        alignment: AlignmentType.RIGHT,
      }),
      emptyP(),

      // Title centered + date right (one line)
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: tabRight }],
        children: [trB('Служебная записка'), tr('\t'), tr(dateDot)],
        alignment: AlignmentType.CENTER,
      }),
      emptyP(),

      // Main table
      mainTable,

      emptyP(),
      emptyP(),
      emptyP(),

      // Signatures
      sigLine(Utils.DAIP_DIRECTOR_ROLE, Utils.DAIP_DIRECTOR_NAME),
      emptyP(),
      new Paragraph({
        children: [trB('Согласовано:')],
        alignment: AlignmentType.JUSTIFIED,
      }),
      sigLine(approverRole, approverName),
    ];

    const doc = new Document({
      sections: [{
        properties: {
          page: {
            // A4 with symmetric 2cm margins (1134 twips)
            margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 },
          },
        },
        children: paragraphs,
      }],
    });

    return await Packer.toBlob(doc);
  },
};
