// protocol-generator.js — Generate Protocol of Underwriting Council meeting
// Layout: основной блок 10pt с отступом «красная строка» для контента
// (имена, повестка, голосование), без отступа для меток («Председатель …:»).
// Подписной блок 8pt без отступа.

const ProtocolGenerator = {

  MONTHS_GEN: [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ],
  MONTHS_NOM: [
    'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
  ],

  async generate(data) {
    const {
      Document, Packer, Paragraph, TextRun, AlignmentType,
      Table, TableRow, TableCell, WidthType, BorderStyle,
      TableLayoutType, VerticalAlign, TabStopType,
    } = docx;

    const FONT = 'Times New Roman';
    const SIZE = 20;          // 10pt — основной блок (до «Принято РЕШЕНИЕ»)
    const SIZE_TITLE = 28;    // 14pt — «ПРОТОКОЛ»
    const SIZE_FOOTER = 16;   // 8pt — подписной блок

    // Indent для «красной строки» — все имена, повестка, голосование.
    // Метки типа «Председатель …:» идут БЕЗ indent.
    const INDENT_LEFT = 720; // 0.5"

    // Основной шрифт (10pt)
    const tr = (text, opts = {}) => new TextRun({ text, font: FONT, size: SIZE, ...opts });
    const trB = (text, opts = {}) => tr(text, { bold: true, ...opts });
    // Подписной блок (8pt)
    const trF = (text, opts = {}) => new TextRun({ text, font: FONT, size: SIZE_FOOTER, ...opts });
    const trFB = (text, opts = {}) => trF(text, { bold: true, ...opts });
    const emptyP = () => new Paragraph({ children: [tr('')] });
    const emptyPF = () => new Paragraph({ children: [trF('')] });

    // Helpers для параграфов
    const p = (children, opts = {}) => new Paragraph({
      children: Array.isArray(children) ? children : [children],
      alignment: AlignmentType.JUSTIFIED,
      ...opts,
    });
    // pInd = «красная строка»: первая строка с отступом, остальные с левого края.
    // Это критично для многострочных параграфов (повестка, по вопросу...) —
    // иначе justify растягивает слова на всю ширину.
    const pInd = (children, opts = {}) => p(children, {
      indent: { firstLine: INDENT_LEFT },
      ...opts,
    });

    // Decide organ
    const organ = Utils.determineOrgan(data.insuranceSum, data.riskClass, data.normativ?.fullAssetsTenge);
    const isPravlenie = organ === 'pravlenie';
    const members = isPravlenie ? Utils.PRAVLENIE_MEMBERS : Utils.AS_MEMBERS;
    const secretary = isPravlenie ? Utils.PRAVLENIE_SECRETARY : Utils.AS_SECRETARY;
    const organName = isPravlenie ? 'Правления' : 'Андеррайтингового Совета';
    const organNameShort = isPravlenie ? 'Правления' : 'Совета';

    // Format date
    const docDate = data.docDate ? new Date(data.docDate) : new Date();
    const day = String(docDate.getDate()).padStart(2, '0');
    const monthNom = ProtocolGenerator.MONTHS_NOM[docDate.getMonth()];
    const year = docDate.getFullYear();
    const dateLine = `«${day}» ${monthNom} ${year} г.`;
    const dateDot = `${day}.${String(docDate.getMonth() + 1).padStart(2, '0')}.${year} г.`;

    const companyName = Utils.formatCompanyName(data.insurerName);
    const docNumber = data.docNumber || '13';

    // Page width A4 - 2×1134 twips margins = 9638 twips usable
    const COL_TOTAL = 9638;

    const paragraphs = [];

    // === P1: Title === (14pt, bold, центр)
    paragraphs.push(new Paragraph({
      children: [new TextRun({ text: `П Р О Т О К О Л  №${docNumber}`, font: FONT, size: SIZE_TITLE, bold: true })],
      alignment: AlignmentType.CENTER,
    }));
    paragraphs.push(new Paragraph({
      children: [trB(`заседания ${organName}`)],
      alignment: AlignmentType.CENTER,
    }));
    paragraphs.push(new Paragraph({
      children: [trB('АО «КСЖ «Standard Life»')],
      alignment: AlignmentType.CENTER,
    }));

    paragraphs.push(emptyP());

    // === P3: City + date (на одной строке, без пустой строки до «На заседании») ===
    paragraphs.push(new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: COL_TOTAL }],
      children: [trB('г. Алматы'), tr('\t'), trB(`от ${dateLine}`)],
    }));

    // === P4: Присутствовали (БЕЗ пустой строки до этого) ===
    paragraphs.push(p(trB(`На заседании ${organName} Компании присутствовали:`)));
    paragraphs.push(emptyP());

    // Председатель — метка без отступа, имя с отступом
    const chair = members[0];
    paragraphs.push(p(trB(`Председатель ${organName}:`)));
    paragraphs.push(pInd(tr(`- ${chair[1]} – ${chair[0]};`)));

    // Члены — метка без отступа, имена с отступом
    paragraphs.push(p(trB(`Члены ${organName}:`)));
    for (let i = 1; i < members.length; i++) {
      const [role, name] = members[i];
      paragraphs.push(pInd(tr(`- ${name} – ${role};`)));
    }

    // Секретарь — метка без отступа, имя с отступом
    paragraphs.push(p(trB(`Секретарь ${organName}:`)));
    paragraphs.push(pInd(tr(`- ${secretary} – главный специалист департамента андеррайтинга и перестрахования.`)));

    // === Повестка дня — метка без отступа, текст с отступом ===
    paragraphs.push(p(trB('Повестка дня:')));
    paragraphs.push(pInd(tr(
      `Рассмотрение целесообразности заключения сделки, подпадающей под лимиты ${organName} Компании – ` +
      `договора обязательного страхования работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей с ${companyName}.`
    )));

    // === По вопросу повестки дня — с отступом ===
    paragraphs.push(pInd([
      trB('По вопросу повестки дня '),
      tr(
        `выступил Директор департамента андеррайтинга и перестрахования ${Utils.DAIP_DIRECTOR_NAME}, ` +
        `предложил членам ${organName} рассмотреть Заключение (рекомендации) департамента андеррайтинга и перестрахования ` +
        `№ ${docNumber} от ${dateDot} по данной сделке и принять решение о целесообразности заключения.`
      ),
    ]));

    paragraphs.push(emptyP());
    // === Вопрос поставлен на голосование — БЕЗ отступа ===
    paragraphs.push(p(tr('Вопрос поставлен на голосование.')));
    paragraphs.push(emptyP());

    // === Результаты голосования — С красной строкой ===
    // Vote tab-stop рассчитан от позиции indent (внутренние tabStops).
    // Чтобы все «- «За»» выровнялись, позиция = INDENT_LEFT + 1680 = 2400.
    const VOTE_TAB = 2400;

    paragraphs.push(pInd(trB('Результаты голосования:')));
    paragraphs.push(pInd(trB(`Председатель ${organNameShort}:`)));
    paragraphs.push(new Paragraph({
      indent: { firstLine: INDENT_LEFT },
      tabStops: [{ type: TabStopType.LEFT, position: VOTE_TAB }],
      children: [tr(chair[1]), tr('\t'), tr('- «За»')],
    }));

    paragraphs.push(pInd(trB(`Члены ${organNameShort}:`)));
    for (let i = 1; i < members.length; i++) {
      const name = members[i][1];
      paragraphs.push(new Paragraph({
        indent: { left: INDENT_LEFT },
        tabStops: [{ type: TabStopType.LEFT, position: VOTE_TAB }],
        children: [tr(name), tr('\t'), tr('- «За»')],
      }));
    }

    // === Всего голосов — две строки с tab-stop'ами (как в шаблоне) ===
    const TOT_LABEL_TAB = 2800; // позиция «За»/«Против»
    const TOT_DASH_TAB = 4200;  // позиция «-»
    const TOT_NUM_TAB = 4500;   // позиция числа
    paragraphs.push(new Paragraph({
      indent: { firstLine: INDENT_LEFT },
      tabStops: [
        { type: TabStopType.LEFT, position: TOT_LABEL_TAB },
        { type: TabStopType.LEFT, position: TOT_DASH_TAB },
        { type: TabStopType.LEFT, position: TOT_NUM_TAB },
      ],
      children: [trB('Всего голосов:'), tr('\t'), trB('«За»'), tr('\t'), tr('-'), tr('\t'), tr(String(members.length))],
    }));
    paragraphs.push(new Paragraph({
      indent: { firstLine: INDENT_LEFT },
      tabStops: [
        { type: TabStopType.LEFT, position: TOT_LABEL_TAB },
        { type: TabStopType.LEFT, position: TOT_DASH_TAB },
        { type: TabStopType.LEFT, position: TOT_NUM_TAB },
      ],
      children: [tr(''), tr('\t'), trB('«Против»'), tr('\t'), tr('-'), tr('\t'), tr('0')],
    }));

    paragraphs.push(emptyP());

    // === Принято РЕШЕНИЕ — БЕЗ красной строки ===
    paragraphs.push(p([
      trB('Принято РЕШЕНИЕ: '),
      tr(
        `заключить договор по обязательному страхованию работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей с ${companyName}, ` +
        `в соответствии с Заключением (рекомендацией) департамента андеррайтинга и перестрахования № ${docNumber} от ${dateDot}`
      ),
    ]));

    paragraphs.push(emptyPF());

    // ============================================
    // ПОДПИСНОЙ БЛОК (8pt) — без красной строки
    // ============================================
    const SIG_COL_NAME = 6038;
    const SIG_COL_LINE = 2200;
    const SIG_COL_DATE = COL_TOTAL - SIG_COL_NAME - SIG_COL_LINE;
    const noBorderStyle = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const noBorders = {
      top: noBorderStyle, bottom: noBorderStyle,
      left: noBorderStyle, right: noBorderStyle,
    };

    const sigRow = (nameText) => new TableRow({
      children: [
        new TableCell({
          width: { size: SIG_COL_NAME, type: WidthType.DXA },
          borders: noBorders,
          verticalAlign: VerticalAlign.CENTER,
          children: [new Paragraph({
            children: [trF(nameText)],
            alignment: AlignmentType.LEFT,
          })],
        }),
        new TableCell({
          width: { size: SIG_COL_LINE, type: WidthType.DXA },
          borders: noBorders,
          verticalAlign: VerticalAlign.CENTER,
          children: [new Paragraph({
            children: [trF('___________________')],
            alignment: AlignmentType.CENTER,
          })],
        }),
        new TableCell({
          width: { size: SIG_COL_DATE, type: WidthType.DXA },
          borders: noBorders,
          verticalAlign: VerticalAlign.CENTER,
          children: [new Paragraph({
            children: [trF(dateLine)],
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

    paragraphs.push(new Paragraph({
      children: [trFB(`Члены ${organName}:`)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    const sigTableRows = [];
    for (const [role, name] of members) {
      sigTableRows.push(sigRow(`${role} – ${name}`));
      sigTableRows.push(blankRow());
    }
    paragraphs.push(new Table({
      rows: sigTableRows,
      width: { size: COL_TOTAL, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      alignment: AlignmentType.CENTER,
    }));

    paragraphs.push(new Table({
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: COL_TOTAL, type: WidthType.DXA },
              borders: noBorders,
              columnSpan: 3,
              children: [new Paragraph({
                children: [trFB(`Секретарь ${organName}:`)],
                alignment: AlignmentType.LEFT,
              })],
            }),
          ],
        }),
        sigRow(secretary),
      ],
      width: { size: COL_TOTAL, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      alignment: AlignmentType.CENTER,
    }));

    const doc = new Document({
      sections: [{
        properties: {
          page: {
            margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 },
          },
        },
        children: paragraphs,
      }],
    });

    return await Packer.toBlob(doc);
  },
};
