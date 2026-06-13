// ar-form.js — строит HTML заполненной формы «Андеррайтинговое решение (АР)»
// в том виде, как лист «АРешение» из шаблона Андеррешение_ОСНС.XLS: три секции
// (Рекомендация ДАиП → Заключение по управлению рисками → Андеррайтинговое
// решение) с горизонтальной таблицей финансовых показателей.
//
// Этот HTML затем рендерится в PDF (html2canvas + jsPDF) контроллером BatchAR.
// Источник данных — строка из BatchReader.parse(); официальное название/адрес и
// дата регистрации (для алерта «моложе 3 лет») берутся из statgov, если есть.

const ARForm = {
  MONTHS_GEN: [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ],

  UNDERWRITER: 'Джелкобаев Т.К.',

  RISK_TEXT: 'Обязательное страхование работника от несчастного случая при исполнении им трудовых (служебных) обязанностей',
  CLASS_TEXT: 'Страхование от несчастных случаев',

  _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  // «12» июня 2026 г.  (пусто → пустые кавычки-плейсхолдеры как в бланке)
  _dateRu(d) {
    if (!(d instanceof Date) || isNaN(d)) return '«__» __________ 20__ г.';
    return `«${String(d.getDate()).padStart(2, '0')}» ${ARForm.MONTHS_GEN[d.getMonth()]} ${d.getFullYear()} г.`;
  },

  _money(v) {
    if (v == null || isNaN(v)) return '';
    const num = Math.round(Number(v) * 100) / 100;
    const parts = num.toFixed(2).split('.');
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return parts[1] === '00' ? intPart : intPart + ',' + parts[1];
  },

  _int(v) {
    if (v == null || isNaN(v)) return '';
    return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  },

  _pct(v) {
    if (v == null || isNaN(v)) return '';
    return (v * 100).toFixed(2).replace('.', ',') + '%';
  },

  _coeff(v) {
    if (v == null || isNaN(v)) return '1';
    return String(v).replace('.', ',');
  },

  // Текст решения по поправочному коэффициенту.
  decisionText(row) {
    return row.decision === 'discount'
      ? `принятие с понижающим коэффициентом (${ARForm._coeff(row.coeff)})`
      : 'принятие со стандартным тарифом';
  },

  // Стили формы — инжектятся один раз в документ, где будет идти рендер.
  injectStyles(doc = document) {
    if (doc.getElementById('arf-styles')) return;
    const st = doc.createElement('style');
    st.id = 'arf-styles';
    st.textContent = `
      .arf {
        width: 900px; box-sizing: border-box; background: #fff; color: #000;
        font-family: 'Times New Roman', Times, serif; font-size: 12px; line-height: 1.25;
        padding: 18px 22px;
      }
      .arf * { box-sizing: border-box; }
      .arf table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      .arf td { border: 1px solid #000; padding: 3px 5px; vertical-align: middle; word-wrap: break-word; }
      .arf .arf-sec { font-weight: bold; font-size: 12.5px; }
      .arf .arf-lbl { width: 220px; }
      .arf .arf-center { text-align: center; }
      .arf .arf-th { text-align: center; font-size: 10.5px; line-height: 1.15; }
      .arf .arf-num { text-align: right; font-variant-numeric: tabular-nums; }
      .arf .arf-fixed { font-size: 11px; }
      .arf .arf-sig { font-size: 11px; }
      .arf .arf-note { font-size: 10px; font-style: italic; }
      .arf .arf-alert {
        color: #b91c1c; font-weight: bold; font-size: 11px; font-style: normal;
      }
      .arf .arf-spacer { height: 10px; border: none !important; }
      .arf .arf-gap td { border: none; padding: 0; height: 8px; }
      .arf-page { margin: 0 auto; }
    `;
    doc.head.appendChild(st);
  },

  // Горизонтальная таблица финансовых показателей (заголовок + строка «Страхователь»
  // + строка «Филиал*»). 1 колонка-метка + 8 колонок данных.
  _financialBlock(row) {
    const e = ARForm._esc;
    return `
      <tr>
        <td class="arf-lbl"></td>
        <td class="arf-th">ГФОТ (тг.)</td>
        <td class="arf-th">Общая страховая сумма (тг.)</td>
        <td class="arf-th">Класс проф. Риска</td>
        <td class="arf-th">Страховой тариф (%)</td>
        <td class="arf-th">Общая страховая премия (тг.)</td>
        <td class="arf-th">Поправочный коэффициент (ПК)</td>
        <td class="arf-th">Страховая премия с учетом ПК (тг.)</td>
        <td class="arf-th">Количество застрахованных</td>
      </tr>
      <tr>
        <td class="arf-lbl">Страхователь</td>
        <td class="arf-num">${ARForm._money(row.gfot)}</td>
        <td class="arf-num">${ARForm._money(row.insuranceSum)}</td>
        <td class="arf-center">${e(row.riskClass)}</td>
        <td class="arf-center">${ARForm._pct(row.tariff)}</td>
        <td class="arf-num">${ARForm._money(row.premiumBase)}</td>
        <td class="arf-center">${ARForm._coeff(row.coeff)}</td>
        <td class="arf-num">${ARForm._money(row.premiumWithCoeff)}</td>
        <td class="arf-center">${ARForm._int(row.workers)}</td>
      </tr>
      <tr>
        <td class="arf-lbl">Филиал*</td>
        <td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td>
      </tr>`;
  },

  // Полная HTML-разметка одной формы АР. Возвращает строку (один .arf-блок).
  buildHTML(row, opts = {}) {
    const e = ARForm._esc;
    const sg = row.statgov && !row.statgov.error ? row.statgov : null;
    const name = (sg && sg.name) || row.insurerName || '';
    const addr = (sg && sg.legalAddress) || '';
    const nameCell = addr ? `${e(name)}, ${e(addr)}` : e(name);
    const docNo = e(row.contractNumber || '');
    const docDate = ARForm._dateRu(row.dateContract);
    const period = `с ${ARForm._dateRu(row.periodFrom)} по ${ARForm._dateRu(row.periodTo)}`;
    const agent = 'нет';
    const rec = `принять на страхование на указанных условиях — ${ARForm.decisionText(row)}`;
    const fin = ARForm._financialBlock(row);

    // Алерт «моложе 3 лет» — печатается на форме, только если включён (opts.printAlert)
    const alertRow = (opts.printAlert && row.youngAlert) ? `
      <tr><td class="arf-spacer" colspan="9"></td></tr>
      <tr><td class="arf-alert" colspan="9">⚠ Внимание: компания моложе 3 лет${row.ageYears != null ? ` (возраст ≈ ${row.ageYears.toFixed(1).replace('.', ',')} г.)` : ''}${row.decision === 'discount' ? ' — понижающий коэффициент может быть применён ошибочно' : ''}.</td></tr>
    ` : '';

    const headRow = (title, no, date) => `
      <tr>
        <td class="arf-sec" colspan="5">${title}</td>
        <td class="arf-center" colspan="2">№&nbsp;${no || '____'}</td>
        <td class="arf-center" colspan="2">от ${date}</td>
      </tr>`;

    return `
    <div class="arf arf-page">
      <table>
        <!-- ===== СЕКЦИЯ 1: РЕКОМЕНДАЦИЯ ДАиП ===== -->
        ${headRow('РЕКОМЕНДАЦИЯ ДАиП', docNo, docDate)}
        <tr><td class="arf-lbl">Страхователь</td><td colspan="8">${nameCell}</td></tr>
        <tr><td class="arf-lbl">БИН/ИИН</td><td colspan="8">${e(row.bin)}</td></tr>
        <tr><td class="arf-lbl">Вид страхования</td><td class="arf-fixed" colspan="8">${ARForm.RISK_TEXT}</td></tr>
        <tr><td class="arf-lbl">Класс страхования</td><td class="arf-fixed" colspan="8">${ARForm.CLASS_TEXT}</td></tr>
        ${fin}
        <tr><td class="arf-lbl">Срок действия договора страхования</td><td colspan="8">${period}</td></tr>
        <tr><td class="arf-lbl">Информация о страховом агенте/Брокере</td><td colspan="8">${agent}</td></tr>
        <tr><td class="arf-lbl">ДАиП рекомендовано:</td><td colspan="8">${rec}</td></tr>
        <tr><td class="arf-lbl">Андеррайтер:</td><td class="arf-sig" colspan="8">${ARForm.UNDERWRITER}&nbsp;&nbsp;&nbsp;_______________ Подпись</td></tr>
        ${alertRow}

        <tr class="arf-gap"><td colspan="9"></td></tr>

        <!-- ===== СЕКЦИЯ 2: ЗАКЛЮЧЕНИЕ ПО УПРАВЛЕНИЮ РИСКАМИ ===== -->
        ${headRow('ЗАКЛЮЧЕНИЕ ПОДРАЗДЕЛЕНИЯ ПО УПРАВЛЕНИЮ РИСКАМИ', docNo, docDate)}
        <tr><td class="arf-lbl">Класс профессионального риска</td><td colspan="8">соответствует</td></tr>
        <tr><td class="arf-lbl">Страховой тариф</td><td colspan="8">соответствует</td></tr>
        <tr><td class="arf-lbl">Источник данных по статистике страховых случаев Страхователя</td><td colspan="8">Единая Страховая База Данных</td></tr>
        <tr><td class="arf-lbl">Риск-менеджер</td><td class="arf-sig" colspan="8">ФИО / должность&nbsp;&nbsp;&nbsp;_______________ Подпись</td></tr>

        <tr class="arf-gap"><td colspan="9"></td></tr>

        <!-- ===== СЕКЦИЯ 3: АНДЕРРАЙТИНГОВОЕ РЕШЕНИЕ ===== -->
        ${headRow('АНДЕРРАЙТИНГОВОЕ РЕШЕНИЕ', docNo, docDate)}
        <tr><td class="arf-lbl">На основании Рекомендации</td><td colspan="8">№&nbsp;${docNo || '____'} от ${docDate}</td></tr>
        <tr><td class="arf-lbl">Страхователь</td><td colspan="8">${nameCell}</td></tr>
        <tr><td class="arf-lbl">БИН/ИИН</td><td colspan="8">${e(row.bin)}</td></tr>
        <tr><td class="arf-lbl">Вид страхования</td><td class="arf-fixed" colspan="8">${ARForm.RISK_TEXT}</td></tr>
        <tr><td class="arf-lbl">Класс страхования</td><td class="arf-fixed" colspan="8">${ARForm.CLASS_TEXT}</td></tr>
        ${fin}
        <tr><td class="arf-lbl">Срок действия договора страхования</td><td colspan="8">${period}</td></tr>
        <tr><td class="arf-lbl">Информация о страховом агенте/Брокере</td><td colspan="8">${agent}</td></tr>
        <tr><td class="arf-lbl">РЕШЕНИЕ:</td><td colspan="8">принять на страхование на указанных условиях — ${ARForm.decisionText(row)}</td></tr>
        <tr><td class="arf-lbl">Андеррайтер:</td><td class="arf-sig" colspan="8">${ARForm.UNDERWRITER}&nbsp;&nbsp;&nbsp;_______________ Подпись</td></tr>
        ${alertRow}

        <tr class="arf-gap"><td colspan="9"></td></tr>
        <tr><td class="arf-note" colspan="9">* Указывается при наличии у Страхователя филиала (филиалов), осуществляющего (осуществляющих) отличную от страхователя деятельность.</td></tr>
      </table>
    </div>`;
  },
};

if (typeof window !== 'undefined') window.ARForm = ARForm;
