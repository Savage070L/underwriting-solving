// protocol-generator.js — Generate Protocol of Underwriting Council meeting
// Стиль по шаблону: основной блок 10pt, подписной блок 8pt, чтобы протокол
// помещался на одну страницу.

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

    // Helpers — основной шрифт (10pt)
    const tr = (text, opts = {}) => new TextRun({ text, font: FONT, size: SIZE, ...opts });
    const trB = (text, opts = {}) => tr(text, { bold: true, ...opts });
    // Подписной блок (8pt)
    const trF = (text, opts = {}) => new TextRun({ text, font: FONT, size: SIZE_FOOTER, ...opts });
    const trFB = (text, opts = {}) => trF(text, { bold: true, ...opts });
    const emptyP = () => new Paragraph({ children: [tr('')] });
    const emptyPF = () => new Paragraph({ children: [trF('')] });

    // Decide organ
    const organ = Utils.determineOrgan(data.insuranceSum, data.riskClass, data.normativ?.fullAssetsTenge);
    const isPravlenie = organ === 'pravlenie';
    const members = isPravlenie ? Utils.PRAVLENIE_MEMBERS : Utils.AS_MEMBERS;
    const secretary = isPravlenie ? Utils.PRAVLENIE_SECRETARY : Utils.AS_SECRETARY;
    const organName = isPravlenie ? 'Правления' : 'Андеррайтингового Совета';

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
      children: [new TextRun({ text: `П Р О Т О К О Л  ${docNumber}`, font: FONT, size: SIZE_TITLE, bold: true })],
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

    // === P3: City + date (tab-stop, на одну строку) ===
    paragraphs.push(new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: COL_TOTAL }],
      children: [trB('г. Алматы'), tr('\t'), trB(`от ${dateLine}`)],
    }));

    paragraphs.push(emptyP());

    // === P4: Присутствовали ===
    paragraphs.push(new Paragraph({
      children: [trB(`На заседании ${organName} Компании присутствовали:`)],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(emptyP());

    // Председатель
    const chair = members[0];
    paragraphs.push(new Paragraph({
      children: [trB(`Председатель ${organName}: `)],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(new Paragraph({
      children: [tr(`- ${chair[1]} – ${chair[0]};`)],
      alignment: AlignmentType.JUSTIFIED,
    }));
    // (без emptyP — переходим сразу к Членам)

    // Члены
    paragraphs.push(new Paragraph({
      children: [trB(`Члены ${organName}:`)],
      alignment: AlignmentType.JUSTIFIED,
    }));
    for (let i = 1; i < members.length; i++) {
      const [role, name] = members[i];
      paragraphs.push(new Paragraph({
        children: [tr(`- ${name} – ${role};`)],
        alignment: AlignmentType.JUSTIFIED,
      }));
    }
    // (без emptyP)

    // Секретарь
    paragraphs.push(new Paragraph({
      children: [trB(`Секретарь ${organName}: `), tr(`${secretary} – главный специалист департамента андеррайтинга и перестрахования.`)],
      alignment: AlignmentType.JUSTIFIED,
    }));
    // (без emptyP)

    // === Повестка дня ===
    paragraphs.push(new Paragraph({
      children: [trB('Повестка дня:')],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(new Paragraph({
      children: [tr(
        `Рассмотрение целесообразности заключения сделки, подпадающей под лимиты ${organName} Компании – ` +
        `договора обязательного страхования работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей с ${companyName}.`
      )],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // === По вопросу повестки дня (жирным) + продолжение (обычным) в одном параграфе ===
    paragraphs.push(new Paragraph({
      children: [
        trB('По вопросу повестки дня '),
        tr(
          `выступил Директор департамента андеррайтинга и перестрахования ${Utils.DAIP_DIRECTOR_NAME}, ` +
          `предложил членам ${organName} рассмотреть Заключение (рекомендации) департамента андеррайтинга и перестрахования ` +
          `№ ${docNumber} от ${dateDot} по данной сделке и принять решение о целесообразности заключения.`
        ),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());
    paragraphs.push(new Paragraph({
      children: [tr('Вопрос поставлен на голосование.')],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // === Результаты голосования — с выровненной табуляцией ===
    // Tab-stop в позиции 2400 — все «- «За»» выровнены в одну вертикальную колонку.
    const VOTE_TAB = 2400;
    paragraphs.push(new Paragraph({
      children: [trB('Результаты голосования:')],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(new Paragraph({
      children: [trB('Председатель Совета:')],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(new Paragraph({
      tabStops: [{ type: TabStopType.LEFT, position: VOTE_TAB }],
      children: [tr(chair[1]), tr('\t'), tr('- «За»')],
    }));

    paragraphs.push(new Paragraph({
      children: [trB('Члены Совета:')],
      alignment: AlignmentType.JUSTIFIED,
    }));
    for (let i = 1; i < members.length; i++) {
      const name = members[i][1];
      paragraphs.push(new Paragraph({
        tabStops: [{ type: TabStopType.LEFT, position: VOTE_TAB }],
        children: [tr(name), tr('\t'), tr('- «За»')],
      }));
    }
    // (без emptyP)

    // === Всего голосов: две строки с выровненной правой колонкой ===
    // Tab-stop'ы: 2400 = метка «За/Против», 3200 = разделитель, 3600 = число
    const TOT_LABEL_TAB = 2400;
    const TOT_DASH_TAB = 3300;
    const TOT_NUM_TAB = 3700;
    paragraphs.push(new Paragraph({
      tabStops: [
        { type: TabStopType.LEFT, position: TOT_LABEL_TAB },
        { type: TabStopType.LEFT, position: TOT_DASH_TAB },
        { type: TabStopType.LEFT, position: TOT_NUM_TAB },
      ],
      children: [trB('Всего голосов:'), tr('\t'), trB('«За»'), tr('\t'), tr('-'), tr('\t'), tr(String(members.length))],
    }));
    paragraphs.push(new Paragraph({
      tabStops: [
        { type: TabStopType.LEFT, position: TOT_LABEL_TAB },
        { type: TabStopType.LEFT, position: TOT_DASH_TAB },
        { type: TabStopType.LEFT, position: TOT_NUM_TAB },
      ],
      children: [tr(''), tr('\t'), trB('«Против»'), tr('\t'), tr('-'), tr('\t'), tr('0')],
    }));

    paragraphs.push(emptyP());

    // === Принято РЕШЕНИЕ (жирным) + продолжение (обычным) в одной строке-параграфе ===
    paragraphs.push(new Paragraph({
      children: [
        trB('Принято РЕШЕНИЕ: '),
        tr(
          `заключить договор по обязательному страхованию работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей с ${companyName}, ` +
          `в соответствии с Заключением (рекомендацией) департамента андеррайтинга и перестрахования № ${docNumber} от ${dateDot}`
        ),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyPF());

    // ============================================
    // ПОДПИСНОЙ БЛОК (8pt)
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
      children: [trFB(`Члены ${organName}: `)],
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

    // Secretary block
    paragraphs.push(new Table({
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: COL_TOTAL, type: WidthType.DXA },
              borders: noBorders,
              columnSpan: 3,
              children: [new Paragraph({
                children: [trFB(`Секретарь ${organName}: `)],
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
