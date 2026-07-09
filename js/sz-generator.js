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

    // Решение по риску из блока «Решение по риску» (ручной выбор или авто).
    // Проект решения и условия в СЗ должны идти именно из него — иначе записка
    // расходится с принятым решением (стандарт / со скидкой / отклонение).
    // Единый источник (Utils.acceptedConditions): вердикт андеррайтера главнее алгоритма.
    const { verdict, conditionText, useAdjusted } = Utils.acceptedConditions(data);
    const verdictLabel = Utils.VERDICT_LABELS[verdict] || Utils.VERDICT_LABELS.accept_standard;

    // Recipient block
    const isPravlenie = (mode === 'pravlenie');
    const recipientRole = isPravlenie
      ? 'Председателю Правления'
      : 'Председателю Совета директоров';
    const fixedRecipientName = isPravlenie ? 'Амерходжаеву Г.Т.' : Utils.SD_CHAIR_NAME;

    // Формулировки для СЗ — с учётом аффилированности (data.isAffiliated)
    const isAff = !!data.isAffiliated;
    // Сделка уровня Совета директоров (крупная сделка или аффилированное лицо).
    const isSdLimit = (data.organ === 'sd');
    // Квалификация сделки для формулировок СД: крупная / с аффилированным лицом.
    const sdDealGen = isAff ? 'сделки с аффилированным лицом' : 'крупной сделки'; // род. падеж
    const sdDealNom = isAff ? 'сделка с аффилированным лицом' : 'крупная сделка'; // им. падеж
    let subject;
    if (isPravlenie) {
      // СЗ на Правление: при лимитах СД — формулировка «на рассмотрение Совета директоров».
      subject = isSdLimit
        ? `О вынесении на рассмотрение Совета директоров решения о заключении ${sdDealGen} (договора ОСРНС)`
        : (isAff
            ? 'О вынесении на рассмотрение Правления решения о заключении сделки с аффилированным лицом (договор ОСРНС)'
            : 'О вынесении на рассмотрение Правления решения о заключении сделки (договор ОСРНС)');
    } else {
      // СЗ на Совет директоров. По умолчанию — «крупная сделка»; для
      // аффилированного лица — «сделка с аффилированным лицом» (без «крупной»).
      subject = isAff
        ? 'О заключении сделки с аффилированным лицом (договор ОСРНС)'
        : 'О заключении крупной сделки (договора ОСРНС)';
    }

    // Проект решения зависит от решения по риску (verdict). Условия принятия
    // (стандарт / со скидкой / с повышением) подставляются из conditionText.
    const ctrGen = 'договора обязательного страхования работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей';
    const ctrAcc = 'договор обязательного страхования работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей';
    const counterpartyPravl = isAff
      ? `с аффилированным лицом с компанией – ${companyName}`
      : `сделки с компанией – ${companyName}`;
    let projectDecision;
    if (verdict === 'reject') {
      projectDecision = isPravlenie
        ? `Отказать в заключении ${ctrGen} ${counterpartyPravl} в связи со степенью риска.`
        : `Отказать в заключении ${ctrGen} с ${companyName} в связи со степенью риска.`;
    } else if (verdict === 'defer') {
      projectDecision = isPravlenie
        ? `Отложить заключение ${ctrGen} ${counterpartyPravl} на определенный срок.`
        : `Отложить заключение ${ctrGen} с ${companyName} на определенный срок.`;
    } else {
      // Для СЗ на СД убираем «со стандартным коэффициентом» (при стандартном решении).
      const condSd = (verdict === 'accept_standard') ? '' : ` ${conditionText}`;
      projectDecision = isPravlenie
        ? `Рассмотреть и утвердить Правлением заключение ${ctrGen} ${counterpartyPravl} ${conditionText}.`
        : `Заключить ${ctrAcc} с ${companyName}${condSd}, в соответствии с заключением (рекомендацией) департамента андеррайтинга и перестрахования № ${docNumber} от ${dateDot}`;
    }

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
    // Премию «с учётом ПК» показываем ТОЛЬКО если решение действительно со
    // скидкой/повышением (useAdjusted из Utils.acceptedConditions). При стандарте
    // или отклонении — прочерк: иначе записка противоречила бы решению по риску
    // (показывала бы скидку там, где принято «со стандартным коэффициентом»).
    const premWithCoeff = (useAdjusted && data.premiumWithCoeff && data.premiumWithCoeff !== data.premiumBase)
      ? Utils.fmtMoney(data.premiumWithCoeff) : '-';

    const detailLine = (label, value) => justifyP([trB(`${label}: `), tr(String(value))]);
    const detailParas = [
      detailLine('Страхователь', companyName),
      detailLine('Класс риска', `– ${data.riskClass || '—'}`),
      detailLine('Вид деятельности страхователя', `«${data.activity || '—'}»`),
      detailLine('Страховая сумма', Utils.fmtMoney(data.insuranceSum)),
      detailLine('Количество работников', Utils.fmtInteger(data.workers)),
      detailLine('Страховая премия', Utils.fmtMoney(data.premiumBase)),
      // «Страховая премия с учётом ПК» — убираем для сделок уровня СД.
      ...(isSdLimit ? [] : [detailLine('Страховая премия с учетом ПК', premWithCoeff)]),
      detailLine('Оплата', data.paymentOrder || '—'),
      detailLine('Статистика НС за последние 3-х лет', claimsLine),
      detailLine('Организация с государственным участием', `– ${data.govParticipation || '—'}`),
      // «Решение по риску»: для СЗ на СД → «Лимит СД – <крупная сделка / с аффил.>»;
      // для СЗ Правления при лимитах СД — строка убирается; иначе — как есть.
      ...(!isSdLimit
          ? [detailLine('Решение по риску', `– ${verdictLabel}`)]
          : (isPravlenie ? [] : [detailLine('Лимит СД', `– ${sdDealNom}`)])),
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

      // Title centered (without date)
      new Paragraph({
        children: [trB('Служебная записка')],
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
      emptyP(), // дополнительный отступ после «Директор ДАиП … Бурханов Д.К.»
      new Paragraph({
        children: [trB('Согласовано:')],
        alignment: AlignmentType.JUSTIFIED,
      }),
      emptyP(), // дополнительный отступ после «Согласовано:» перед ролью утверждающего
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
