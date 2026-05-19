// zakl-generator.js — Generate Заключение .docx

const ZaklGenerator = {

  async generate(data) {
    const {
      Document, Packer, Paragraph, TextRun, AlignmentType,
    } = docx;

    const FONT = 'Times New Roman';
    const SIZE = 23; // 11.5pt in half-points

    // Helpers
    const tr = (text, opts = {}) => new TextRun({ text, font: FONT, size: SIZE, ...opts });
    const trB = (text, opts = {}) => tr(text, { bold: true, ...opts });
    const emptyP = (bold) => new Paragraph({
      children: bold ? [trB('')] : [tr('')],
    });

    const organ = Utils.determineOrgan(data.insuranceSum, data.riskClass, data.normativ?.fullAssetsTenge);
    const decision = Utils.determineDecision(data.coeff, data.coeffDown);
    const verdict = Utils.resolveVerdict(data.verdict, decision);
    const dateShort = Utils.fmtDateShort(data.docDate);
    const companyName = Utils.formatCompanyName(data.insurerName);
    const residency = data.nonResident ? 'нерезидент' : 'резидент';

    // Contract period years
    const periodFrom = data.periodFrom ? Utils.parseExcelDate(data.periodFrom) : null;
    const yearStart = periodFrom ? periodFrom.getFullYear() : new Date().getFullYear();
    const yearEnd = yearStart + 1;

    // Duration
    const duration = Utils.calcDurationMonths(data.periodFrom, data.periodTo);

    // Address line
    const addressParts = [companyName, 'РК'];
    if (data.legalAddress && data.legalAddress !== '-') {
      addressParts.push(data.legalAddress);
    }
    addressParts.push(`БИН ${data.bin}`);
    addressParts.push(`Признак резидентства – ${residency}.`);
    const addressLine = addressParts.join(', ');

    // Normativ data
    const normativDate = data.normativ
      ? Utils.fmtDateWithG(data.normativ.date)
      : '-';
    const fullAssetsThousands = data.normativ ? data.normativ.fullAssets : 0;
    const pctOfAssets = (data.normativ && data.normativ.fullAssetsTenge > 0)
      ? ((data.insuranceSum / data.normativ.fullAssetsTenge) * 100).toFixed(2).replace('.', ',')
      : '-';
    const portfolioSharePct = data.normativ
      ? (data.normativ.portfolioShare * 100).toFixed(2).replace('.', ',')
      : '-';

    // KU data
    const kuWith = data.ku ? Utils.fmtPctRaw(data.ku.lossRatioWith) : '-';
    const kuWithout = data.ku ? Utils.fmtPctRaw(data.ku.lossRatioWithout) : '-';

    // Tariff
    const tariffDisplay = data.tariff ? Utils.fmtPct(data.tariff) : '-';

    // Coefficient effective
    const coeffEffective = (data.coeffDown != null && data.coeffDown !== 0)
      ? (1 - data.coeffDown) : 1;

    // Claims data
    const claimsCount = data.claims ? data.claims.totalClaims : 0;
    const claimsSummary = data.claims
      ? data.claims.detailedSummary
      : 'НС не было';

    // Calculator (risk coefficients)
    const activityData = data.selectedActivity || { deathRate: 0, injuryRate: 0 };
    const deathCalc = (data.workers * activityData.deathRate / 1000);
    const injuryCalc = (data.workers * activityData.injuryRate / 1000);

    // Predicted loss
    const avgAnnualClaims = claimsCount / 3;
    const predictedLoss = Math.round(avgAnnualClaims) * 900000;

    // Final premium (recommendation)
    const finalPremium = coeffEffective !== 1
      ? data.premiumWithCoeff
      : data.premiumBase;

    // Build paragraphs
    const paragraphs = [];

    // P0: Title
    paragraphs.push(new Paragraph({
      children: [trB('Заключение департамента андеррайтинга и перестрахования (рекомендация)')],
      alignment: AlignmentType.CENTER,
    }));

    // P1: Subtitle
    paragraphs.push(new Paragraph({
      children: [trB(`№ ${data.docNumber} от ${dateShort} г.`)],
      alignment: AlignmentType.CENTER,
    }));

    paragraphs.push(emptyP(true));

    // P3: Class of insurance
    paragraphs.push(new Paragraph({
      children: [
        trB('Класс страхования: '),
        tr('обязательное страхование работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей'),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // P5: Info header
    paragraphs.push(new Paragraph({
      children: [trB('Информация и реквизиты страхователя, застрахованного (-х), выгодоприобретателя (-ей):')],
      alignment: AlignmentType.JUSTIFIED,
    }));

    // P6: Company info
    paragraphs.push(new Paragraph({
      children: [tr(addressLine)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // P8: Insurance type and conditions
    paragraphs.push(new Paragraph({
      children: [tr('Вид и условия договора страхования (перестрахования):')],
      alignment: AlignmentType.JUSTIFIED,
    }));

    // P9: Insurance type with years
    paragraphs.push(new Paragraph({
      children: [tr(`Обязательное страхование работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей (${yearStart}-${yearEnd} гг.).`)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    // P10: Covered risks — bulleted list
    paragraphs.push(new Paragraph({
      children: [tr('Покрываемые риски:')],
      alignment: AlignmentType.JUSTIFIED,
    }));

    for (const risk of Utils.COVERED_RISKS) {
      paragraphs.push(new Paragraph({
        children: [tr(risk)],
        alignment: AlignmentType.JUSTIFIED,
        bullet: { level: 0 },
      }));
    }

    paragraphs.push(emptyP(true));

    // Activity
    paragraphs.push(new Paragraph({
      children: [
        trB('Вид экономической деятельности: '),
        tr(`${data.activity || '-'}.`),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP(true));

    // Risk class
    paragraphs.push(new Paragraph({
      children: [
        trB('Класс профессионального риска: '),
        tr(String(data.riskClass || '-')),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));

    // Insured workers
    paragraphs.push(new Paragraph({
      children: [
        trB('Застрахованные: '),
        tr(`${Utils.fmtInteger(data.workers)} работников`),
      ],
      alignment: AlignmentType.JUSTIFIED,
      spacing: { before: 100, after: 100 },
    }));

    // Beneficiaries
    paragraphs.push(new Paragraph({
      children: [
        trB('Выгодоприобретатели'),
        tr(': '),
        tr(companyName),
        tr(Utils.ZAKL_BENEFICIARY_TAIL),
      ],
      alignment: AlignmentType.JUSTIFIED,
      spacing: { before: 100, after: 100 },
    }));

    // Insurance sum with % of assets
    paragraphs.push(new Paragraph({
      children: [
        trB('Общая страховая сумма по договору –'),
        tr(` ${Utils.fmtMoney(data.insuranceSum)} (${pctOfAssets}% от Активов Компании).`),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // Company assets
    paragraphs.push(new Paragraph({
      children: [
        trB(`Активы ${Utils.COMPANY_FULL_NAME}`),
        tr(` (далее – Компания) в страховых резервах на ${normativDate} составляют ${Utils.fmtMoneyThousands(fullAssetsThousands)}.`),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // Portfolio
    paragraphs.push(new Paragraph({
      children: [
        trB(`Страховой портфель Компании на `),
        tr(`${normativDate}:`),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(new Paragraph({
      children: [tr(`Договора по обязательному страхованию работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей составляют ${portfolioSharePct}% от общего портфеля заключенных договоров Компании (по нетто-премии).`)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP(true));

    // Loss ratio with reinsurer
    paragraphs.push(new Paragraph({
      children: [
        trB('Коэффициент убыточности (с учетом доли перестраховщика) на '),
        tr(`${normativDate}: обязательное страхование работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей составляет ${kuWith}.`),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // Loss ratio without reinsurer
    paragraphs.push(new Paragraph({
      children: [
        trB('Коэффициент убыточности (без учета доли перестраховщика) на '),
        tr(`${normativDate}:`),
        trB(' '),
        tr(`обязательное страхование работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей составляет ${kuWithout}.`),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // Contract duration
    paragraphs.push(new Paragraph({
      children: [
        trB('Срок действия договора страхования (перестрахования):'),
        tr(` ${duration} мес.`),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP(true));

    // Claims history
    paragraphs.push(new Paragraph({
      children: [
        trB('Сведения об убытках за последние 3-х лет:'),
        tr(` ${claimsSummary}`),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP(true));

    // Tariff
    paragraphs.push(new Paragraph({
      children: [
        trB('Страховой тариф:'),
        tr(` ${tariffDisplay}`),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP(true));

    // Premium
    paragraphs.push(new Paragraph({
      children: [
        trB('Страховая премия: '),
        tr(Utils.fmtMoney(data.premiumBase)),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));

    // Premium with adjustment (only if coefficient != 1)
    if (coeffEffective !== 1) {
      paragraphs.push(new Paragraph({
        children: [
          trB('Страховая премия с поправочным (понижающим) коэффициентом:'),
          tr(` ${Utils.fmtMoney(data.premiumWithCoeff)}`),
        ],
        alignment: AlignmentType.JUSTIFIED,
      }));
    }

    paragraphs.push(emptyP());

    // Reinsurance
    paragraphs.push(new Paragraph({
      children: [
        trB('Условия перестрахования'),
        tr(` – ${Utils.REINSURANCE_TEXT}`),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // State participation
    paragraphs.push(new Paragraph({
      children: [
        trB('Организация с государственным участием: '),
        tr(data.govParticipation || '-'),
      ],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // Risks section
    paragraphs.push(new Paragraph({
      children: [trB('Риски, связанные с принимаемым договором:')],
      alignment: AlignmentType.JUSTIFIED,
    }));

    // Main activity sentence
    paragraphs.push(new Paragraph({
      children: [tr(`Основной деятельностью ${companyName} — ${data.activity || '-'}.`)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    // Free-form risk text
    if (data.riskText) {
      const riskParagraphs = data.riskText.split('\n').filter(p => p.trim());
      for (const p of riskParagraphs) {
        paragraphs.push(new Paragraph({
          children: [tr(p.trim())],
          alignment: AlignmentType.JUSTIFIED,
        }));
      }
    }

    // Risk analysis — fixed template wording (per template approved by underwriting dept).
    paragraphs.push(new Paragraph({
      children: [tr('Оценка рисков по данному предприятию производилась на основе предоставленных данных по статистике страховых случаев, указанных в заявлении анкете.')],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // Probabilities per 1000 (from калькулятор) and projected counts at this plant.
    // Trim trailing zeros so "0,190" → "0,19", "0,027" stays as-is.
    const fmtRate = (v) => {
      const s = Number(v || 0).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
      return s.replace('.', ',');
    };
    const deathRateStr = fmtRate(activityData.deathRate);
    const injuryRateStr = fmtRate(activityData.injuryRate);
    const deathOnPlantStr = fmtRate((data.workers || 0) * activityData.deathRate / 1000);
    const injuryOnPlantStr = fmtRate((data.workers || 0) * activityData.injuryRate / 1000);

    // Word for risk-class severity: 1–10 низкая, 11–15 средняя, 16–22 высокая
    const riskWord = Utils.riskClassWord(data.riskClass);

    const comparisonText = activityData.deathRate < activityData.injuryRate
      ? 'наиболее подвержены к риску травматизма, чем риску смерти'
      : 'наиболее подвержены к риску смерти, чем риску травматизма';

    paragraphs.push(new Paragraph({
      children: [tr(
        `Учитывая специфику действия предприятия, статистику за последние 3-х лет, ` +
        `вероятность несчастного случая данного класса риска ${riskWord}, ` +
        `исходя из данных Агентства статистики РК количество пострадавших в данном виде деятельности ` +
        `коэффициент травматизма составляет ${injuryRateStr} на 1 000 человек, ` +
        `в нашем случае риск получения травмы на данном предприятии составляет ${injuryOnPlantStr} на ${Utils.fmtInteger(data.workers)} человек, ` +
        `при этом смертельные случаи по данному виду в статистики Агентства РК составляет ${deathRateStr} на 1 000 человек, ` +
        `в нашем случае риск смертельного исхода на данном предприятии составляет ${deathOnPlantStr} на ${Utils.fmtInteger(data.workers)} человека. ` +
        `Таким образом сотрудники данного предприятия ${comparisonText}.`
      )],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP());

    // Summary block — fixed template per ТЗ (predicted loss 900 000 ₸ per recognized injury case)
    paragraphs.push(new Paragraph({
      children: [tr(
        `Резюмируя вышесказанное отмечаем, что вероятность возникновения травмы в страхуемой группе ` +
        `в силу профессиональной деятельности возможен, факт получения одна травма ` +
        `(прогнозируемый убыток нетрудоспособности 900 000 тг.), ` +
        `в связи с чем данные убытки на приемлемом уровне для Компании ` +
        `и страховой премии будет достаточно для покрытия данных убытков.`
      )],
      alignment: AlignmentType.JUSTIFIED,
    }));

    paragraphs.push(emptyP(true));

    // Recommendation
    paragraphs.push(new Paragraph({
      children: [trB('Рекомендация:')],
      alignment: AlignmentType.JUSTIFIED,
    }));

    const decisionTextLower = decision === 'lowered'
      ? 'пониженным поправочным'
      : (decision === 'raised' ? 'повышенным' : 'стандартным');

    let recommendationText;
    if (verdict === 'reject') {
      recommendationText = 'Учитывая вышеизложенное департамент андеррайтинга и перестрахования не считает возможным принять данный риск на страхование в связи с высокой степенью риска.';
    } else if (verdict === 'defer') {
      recommendationText = 'Учитывая вышеизложенное департамент андеррайтинга и перестрахования рекомендует отложить принятие решения по данному риску до предоставления страхователем дополнительной информации.';
    } else {
      recommendationText = `Учитывая вышеизложенное департамент андеррайтинга и перестрахования считает, возможным принять данный риск на страхование со страховой премией не менее ${Utils.fmtMoney(finalPremium)}.`;
    }

    paragraphs.push(new Paragraph({
      children: [tr(recommendationText)],
      alignment: AlignmentType.JUSTIFIED,
    }));

    // Signature
    paragraphs.push(emptyP(true));
    paragraphs.push(emptyP(true));

    const { TabStopType, TabStopPosition } = docx;
    paragraphs.push(new Paragraph({
      children: [trB('Директор Департамента')],
    }));

    // Use a right-aligned tab stop so signatory name sits on the same line
    paragraphs.push(new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: 9638 }],
      children: [
        trB('андеррайтинга и перестрахования'),
        trB('\t'),
        trB('Джелкобаев Т.К.'),
      ],
    }));

    // Trailing empty paragraphs
    for (let i = 0; i < 5; i++) {
      paragraphs.push(emptyP());
    }

    // Assemble document
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
