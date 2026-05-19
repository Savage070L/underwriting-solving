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

    const paragraphs = [];

    // P1: Title "П Р О Т О К О Л"
    paragraphs.push(new Paragraph({
      children: [new TextRun({ text: 'П Р О Т О К О Л', font: FONT, size: SIZE_TITLE, bold: true })],
      alignment: AlignmentType.CENTER,
    }));

    paragraphs.push(emptyP());

    // P2: Number and meeting title
    paragraphs.push(new Paragraph({
      children: [
        trB(`№ ${docNumber}`),
      ],
      alignment: AlignmentType.CENTER,
    }));

    paragraphs.push(new Paragraph({
      children: [
        trB(`заседания ${organName}`),
      ],
      alignment: AlignmentType.CENTER,
    }));

    paragraphs.push(new Paragraph({
      children: [
        trB(`АО «КСЖ «Standard Life»`),
      ],
      alignment: AlignmentType.CENTER,
    }));

    paragraphs.push(emptyP());

    // P3: City + date
    paragraphs.push(new Paragraph({
      children: [
        tr('г. Алматы                                                                                                                         '),
        tr(`от ${dateLine}`),
      ],
      alignment: AlignmentType.LEFT,
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

    // Voting results — empty checkboxes since we don't know the actual votes in advance
    const CHECKBOX = '☐'; // ☐ unchecked
    paragraphs.push(new Paragraph({
      children: [trB('Результаты голосования:')],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(new Paragraph({
      children: [trB('Председатель Совета:')],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(new Paragraph({
      children: [tr(`${chair[1]}     ${CHECKBOX} «За»     ${CHECKBOX} «Против»`)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(new Paragraph({
      children: [trB('Члены Совета:')],
      alignment: AlignmentType.JUSTIFIED,
    }));
    for (let i = 1; i < members.length; i++) {
      const name = members[i][1];
      paragraphs.push(new Paragraph({
        children: [tr(`${name}     ${CHECKBOX} «За»     ${CHECKBOX} «Против»`)],
        alignment: AlignmentType.JUSTIFIED,
      }));
    }

    paragraphs.push(emptyP());

    // Totals — leave numbers blank, to be filled in by hand
    paragraphs.push(new Paragraph({
      children: [trB('Всего голосов:')],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(new Paragraph({
      children: [tr(`«За»           - ____ из ${members.length}`)],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(new Paragraph({
      children: [tr(`«Против»  - ____ из ${members.length}`)],
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

    // Signatures
    paragraphs.push(new Paragraph({
      children: [trB(`Члены ${organName}: `)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    for (const [role, name] of members) {
      paragraphs.push(new Paragraph({
        children: [tr(`${role} – ${name}`)],
        alignment: AlignmentType.JUSTIFIED,
      }));
      paragraphs.push(new Paragraph({
        children: [tr(`___________________      ${dateLine}`)],
        alignment: AlignmentType.JUSTIFIED,
      }));
      paragraphs.push(emptyP());
    }

    // Secretary
    paragraphs.push(new Paragraph({
      children: [trB(`Секретарь ${organName}: `)],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(new Paragraph({
      children: [tr(`${secretary}`)],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(new Paragraph({
      children: [tr(`__________________     ${dateLine}`)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    // Build document
    const doc = new Document({
      sections: [{
        properties: {
          page: {
            margin: {
              top: 1440,
              bottom: 1440,
              left: 1800,
              right: 1800,
            },
          },
        },
        children: paragraphs,
      }],
    });

    return await Packer.toBlob(doc);
  },
};
