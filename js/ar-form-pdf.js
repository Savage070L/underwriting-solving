// ar-form-pdf.js — та же форма «АРешение», что и в ar-form.js, но в PDF.
//
// Зачем PDF, а не .docx: в документ вшиты факсимиле подписантов, а подписанный
// документ не должен быть редактируемым. Word-версия этой формы больше не
// печатается (по решению пользователя) — остаётся только PDF.
//
// Данные и правила БЕРУТСЯ ИЗ ARForm (ar-form.js): _effName, _money, _pct,
// _coeff, _int, _dateRu, decisionText, подписанты и факсимиле. Здесь только
// РАЗМЕТКА — так две версии формы не разъезжаются по смыслу.
//
// Геометрия повторяет .docx один в один: те же ширины колонок (COLS в твипах),
// те же кегли (8 pt тело, 6,5 pt шапка финансовой таблицы), поля страницы 1 см.
// Шрифт — Times New Roman, вшитый в документ (см. js/lib/pdf-fonts.js): бланк
// свёрстан под него, и PDF должен выглядеть одинаково у любого получателя.

const ARFormPdf = {
  TW: 20,            // 1 pt = 20 твипов (единицы .docx-версии)
  SZ: 8,             // pt — тело
  SZ_TH: 6.5,        // pt — шапка финансовой таблицы
  FONT: 'TimesNewRoman',

  _pt(twips) { return twips / ARFormPdf.TW; },

  // ===== Вертикальное центрирование в ячейках =====
  // pdfmake прижимает содержимое ячейки к ВЕРХУ и центрировать по высоте не
  // умеет, а в бланке (и в .docx-оригинале) всё центрировано: там, где подпись
  // стоит рядом с двухстрочной подписью должности, текст должен быть посередине.
  // Поэтому считаем переносы сами — по реальным ширинам символов Times New Roman
  // (PDF_CHAR_W из js/lib/pdf-fonts.js) — и добавляем ячейке верхний отступ.
  LINE_K: 1.15,          // высота строки = кегль × K (замерено по готовому PDF)
  SIG_ROW_K: 2.5,        // во столько раз выше обычной делаем строку с подписью
  SIG_ROW_PAD: 12,       // pt — воздух над и под подписью внутри строки
  SIG_ABOVE: 0.55,       // какая доля росчерка лежит ВЫШЕ линии прочерка

  _charW(ch, bold) {
    const t = (typeof PDF_CHAR_W !== 'undefined') ? PDF_CHAR_W
      : ((typeof window !== 'undefined' && window.PDF_CHAR_W) || null);
    if (!t) return 0.5;
    const m = t[bold ? 'b' : 'n'];
    const v = m && m[ch];
    return (v == null) ? 0.5 : v;   // неизвестный символ — средняя ширина
  },

  _textW(str, size, bold) {
    let w = 0;
    for (const ch of String(str)) w += ARFormPdf._charW(ch, bold);
    return w * size;
  },

  // Сколько строк займёт текст в колонке шириной widthPt. Перенос жадный, по
  // пробелам — как у pdfmake; слово длиннее колонки занимает свою строку.
  _lineCount(str, widthPt, size, bold) {
    const words = String(str == null ? '' : str).split(/\s+/).filter(Boolean);
    if (!words.length || widthPt <= 0) return 1;
    const spaceW = ARFormPdf._charW(' ', bold) * size;
    let lines = 1, cur = 0;
    for (const word of words) {
      const ww = ARFormPdf._textW(word, size, bold);
      const add = cur === 0 ? ww : cur + spaceW + ww;
      if (add <= widthPt) { cur = add; }
      else { lines++; cur = ww; }
    }
    return lines;
  },

  // Готовит pdfmake к работе: шрифты в виртуальную ФС + описание начертаний.
  _ensureFonts() {
    if (ARFormPdf._fontsReady) return;
    if (typeof pdfMake === 'undefined') throw new Error('pdfmake не подключён');
    const fonts = (typeof PDF_FONTS !== 'undefined') ? PDF_FONTS
      : ((typeof window !== 'undefined' && window.PDF_FONTS) || {});
    pdfMake.vfs = Object.assign({}, pdfMake.vfs || {}, fonts);
    pdfMake.fonts = Object.assign({}, pdfMake.fonts || {}, {
      TimesNewRoman: {
        normal: 'TimesNewRoman-Regular.ttf',
        bold: 'TimesNewRoman-Bold.ttf',
        italics: 'TimesNewRoman-Italic.ttf',
        bolditalics: 'TimesNewRoman-Bold.ttf',
      },
    });
    ARFormPdf._fontsReady = true;
  },

  // PNG-факсимиле как data:URL — pdfmake принимает только их.
  async _signaturesDataUrl() {
    if (ARFormPdf._sigUrls) return ARFormPdf._sigUrls;
    const out = {};
    for (const s of ARForm.SIGNATURES) {
      try {
        const resp = await fetch(s.file);
        if (!resp.ok) continue;
        const buf = await resp.arrayBuffer();
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const dim = await ARForm._pngSize(buf);
        out[s.file] = { url: 'data:image/png;base64,' + btoa(bin), ...dim };
      } catch (e) { /* нет картинки — печатаем пустой прочерк */ }
    }
    ARFormPdf._sigUrls = out;
    return out;
  },

  // ===== Описание документа для pdfmake =====
  _docDefinition(row, opts = {}) {
    const A = ARForm;
    const pt = ARFormPdf._pt;
    // ВАЖНО про ширины: в .docx отступы ячейки ВХОДЯТ в ширину колонки, а pdfmake
    // прибавляет их СНАРУЖИ. Если этого не учесть, таблица шире листа и правая
    // колонка обрезается. Поэтому из каждой колонки вычитаем горизонтальные
    // отступы — тогда внешняя ширина совпадает с .docx-версией.
    const PAD_X = pt(60);                       // отступ слева/справа в ячейке
    const COLS = A.COLS.map(c => pt(c) - 2 * PAD_X);
    const SZ = ARFormPdf.SZ, SZ_TH = ARFormPdf.SZ_TH;
    const sigs = opts.signatures || {};

    // ==== значения строки (та же логика, что в .docx-версии) ====
    const nameCell = A._effName(row) || '';
    const binCell = `${row.bin}${A._residencySuffix(row.bin)}`;
    const docNo = row.contractNumber || '';
    const docDate = A._dateRu(row.dateContract);
    const period = `с ${A._dateRu(row.periodFrom)} по ${A._dateRu(row.periodTo)}`;
    const recText = `принять на страхование на указанных условиях — ${A.decisionText(row)}`;

    const fromRef = (key) => ((typeof App !== 'undefined' && App._getSigner) ? App._getSigner(key) : null);
    const fromRefRole = (key) => ((typeof App !== 'undefined' && App._getSignerRole) ? App._getSignerRole(key) : null);
    // Подписант Рекомендации ДАиП — ОТДЕЛЬНЫЙ справочник ('daipUnderwriter'), а
    // не «Директор ДАиП» ('daipDirector'). Ключ был один, и смена подписанта
    // Рекомендации протаскивала его во все документы «Андеррайтингового
    // решения» (СЗ, Протокол) — теперь это разные люди и разные поля.
    const uwName = (opts.underwriterName && String(opts.underwriterName).trim())
      || fromRef('daipUnderwriter') || A.UNDERWRITER;
    const uwRole = (opts.underwriterRole && String(opts.underwriterRole).trim())
      || fromRefRole('daipUnderwriter') || A.UNDERWRITER_ROLE;
    const rmName = fromRef('asMember4') || A.RISK_MANAGER;
    const rmRole = (typeof App !== 'undefined' && App._getSignerRole)
      ? (App._getSignerRole('asMember4') || A.RISK_MANAGER_ROLE) : A.RISK_MANAGER_ROLE;

    // ==== ячейки ====
    const txt = (text, o = {}) => Object.assign({ text: String(text == null ? '' : text), fontSize: SZ }, o);
    const span = (n) => ({ colSpan: n });

    // Ячейка подписи. Факсимиле — картинка с ОТРИЦАТЕЛЬНЫМИ полями: она ложится
    // ПОВЕРХ прочерка (между ФИО и словом «Подпись») и не увеличивает высоту
    // строки — бланк свёрстан ровно под один лист A4. Позиция выверена по
    // образцу пользователя (SIG_HEIGHT и dy каждой подписи — в ar-form.js).
    // Подпись привязана к ФАМИЛИИ: у постороннего подписанта останется прочерк.
    // Ячейка подписи: ФИО | прочерк с факсимиле поверх | «Подпись».
    //
    // Три отдельные колонки нужны, чтобы подпись ВСЕГДА стояла одинаково
    // ОТНОСИТЕЛЬНО ПРОЧЕРКА. Раньше отступ считался от края ячейки, и из-за
    // разной длины ФИО («Джелкобаев Т.К.» против «Осинцев Р.С.») подпись у
    // одного съезжала к началу линии, у другого вставала по центру.
    // Теперь она центрируется по самому прочерку, а его ширина считается из
    // длины строки (в Times New Roman «_» шириной ровно половина кегля).
    //
    // Отрицательные поля картинки: верхнее поднимает её на линию, нижнее
    // компенсирует высоту, чтобы строка бланка не подросла (форма свёрстана
    // ровно под один лист A4).
    // Подпись привязана к ФАМИЛИИ: у постороннего подписанта останется прочерк.
    const UNDERSCORES = '_______________';
    const LINE_W = UNDERSCORES.length * 0.5 * SZ;   // ширина прочерка, pt
    // Факсимиле объявляем в словаре images и ссылаемся по ключу: директор ДАиП
    // подписывает разделы 1 и 3, и при передаче data:URL прямо в узел pdfmake
    // вшивает один и тот же PNG в документ ДВАЖДЫ (+60 КБ на документ пакета).
    const imageDict = {};
    const imageKey = (file) => {
      if (!imageDict[file]) imageDict[file] = sigs[file].url;
      return file;
    };
    const sigCell = (name) => {
      const meta = A._sigFor(name);
      const img = meta && sigs[meta.file];
      if (!img) return txt(`${name}   ${UNDERSCORES} Подпись`);
      const MM = 72 / 25.4;                       // 1 мм в пунктах
      const h = A.SIG_HEIGHT * 0.75;              // px(96 dpi) → pt
      const w = h * (img.width / img.height);
      return {
        columns: [
          txt(name, { width: 'auto' }),
          {
            width: 'auto',
            stack: [
              txt(UNDERSCORES),
              {
                image: imageKey(meta.file),
                width: w,
                height: h,
                // dy — своя посадка у каждой подписи (см. ARForm.SIGNATURES).
                // Доля росчерка НАД линией (SIG_ABOVE) + тонкая подстройка dy.
                // Раньше подпись висела на линии нижним краем (доля = 1), и при
                // увеличении размера верх уезжал на соседние строки. Теперь доля
                // постоянна, поэтому посадка не зависит от размера подписи.
                margin: [(LINE_W - w) / 2 + (meta.dx != null ? meta.dx : A.SIG_DX_DEFAULT) * MM,
                  -(h * ARFormPdf.SIG_ABOVE + (meta.dy != null ? meta.dy : A.SIG_DY_DEFAULT) * MM), 0, -h],
              },
            ],
          },
          txt('Подпись', { width: 'auto' }),
        ],
        // Зазор между ФИО, прочерком и словом «Подпись». Пробелами его не
        // задать: pdfmake обрезает хвостовые пробелы в колонке.
        columnGap: 7,
      };
    };

    const sectionRow = (title, no, date) => ([
      Object.assign(txt(title, { bold: true }), span(5)), {}, {}, {}, {},
      Object.assign(txt('№ ' + (no || '____'), { alignment: 'center' }), span(2)), {},
      Object.assign(txt('от ' + date, { alignment: 'center' }), span(2)), {},
    ]);
    const labelRow = (label, content) => ([
      txt(label),
      Object.assign(typeof content === 'string' ? txt(content) : content, span(8)),
      {}, {}, {}, {}, {}, {}, {},
    ]);

    const FIN_HEADERS = ['ГФОТ (тг.)', 'Страховая сумма (тг.)', 'Класс проф. Риска',
      'Страховой тариф (%)', 'Страховая премия (тг.)', 'Поправочный коэффициент (ПК)',
      'Страховая премия с учетом ПК (тг.)', 'Количество застрахованных'];
    const finHeaderRow = () => ([txt(''), ...FIN_HEADERS.map(h => txt(h, { fontSize: SZ_TH, alignment: 'center' }))]);
    const finDataRow = (label, vals) => ([txt(label), ...vals.map(v => txt(v.text, { alignment: v.align || 'center' }))]);

    const filials = Array.isArray(opts.filials) ? opts.filials : [];
    const allRows = [row, ...filials];
    const finRowFor = (label, r) => finDataRow(label, [
      { text: A._money(r.gfot), align: 'right' },
      { text: A._money(r.insuranceSum), align: 'right' },
      { text: r.riskClass, align: 'center' },
      { text: A._pct(r.tariff), align: 'center' },
      { text: A._money(r.premiumBase), align: 'right' },
      { text: A._coeff(r.coeff), align: 'center' },
      { text: A._money(r.premiumWithCoeff), align: 'right' },
      { text: A._int(r.workers), align: 'center' },
    ]);
    const finTotalRow = () => {
      const sum = (k) => allRows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
      return finDataRow('Итого:', [
        { text: '' }, { text: A._money(sum('insuranceSum')), align: 'right' },
        { text: '' }, { text: '' },
        { text: A._money(sum('premiumBase')), align: 'right' }, { text: '' },
        { text: A._money(sum('premiumWithCoeff')), align: 'right' },
        { text: A._int(sum('workers')), align: 'center' },
      ]);
    };
    const finBody = () => {
      const out = [finRowFor('Страхователь', row)];
      if (filials.length) filials.forEach(f => out.push(finRowFor(A._effName(f) || 'Филиал', f)));
      else out.push(finDataRow('Филиал*', Array.from({ length: 8 }, () => ({ text: '' }))));
      out.push(finTotalRow());
      return out;
    };

    const body = [];
    // Индексы строк с подписью: им задаётся увеличенная высота (см. ниже).
    const sigRows = [];
    // ===== СЕКЦИЯ 1: РЕКОМЕНДАЦИЯ ДАиП =====
    body.push(sectionRow('РЕКОМЕНДАЦИЯ ДАиП', docNo, docDate));
    body.push(labelRow('Страхователь', nameCell));
    body.push(labelRow('БИН/ИИН', binCell));
    body.push(labelRow('Вид страхования', A.RISK_TEXT));
    body.push(labelRow('Класс страхования', A.CLASS_TEXT));
    body.push(finHeaderRow());
    finBody().forEach(r => body.push(r));
    body.push(labelRow('Срок действия договора страхования', period));
    body.push(labelRow('Информация о страховом агенте/Брокере', 'нет'));
    body.push(labelRow('ДАиП рекомендовано:', recText));
    sigRows.push(body.length); body.push(labelRow(`${uwRole}:`, sigCell(uwName)));
    // ===== СЕКЦИЯ 2: ЗАКЛЮЧЕНИЕ ПО УПРАВЛЕНИЮ РИСКАМИ =====
    body.push(sectionRow('ЗАКЛЮЧЕНИЕ ПОДРАЗДЕЛЕНИЯ ПО УПРАВЛЕНИЮ РИСКАМИ', docNo, docDate));
    body.push(labelRow('Класс профессионального риска', 'соответствует'));
    body.push(labelRow('Страховой тариф', 'соответствует'));
    body.push(labelRow('Источник данных по статистике страховых случаев Страхователя', 'Единая Страховая База Данных'));
    sigRows.push(body.length); body.push(labelRow(rmRole, sigCell(rmName)));
    // ===== СЕКЦИЯ 3: АНДЕРРАЙТИНГОВОЕ РЕШЕНИЕ =====
    body.push(sectionRow('АНДЕРРАЙТИНГОВОЕ РЕШЕНИЕ', docNo, docDate));
    body.push(labelRow('На основании Рекомендации', `№ ${docNo || '____'} от ${docDate}`));
    body.push(labelRow('Страхователь', nameCell));
    body.push(labelRow('БИН/ИИН', binCell));
    body.push(labelRow('Вид страхования', A.RISK_TEXT));
    body.push(labelRow('Класс страхования', A.CLASS_TEXT));
    body.push(finHeaderRow());
    finBody().forEach(r => body.push(r));
    body.push(labelRow('Срок действия договора страхования', period));
    body.push(labelRow('Информация о страховом агенте/Брокере', 'нет'));
    body.push(labelRow('РЕШЕНИЕ:', recText));
    sigRows.push(body.length); body.push(labelRow(`${uwRole}:`, sigCell(uwName)));

    // Строки с подписью делаем выше обычных — чтобы факсимиле было читаемым
    // на бумаге (пользователь: на печати подписи выглядели слишком мелкими).
    // Высота задаётся МИНИМУМОМ через table.heights: содержимое в неё
    // центрируется, а не прижимается к верху.
    const rowHeights = {};
    {
      // Высота строки подписи — НЕ МЕНЬШЕ самой подписи плюс поля, иначе
      // факсимиле не помещается и вылезает на соседние строки. Отдельно
      // держим кратность SIG_ROW_K (во сколько раз выше обычной строки), но
      // побеждает большее из двух.
      const sigH = A.SIG_HEIGHT * 0.75;                       // px(96 dpi) → pt
      for (const idx of sigRows) {
        const labelLines = ARFormPdf._lineCount(body[idx][0].text, COLS[0], SZ, false);
        const byLines = labelLines * SZ * ARFormPdf.LINE_K * ARFormPdf.SIG_ROW_K;
        const byImage = sigH + ARFormPdf.SIG_ROW_PAD;
        rowHeights[idx] = Math.max(byLines, byImage);
      }
    }

    // Вертикально центрируем содержимое каждой ячейки: в бланке (и в исходной
    // .docx-форме) текст стоит посередине строки, а pdfmake прижимает его к
    // верху. Считаем, сколько строк займёт каждая ячейка, и недостающую
    // половину разницы добавляем верхним отступом.
    const LINE_H = SZ * ARFormPdf.LINE_K;
    body.forEach((rowCells, rowIdx) => {
      // Ширина ячейки с учётом объединения колонок (внутренние отступы
      // объединённых колонок становятся частью содержимого).
      const widthAt = (j, cs) => {
        let wsum = 0;
        for (let k = j; k < j + cs && k < COLS.length; k++) wsum += COLS[k];
        return wsum + (cs - 1) * 2 * PAD_X;
      };
      const info = [];
      for (let j = 0; j < rowCells.length; j++) {
        const c = rowCells[j];
        if (!c || c.text == null) { info.push(null); continue; }   // заглушка colSpan или колонки
        const cs = c.colSpan || 1;
        const size = c.fontSize || SZ;
        info.push({ cell: c, lines: ARFormPdf._lineCount(c.text, widthAt(j, cs), size, !!c.bold), size });
      }
      const maxLines = Math.max(1, ...info.filter(Boolean).map(x => x.lines));
      // Полезная высота строки: обычно по самой «высокой» ячейке, а у строк с
      // подписью — заданная принудительно (ROW_H в rowHeights).
      const forced = rowHeights[rowIdx];
      const rowH = forced != null ? forced : maxLines * LINE_H;
      if (rowH <= LINE_H + 0.01) return;                            // однострочная строка — центрировать нечего
      for (const x of info) {
        if (!x) continue;
        const own = x.lines * (x.size * ARFormPdf.LINE_K);
        const shift = (rowH - own) / 2;
        if (shift <= 0) continue;
        const m = x.cell.margin || [0, 0, 0, 0];
        x.cell.margin = [m[0], m[1] + shift, m[2], m[3]];
      }
      // Ячейка подписи — это columns, а не text: её тоже опускаем к центру.
      for (const c of rowCells) {
        if (c && c.columns && !c._vcentered) {
          c._vcentered = true;
          const shift = (rowH - LINE_H) / 2;
          const m = c.margin || [0, 0, 0, 0];
          c.margin = [m[0], m[1] + shift, m[2], m[3]];
        }
      }
    });

    const content = [{
      table: { widths: COLS, body, dontBreakRows: true,
        heights: (i) => rowHeights[i] },
      layout: {
        hLineWidth: () => 0.5, vLineWidth: () => 0.5,
        hLineColor: () => '#000000', vLineColor: () => '#000000',
        paddingLeft: () => PAD_X, paddingRight: () => PAD_X,
        paddingTop: () => pt(12), paddingBottom: () => pt(12),
      },
    }, {
      text: '* Указывается при наличии у Страхователя филиала (филиалов), осуществляющего (осуществляющих) отличную от страхователя деятельность.',
      fontSize: 7, italics: true, margin: [0, 3, 0, 0],
    }];
    if (opts.printAlert && row.youngAlert) {
      content.push({
        text: `⚠ Внимание: компания моложе 3 лет${row.ageYears != null ? ` (возраст ≈ ${row.ageYears.toFixed(1).replace('.', ',')} г.)` : ''}${row.decision === 'discount' ? ' — понижающий коэффициент может быть применён ошибочно' : ''}.`,
        fontSize: 7.5, bold: true, color: '#B91C1C', margin: [0, 2, 0, 0],
      });
    }

    return {
      pageSize: 'A4',
      pageMargins: [pt(567), pt(567), pt(567), pt(567)],
      defaultStyle: { font: ARFormPdf.FONT, fontSize: SZ },
      images: imageDict,
      content,
    };
  },

  // Возвращает Blob (.pdf) — для браузера.
  async buildPdf(row, opts = {}) {
    ARFormPdf._ensureFonts();
    const signatures = opts.signatures || await ARFormPdf._signaturesDataUrl();
    const def = ARFormPdf._docDefinition(row, { ...opts, signatures });
    return new Promise((resolve, reject) => {
      try {
        pdfMake.createPdf(def).getBlob(resolve);
      } catch (e) { reject(e); }
    });
  },
};

if (typeof window !== 'undefined') window.ARFormPdf = ARFormPdf;
if (typeof module !== 'undefined' && module.exports) module.exports = ARFormPdf;
