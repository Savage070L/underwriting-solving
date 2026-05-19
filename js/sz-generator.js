// sz-generator.js — Generates Служебная Записка (СЗ) addressed to Правление or СД.
// One module covers both via the `mode` parameter: 'pravlenie' | 'sd'.

const SZGenerator = {

  MONTHS_NOM: [
    'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
  ],

  /**
   * Generate Служебная Записка.
   * @param {Object} data — common data object (same shape as for AR/Zakl)
   * @param {'pravlenie'|'sd'} mode — recipient: chair of Правление or Совет директоров
   */
  async generate(data, mode) {
    const { Document, Packer, Paragraph, TextRun, AlignmentType,
            Table, TableRow, TableCell, WidthType, BorderStyle,
            TabStopType } = docx;

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
    const recipientName = isPravlenie
      ? `${Utils.PRAVLENIE_CHAIR_NAME.replace('Г.', 'Амерходжаеву Г.Т')}` // dative case
      : Utils.SD_CHAIR_NAME;

    const fixedRecipientName = isPravlenie ? 'Амерходжаеву Г.Т.' : Utils.SD_CHAIR_NAME;

    const subject = isPravlenie
      ? 'О вынесении на рассмотрение Правления решения о заключении сделки (договора ОСРНС)'
      : 'О заключении c аффилированным лицом (договор ОСРНС)';

    // Project decision text
    const projectDecision = isPravlenie
      ? `Рассмотреть и утвердить Правлением заключение договора обязательного страхования работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей сделки с компанией – ${companyName}.`
      : `Заключить договор обязательного страхования работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей с ${companyName}, в соответствии с заключением (рекомендацией) департамента андеррайтинга и перестрахования № ${docNumber} от ${dateDot}`;

    // Bottom approval signatory
    const approverRole = isPravlenie ? Utils.UPRAV_DIR_ROLE : Utils.PRAVLENIE_CHAIR_ROLE;
    const approverName = isPravlenie ? Utils.UPRAV_DIR_NAME : Utils.PRAVLENIE_CHAIR_NAME;

    // ---- Helper: two-column row with right-aligned name (tab stops) ----
    const tabRight = 9000;
    const sigLine = (left, right) => new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: tabRight }],
      children: [trB(left), trB('\t'), trB(right)],
    });

    const paragraphs = [];

    // P1: Recipient (right-aligned)
    paragraphs.push(new Paragraph({
      children: [trB(recipientRole)],
      alignment: AlignmentType.RIGHT,
    }));
    paragraphs.push(new Paragraph({
      children: [trB(fixedRecipientName)],
      alignment: AlignmentType.RIGHT,
    }));

    paragraphs.push(emptyP());
    paragraphs.push(emptyP());

    // P2: Title + date — title centered, date on the right
    paragraphs.push(new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: tabRight }],
      children: [trB('Служебная записка'), tr('\t'), tr(dateDot)],
      alignment: AlignmentType.LEFT,
    }));

    paragraphs.push(emptyP());

    // P3: Subject line
    paragraphs.push(new Paragraph({
      children: [
        tr('Укажите формулировку вопроса включаемого в повестку дня заседания. ', { italics: true, color: '808080' }),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(new Paragraph({
      children: [trB(subject)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // P4: Body with details
    paragraphs.push(new Paragraph({
      children: [
        tr('Коротко дайте пояснения по предлагаемому вопросу повестки дня. ', { italics: true, color: '808080' }),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));

    // Detail lines
    const detail = (label, value) => new Paragraph({
      children: [trB(`${label}: `), tr(String(value))],
      alignment: AlignmentType.JUSTIFIED,
    });

    paragraphs.push(detail('Страхователь', companyName));
    paragraphs.push(detail('Класс риска', `– ${data.riskClass || '—'}`));
    paragraphs.push(detail('Вид деятельности страхователя', `«${data.activity || '—'}»`));
    paragraphs.push(detail('Страховая сумма', `${Utils.fmtMoney(data.insuranceSum)}`));
    paragraphs.push(detail('Количество работников', `${Utils.fmtInteger(data.workers)}`));
    paragraphs.push(detail('Страховая премия', `${Utils.fmtMoney(data.premiumBase)}`));
    const premWithCoeff = data.premiumWithCoeff && data.premiumWithCoeff !== data.premiumBase
      ? Utils.fmtMoney(data.premiumWithCoeff) : '-';
    paragraphs.push(detail('Страховая премия с учетом ПК', premWithCoeff));
    paragraphs.push(detail('Оплата', data.paymentOrder || '—'));
    const claimsLine = (data.claims && data.claims.detailedSummary && data.claims.detailedSummary !== 'НС не было')
      ? data.claims.detailedSummary
      : (data.claimsSummary || 'НС не было');
    paragraphs.push(detail('Статистика НС за последние 3-х лет', claimsLine));
    paragraphs.push(detail('Организация с государственным участием', `– ${data.govParticipation || '—'}`));

    paragraphs.push(emptyP());

    // P5: Project of decision
    paragraphs.push(new Paragraph({
      children: [
        tr('Укажите проект решения по вопросу повестки. ', { italics: true, color: '808080' }),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(new Paragraph({
      children: [tr(projectDecision)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // P6: Speaker
    paragraphs.push(new Paragraph({
      children: [trB('Докладчик: '), tr(Utils.DAIP_DIRECTOR_NAME)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // P7: Attachments
    paragraphs.push(new Paragraph({
      children: [trB('Приложения')],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(new Paragraph({
      children: [tr(`Андеррайтинговое решение № ${docNumber} от ${dateDot}`)],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(new Paragraph({
      children: [tr(`Заключение ДАиП от ${dateDot}`)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());
    paragraphs.push(emptyP());

    // P8: Signatures — Director ДАиП + Approver
    paragraphs.push(sigLine(Utils.DAIP_DIRECTOR_ROLE, Utils.DAIP_DIRECTOR_NAME));

    paragraphs.push(emptyP());

    paragraphs.push(new Paragraph({
      children: [trB('Согласовано:')],
      alignment: AlignmentType.JUSTIFIED,
    }));
    paragraphs.push(sigLine(approverRole, approverName));

    // Build document
    const doc = new Document({
      sections: [{
        properties: {
          page: {
            margin: { top: 1440, bottom: 1440, left: 1800, right: 1800 },
          },
        },
        children: paragraphs,
      }],
    });

    return await Packer.toBlob(doc);
  },
};
