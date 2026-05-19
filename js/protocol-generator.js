// protocol-generator.js — Generate Protocol of Underwriting Council meeting

const ProtocolGenerator = {

  // Russian month names (genitive case for "от 02 февраля")
  MONTHS_GEN: [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ],
  // Russian month names (nominative — as used in original template)
  MONTHS_NOM: [
    'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
  ],

  async generate(data) {
    const {
      Document, Packer, Paragraph, TextRun, AlignmentType,
      Table, TableRow, TableCell, WidthType, BorderStyle,
      TableLayoutType, VerticalAlign,
    } = docx;

    const FONT = 'Times New Roman';
    const SIZE = 24; // 12pt in half-points
    const SIZE_TITLE = 32; // 16pt

    // Helpers
    const tr = (text, opts = {}) => new TextRun({ text, font: FONT, size: SIZE, ...opts });
    const trB = (text, opts = {}) => tr(text, { bold: true, ...opts });
    const emptyP = () => new Paragraph({ children: [tr('')] });

    // Decide organ
    const organ = Utils.determineOrgan(data.insuranceSum, data.riskClass, data.normativ?.fullAssetsTenge);
    const isPravlenie = organ === 'pravlenie';
    const members = isPravlenie ? Utils.PRAVLENIE_MEMBERS : Utils.AS_MEMBERS;
    const secretary = isPravlenie ? Utils.PRAVLENIE_SECRETARY : Utils.AS_SECRETARY;
    const organName = isPravlenie ? 'Правления' : 'Андеррайтингового Совета';
    const organNameShort = isPravlenie ? 'Правления' : 'АС';
    const organNameFull = isPravlenie ? 'Правление' : 'Андеррайтинговый Совет';

    // Format date
    const docDate = data.docDate ? new Date(data.docDate) : new Date();
    const day = String(docDate.getDate()).padStart(2, '0');
    const monthNom = ProtocolGenerator.MONTHS_NOM[docDate.getMonth()];
    const year = docDate.getFullYear();
    const dateLine = `«${day}» ${monthNom} ${year} г.`;

    const companyName = Utils.formatCompanyName(data.insurerName);

    // Number
    const docNumber = data.docNumber || '13';

    const { TabStopType } = docx;
    const paragraphs = [];

    // P1: Title — "П Р О Т О К О Л NN" on one line
    paragraphs.push(new Paragraph({
      children: [new TextRun({ text: `П Р О Т О К О Л ${docNumber}`, font: FONT, size: SIZE_TITLE, bold: true })],
      alignment: AlignmentType.CENTER,
    }));

    // P2: subtitle lines
    paragraphs.push(new Paragraph({
      children: [trB(`заседания ${organName}`)],
      alignment: AlignmentType.CENTER,
    }));
    paragraphs.push(new Paragraph({
      children: [trB('АО «КСЖ «Standard Life»')],
      alignment: AlignmentType.CENTER,
    }));

    paragraphs.push(emptyP());

    // P3: City (left) and date (right) on the same line via right-aligned tab stop
    paragraphs.push(new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: 9638 }],
      children: [
        trB('г. Алматы'),
        tr('\t'),
        trB(`от ${dateLine}`),
      ],
    }));

    paragraphs.push(emptyP());

    // P4: Attendance header
    paragraphs.push(new Paragraph({
      children: [trB(`На заседании ${organName} Компании присутствовали:`)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // Председатель (chair) — first member
    const chair = members[0]; // ['Председатель Правления', 'Амерходжаев Г.Т.']
    paragraphs.push(new Paragraph({
      children: [trB(`Председатель ${organName}: `)],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(new Paragraph({
      children: [tr(`- ${chair[1]} – ${chair[0]};`)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // Члены Совета (members 2..N-1; last one if not Director — actually the protocol includes Director ДАиП at the end)
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

    paragraphs.push(emptyP());

    // Секретарь
    paragraphs.push(new Paragraph({
      children: [trB(`Секретарь ${organName}: `)],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(new Paragraph({
      children: [tr(`- ${secretary} – главный специалист департамента андеррайтинга и перестрахования.`)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // Agenda
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

    // Speaker section
    const directorName = 'Джелкобаев Т.К.';
    paragraphs.push(new Paragraph({
      children: [tr(
        `По вопросу повестки дня выступил Директор департамента андеррайтинга и перестрахования ${directorName}, ` +
        `предложил членам ${organName} рассмотреть Заключение (рекомендации) департамента андеррайтинга и перестрахования ` +
        `№ ${docNumber} от ${day}.${String(docDate.getMonth() + 1).padStart(2, '0')}.${year} г. ` +
        `по данной сделке и принять решение о целесообразности заключения.`
      )],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    paragraphs.push(new Paragraph({
      children: [tr('Вопрос поставлен на голосование.')],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // Voting results — show only "За" per template (no "Против" column).
    const CHECKBOX = '☐';
    paragraphs.push(new Paragraph({
      children: [trB('Результаты голосования:')],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(new Paragraph({
      children: [trB('Председатель Совета:')],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(new Paragraph({
      children: [tr(`${chair[1]}     ${CHECKBOX} «За»`)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(new Paragraph({
      children: [trB('Члены Совета:')],
      alignment: AlignmentType.JUSTIFIED,
    }));
    for (let i = 1; i < members.length; i++) {
      const name = members[i][1];
      paragraphs.push(new Paragraph({
        children: [tr(`${name}     ${CHECKBOX} «За»`)],
        alignment: AlignmentType.JUSTIFIED,
      }));
    }

    paragraphs.push(emptyP());

    // Totals — only "За" per template.
    paragraphs.push(new Paragraph({
      children: [trB('Всего голосов:')],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(new Paragraph({
      children: [tr(`«За»  - ____ из ${members.length}`)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // DECISION
    paragraphs.push(new Paragraph({
      children: [trB('Принято РЕШЕНИЕ:')],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(new Paragraph({
      children: [tr(
        `заключить договор по обязательному страхованию работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей с ${companyName}, ` +
        `в соответствии с Заключением (рекомендацией) департамента андеррайтинга и перестрахования № ${docNumber} от ${day}.${String(docDate.getMonth() + 1).padStart(2, '0')}.${year} г.`
      )],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());
    paragraphs.push(emptyP());

    // === Signatures — same 3-column invisible-border table as in AR ===
    // Page width A4 minus 2×1134 twips of margins = 9638 twips available.
    const COL_TOTAL = 9638;
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
            children: [tr(nameText)],
            alignment: AlignmentType.LEFT,
          })],
        }),
        new TableCell({
          width: { size: SIG_COL_LINE, type: WidthType.DXA },
          borders: noBorders,
          verticalAlign: VerticalAlign.CENTER,
          children: [new Paragraph({
            children: [tr('___________________')],
            alignment: AlignmentType.CENTER,
          })],
        }),
        new TableCell({
          width: { size: SIG_COL_DATE, type: WidthType.DXA },
          borders: noBorders,
          verticalAlign: VerticalAlign.CENTER,
          children: [new Paragraph({
            children: [tr(dateLine)],
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
      children: [trB(`Члены ${organName}: `)],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(emptyP());

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

    paragraphs.push(emptyP());

    // Secretary block — same column structure, header spanning 3 cells then sigRow.
    paragraphs.push(new Table({
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: COL_TOTAL, type: WidthType.DXA },
              borders: noBorders,
              columnSpan: 3,
              children: [new Paragraph({
                children: [trB(`Секретарь ${organName}: `)],
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

    // Build document
    const doc = new Document({
      sections: [{
        properties: {
          page: {
            margin: {
              top: 1134,   // 2 cm
              bottom: 1134,
              left: 1134,
              right: 1134,
            },
          },
        },
        children: paragraphs,
      }],
    });

    return await Packer.toBlob(doc);
  },
};
