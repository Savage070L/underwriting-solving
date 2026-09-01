// dossier.js — «Досье» по стороне договора: всё, что приложение знает об одном
// БИН/ИИН, собранное из ВСЕХ источников в одном месте.
//
// Два входа (разметка и содержимое одинаковые, отличается только хост):
//   • «Проверка Договоров» — клик по БИН Страхователя/Контрагента в таблице
//     открывает досье в НОВОЙ ВКЛАДКЕ (Dossier.openFromRow).
//   • «Проверка контрагента» и «Андеррайтинговое решение» — то же досье,
//     встроенное в страницу как САМ профиль компании (Dossier.renderSingle,
//     маунты из _SINGLE_MOUNTS; старые карточки полей убраны).
//
// Источники: выгрузка (реестр), stat.gov.kz (мост-расширение), kyc.kz, egov
// P30.01/P30.11 (резидентство), e-Qazyna (гос. участие), локальный индекс ГБД ЮЛ,
// справочники приложения (классификатор ОКЭД → класс → тариф, аффилированные
// лица), statsnet.co (отрасль — только одиночная проверка).
//
// Досье НИЧЕГО не пересчитывает заново: оно читает те же объекты, что уже лежат
// на строке реестра / в App, и те же helper'ы BatchAR, что красят таблицу — так
// цифры в досье и в таблице не разъезжаются. Чего на строке нет (kyc или egov по
// КОНТРАГЕНТУ — пакетная проверка их не запрашивает), досье догружает САМО по
// открытии и перерисовывается.

const Dossier = {
  // Догруженное «по требованию» — общий кэш страницы (ключ = БИН/ИИН, 12 цифр).
  // egov P30.01/P30.11 своей карты НЕ имеет: сырые ответы кэширует ResidentCheck
  // (_egovRaw + localStorage) — общий бюджет «один БИН = один запрос».
  _sg: new Map(),      // stat.gov.kz
  _kyc: new Map(),     // kyc.kz
  _gov: new Map(),     // e-Qazyna (гос. участие)
  _busy: new Set(),    // «источник+БИН» уже в полёте — не дёргаем повторно
  _miss: new Map(),    // «источник+БИН» → ts неудачи: не молотим источник повторно
  MISS_TTL_MS: 5 * 60 * 1000,  // после неудачи источник не трогаем 5 минут

  // Сырой ответ egov P30.01/P30.11 — из общего кэша ResidentCheck (включая localStorage).
  _egovRawOf(id) {
    return (typeof ResidentCheck !== 'undefined' && ResidentCheck.egovRawFor)
      ? ResidentCheck.egovRawFor(id) : null;
  },

  // Подписи источников (серым рядом со значением). Держим в одном месте: они
  // повторяются в каждой строке досье и в секции «Источники».
  SRC: {
    // «база» — значение как оно пришло в выгрузке (в таблице договоров это верхняя,
    // чёрная строка); «проверка» — то, что посчитало приложение по справочникам.
    exp: 'база',
    check: 'проверка',
    sg: 'stat.gov.kz',
    kyc: 'kyc.kz',
    egov: 'egov P30.01/P30.11',
    gbd: 'ГБД ЮЛ',
    qazyna: 'e-Qazyna',
    statsnet: 'statsnet.co',
    worker: 'pk.uchet.kz',
  },

  // SVG-иконки (эмодзи в карточках рендерятся по-разному на разных системах и
  // выглядят игрушечно; stroke-иконки наследуют цвет через currentColor).
  ICONS: (function () {
    const w = (inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
    return {
      copy: w('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
      download: w('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
      check: w('<polyline points="20 6 9 17 4 12"/>'),
      x: w('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
      briefcase: w('<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>'),
      tag: w('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z"/><circle cx="7" cy="7" r="1"/>'),
      file: w('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>'),
      activity: w('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
      percent: w('<line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>'),
      shield: w('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
      shieldCheck: w('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>'),
      banknote: w('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>'),
      chart: w('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'),
      users: w('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
      user: w('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
      pin: w('<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>'),
      clock: w('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
      landmark: w('<line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/>'),
      wallet: w('<path d="M20 7H4a2 2 0 0 1 0-4h14a2 2 0 0 1 2 2v2z"/><path d="M4 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2H4z"/><circle cx="16" cy="14" r="1.5"/>'),
      card: w('<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>'),
      hash: w('<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>'),
      calendar: w('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
      layers: w('<path d="M12 2 2 7l10 5 10-5-10-5z"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>'),
      globe: w('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
      checkCircle: w('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'),
      server: w('<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>'),
      database: w('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>'),
    };
  })(),

  // Кнопка «копировать» — самодостаточная (в вкладке досье нет window.Dossier):
  // весь обработчик в onclick, успех показывается сменой иконки на галку (CSS).
  _copyBtnHtml(id, small) {
    const js = "(function(b){var d=b.getAttribute('data-id');var done=function(){b.classList.add('is-done');setTimeout(function(){b.classList.remove('is-done');},1200);};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(d).then(done,function(){});}else{var t=document.createElement('textarea');t.value=d;document.body.appendChild(t);t.select();try{document.execCommand('copy');done();}catch(e){}t.remove();}})(this)";
    return `<button type="button" class="ds-copy${small ? ' ds-copy--sm' : ''}" title="Скопировать" aria-label="Скопировать" data-id="${Dossier._esc(id)}" onclick="${js}">`
      + `<span class="ds-ico-copy">${Dossier.ICONS.copy}</span><span class="ds-ico-check">${Dossier.ICONS.check}</span></button>`;
  },

  _esc(v) {
    const s = v == null ? '' : String(v);
    return (typeof ARForm !== 'undefined' && ARForm._esc) ? ARForm._esc(s)
      : s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
  _norm(v) { return String(v == null ? '' : v).replace(/\D/g, ''); },
  _money(v) { return (typeof BatchAR !== 'undefined') ? BatchAR._fmtMoney(v) : String(v ?? '—'); },
  _pct(v) { return (v == null) ? '—' : ((typeof BatchAR !== 'undefined') ? BatchAR._fmtPct(v) : String(v)); },
  _date(v) {
    if (!v) return null;
    if (v instanceof Date) return `${String(v.getDate()).padStart(2, '0')}.${String(v.getMonth() + 1).padStart(2, '0')}.${v.getFullYear()}`;
    const s = String(v).trim();
    // kyc.kz отдаёт ISO («2012-04-11T00:00:00Z»), выгрузка — «03.08.2026 0:00:00»,
    // stat.gov.kz — уже «11.04.2012». Приводим всё к ДД.ММ.ГГГГ.
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
    return s.replace(/\s\d{1,2}:\d{2}(:\d{2})?$/, '');
  },

  // БИН группами по три — так его читают и диктуют: 170 340 019 371.
  _spacedId(id) {
    const s = Dossier._norm(id);
    return s.length === 12 ? s.replace(/(\d{3})(?=\d)/g, '$1 ') : (s || '—');
  },

  // Организационно-правовая форма из наименования + человеческая расшифровка.
  // «РГП на ПХВ «…» МЗ РК» → { form:'РГП на ПХВ', note:'гос. предприятие' }.
  // ВАЖНО: \b в JS-регулярках работает по [A-Za-z0-9_], для кириллицы он не
  // срабатывает вовсе («"РГП» не даёт границы). Поэтому границы задаём явно:
  // перед аббревиатурой не буква и после неё не буква.
  _abbrRe(abbr) {
    return new RegExp('(^|[^A-Za-zА-ЯЁа-яё])' + abbr.replace(/\s+/g, '\\s+') + '(?![A-Za-zА-ЯЁа-яё])', 'i');
  },
  // Подпись — РАСШИФРОВКА аббревиатуры ОПФ, а не вывод о собственности:
  // «ТОО — частная компания» было неверно (бывают ТОО со 100% гос. долей).
  // Собственность видна отдельно: КФС в карточке стороны и карточка «Гос. участие».
  _FORMS: [
    ['РГП на ПХВ', 'РГП на ПХВ', 'республиканское госпредприятие на праве хоз. ведения'],
    ['ГКП на ПХВ', 'ГКП на ПХВ', 'коммунальное госпредприятие на праве хоз. ведения'],
    ['КГП на ПХВ', 'КГП на ПХВ', 'коммунальное госпредприятие на праве хоз. ведения'],
    ['РГП', 'РГП', 'республиканское госпредприятие'],
    ['ГКП', 'ГКП', 'коммунальное госпредприятие'],
    ['КГУ', 'КГУ', 'коммунальное гос. учреждение'],
    ['РГУ', 'РГУ', 'республиканское гос. учреждение'],
    ['ГУ', 'ГУ', 'государственное учреждение'],
    ['ТОО', 'ТОО', 'товарищество с ограниченной ответственностью'],
    ['ТДО', 'ТДО', 'товарищество с дополнительной ответственностью'],
    ['АО', 'АО', 'акционерное общество'],
    ['ПК', 'ПК', 'производственный кооператив'],
    ['ИП', 'ИП', 'индивидуальный предприниматель'],
  ],
  // Полные формулировки реестра — их проверяем первыми: в них аббревиатуры нет.
  _FORMS_FULL: [
    [/республиканск\w*\s+государственн\w*\s+предприяти/i, 'РГП', 'республиканское госпредприятие'],
    [/коммунальн\w*\s+государственн\w*\s+предприяти/i, 'КГП', 'коммунальное госпредприятие'],
    [/государственн\w*\s+учреждени/i, 'ГУ', 'государственное учреждение'],
    [/товарищество\s+с\s+ограниченной/i, 'ТОО', 'товарищество с ограниченной ответственностью'],
    [/товарищество\s+с\s+дополнительной/i, 'ТДО', 'товарищество с дополнительной ответственностью'],
    [/акционерное\s+общество/i, 'АО', 'акционерное общество'],
    [/производственный\s+кооператив/i, 'ПК', 'производственный кооператив'],
    [/^\s*филиал/i, 'Филиал', 'обособленное подразделение'],
    [/^\s*представительство/i, 'Представительство', 'обособленное подразделение'],
    [/индивидуальный\s+предприниматель/i, 'ИП', 'индивидуальный предприниматель'],
  ],
  _legalForm(name) {
    const s = String(name || '');
    if (!s) return null;
    // Аббревиатуру ищем ПЕРВОЙ: «РГП на ПХВ» точнее, чем общее «республиканское
    // государственное предприятие» из той же строки.
    for (const [abbr, form, note] of Dossier._FORMS) {
      if (Dossier._abbrRe(abbr).test(s)) return { form, note };
    }
    for (const [re, form, note] of Dossier._FORMS_FULL) if (re.test(s)) return { form, note };
    return null;
  },

  // Строка размерности: «Малые предприятия (41–50)» из наименования КРП.
  // Диапазон вытаскиваем из самого наименования и переклеиваем в скобки.
  _krpLabel(name) {
    const s0 = String(name || '').trim();
    if (!s0) return null;
    const m = s0.match(/(\d+\s*[-–—]\s*\d+)|(<=?\s*\d+)|(\d+\s*и\s*более)|(более\s*\d+)/i);
    if (!m) return s0;
    const range = m[0].replace(/\s*[-–—]\s*/, '–').replace(/^<=?\s*/, '≤ ').trim();
    let base = s0.replace(m[0], '').replace(/с\s+численностью/i, '').replace(/[\s(),.«»]+$/g, '').replace(/^[\s(),.]+/g, '').trim();
    if (!base) base = 'Предприятия';
    return `${base} (${range})`;
  },
  _krpRow(label, name, code) {
    const lbl = Dossier._krpLabel(name);
    if (!lbl) return null;
    return [label, `<span class="ds-v">${Dossier._esc(lbl)}</span>${code ? `<span class="ds-vnote ds-vnote--block">КРП ${Dossier._esc(code)}</span>` : ''}`];
  },

  // Размер компании из КРП: в наименовании КРП зашит диапазон численности
  // («Предприятия с численностью 251-500» → «251–500»).
  _krpSize(ctx) {
    const sg = Dossier._ok(ctx.sg) ? ctx.sg : null;
    const k = Dossier._ok(ctx.kyc) ? ctx.kyc : null;
    const name = (sg && (sg.krpWithBranchesName || sg.krpWithoutBranchesName)) || (k && k.krpName) || '';
    const m = String(name).match(/(\d+\s*[-–—]\s*\d+)|(<=?\s*\d+)|(\d+\s*и\s*более)|(более\s*\d+)/i);
    // «<= 5» из справочника КРП читается как мусор — пишем по-человечески «≤ 5».
    return m ? m[0].replace(/\s*[-–—]\s*/, '–').replace(/^<=?\s*/, '≤ ').trim() : null;
  },

  // Короткое и полное наименования: короткое идёт в шапку, полное (как в реестре,
  // капсом и целиком) — в раскрывашку под ним.
  _fullName(ctx) {
    const sg = Dossier._ok(ctx.sg) ? ctx.sg.name : null;
    const eg = ctx.egovRaw ? ctx.egovRaw.fullName : null;
    const k = Dossier._ok(ctx.kyc) ? ctx.kyc.name : null;
    const all = [sg, eg, k, ctx.nameExport].filter(Boolean);
    if (!all.length) return null;
    return all.slice().sort((a, b) => b.length - a.length)[0];
  },
  _shortName(ctx) {
    const eg = ctx.egovRaw ? ctx.egovRaw.shortName : null;
    const all = [eg, ctx.nameExport, Dossier._ok(ctx.kyc) ? ctx.kyc.name : null, Dossier._ok(ctx.sg) ? ctx.sg.name : null].filter(Boolean);
    if (!all.length) return null;
    return all.slice().sort((a, b) => a.length - b.length)[0];
  },

  // Значение поля из нескольких источников для «паспорта»: показываем ОДНО —
  // от самого авторитетного источника (порядок items = приоритет), а расхождение
  // сворачиваем в чип «N версии», который раскрывается списком «значение —
  // источник». Перечислять все версии подряд нельзя: карточка превращается в
  // простыню, а знать о разногласии реестров нужно.
  _field(items, opts) {
    const e = Dossier._esc;
    const o = opts || {};
    const list = (items || []).filter(x => x && x.v != null && String(x.v).trim() !== '');
    if (!list.length) return null;
    const keyOf = (v) => (o.key ? o.key(v) : String(v).trim());
    const groups = [];
    for (const it of list) {
      const kk = keyOf(it.v);
      const g = groups.find(x => x.k === kk);
      if (g) { if (!g.srcs.includes(it.src)) g.srcs.push(it.src); continue; }
      groups.push({ k: kk, it, srcs: [it.src] });
    }
    const one = groups[0];
    const many = groups.length > 1;
    // Для полей, где расхождение = «мы не знаем» (руководитель), значение не
    // показываем вовсе: выбрать «правильного» директора мы не можем.
    const head = (many && o.unconfirmed)
      ? '<span class="ds-unconfirmed">не подтверждён</span>'
      : `<span class="ds-v">${one.it.html || e(one.it.v)}</span>`;
    const tail = one.it.note ? `<span class="ds-vnote">${e(one.it.note)}</span>` : '';
    if (!many) return head + tail;
    const label = `${groups.length} ${Utils.plural(groups.length, 'версия', 'версии', 'версий')}`;
    const variants = groups.map(g => `<div class="ds-ver"><span class="ds-v">${g.it.html || e(g.it.v)}</span><span class="ds-src">${e(g.srcs.join(' · '))}</span></div>`).join('');
    return head + tail
      + `<details class="ds-vers"><summary><span class="ds-chip-ver">${e(label)}</span></summary>${variants}</details>`;
  },

  // Наименование без организационно-правовой формы и кавычек — для сравнения
  // между источниками («ТОО «Ромашка»» и «Товарищество с ограниченной
  // ответственностью "Ромашка"» — это одно и то же).
  _nameKey(s) {
    return String(s || '')
      .toUpperCase()
      .replace(/[«»"'`]/g, ' ')
      .replace(/ТОВАРИЩЕСТВО\s+С\s+ОГРАНИЧЕННОЙ\s+ОТВЕТСТВЕННОСТЬЮ|АКЦИОНЕРНОЕ\s+ОБЩЕСТВО|ИНДИВИДУАЛЬНЫЙ\s+ПРЕДПРИНИМАТЕЛЬ/g, ' ')
      .replace(/\b(ТОО|АО|ИП|ГУ|КГП|ТОО|LLP|LLC)\b/g, ' ')
      .replace(/[^A-ZА-ЯЁ0-9]+/g, ' ')
      .trim();
  },


  // ===== Вход 1: клик по БИН в таблице «Проверка Договоров» =====
  // side: 'insurer' (Страхователь) | 'contr' (Контрагент).
  // window.open ОБЯЗАН вызываться синхронно в обработчике клика — иначе браузер
  // считает вкладку всплывающим окном и блокирует (см. CLAUDE.md).
  openFromRow(idx, side) {
    if (typeof BatchAR === 'undefined' || !BatchAR.rows[idx]) return;
    const ctx = Dossier._ctxFromRow(idx, side);
    if (!ctx.id) {
      App.showMsg && App.showMsg('В этой строке нет БИН/ИИН для досье.', 'error');
      return;
    }
    const win = window.open('', '_blank');
    if (!win) {
      App.showMsg && App.showMsg('Разрешите всплывающие окна, чтобы открыть досье в новой вкладке.', 'error');
      return;
    }
    Dossier._navigateShell(win, ctx);
    Dossier._paintWin(win, ctx);
    Dossier._enrich(ctx, () => Dossier._paintWin(win, ctx));
  },

  // Каркас новой вкладки — через BLOB-URL, а не document.write в about:blank.
  // Причина: Chrome блокирует СКАЧИВАНИЯ, инициированные страницей about:blank
  // (кнопка «Скачать» молча не работала), а «Сохранить как…» для about:blank
  // сохраняет пустышку. У blob-страницы есть настоящий URL — работает и кнопка,
  // и ПКМ → «Сохранить как», и обновление стилей. Окно уже открыто синхронно
  // в обработчике клика (иначе попап-блокер), сюда лишь доезжает адрес.
  _css: null,
  _shellScript: '(function(){function L(){document.querySelectorAll(".ds-grid").forEach(function(g){var c=[].slice.call(g.children);'
    + 'g.classList.remove("ds-grid--masonry");c.forEach(function(x){x.style.gridRowEnd="";});'
    + 'var h=c.map(function(x){return x.getBoundingClientRect().height;});g.classList.add("ds-grid--masonry");'
    + 'c.forEach(function(x,i){x.style.gridRowEnd="span "+Math.max(1,Math.ceil((h[i]+16)/4));});});}'
    + 'window.__dsRelayout=L;addEventListener("resize",function(){clearTimeout(window.__dsT);window.__dsT=setTimeout(L,60);});'
    + 'document.addEventListener("toggle",function(){setTimeout(L,10);},true);})();',
  _shellHtml(ctx) {
    const title = `Досье ${ctx.id}${ctx.role ? ' — ' + ctx.role : ''}`;
    return '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + `<title>${Dossier._esc(title)}</title>`
      + `<link rel="stylesheet" href="${new URL('css/style.css', location.href).href}">`
      + `<style id="ds-inline-css">${Dossier._css || ''}</style>`
      + '<style>body{margin:0;padding:24px 24px 48px;background:#f4f6fa;'
      + 'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f172a}'
      + '.ds{max-width:1400px;margin:0 auto}</style>'
      + '</head><body><div class="ds" id="ds-root"></div>'
      + '<scr' + 'ipt>' + Dossier._shellScript + '</scr' + 'ipt></body></html>';
  },
  // ===== Досье как САМОДОСТАТОЧНЫЙ HTML-файл (для ZIP пакетной печати) =====
  // Отличия от вкладки: стили вшиты в файл (внешний css/style.css рядом с ним
  // не лежит), содержимое отрендерено заранее, а масонри пересчитывается сразу
  // при открытии. Файл открывается офлайн и переживает пересылку.
  //
  // ВАЖНО: enrich здесь НЕ вызываем. Пакетная проверка уже сложила stat.gov,
  // kyc, e-Qazyna и резидентство в кэши по каждому БИН — берём готовое. Дёргать
  // источники на сотни строк при печати значило бы устроить тот самый шторм
  // запросов, от которого мы уходили (см. бюджет запросов к egov).
  ensureCss() {
    if (Dossier._css) return Promise.resolve(Dossier._css);
    return fetch(new URL('css/style.css', location.href).href)
      .then(r => r.text())
      .then((t) => { Dossier._css = t; return t; })
      .catch(() => '');
  },

  fileHtml(ctx) {
    const title = `Досье ${ctx.id}${ctx.role ? ' — ' + ctx.role : ''}`;
    return '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + `<title>${Dossier._esc(title)}</title>`
      + `<style>${Dossier._css || ''}</style>`
      + '<style>body{margin:0;padding:24px 24px 48px;background:#f4f6fa;'
      + 'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f172a}'
      + '.ds{max-width:1400px;margin:0 auto}</style>'
      + '</head><body><div class="ds" id="ds-root">' + Dossier._html(ctx) + '</div>'
      + '<scr' + 'ipt>' + Dossier._shellScript + '</scr' + 'ipt>'
      + '<scr' + 'ipt>(function(){function R(){window.__dsRelayout&&window.__dsRelayout();}'
      + 'if(document.readyState==="complete")R();else addEventListener("load",R);})();</scr' + 'ipt>'
      + '</body></html>';
  },

  _navigateShell(win, ctx) {
    const url = URL.createObjectURL(new Blob([Dossier._shellHtml(ctx)], { type: 'text/html;charset=utf-8' }));
    try { win.location.replace(url); } catch (e) { try { win.location = url; } catch (e2) {} }
    // blob-URL не отзываем: страница живёт, пока открыта вкладка, и должна
    // переживать перезагрузку/сохранение.
    Dossier._injectCss(win);
  },

  // Ждём, пока в окне появится каркас (#ds-root): навигация на blob асинхронна,
  // и до неё document — ещё пустой about:blank.
  _whenReady(win, cb, tries) {
    const left = tries == null ? 100 : tries;
    if (!win || win.closed || left <= 0) return;
    let ok = false;
    try { ok = !!(win.document && win.document.getElementById('ds-root')); } catch (e) { ok = false; }
    if (ok) { cb(); return; }
    setTimeout(() => Dossier._whenReady(win, cb, left - 1), 50);
  },

  _injectCss(win) {
    const put = (text) => {
      if (!win || win.closed || !text) return;
      Dossier._whenReady(win, () => {
        try {
          const el = win.document.getElementById('ds-inline-css');
          if (el && !el.textContent) el.textContent = text;
        } catch (e) { /* окно закрыли */ }
      });
    };
    if (Dossier._css) { put(Dossier._css); return; }
    fetch(new URL('css/style.css', location.href).href)
      .then(r => r.text())
      .then(t => { Dossier._css = t; put(t); })
      .catch(() => {});
  },

  _paintWin(win, ctx) {
    if (!win || win.closed) return;
    Dossier._whenReady(win, () => {
      const root = win.document.getElementById('ds-root');
      if (!root) return;
      root.innerHTML = Dossier._html(ctx);
      Dossier._layout(root, win);
    });
  },

  // ===== Масонри: высота карточки = её содержимое =====
  // Обычная CSS-сетка тянет всю строку по самой высокой карточке, и под
  // короткими зияют дыры. Поэтому: замер высот в обычной сетке → включаем
  // masonry-режим (строка 4px) → каждой карточке span по фактической высоте.
  // Если скрипт не отработал, остаётся обычная сетка (деградация, не поломка).
  ROW_UNIT: 4,
  ROW_GAP: 16,
  _layout(root, win) {
    const grids = (root && root.querySelectorAll) ? root.querySelectorAll('.ds-grid') : [];
    for (const grid of grids) {
      const cards = Array.prototype.slice.call(grid.children);
      if (!cards.length) continue;
      grid.classList.remove('ds-grid--masonry');
      cards.forEach((c) => { c.style.gridRowEnd = ''; });
      const heights = cards.map((c) => c.getBoundingClientRect().height);
      grid.classList.add('ds-grid--masonry');
      cards.forEach((c, i) => {
        c.style.gridRowEnd = 'span ' + Math.max(1, Math.ceil((heights[i] + Dossier.ROW_GAP) / Dossier.ROW_UNIT));
      });
    }
    if (grids.length) Dossier._hookLayout(root, win);
  },

  // Пересчёт при изменении ширины и при раскрытии деталей — высота карточки
  // меняется, span должен ехать следом (toggle не всплывает — фаза перехвата).
  _hookLayout(root, win) {
    if (!root || root._dsHooked) return;
    root._dsHooked = true;
    const w = win || window;
    let t = null;
    const relayout = () => { clearTimeout(t); t = setTimeout(() => Dossier._layout(root, win), 60); };
    root.addEventListener('toggle', relayout, true);
    try { w.addEventListener('resize', relayout); } catch (e) {}
  },

  // ===== Вход 2: встроенное досье одиночной проверки =====
  // Два маунта с ОДНИМ контентом: вкладка «Проверка контрагента» и вкладка
  // «Андеррайтинговое решение» (там досье заменило старую карточку «Основная
  // информация»). Вызывается из App.showPreview; перерисовывает ТОЛЬКО свои
  // контейнеры, чтобы догрузка источников не дёргала showPreview (иначе цикл).
  _SINGLE_MOUNTS: ['dossier-contractor', 'dossier-decision'],
  //
  // ПОЧЕМУ ctx ПЕРЕСОБИРАЕТСЯ НА КАЖДУЮ ОТРИСОВКУ (и зачем поколение _singleGen).
  // Проверка по БИН рисует досье дважды: сразу (stat.gov ещё «в пути», ОКЭДов
  // компании нет) и после ответа. Первая отрисовка запускала _enrich, чей
  // колбэк держал ЗАМЫКАНИЕ на старый ctx — и когда через секунду отвечали
  // kyc / e-Qazyna / egov, они перерисовывали досье из ТОГО ЖЕ устаревшего
  // среза, затирая уже показанные данные stat.gov. Наружу это выглядело как
  // «вторичные ОКЭДы не появляются, показывается только основной, а с 2-3-й
  // попытки всё на месте» (со второй попытки источники уже в кэше, поздних
  // колбэков нет — и затирать некому). Лечится двумя правилами:
  //   1) ctx собирается ЗАНОВО в момент отрисовки (_ctxSingle всегда читает
  //      текущее состояние App и кэши источников);
  //   2) колбэки прошлой проверки отбрасываются по номеру поколения.
  _singleGen: 0,
  renderSingle() {
    const hosts = () => Dossier._SINGLE_MOUNTS
      .map(id => document.getElementById(id)).filter(Boolean);
    if (!hosts().length) return;
    const gen = ++Dossier._singleGen;
    const paint = () => {
      if (gen !== Dossier._singleGen) return null;   // это ответ прошлой проверки
      const ctx = Dossier._ctxSingle();
      hosts().forEach(h => {
        if (!ctx.id) { h.innerHTML = ''; return; }
        h.innerHTML = Dossier._html(ctx);
        Dossier._layout(h);
      });
      return ctx;
    };
    const ctx = paint();
    if (ctx && ctx.id) Dossier._enrich(ctx, paint);
  },

  // Пересчёт masonry для встроенных досье — зовётся из App.switchTab: маунт,
  // отрисованный в скрытой вкладке (display:none), намерял нулевые высоты,
  // и при показе спаны надо посчитать заново.
  relayoutMounts() {
    Dossier._SINGLE_MOUNTS.forEach(id => {
      const h = document.getElementById(id);
      if (h && h.firstChild && h.offsetParent !== null) Dossier._layout(h);
    });
  },

  // ===== Контекст =====
  // Все источники на строке реестра привязаны к БИН СТРАХОВАТЕЛЯ (_insurerBin):
  // statgov/kyc/e-Qazyna/egov-резидентство запрашиваются по нему. У контрагента
  // из пакетной проверки есть только statgovContr — остальное досье догружает.
  _ctxFromRow(idx, side) {
    const r = BatchAR.rows[idx];
    const insurerBin = Dossier._norm(BatchAR._insurerBin(r));
    const id = Dossier._norm(side === 'insurer' ? (r.binInsurer || insurerBin) : r.bin);
    const isInsurer = id === insurerBin;
    const pick = (own, shared) => (isInsurer ? (own || shared) : shared);
    return {
      id,
      role: side === 'insurer' ? 'Страхователь' : 'Контрагент',
      side,
      nameExport: side === 'insurer' ? (r.insurerNameSt || '') : (r.insurerName || r.excelName || ''),
      row: r,
      rowIdx: idx,
      sg: (side === 'insurer' ? r.statgov : r.statgovContr) || Dossier._sg.get(id) || null,
      sgPending: r.statgovStatus === 'loading' || r.statgovStatus === 'pending',
      kyc: pick(r.kyc, Dossier._kyc.get(id)) || null,
      gov: pick(r.egov, Dossier._gov.get(id)) || null,
      egovRaw: Dossier._egovRawOf(id),
      statsnet: null,
    };
  },

  _ctxSingle() {
    const z = (typeof App !== 'undefined' && App.zayavka) || null;
    const id = Dossier._norm(z && z.bin);
    const sg = (typeof App !== 'undefined' && App.statgov && !App.statgov.loading) ? App.statgov : null;
    // Гос. участие одиночной проверки лежит в App.binData как ГОТОВАЯ строка
    // («Нет» / доля / «Да (доля не определена)») — приводим к форме e-Qazyna.
    const bd = (typeof App !== 'undefined' && App.binData) || null;
    const govTxt = bd && !bd.loading ? bd.govParticipation : null;
    const gov = govTxt == null ? (Dossier._gov.get(id) || null)
      : { status: 'done', found: govTxt !== 'Нет', share: /^\d/.test(String(govTxt)) ? String(govTxt) : null };
    return {
      id,
      role: 'Проверка контрагента',
      side: 'single',
      nameExport: '',
      row: null,
      rowIdx: null,
      sg: sg || Dossier._sg.get(id) || null,
      sgPending: !!(App.statgov && App.statgov.loading),
      kyc: Dossier._kyc.get(id) || null,
      gov,
      egovRaw: Dossier._egovRawOf(id),
      statsnet: (typeof App !== 'undefined' && App.statsnet) || null,
      legalAddressWorker: bd && bd.legalAddress ? bd.legalAddress : null,
    };
  },

  // ===== Догрузка недостающих источников =====
  // Каждый источник тянем максимум один раз на БИН (кэш + _busy), результат
  // кладём и в общий кэш, и в ctx, после чего дёргаем repaint.
  //
  // АНТИ-ШТОРМ (_miss): fn возвращает true = данные получены. Неудача помечает
  // «источник+БИН» на MISS_TTL_MS, и повторные перерисовки его НЕ дёргают.
  // Без этого любой недоступный источник запрашивался заново на каждый repaint
  // (ctx пересобирается при каждом showPreview) — к egov/stat.gov летел
  // бесконечный поток запросов, что и пугало пользователей.
  _enrich(ctx, repaint) {
    const id = ctx.id;
    if (!id || id.length !== 12) return;
    const bridge = typeof StatGovClient !== 'undefined' && StatGovClient.isAvailable && StatGovClient.isAvailable();
    const isBin = typeof ResidentCheck !== 'undefined' && ResidentCheck.idKind(id) === 'bin';
    const run = (key, cond, fn) => {
      const tag = key + ':' + id;
      if (!cond || Dossier._busy.has(tag)) return;
      if (Date.now() - (Dossier._miss.get(tag) || 0) < Dossier.MISS_TTL_MS) return;
      Dossier._busy.add(tag);
      Promise.resolve()
        .then(fn)
        .then((got) => { if (!got) Dossier._miss.set(tag, Date.now()); },
          () => Dossier._miss.set(tag, Date.now()))
        .then(() => { Dossier._busy.delete(tag); repaint(); });
    };
    // stat.gov.kz — нужен, когда строка ещё не проверялась или досье открыто
    // по контрагенту, которого пакетная проверка не трогала.
    run('sg', bridge && !ctx.sg && !ctx.sgPending, async () => {
      try { const d = await StatGovClient.lookup(id); Dossier._sg.set(id, d); ctx.sg = d; return true; }
      catch (e) { ctx.sg = { error: (e && e.message) || 'ошибка' }; return false; }
    });
    // kyc.kz — открытый источник, работает и без ЭЦП-сессии (нужен только мост).
    run('kyc', bridge && !ctx.kyc && !!StatGovClient.lookupKyc, async () => {
      try { const d = await StatGovClient.lookupKyc(id); Dossier._kyc.set(id, d); ctx.kyc = d; return true; }
      catch (e) { ctx.kyc = { error: (e && e.message) || 'ошибка' }; return false; }
    });
    // e-Qazyna — через Cloudflare-воркер, мост не нужен.
    run('gov', !ctx.gov && typeof BatchAR !== 'undefined', async () => {
      const d = await BatchAR._lookupEgov(id);
      Dossier._gov.set(id, d); ctx.gov = d;
      return !!(d && d.status !== 'error');
    });
    // egov P30.01/P30.11 — авторитетное резидентство. ТОЛЬКО через общий
    // ResidentCheck.fetchEgovRaw: один БИН = один сетевой запрос на всё
    // приложение (кэш raw + localStorage + пауза после ошибки — там же).
    run('egov', bridge && isBin && !ctx.egovRaw
      && typeof ResidentCheck !== 'undefined' && !!ResidentCheck.fetchEgovRaw, async () => {
      const d = await ResidentCheck.fetchEgovRaw(id);
      if (d) ctx.egovRaw = d;
      return !!d;
    });
  },

  // ===== Разметка =====
  _html(ctx) {
    const e = Dossier._esc;
    const secs = Dossier._sections(ctx).filter(Boolean);
    // Каждая зона — отдельная сетка: масонри-раскладка с dense-упаковкой не
    // может перепрыгивать заголовок зоны, если зона — собственный грид.
    const zones = [];
    for (const sec of secs) {
      const last = zones[zones.length - 1];
      if (!last || last.name !== sec.zone) zones.push({ name: sec.zone, list: [sec] });
      else last.list.push(sec);
    }
    return Dossier._headerHtml(ctx) + zones.map(z =>
      (z.name ? `<div class="ds-zone"><span>${e(z.name)}</span></div>` : '')
      + `<div class="ds-grid">${z.list.map(Dossier._sectionHtml).join('')}</div>`).join('');
  },


  // Орган принятия решения по лимитам — для блока «Лимит» в шапке.
  // Пакетная строка: СС договора (ОбщаяСтраховаяСумма, max по филиалам) и класс
  // из выгрузки — ровно те же входы, что у BatchAR._exceedsAsLimit; активов в
  // выгрузке нет (порог СД по 25 % активов не проверить), аффилированность по
  // справочнику → всегда СД. Одиночный кейс: готовые organ/insuranceSum из
  // App._effectiveFinancials — та же логика, что в генерируемых документах.
  ORGAN_LABELS: {
    standard: 'Филиал',
    as: 'Андеррайтинговый совет',
    pravlenie: 'Правление',
    sd: 'Совет директоров',
  },
  _organInfo(ctx) {
    if (typeof Utils === 'undefined' || !Utils.determineOrgan) return null;
    const r = ctx.row;
    const B = Dossier._cB();
    if (r && B) {
      const group = B._groupByContract().get(r.contractNumber || '') || [r];
      const sum = Math.max(0, ...group.map(x => Number(x.insuranceSumTotal) || 0));
      if (!(sum > 0)) return null;
      const cls = Math.max(0, ...group.map(x => parseInt(x.riskClass, 10) || 0));
      return { organ: Utils.determineOrgan(sum, cls, 0, Dossier._affiliated(ctx.id)), sum };
    }
    const z = (typeof App !== 'undefined' && App.zayavka) || null;
    if (!z || z._lookupOnly || typeof App._effectiveFinancials !== 'function') return null;
    const f = App._effectiveFinancials(z);
    if (!f || !(Number(f.insuranceSum) > 0)) return null;
    return { organ: f.organ, sum: f.insuranceSum };
  },

  _headerHtml(ctx) {
    const e = Dossier._esc;
    const name = Dossier._bestName(ctx);
    const short = Dossier._shortName(ctx) || name;
    const B = Dossier._cB();
    const k = Dossier._ok(ctx.kyc) ? ctx.kyc : null;
    const sg = Dossier._ok(ctx.sg) ? ctx.sg : null;
    const r = ctx.row;
    const regSt = (typeof ResidentCheck !== 'undefined' && ResidentCheck.registryStatus) ? ResidentCheck.registryStatus(ctx.id) : 0;
    const dead = (k && k.isActive === false) || regSt === 1;
    // Статус у БИНа показываем ТОЛЬКО когда он подтверждён источником:
    // «Ликвидирована» — kyc isActive=false или пометка ГБД ЮЛ; «Действующая» —
    // явное подтверждение kyc. Без данных пилюли НЕТ: писать «Действующая» по
    // умолчанию — враньё (на «Проверке контрагента» источники часто молчат).
    const activeConfirmed = k && (k.isActive === true || /зарегистрирован/i.test(String(k.status || '')));
    const statusPill = dead
      ? '<span class="ds-pill ds-pill--bad">Ликвидирована</span>'
      : (activeConfirmed ? '<span class="ds-pill ds-pill--good">✓ Действующая</span>' : '');
    // Правый блок шапки — Регион и Автор строки реестра (по просьбе
    // пользователя вместо класса/тарифа: те и так есть в KPI-карточках).
    const risk = (r && (r.region || r.author)) ? `
      <div class="ds-risk">
        <div class="ds-risk-ico">${Dossier.ICONS.pin}</div>
        <div class="ds-risk-body">
          ${r.region ? `<div class="ds-risk-l">Регион</div><div class="ds-risk-v ds-risk-v--sm">${e(r.region)}</div>` : ''}
          ${r.author ? `<div class="ds-risk-t">Автор <b>${e(r.author)}</b></div>` : ''}
        </div>
      </div>` : '';
    // Слева от Региона — орган принятия решения по лимитам (просьба пользователя):
    // «Филиал» в пределах лимита, иначе АС / Правление / Совет директоров;
    // под ним — страховая сумма договора, по которой орган определён.
    const oi = Dossier._organInfo(ctx);
    const organBlock = oi ? `
      <div class="ds-risk">
        <div class="ds-risk-ico">${Dossier.ICONS.landmark}</div>
        <div class="ds-risk-body">
          <div class="ds-risk-l">Лимит</div>
          <div class="ds-risk-v ds-risk-v--sm">${e(Dossier.ORGAN_LABELS[oi.organ] || Dossier.ORGAN_LABELS.standard)}</div>
          <div class="ds-risk-t">Страховая сумма: <b>${e(Dossier._money(oi.sum))} тг</b></div>
        </div>
      </div>` : '';
    const headSide = (organBlock || risk) ? `<div class="ds-head-side">${organBlock}${risk}</div>` : '';
    const copyBtn = Dossier._copyBtnHtml(ctx.id);
    // «Скачать HTML». Скачивание запускаем В ОКНЕ ПРИЛОЖЕНИЯ (window.opener):
    // Chrome блокирует загрузки, инициированные программно открытыми вкладками
    // (сначала about:blank, потом и blob-страница у пользователя) — а из
    // обычной http(s)-страницы приложения загрузки разрешены всегда (та же
    // механика, что у рабочей кнопки «Скачать результаты (HTML)»). Если opener
    // уже закрыт — фолбэк в своём окне (лучше, чем ничего).
    const saveJs = "(function(){var h='<!DOCTYPE html>'+document.documentElement.outerHTML;"
      + "var w=window;try{if(window.opener&&!window.opener.closed&&window.opener.document)w=window.opener;}catch(e){}"
      + "try{var d=w.document;var b=new w.Blob([h],{type:'text/html;charset=utf-8'});var u=w.URL.createObjectURL(b);"
      + "var a=d.createElement('a');a.href=u;a.download=(document.title||'Досье')+'.html';d.body.appendChild(a);a.click();"
      + "setTimeout(function(){try{w.URL.revokeObjectURL(u);a.remove();}catch(e){}},800);}"
      + "catch(e){var b2=new Blob([h],{type:'text/html;charset=utf-8'});var u2=URL.createObjectURL(b2);"
      + "var a2=document.createElement('a');a2.href=u2;a2.download=(document.title||'Досье')+'.html';document.body.appendChild(a2);a2.click();"
      + "setTimeout(function(){URL.revokeObjectURL(u2);a2.remove();},800);}})()";
    const saveBtn = `<button type="button" class="ds-copy ds-save" title="Скачать HTML-файлом" aria-label="Скачать HTML-файлом" onclick="${saveJs}">${Dossier.ICONS.download}</button>`;
    return `<div class="ds-head">
      <div class="ds-head-top">
        <div class="ds-head-main">
          <div class="ds-head-role">${e(ctx.role)}</div>
          <div class="ds-head-id-row">
            <span class="ds-id">${e(ctx.id || '—')}</span>
            ${copyBtn}
            ${saveBtn}
            ${statusPill}
          </div>
          <div class="ds-head-name">${e(short || '— наименование не найдено')}</div>
        </div>
        ${headSide}
      </div>
      ${Dossier._kpiStrip(ctx)}
    </div>`;
  },

  // Плитки показателей в баннере (референс): деньги, штат, ОКЭД — с иконками.
  // Класс/тариф живут в правом блоке шапки, компания и сроки — в карточках.
  _kpiStrip(ctx) {
    const e = Dossier._esc;
    const r = ctx.row;
    const B = Dossier._cB();
    const sg = Dossier._ok(ctx.sg) ? ctx.sg : null;
    const k = Dossier._ok(ctx.kyc) ? ctx.kyc : null;
    const money = (v) => (v == null || v === '' || isNaN(v)) ? null : Dossier._money(v) + ' ₸';
    const tiles = [];
    const add = (icon, label, value, cls) => {
      if (value == null || String(value).trim() === '') return;
      tiles.push({ icon, label, value: String(value), cls: cls || '' });
    };
    if (r) {
      add('shield', 'Страховая сумма', money(r.insuranceSumTotal));
      add('banknote', 'Премия с ПК', money(r.premiumTotal));
      add('chart', 'ПК', r.coeff != null ? String(r.coeff) : null);
      const w = Number(r.workers);
      if (w > 0) add('users', 'Сотрудников', String(w));
      const fot = Number(r.gfot);
      add('wallet', 'ФОТ (годовой)', money(fot));
      if (w > 0 && fot > 0) add('card', 'Средняя зарплата', Dossier._money(Math.round(fot / w / 12)) + ' ₸/мес');
    }
    // Без фолбэка на kyc.kz: ОКЭД показываем из выгрузки или stat.gov.kz.
    const oked = (r && r.oked) || (sg && sg.okedPrimaryCode) || null;
    add('hash', 'ОКЭД', oked);
    if (r) {
      const trP = Array.isArray(r.tranches) ? r.tranches : [];
      add('calendar', 'Порядок оплаты', trP.length
        ? `рассрочка · ${trP.length} ${Utils.plural(trP.length, 'транш', 'транша', 'траншей')}`
        : (r.paymentOrder ? String(r.paymentOrder).toLowerCase() : 'единовременно'));
    }
    // Возраст компании НА ДАТУ ДОГОВОРА (по нему решается право на ПК);
    // в одиночной проверке договора нет — возраст на сегодня.
    const ageRaw = (r && r._foundingDate) || (sg && sg.registrationDate) || (k && k.registrationDate) || null;
    if (B && B._ageText && ageRaw) {
      const ref = (r && B._ageShownRef) ? B._ageShownRef(r) : new Date();
      const age = B._ageText(ageRaw, ref);
      if (age) add('clock', r ? 'Возраст на дату договора' : 'Возраст компании', age);
    }
    const g = ctx.gov;
    if (g && g.status === 'done' && g.found != null) add('landmark', 'Гос. участие', g.found ? 'да' : 'нет');
    const aff = Dossier._affiliated(ctx.id);
    if (aff) add('users', 'Аффилированность', 'да', ' is-bad');
    else if (typeof App !== 'undefined' && App.refData && App.refData.affiliated) add('users', 'Аффилированность', 'нет');
    const res = Dossier._residency(ctx);
    if (res.short || res.label) add('globe', 'Резидентство', res.short || res.label, res.tone === 'bad' ? ' is-bad' : '');
    if (!tiles.length) return '';
    return `<div class="ds-kpis">${tiles.map(t =>
      `<div class="ds-kpi${t.cls}"><span class="ds-kpi-ico">${Dossier.ICONS[t.icon] || ''}</span><div>`
      + `<div class="ds-kpi-l">${e(t.label)}</div><div class="ds-kpi-v ds-v--num">${e(t.value)}</div></div></div>`).join('')}</div>`;
  },

  _sectionHtml(sec) {
    const e = Dossier._esc;
    // Иконка + цветовой акцент: одинаковые серые карточки сливались, глазу не
    // за что зацепиться. Цвет кодирует ТИП карточки (компания / деньги / риск /
    // служебное), иконка — предмет.
    const ico = sec.icon ? `<span class="ds-card-ico">${Dossier.ICONS[sec.icon] || ''}</span>` : '';
    const head = `<div class="ds-card-head">${ico}<span class="ds-card-title">${e(sec.title)}</span>`
      + `${sec.titleRight ? `<span class="ds-card-right">${sec.titleRight}</span>` : ''}</div>`;
    let body = '';
    if (sec.lead) body += sec.lead;
    if (sec.rows) {
      // Строка с пустым названием — подзаголовок блока внутри карточки
      // («Классификация», «Итог по договору»): группирует значения по смыслу.
      body += `<div class="ds-kv">${sec.rows.filter(Boolean).map(([k, v, note]) => (k == null
        ? v
        : `<div class="ds-kv-row"><div class="ds-kv-k">${e(k)}</div>`
          + `<div class="ds-kv-v">${v == null || v === '' ? '<span class="ds-dim">—</span>' : v}`
          + `${note ? `<div class="ds-kv-note">${e(note)}</div>` : ''}</div></div>`)).join('')}</div>`;
    }
    if (sec.foot) body += `<div class="ds-card-foot">${sec.foot}</div>`;
    if (sec.table) {
      body += `<div class="ds-table-wrap"><table class="ds-table"><thead><tr>${
        sec.table.head.map(h => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${
        sec.table.rows.map(row => `<tr>${row.map(c => `<td>${c == null ? '<span class="ds-dim">—</span>' : c}</td>`).join('')}</tr>`).join('')
      }</tbody></table></div>`;
    }
    if (sec.details) {
      body += sec.details.map(d => `<details class="ds-raw"><summary>${e(d.title)}</summary>`
        + `<div class="ds-table-wrap"><table class="ds-table ds-table--raw"><tbody>${
          d.rows.map(([k, v]) => `<tr><td>${e(k)}</td><td>${e(v)}</td></tr>`).join('')
        }</tbody></table></div></details>`).join('');
    }
    // Секция-раскрывашка (например «Справочные коды») — по умолчанию свёрнута,
    // в заголовке счётчик строк, чтобы было понятно, что внутри.
    const cls = 'ds-card'
      + (sec.span === 'full' ? ' ds-card--full' : (sec.span === 'wide' ? ' ds-card--wide' : ''))
      + (sec.accent ? ' ds-card--' + sec.accent : '');
    if (sec.collapsible) {
      return `<details class="${cls} ds-card--fold"${sec.open ? ' open' : ''}><summary class="ds-card-head">${ico}`
        + `<span class="ds-card-title">${e(sec.title)}</span>`
        + `<span class="ds-card-right">${sec.rows ? sec.rows.filter(Boolean).length : ''}</span></summary>${body}</details>`;
    }
    return `<section class="${cls}">${head}${body}</section>`;
  },

  // «База | ✓/✕ | Проверка» — блок сверки в стиле референса: заголовок по
  // центру, слева значение из базы, в круге вердикт, справа наш расчёт.
  // Совпало — оба зелёные с галкой; разошлось — база красная и зачёркнута,
  // проверка зелёная, в круге крест. Допуски те же, что в валидаторах таблицы.
  _vsRow(title, base, check, opts) {
    const e = Dossier._esc;
    if (base == null && check == null) return '';
    const o = opts || {};
    // Только одно значение — просто центрированная строка без вердикта.
    const baseL = o.baseLabel || 'База';
    const checkL = o.checkLabel || 'Проверка';
    if (base == null || check == null) {
      const one = base || check;
      return `<div class="ds-vs"><div class="ds-vs-t">${e(title)}</div>`
        + `<div class="ds-vs-grid ds-vs-grid--one"><div class="ds-vs-side">`
        + `<div class="ds-vs-l">${e(base != null ? baseL : checkL)}</div>`
        + `<div class="ds-vs-v is-plain">${one.html || e(one.v)}</div></div></div></div>`;
    }
    let same;
    if (base.num != null && check.num != null && isFinite(base.num) && isFinite(check.num)) {
      const d = Math.abs(Number(base.num) - Number(check.num));
      const tol = o.rel ? Math.abs(Number(check.num)) * o.rel : (o.tol != null ? o.tol : 0);
      same = d <= tol;
    } else {
      same = String(base.v).trim() === String(check.v).trim();
    }
    return `<div class="ds-vs"><div class="ds-vs-t">${e(title)}</div>`
      + `<div class="ds-vs-grid">`
      + `<div class="ds-vs-side"><div class="ds-vs-l">${e(baseL)}</div>`
      + `<div class="ds-vs-v${same ? '' : ' is-bad'}">${base.html || e(base.v)}</div></div>`
      + `<div class="ds-vs-ico ${same ? 'ok' : 'bad'}">${same ? Dossier.ICONS.check : Dossier.ICONS.x}</div>`
      + `<div class="ds-vs-side"><div class="ds-vs-l">${e(checkL)}</div>`
      + `<div class="ds-vs-v">${check.html || e(check.v)}</div></div>`
      + `</div>${o.note ? `<div class="ds-vs-note">${e(o.note)}</div>` : ''}</div>`;
  },

  // ===== Поле из нескольких источников =====
  // Досье устроено ПО ДАННЫМ, а не по источникам: строка — это поле («Наименование»),
  // в ней одно или несколько значений, у каждого серым подписан источник. Одинаковые
  // значения схлопываются в одну строку с перечислением источников («stat.gov.kz ·
  // kyc.kz»), разные — остаются рядом и помечаются «источники расходятся»: именно
  // это андеррайтеру и нужно видеть, а не одну и ту же карточку три раза подряд.
  //   items: [{ src, v, html?, note? }] — v это ТЕКСТ (по нему сравниваем и его же
  //   показываем, если не передан готовый html).
  // collapse=false — НЕ схлопывать одинаковые значения (каждый источник своей
  // строкой). Так показываем «базу» и «проверку» в договоре: даже когда они
  // совпали, важно видеть, что проверка реально отработала, а не гадать, где
  // схлопнулось значение, а где источник промолчал.
  _vals(items, keyFn, collapse) {
    const e = Dossier._esc;
    const list = (items || []).filter(x => x && x.v != null && String(x.v).trim() !== '');
    if (!list.length) return { html: '', diff: false };
    const keyOf = (v) => (keyFn ? keyFn(v) : String(v).trim());
    // Расхождение считаем по РАЗНЫМ значениям — независимо от того, схлопываем мы их или нет.
    const distinct = new Set(list.map(x => keyOf(x.v)));
    const groups = [];
    for (const it of list) {
      const k = keyOf(it.v);
      const g = collapse === false ? null : groups.find(x => x.k === k);
      if (g) { if (!g.srcs.includes(it.src)) g.srcs.push(it.src); continue; }
      groups.push({ k, it, srcs: [it.src] });
    }
    const html = groups.map(({ it, srcs }) =>
      `<div class="ds-val"><span class="ds-val-v">${it.html || e(it.v)}</span>`
      + `<span class="ds-src">${e(srcs.join(' · '))}</span>`
      + `${it.note ? `<div class="ds-kv-note">${e(it.note)}</div>` : ''}</div>`).join('');
    return { html, diff: distinct.size > 1 };
  },

  // Строка «поле → значения из источников» для секции. null, если ни один
  // источник поле не отдал (пустые строки досье не засоряют). diffText — подпись
  // расхождения: для реестров это «источники расходятся», для договора, где
  // сравниваются база и наш расчёт, — «база ≠ проверка».
  _row(label, items, keyFn, diffText) {
    const { html, diff } = Dossier._vals(items, keyFn);
    if (!html) return null;
    return [label, Dossier._wrapVals(html, diff, diffText || 'источники расходятся')];
  },

  // То же, но БЕЗ схлопывания: каждое значение своей строкой со своей подписью.
  // Для договора, где сравниваются «база» (как в выгрузке) и «проверка» (наш
  // расчёт) — их всегда показываем обе.
  //   opts.tol — ДОПУСК сравнения по числу (items[].num). Без него «13 076 923»
  //   и «13 076 923,08» считались бы расхождением, хотя разница 8 тиын —
  //   округление копеек. Допуски те же, что у валидаторов таблицы (±1 ₸ на
  //   премии и итоги, 100 ₸ на СС контрагента, 1 % на тариф), чтобы досье и
  //   таблица не спорили друг с другом.
  _rowSplit(label, items, diffText, opts) {
    const res = Dossier._vals(items, null, false);
    if (!res.html) return null;
    let diff = res.diff;
    const o = opts || {};
    const nums = (items || []).filter(x => x && x.num != null && isFinite(x.num)).map(x => Number(x.num));
    if (nums.length >= 2) {
      const d = Math.abs(nums[0] - nums[1]);
      const tol = o.rel ? Math.abs(nums[1]) * o.rel : (o.tol != null ? o.tol : 0);
      diff = d > tol;
    }
    return [label, Dossier._wrapVals(res.html, diff, diffText || 'база ≠ проверка')];
  },

  // Расхождение — КРАСНОЕ: красная плашка с причиной и красная отбивка слева у
  // всей группы значений, чтобы строку было видно при прокрутке (жёлтый читался
  // как «мелочь», а расхождение базы с проверкой мелочью не бывает).
  _wrapVals(html, diff, text) {
    if (!diff) return html;
    return `<div class="ds-vals is-diff">${html}<div class="ds-diff">${Dossier._esc(text)}</div></div>`;
  },

  // ===== Секции =====
  _sections(ctx) {
    // Одна общая сетка (3 колонки): первая строка — «Основная информация» (1
    // колонка) + «Деятельность и тариф» (2 колонки); под Деятельностью dense-
    // упаковка ставит «Договор» и «Активность». Служебная зона — отдельно ниже.
    const zS = 'Проверка и источники';
    const list = [
      ...Dossier._partyCards(ctx).map(sec => ['', sec]),
      ['', Dossier._secOkeds(ctx)],
      ['', Dossier._secContract(ctx)],
      ['', Dossier._secActivity(ctx)],
      ['', Dossier._secClass(ctx)],
      ['', Dossier._secSum(ctx)],
      ['', Dossier._secPremium(ctx)],
      ['', Dossier._secPk(ctx)],
      ['', Dossier._secStaff(ctx)],
      ['', Dossier._secPayment(ctx)],
      ['', Dossier._secResidencyCard(ctx)],
      ['', Dossier._secGov(ctx)],
      ['', Dossier._secAff(ctx)],
      ['', Dossier._secLimits(ctx)],
      ['', Dossier._secBranches(ctx)],
      [zS, Dossier._secChecks(ctx)],
      [zS, Dossier._secCodes(ctx)],
      [zS, Dossier._secSources(ctx)],
    ].concat(Dossier._secSourceCards(ctx).map(sec => [zS, sec]));
    return list.filter(([, sec]) => sec).map(([zone, sec]) => ({ ...sec, zone }));
  },


  // ПАСПОРТ КОНТРАГЕНТА — то, что определяет компанию: форма, регистрация,
  // адрес, руководитель, размер, собственность, гос. участие. Значение одно (от
  // самого авторитетного источника), расхождение реестров сворачивается в чип
  // «N версий» — см. _field. Сравнение «база ↔ проверка» тут не нужно: это не
  // условия договора, а карточка компании.
  // Карточки сторон. Требование пользователя: ВСЕГДА видеть и страхователя, и
  // контрагента. Одно лицо — одна карточка «Страхователь = Контрагент»; разные —
  // две одинаковые по структуре карточки. Гос. участие / резидентство /
  // аффилированность — ОТДЕЛЬНЫЕ карточки, здесь их нет.
  _partyCards(ctx) {
    const r = ctx.row;
    if (!r) {
      return [Dossier._partyCard(ctx, Dossier._ok(ctx.sg) ? ctx.sg : null, 'Основная информация', ctx.id, true)];
    }
    const insB = Dossier._norm(r.binInsurer || r.bin);
    const conB = Dossier._norm(r.bin);
    const same = insB && insB === conB;
    const sgIns = (r.statgov && !r.statgov.error) ? r.statgov : null;
    const sgCon = (r.statgovContr && !r.statgovContr.error) ? r.statgovContr : null;
    if (same) {
      return [Dossier._partyCard(ctx, sgIns || sgCon, 'Страхователь = Контрагент', insB, true)];
    }
    return [
      Dossier._partyCard(ctx, sgIns, 'Страхователь', insB, insB === ctx.id),
      Dossier._partyCard(ctx, sgCon, 'Контрагент', conB, conB === ctx.id),
    ];
  },

  // Одна карточка стороны. isCtxId — карточка о том же БИН, что открыт в досье:
  // тогда подмешиваются kyc/egov (они догружаются только для ctx.id).
  _partyCard(ctx, sgo, title, bin, isCtxId) {
    const e = Dossier._esc;
    const S = Dossier.SRC;
    const B = Dossier._cB();
    const r = ctx.row;
    const k = (isCtxId && Dossier._ok(ctx.kyc)) ? ctx.kyc : null;
    const eg = isCtxId ? (ctx.egovRaw || null) : null;
    const sn = (isCtxId && ctx.statsnet && !ctx.statsnet.loading && !ctx.statsnet.error) ? ctx.statsnet : null;
    const sgAddr = sgo ? (sgo.legalAddress || (typeof Utils !== 'undefined' && Utils.statgovLegalAddress ? Utils.statgovLegalAddress(sgo) : null)) : null;
    const d = (v) => Dossier._date(v);
    const isInsurer = /Страхователь/.test(title);
    const form = Dossier._legalForm((sgo && sgo.name) || (isCtxId ? (Dossier._fullName(ctx) || ctx.nameExport) : ''));
    const regDate = Dossier._field([
      { src: S.sg, v: sgo && d(sgo.registrationDate) },
      { src: S.egov, v: eg && d(eg.registrationDate) },
      { src: S.kyc, v: k && d(k.registrationDate) },
    ]);
    // Возраст: текущий у обеих сторон; «на заключение» — у страхователя (по нему
    // решается право на ПК).
    const ageRaw = (isInsurer && r && r._foundingDate) || (sgo && sgo.registrationDate) || (k && k.registrationDate) || null;
    const ageNow = (B && B._ageText && ageRaw) ? B._ageText(ageRaw, new Date()) : null;
    const ageAtDeal = (isInsurer && B && B._ageText && ageRaw && r && B._ageShownRef) ? B._ageText(ageRaw, B._ageShownRef(r)) : null;
    // Вид деятельности — из stat.gov.kz (или из выгрузки строки). Фолбэк на
    // kyc.kz убран: его вид деятельности идёт от собственного ОКЭД, который
    // мы больше не используем, и мог противоречить реестру.
    const act = (sgo && sgo.okedPrimaryName) || (isCtxId && ctx.row && ctx.row.activity) || null;
    const name = (sgo && sgo.name) || (isCtxId ? Dossier._bestName(ctx) : '') || '';
    const rows = [
      bin ? ['БИН', `<span class="ds-v ds-v--num">${e(bin)}</span> ${Dossier._copyBtnHtml(bin, true)}`] : null,
      name ? ['Наименование', `<span class="ds-v">${e(name)}</span>`] : null,
      act ? ['Вид деятельности', `<span class="ds-v">${e(act)}</span>`] : null,
      form ? ['Форма', `<span class="ds-v">${e(form.form)}</span><span class="ds-vnote">— ${e(form.note)}</span>`] : null,
      regDate ? ['Регистрация', regDate.replace('<span class="ds-v">', '<span class="ds-v ds-v--num">')] : null,
      ageNow ? ['Возраст (текущий)', `<span class="ds-v">${e(ageNow)}</span>`
        + `<span class="ds-vnote ds-vnote--block">на сегодняшний день ${e(Dossier._date(new Date()))}</span>`] : null,
      ageAtDeal ? ['Возраст (на заключение)', `<span class="ds-v">${e(ageAtDeal)}</span>`
        + `<span class="ds-vnote ds-vnote--block">на дату договора${r && r.dateContract ? ' ' + e(Dossier._date(r.dateContract) || '') : ''}</span>`] : null,
      (sgAddr || (k && k.legalAddress) || (isCtxId && ctx.legalAddressWorker)) ? ['Юридический адрес', Dossier._field([
        { src: S.sg, v: sgAddr },
        { src: S.kyc, v: k && k.legalAddress },
        { src: S.worker, v: isCtxId ? ctx.legalAddressWorker : null },
      ], { key: Dossier._addrKey })] : null,
      (sgo && sgo.headFullname) || (k && k.headFullname) ? ['Руководитель', Dossier._field([
        { src: S.sg, v: sgo && sgo.headFullname },
        { src: S.kyc, v: k && k.headFullname },
      ], { key: Dossier._nameKey, unconfirmed: true })] : null,
      Dossier._krpRow('Размерность (без филиалов)',
        (sgo && sgo.krpWithoutBranchesName) || (k && k.krpName), (sgo && sgo.krpWithoutBranchesCode) || (k && k.krpCode)),
      Dossier._krpRow('Размерность (с филиалами)',
        (sgo && sgo.krpWithBranchesName) || (k && k.krpName), (sgo && sgo.krpWithBranchesCode) || (k && k.krpCode)),
      (sgo && (sgo.kfsName || sgo.kfsCode)) ? ['Форма собственности',
        `<span class="ds-v">${e(Dossier._short(sgo.kfsName) || '—')}</span>${sgo.kfsCode ? `<span class="ds-vnote">(КФС ${e(sgo.kfsCode)})</span>` : ''}`] : null,
      sn && sn.industry ? ['Отрасль', `<span class="ds-v">${e(sn.industry)}</span><span class="ds-vnote">statsnet.co</span>`] : null,
    ].filter(Boolean);
    if (!rows.length) {
      return { title, icon: 'briefcase', accent: 'company',
        rows: [['Данные', '<span class="ds-dim">источники по этой стороне не ответили</span>']] };
    }
    return { title, icon: 'briefcase', accent: 'company', rows };
  },

  // Отдельные карточки: гос. участие и аффилированность (сверки «база ↔ проверка»).
  _secGov(ctx) {
    const g = ctx.gov;
    const qazyna = (!g || g.status === 'loading' || g.status === 'error' || g.found == null)
      ? null : (g.found ? 'да' : 'нет');
    const base = ctx.row ? (ctx.row.govParticipation ? 'да' : 'нет') : null;
    if (qazyna == null && base == null) return null;
    const S = Dossier.SRC;
    const share = Dossier._row('Доля гос. участия', [{ src: S.qazyna, v: g && g.share }]);
    return {
      title: 'Гос. участие', icon: 'landmark', accent: 'risk',
      lead: Dossier._vsRow('Участие государства',
        base != null ? { v: base } : null,
        qazyna != null ? { v: qazyna } : null,
        { note: qazyna != null ? 'проверка: e-Qazyna' : '' }),
      rows: share ? [share] : [],
    };
  },

  _secAff(ctx) {
    const r = ctx.row;
    const aff = Dossier._affiliated(ctx.id);
    const refLoaded = typeof App !== 'undefined' && App.refData && App.refData.affiliated;
    const base = (r && r.affiliatedExport != null) ? (r.affiliatedExport ? 'да' : 'нет') : null;
    const check = refLoaded ? (aff ? 'да' : 'нет') : null;
    if (base == null && check == null) return null;
    return {
      title: 'Аффилированность', icon: 'users', accent: 'risk',
      lead: Dossier._vsRow('Аффилированное лицо',
        base != null ? { v: base } : null,
        check != null ? { v: check } : null,
        { note: check != null ? 'проверка: справочник аффилированных лиц' : '' }),
      rows: aff ? [['В справочнике', `<span class="ds-v">${Dossier._esc(aff.name || '—')}</span>`]] : [],
    };
  },

  // СПРАВОЧНЫЕ КОДЫ — свёрнуто: коды нужны редко, но когда нужны, нужны точные.
  _secCodes(ctx) {
    const e = Dossier._esc;
    const S = Dossier.SRC;
    const sg = Dossier._ok(ctx.sg) ? ctx.sg : null;
    const k = Dossier._ok(ctx.kyc) ? ctx.kyc : null;
    const eg = ctx.egovRaw || null;
    const kind = typeof ResidentCheck !== 'undefined' ? ResidentCheck.idKind(ctx.id) : 'invalid';
    const note = typeof ResidentCheck !== 'undefined' ? ResidentCheck.binTypeNote(ctx.id) : '';
    const code = (c, name) => `<span class="ds-v ds-v--num">${e(c)}</span>${name ? `<span class="ds-vnote">${e(name)}</span>` : ''}`;
    const kato = (sg && sg.kato) || (k && k.kato) || null;
    const rows = [
      kato ? ['КАТО', code(kato, Dossier._short(sgAddrRegion(sg, k)))] : null,
      (sg && sg.sectorCode) ? ['Сектор', code(sg.sectorCode, Dossier._short(sg.sectorName))] : null,
      (eg && eg.incorporationCountry) ? ['Страна', code(eg.incorporationCountry, '')] : null,
      ['Тип ид.', `<span class="ds-v">${e(kind === 'bin' ? 'БИН' : (kind === 'iin' ? 'ИИН' : 'некорректный ид.'))}</span>${note ? `<span class="ds-vnote">${e(note.replace(/^по структуре БИН — /, ''))}</span>` : ''}`],
      (k && k.payNds != null) ? ['Плательщик НДС', `<span class="ds-v">${e(Dossier._flat(k.payNds) === 'true' ? 'да' : (Dossier._flat(k.payNds) === 'false' ? 'нет' : Dossier._flat(k.payNds)))}</span>`] : null,
      (k && k.status) ? ['Статус в реестре', `<span class="ds-v">${e(k.status)}</span><span class="ds-vnote">kyc.kz</span>`] : null,
      // Только stat.gov.kz: вторичные виды деятельности из kyc.kz не берём
      // (см. комментарий в _secOkeds — их маппинг не совпадает с реестром).
      Dossier._row('Вторичные ОКЭД', [
        { src: S.sg, v: sg && (sg.okedSecondaryCodes && sg.okedSecondaryCodes.length ? sg.okedSecondaryCodes.join(', ') : sg.okedSecondaryCode) },
      ]),
    ].filter(Boolean);
    if (!rows.length) return null;
    return { title: 'Справочные коды', icon: 'hash', accent: 'tech', rows, collapsible: true, open: true };

    // Регион по КАТО показываем только если он уже есть в адресе — отдельного
    // справочника КАТО в приложении нет, выдумывать расшифровку не будем.
    function sgAddrRegion(sgo, kyco) {
      const a = (sgo && sgo.legalAddress) || (kyco && kyco.legalAddress) || '';
      const m = String(a).match(/^([^,]+,\s*[^,]+)/);
      return m ? m[1] : '';
    }
  },

  // Резидентство — своя карточка в обоих режимах: «база» (страна из выгрузки)
  // против «проверки» (egov — авторитет, локальный индекс ГБД ЮЛ).
  _secResidencyCard(ctx) {
    const B = Dossier._cB();
    const diff = ctx.row && B && B._residRegDiff(ctx.row);
    return {
      title: 'Резидентство', icon: 'globe', accent: 'risk',
      titleRight: diff ? '<span class="ds-pill ds-pill--bad">выгрузка ≠ egov</span>' : '',
      rows: Dossier._residencyRows(ctx),
    };
  },

  _residencyRows(ctx) {
    const e = Dossier._esc;
    const S = Dossier.SRC;
    const eg = ctx.egovRaw || null;
    const verdict = (typeof ResidentCheck !== 'undefined' && ResidentCheck.egovResolved) ? ResidentCheck.egovResolved(ctx.id) : null;
    const local = typeof ResidentCheck !== 'undefined' ? ResidentCheck.check(ctx.id) : null;
    const kind = typeof ResidentCheck !== 'undefined' ? ResidentCheck.idKind(ctx.id) : 'invalid';
    // Страна из выгрузки относится к СТРАХОВАТЕЛЮ: показываем её как базу и
    // когда досье открыто по контрагенту, совпадающему со страхователем.
    const isInsurerSide = ctx.row && (ctx.side === 'insurer'
      || Dossier._norm(ctx.row.binInsurer || ctx.row.bin) === ctx.id);
    const country = isInsurerSide ? (ctx.row.residencyCountry || '') : '';
    const egTxt = eg && eg.resident != null ? (eg.resident ? 'резидент' : 'нерезидент') : (verdict ? verdict.label : null);
    const tone = (t) => t === 'резидент' ? `<span class="ds-good">${e(t)}</span>` : `<span class="ds-bad">${e(t)}</span>`;
    const egovNote = !egTxt
      ? (kind !== 'bin'
        ? 'egov не запрашивается для ИИН (P30.01/P30.11 — только БИН юр. лиц; для ИИН он вернул бы ложного «нерезидента»)'
        : ((typeof ResidentCheck !== 'undefined' && ResidentCheck.bridgeAvailable && ResidentCheck.bridgeAvailable())
          ? 'egov (P30.01/P30.11): запрашивается…' : 'egov (P30.01/P30.11): нет моста (расширение выключено или нет сессии egov.kz)'))
      : '';
    const regSt = (typeof ResidentCheck !== 'undefined' && ResidentCheck.registryStatus) ? ResidentCheck.registryStatus(ctx.id) : 0;
    // ИИН (ИП/физлицо): резидентство автоматически не определяется — одна
    // короткая строка вместо простыни оговорок про egov и реестр юр. лиц.
    if (kind !== 'bin') {
      return [
        ['Признак резидентства', '<span class="ds-v">ИП / физлицо — автоматически не определяется</span>'],
        country ? Dossier._rowSplit('Страна резидентства', [{ src: S.exp, v: country }]) : null,
      ].filter(Boolean);
    }
    // Сверка в формате «База | вердикт | Проверка»: база — страна из выгрузки,
    // проверка — egov (авторитет), при его молчании — локальный ГБД ЮЛ.
    const baseTxt = country ? (/казахстан/i.test(country) ? 'резидент' : 'нерезидент') : null;
    const checkTxt = egTxt || (local && (local.status === 'resident' || local.status === 'nonresident') ? local.label.replace(/\s·.*$/, '') : null);
    const vsResid = Dossier._vsRow('Признак резидентства',
      baseTxt ? { v: baseTxt } : null,
      checkTxt ? { v: checkTxt } : null,
      { note: [country ? 'страна в выгрузке: ' + country : '', egTxt ? 'проверка: egov' : (checkTxt ? 'проверка: ГБД ЮЛ' : '')].filter(Boolean).join(' · ') });
    const rows = [
      [null, vsResid],
      Dossier._rowSplit('Страна резидентства', [{ src: S.exp, v: country || null }]),
      Dossier._row('Страна инкорпорации', [{ src: S.egov, v: eg && eg.incorporationCountry }]),
      Dossier._row('Есть в реестре юр. лиц РК', [
        { src: S.gbd, v: ResidentCheck.has(ctx.id) ? 'да' : 'нет',
          html: ResidentCheck.has(ctx.id) ? '<span class="ds-good">да</span>' : '<span class="ds-bad">нет</span>' },
      ]),
      (ResidentCheck.has(ctx.id)) ? Dossier._row('Статус записи в реестре', [
        { src: S.gbd, v: regSt ? ResidentCheck.STATUS_LABELS[regSt] : 'зарегистрирован',
          html: regSt ? `<span class="ds-bad">${e(ResidentCheck.STATUS_LABELS[regSt])}</span>` : '<span class="ds-good">зарегистрирован</span>' },
      ]) : null,
    ].filter(Boolean);
    return rows;
  },

  // Гос. участие (внутри регистрационных данных): e-Qazyna против выгрузки.
  // Само наличие компании в реестре e-Qazyna и означает, что участие есть.
  _govRows(ctx) {
    const S = Dossier.SRC;
    const g = ctx.gov;
    const qazyna = (!g || g.status === 'loading' || g.status === 'error' || g.found == null)
      ? null : (g.found ? 'да' : 'нет');
    const base = ctx.row ? (ctx.row.govParticipation ? 'да' : 'нет') : null;
    const rows = [];
    if (qazyna != null || base != null) {
      // Сверка «База | вердикт | Проверка»: база — выгрузка, проверка — e-Qazyna.
      rows.push([null, Dossier._vsRow('Гос. участие',
        base != null ? { v: base } : null,
        qazyna != null ? { v: qazyna } : null,
        { note: qazyna != null ? 'проверка: e-Qazyna' : '' })]);
    } else {
      const why = (!g || g.status === 'loading') ? 'запрашивается…' : (g && g.status === 'error' ? 'ошибка запроса к e-Qazyna' : 'не определено');
      rows.push(['Гос. участие', `<span class="ds-dim">${Dossier._esc(why)}</span>`]);
    }
    const share = Dossier._row('Доля гос. участия', [{ src: S.qazyna, v: g && g.share }]);
    if (share) rows.push(share);
    return rows;
  },

  // ===== ВСЕ ПОЛЯ ИСТОЧНИКОВ =====
  // Досье должно содержать ВСЁ, что источник отдал по клиенту, а не только то,
  // что мы разложили по карточкам: ЛИН, местонахождение ИП, коды КРП/КФС/КАТО,
  // сектор экономики, РНН, ОКПО, ОПФ, даты и номер госрегистрации, блокировку,
  // орган гос. управления, отрасли. Поэтому по каждому источнику — карточка с
  // полной таблицей «поле → значение», как он её отдал.
  _secSourceCards(ctx) {
    const e = Dossier._esc;
    const out = [];
    // Не таблица, а сетка «ярлык → значение» в две колонки: у источников бывают
    // многострочные поля («Орган гос.управления» в e-Qazyna несёт РНН, БИН,
    // адрес и контакты), и в таблице они выглядели месивом. white-space:pre-line
    // (см. .ds-fields-v) сохраняет переносы как на самом сайте.
    const table = (title, icon, rows) => ({
      title, icon, accent: 'tech', span: 'full',
      titleRight: `<span class="ds-card-note">${rows.length} ${Utils.plural(rows.length, 'поле', 'поля', 'полей')}</span>`,
      lead: `<div class="ds-fields">${rows.map(([k, v]) => (v === '' && /^—/.test(k)
        ? `<div class="ds-fields-sep">${e(k.replace(/^—\s*|\s*—$/g, ''))}</div>`
        : `<div class="ds-fields-k">${e(k)}</div><div class="ds-fields-v">${e(v)}</div>`)).join('')}</div>`,
    });
    const sg = Dossier._ok(ctx.sg) ? ctx.sg : null;
    if (sg && Array.isArray(sg._raw) && sg._raw.length) {
      out.push(table('stat.gov.kz — все поля', 'database', sg._raw.map(([k, v]) => [k, Dossier._flat(v)])));
    }
    const k = Dossier._ok(ctx.kyc) ? ctx.kyc : null;
    if (k) {
      // У kyc карточка приходит объектом: сначала «человеческие» поля, потом
      // весь сырой набор, который отдал сайт.
      const known = [
        ['Наименование', k.name], ['БИН', k.bin], ['Дата регистрации', Dossier._date(k.registrationDate)],
        ['ОКЭД', k.okedPrimaryCode], ['Вид деятельности', k.okedPrimaryName], ['Вторичные виды', k.okedSecondary],
        ['КАТО', k.kato], ['Код КРП', k.krpCode], ['Наименование КРП', k.krpName],
        ['Руководитель', k.headFullname], ['Адрес', k.legalAddress], ['Статус', k.status],
        ['Действующая', k.isActive == null ? null : (k.isActive ? 'да' : 'нет')],
        ['ИП / физлицо', k.isIndividual == null ? null : (k.isIndividual ? 'да' : 'нет')],
        ['Плательщик НДС', k.payNds == null ? null : Dossier._flat(k.payNds)],
      ].filter(([, v]) => v != null && String(v).trim() !== '').map(([a, b]) => [a, String(b)]);
      const raw = (k._raw && typeof k._raw === 'object')
        ? Object.keys(k._raw).sort().map(key => [key, Dossier._flat(k._raw[key])]).filter(([, v]) => v !== '' && v !== 'null')
        : [];
      const rows = known.concat(raw.length ? [['— сырые поля kyc.kz —', '']] : []).concat(raw);
      if (rows.length) out.push(table('kyc.kz — все поля', 'database', rows));
    }
    if (ctx.egovRaw) {
      const rows = Object.keys(ctx.egovRaw)
        .map(key => [key, Dossier._flat(ctx.egovRaw[key])])
        .filter(([, v]) => v !== '' && v !== 'null');
      if (rows.length) out.push(table(Dossier.SRC.egov + ' — все поля', 'database', rows));
    }
    // e-Qazyna: и результат поиска, и блок «Дополнительные сведения» карточки
    // объекта (его тянет воркер — см. worker/index.js fetchGovExtra).
    const g = ctx.gov;
    if (g && g.status === 'done') {
      const rows = [
        ['Найдена в реестре', g.found == null ? 'не определено' : (g.found ? 'да' : 'нет')],
        ['Доля гос. участия', g.share || '—'],
        ['Наименование в реестре', g.name || '—'],
        ['Статус объекта', g.objStatus || '—'],
      ];
      if (Array.isArray(g.extra)) rows.push(...g.extra.map(([a, b]) => [a, b]));
      out.push(table('e-Qazyna — все поля', 'database', rows));
    }
    return out;
  },

  // 8. ОКЭДы → класс профриска → тариф. Здесь же видно, какой класс «правильный»
  // (с НАИБОЛЬШИМ тарифом, а не с наибольшим номером) и что стоит в выгрузке.
  _secOkeds(ctx) {
    const e = Dossier._esc;
    if (typeof BatchAR === 'undefined') return null;
    const sg = Dossier._ok(ctx.sg) ? ctx.sg : null;
    const codes = [];
    const push = (code, tag) => {
      const c = String(code || '').trim();
      if (!c) return;
      const found = codes.find(x => x.code === c);
      if (found) { if (!found.tags.includes(tag)) found.tags.push(tag); return; }
      codes.push({ code: c, tags: [tag] });
    };
    // ОКЭДы КОМПАНИИ берём ТОЛЬКО из stat.gov.kz — это официальный реестр и
    // единственный источник, которому мы доверяем в вопросе видов деятельности.
    // Раньше сюда подмешивался ОКЭД из kyc.kz: его маппинг вида деятельности
    // приблизительный, и в таблицу попадала строка с кодом, которого у компании
    // по реестру нет, — она путала выбор класса и тарифа.
    if (sg) {
      push(sg.okedPrimaryCode, Dossier.SRC.sg + ' (основной)');
      (sg.okedSecondaryCodes || []).forEach(c => push(c, Dossier.SRC.sg + ' (вторичный)'));
    }
    // Ниже — НЕ источники ОКЭДов компании, а проверяемые значения: код из
    // выгрузки (его и красим красным, если у компании такого нет) и код,
    // применённый в расчёте одиночной проверки.
    if (ctx.row) push(ctx.row.oked, Dossier.SRC.exp);
    if (!ctx.row && typeof App !== 'undefined' && App._resolveOked) {
      const rez = App._resolveOked();
      if (rez && rez.oked) push(rez.oked, 'применён в проверке');
    }
    if (!codes.length) return { title: 'Деятельность и тариф', icon: 'tag', accent: 'company', span: 'wide', rows: [['ОКЭД', '<span class="ds-dim">нет данных</span>']] };
    const classifier = (typeof App !== 'undefined' && App.refData) ? App.refData.classifier : null;
    const enriched = codes.map((c) => {
      const cls = BatchAR._classOf(c.code);
      const look = (classifier && typeof Utils !== 'undefined' && Utils.lookupOked) ? Utils.lookupOked(c.code, classifier) : null;
      return { ...c, cls, tariff: BatchAR._tariffByClass(cls), name: look ? look.name : null };
    });
    // Ведущий ОКЭД (класс с наибольшим тарифом — по нему считается договор)
    // помечаем ПОДСВЕТКОЙ строки, без слов: подписи «макс. тариф» просто шумели.
    // «Правильный» класс считаем ТОЛЬКО по ОКЭД компании из stat.gov.kz —
    // ошибочный ОКЭД из базы не должен претендовать на роль правильного.
    const sgPool = enriched.filter(x => x.tags.some(t => t.indexOf('stat.gov') === 0));
    const best = BatchAR._maxTariffClass((sgPool.length ? sgPool : enriched).map(x => x.cls).filter(x => x != null));
    // «База» есть только у строки реестра: в одиночной проверке контрагента
    // выгрузки нет, красить красным/жёлтым нечего — там только зелёный
    // «правильный» класс.
    const baseCode = ctx.row ? String(ctx.row.oked || '').trim() : '';
    // Пока stat.gov.kz не ответил, вердикт НЕ выносим: без его списка ОКЭД
    // проверка «база отсутствует у компании» ложно срабатывала, и карточка
    // мигала зелёным → красным → зелёным по мере прихода источников.
    const pending = !!ctx.sgPending;
    const rows = enriched.map((x) => {
      const lead = !pending && x.cls != null && x.cls === best;
      const isBase = !pending && baseCode && x.code === baseCode;
      // База не среди ОКЭД компании по stat.gov.kz — ошибочный ОКЭД.
      const fromSg = x.tags.some(t => t.indexOf('stat.gov') === 0);
      // Раскраска ВСЕЙ строки по смыслу: правильный (наибольший тариф) —
      // зелёная; база с ОКЭД, которого у компании НЕТ, — красная; база с
      // валидным, но не наивысшим классом — жёлтая; остальные нейтральные.
      const wrap = (h) => {
        if (isBase && !fromSg) return `<b class="ds-bad">${h}</b>`;
        if (lead) return `<b class="ds-good">${h}</b>`;
        if (isBase) return `<b class="ds-warnc">${h}</b>`;
        return h;
      };
      const nm = x.name || (sg && x.code === sg.okedPrimaryCode ? sg.okedPrimaryName : '') || '';
      return [
        wrap(`<span class="ds-v--num">${e(x.code)}</span>`),
        wrap(e(nm)),
        x.cls == null ? '<span class="ds-dim">—</span>' : wrap(e(String(x.cls))),
        x.tariff == null ? '<span class="ds-dim">—</span>' : wrap(e(Dossier._pct(x.tariff))),
      ];
    });
    return {
      title: 'Деятельность и тариф', icon: 'tag', accent: 'company', span: 'wide',
      titleRight: pending ? '<span class="ds-card-note">идёт проверка stat.gov.kz…</span>' : '',
      table: { head: ['ОКЭД', 'Вид деятельности', 'Класс', 'Тариф'], rows },
    };
  },

  // ===== ДОГОВОР — РАЗБИТ НА ОТДЕЛЬНЫЕ КАРТОЧКИ =====
  // Одна простыня на 25 строк не читается, поэтому каждый смысловой кусок —
  // своя карточка: реквизиты, класс/тариф, страховая сумма, премия, ПК,
  // работники, оплата, филиалы, лимиты, резидентство. Внутри каждой — «база»
  // (как в выгрузке) против «проверки» (наш расчёт по справочникам).
  _cRow(ctx) { return ctx.row || null; },
  _cB() { return (typeof BatchAR !== 'undefined') ? BatchAR : null; },
  _moneyT(v) { return (v == null || isNaN(v)) ? null : Dossier._money(v) + ' ₸'; },
  _numTxt(v) { return (v == null || v === '') ? null : String(v); },

  // Реквизиты договора: номер, даты, шкала срока, стороны, автор.
  _secContract(ctx) {
    const e = Dossier._esc;
    const r = ctx.row;
    if (!r) return null;
    const S = Dossier.SRC;
    const B = Dossier._cB();
    const group = B ? (B._groupByContract().get(r.contractNumber || '') || [r]) : [r];
    const tr = Array.isArray(r.tranches) ? r.tranches : [];
    const sameParty = Dossier._norm(r.binInsurer) && Dossier._norm(r.binInsurer) === Dossier._norm(r.bin);
    // Совпадение сторон — зелёным, расхождение — красным (карточки обеих сторон
    // стоят выше, здесь только сам факт).
    const parties = sameParty
      ? `<span class="ds-good">Страхователь = Контрагент</span><span class="ds-vnote ds-vnote--block">БИН ${e(Dossier._norm(r.bin))}</span>`
      : `<span class="ds-bad">Страхователь ≠ Контрагент</span>`
        + `<span class="ds-vnote ds-vnote--block">${e(r.binInsurer || '—')} · страхователь</span>`
        + `<span class="ds-vnote ds-vnote--block">${e(r.bin || '—')} · контрагент</span>`;
    const payment = tr.length
      ? `в рассрочку · ${e(String(tr.length))} ${Utils.plural(tr.length, 'транш', 'транша', 'траншей')}`
      : (r.paymentOrder ? e(String(r.paymentOrder).toLowerCase()) : 'единовременная оплата');
    return {
      title: 'Договор', icon: 'file', accent: 'deal',
      rows: [
        ['Номер', `<span class="ds-v ds-v--num">${e(r.contractNumber || '—')}</span>`],
        ['Заключён', `<span class="ds-v ds-v--num">${e(Dossier._date(r.dateContract) || '—')}</span>`],
        ['Период', Dossier._periodHtml(r)],
        ['Порядок оплаты', `<span class="ds-v">${payment}</span>`],
        ['Стороны', parties],
        group.length > 1 ? ['Строк (филиалов)', `<span class="ds-v">${e(String(group.length))}</span><span class="ds-vnote">см. карточку «Филиалы»</span>`] : null,
      ].filter(Boolean),
    };
  },

  // Шкала тарифов по классам 1–22 (из «Поправочных коэффициентов»): столбик на
  // класс, зелёный — правильный (наибольший тариф среди ОКЭД), красный — класс
  // из базы, если он другой. Даёт мгновенно увидеть, НАСКОЛЬКО база промахнулась.
  _tariffScaleHtml(baseCls, checkCls, altCls) {
    const B = Dossier._cB();
    if (!B) return '';
    const alts = new Set((altCls || []).filter(c => c != null && c !== checkCls && c !== baseCls));
    const items = [];
    let max = 0;
    for (let c = 1; c <= 22; c++) {
      const t = B._tariffByClass(c);
      if (t != null) { items.push([c, t]); if (t > max) max = t; }
    }
    if (items.length < 5 || !(max > 0)) return '';
    const bars = items.map(([c, t]) => {
      const h = Math.max(6, Math.round(t / max * 46));
      // Зелёный — нужный класс; красный — класс из базы (если другой);
      // синий — ВОЗМОЖНЫЕ классы по остальным ОКЭД компании.
      const cls = c === checkCls ? ' is-check' : (c === baseCls ? ' is-base' : (alts.has(c) ? ' is-alt' : ''));
      // Значение тарифа стоит НАД столбиком, повёрнуто вертикально (читается
      // снизу вверх) — на 22 столбика горизонтальные подписи не влезают.
      return `<div class="ds-scale-col${cls}" title="класс ${c} — ${Dossier._esc(Dossier._pct(t))}">`
        + `<span class="ds-scale-val">${Dossier._esc(Dossier._pct(t))}</span>`
        + `<i style="height:${h}px"></i><b>${c}</b></div>`;
    }).join('');
    const legend = `<div class="ds-scale-legend"><span><i class="is-check"></i>нужный класс</span>`
      + `${baseCls != null && baseCls !== checkCls ? '<span><i class="is-base"></i>класс из базы</span>' : ''}`
      + `${alts.size ? '<span><i class="is-alt"></i>возможный по ОКЭД</span>' : ''}</div>`;
    return `<div class="ds-scale">${bars ? `<div class="ds-scale-bars">${bars}</div>${legend}` : ''}</div>`;
  },

  // Класс профриска и тариф — то, из чего считается вся премия.
  _secClass(ctx) {
    const r = ctx.row;
    if (!r) return null;
    const B = Dossier._cB();
    const num = Dossier._numTxt;
    const pct = (v) => (v == null) ? null : Dossier._pct(v);
    const baseCls = parseInt(r.riskClass, 10);
    const checkClsRaw = B ? B._computedClass(r) : null;
    const checkCls = checkClsRaw != null ? checkClsRaw : (Number.isFinite(baseCls) ? baseCls : null);
    const v = (val, n) => (val == null ? null : { v: String(val), num: n });
    const vs = [
      Dossier._vsRow('Класс профриска (страхователь)',
        v(num(r.riskClass), parseInt(r.riskClass, 10)),
        B ? v(num(B._computedClass(r)), B._computedClass(r)) : null),
      Dossier._vsRow('Класс профриска (контрагент)',
        v(num(r.riskClassContragent), parseInt(r.riskClassContragent, 10)),
        B ? v(num(B._contrComputedClass(r)), B._contrComputedClass(r)) : null),
      // Допуск 1 % относительно справочного — как в _contrTariffClassError.
      Dossier._vsRow('Страховой тариф',
        v(pct(r.tariff), r.tariff),
        B ? v(pct(B._contrTariff(r)), B._contrTariff(r)) : null, { rel: 0.01 }),
    ].join('');
    return {
      title: 'Класс и тариф', icon: 'percent', accent: 'deal',
      lead: vs + Dossier._tariffScaleHtml(Number.isFinite(baseCls) ? baseCls : null, checkCls,
        B ? B._computedClasses(r).concat(B._contrClassList(r)) : []),
      rows: [
        ['ОКЭД в договоре', `<span class="ds-v ds-v--num">${Dossier._esc(r.oked || '—')}</span>`
          + (r.activity ? `<span class="ds-vnote">${Dossier._esc(r.activity)}</span>` : '')],
      ],
    };
  },

  // Страховая сумма: по строке, по договору, сумма по контрагентам + расчётные.
  _secSum(ctx) {
    const r = ctx.row;
    if (!r) return null;
    const B = Dossier._cB();
    const agg = B ? B._contractAgg(r) : null;
    const multi = agg && agg.count > 1;
    const ssT = Number(r.insuranceSumTotal);
    const fotT = (agg && agg.sumFot > 0) ? agg.sumFot : Number(r.gfot);
    let cmp = '';
    if (ssT > 0 && fotT > 0) {
      const mx = Math.max(ssT, fotT);
      const bar = (label, v2, cls) => `<div class="ds-cmp-row"><span class="ds-cmp-l">${label}</span>`
        + `<div class="ds-cmp-bar"><i class="${cls}" style="width:${Math.max(3, Math.round(v2 / mx * 100))}%"></i></div>`
        + `<b class="ds-v--num">${Dossier._esc(Dossier._money(v2))} ₸</b></div>`;
      cmp = `<div class="ds-cmp">${bar('СС', ssT, ssT < fotT ? 'is-bad' : 'is-ok')}${bar('ФОТ', fotT, 'is-fot')}</div>`;
    }
    const m = (v2) => (v2 == null || isNaN(v2)) ? null : { v: Dossier._money(v2) + ' ₸', num: Number(v2) };
    const vs = [
      // Допуск 100 ₸ — как в _contrSumDiff (расчёт по премии даёт копейки).
      Dossier._vsRow('Контрагент', m(r.insuranceSum), B ? m(B._contrExpectedSum(r)) : null, { tol: 100 }),
      Dossier._vsRow('Страхователь (итог по договору)', m(r.insuranceSumTotal), B ? m(B._expectedSum(r)) : null, { tol: 1 }),
      // Итог страхователя обязан равняться сумме всех контрагентов договора.
      multi ? Dossier._vsRow('Страхователь = Σ всех контрагентов', m(r.insuranceSumTotal), m(agg.sumSS),
        { tol: 1, baseLabel: 'Страхователь', checkLabel: 'Σ контрагентов' }) : '',
    ].join('');
    return {
      title: 'Страховая сумма', icon: 'shield', accent: 'money',
      lead: vs + cmp,
    };
  },

  // Страховая премия: до ПК, с ПК, итог, сумма по контрагентам, пол в 1 МЗП.
  _secPremium(ctx) {
    const r = ctx.row;
    if (!r) return null;
    const B = Dossier._cB();
    const agg = B ? B._contractAgg(r) : null;
    const multi = agg && agg.count > 1;
    const pk = (r.coeff && r.coeff > 0) ? r.coeff : 1;
    const expPremTotal = B && B._expectedPremium(r) != null ? Math.round(B._expectedPremium(r) * pk * 100) / 100 : null;
    const minP = B ? B._minPremium() : 85000;
    const m = (v2) => (v2 == null || isNaN(v2)) ? null : { v: Dossier._money(v2) + ' ₸', num: Number(v2) };
    // Ожидаемая премия ДО ПК = СС контрагента × тариф (без коэффициента).
    const tarC = B ? B._contrTariff(r) : null;
    const expBase = (tarC > 0 && isFinite(Number(r.insuranceSum)))
      ? Math.round(Number(r.insuranceSum) * tarC * 100) / 100 : null;
    const vs = [
      Dossier._vsRow('Контрагент, до ПК', m(r.premiumBase), m(expBase), { tol: 1 }),
      Dossier._vsRow('Контрагент, с ПК', m(r.premiumWithCoeff), B ? m(B._contrExpectedPremium(r)) : null, { tol: 1 }),
      Dossier._vsRow('Страхователь (итог по договору)', m(r.premiumTotal), m(expPremTotal), { tol: 1 }),
      multi ? Dossier._vsRow('Страхователь = Σ всех контрагентов', m(r.premiumTotal), m(agg.sumSP),
        { tol: 1, baseLabel: 'Страхователь', checkLabel: 'Σ контрагентов' }) : '',
    ].join('');
    // Полосы: МЗП (пол премии) · средняя зарплата · премия договора — видно и
    // запас премии над полом, и порядок величин.
    const w = Number(r.workers), fot = Number(r.gfot);
    const avg = (w > 0 && fot > 0) ? Math.round(fot / w / 12) : null;
    const prem = Number(r.premiumTotal);
    let cmp = '';
    if (isFinite(prem) && prem > 0) {
      const vals = [['МЗП', minP, 'is-fot'], avg != null ? ['Сред. ЗП', avg, 'is-avg'] : null,
        ['Премия', prem, prem < minP ? 'is-bad' : 'is-ok']].filter(Boolean);
      const mx = Math.max(...vals.map(x => x[1]));
      cmp = `<div class="ds-cmp">${vals.map(([l, v2, cls]) =>
        `<div class="ds-cmp-row"><span class="ds-cmp-l">${l}</span>`
        + `<div class="ds-cmp-bar"><i class="${cls}" style="width:${Math.max(3, Math.round(v2 / mx * 100))}%"></i></div>`
        + `<b class="ds-v--num">${Dossier._esc(Dossier._money(v2))} ₸</b></div>`).join('')}</div>`;
    }
    return {
      title: 'Страховая премия', icon: 'banknote', accent: 'money',
      lead: vs + cmp,
    };
  },

  // Поправочный коэффициент и право на скидку (возраст компании на дату договора).
  _secPk(ctx) {
    const e = Dossier._esc;
    const r = ctx.row;
    if (!r) return null;
    const B = Dossier._cB();
    const pkTxt = String(r.coeff);
    const isDisc = r.decision === 'discount';
    const young = !!r.youngAlert;
    const bad = B && B._pkYoungError(r);
    const thr = B && B._youngThreshold ? B._youngThreshold() : 3;
    const ageShown = (B && B._ageText && r._foundingDate) ? B._ageText(r._foundingDate, B._ageShownRef(r)) : null;
    const refTxt = (r.dateContract instanceof Date && !isNaN(r.dateContract))
      ? `на дату договора ${Dossier._date(r.dateContract)}`
      : 'на сегодня';
    return {
      title: 'Поправочный коэффициент', icon: 'chart', accent: 'money',
      titleRight: isDisc ? '<span class="ds-pill ds-pill--info">со скидкой</span>' : '<span class="ds-pill ds-pill--muted">стандарт</span>',
      rows: [
        ['ПК', `<span class="ds-v ds-v--num">${e(pkTxt)}</span><span class="ds-vnote">${isDisc ? 'принятие с понижающим коэффициентом' : 'стандартное принятие'}</span>`],
        ageShown ? ['Возраст компании', `<span class="ds-v">${e(ageShown)}</span><span class="ds-vnote ds-vnote--block">${e(refTxt)}</span>`] : null,
        ['Право на скидку', bad
          ? `<span class="ds-bad">нет — компания моложе ${e(String(thr))} лет, скидка применена неправомерно</span>`
          : (young ? `<span class="ds-bad">нет — компания моложе ${e(String(thr))} лет</span>`
            : `<span class="ds-good">есть — компания старше ${e(String(thr))} лет</span>`)],

      ].filter(Boolean),
    };
  },

  // «Активность» — таймлайн договора (референс): создан → вступил в силу →
  // платежи по траншам (прошедшие синим, ближайший — «Следующий платёж») →
  // окончание. Даты берутся из строки реестра, истории вне её у нас нет.
  _secActivity(ctx) {
    const e = Dossier._esc;
    const r = ctx.row;
    if (!r) return null;
    const asDate = (v) => v instanceof Date ? v : (v ? new Date(v) : null);
    const now = Date.now();
    const ev = [];
    const dc = asDate(r.dateContract);
    if (dc && !isNaN(dc)) ev.push({ d: dc, label: 'Договор создан', state: dc <= now ? 'done' : 'future' });
    const from = asDate(r.periodFrom);
    if (from && !isNaN(from)) ev.push({ d: from, label: 'Договор вступил в силу', state: from <= now ? 'done' : 'future' });
    const tr = Array.isArray(r.tranches) ? r.tranches : [];
    let nextMarked = false;
    tr.forEach((t, i) => {
      const d = asDate(t.date);
      if (!d || isNaN(d)) return;
      if (d <= now) {
        ev.push({ d, label: `Оплата ${i + 1}-го транша`, state: 'pay' });
      } else if (!nextMarked) {
        nextMarked = true;
        ev.push({ d, label: 'Следующий платёж', state: 'next' });
      } else {
        ev.push({ d, label: `Платёж ${i + 1}-го транша`, state: 'future' });
      }
    });
    const to = asDate(r.periodTo);
    if (to && !isNaN(to)) ev.push({ d: to, label: 'Окончание договора', state: to <= now ? 'over' : 'future' });
    if (ev.length < 2) return null;
    ev.sort((a, b) => a.d - b.d);
    // Рядом с каждым событием — сколько дней прошло (или осталось).
    const relTxt = (d) => {
      const rel = Math.round((d - now) / 86400000);
      return rel === 0 ? 'сегодня' : (rel < 0 ? `${-rel} дн. назад` : `через ${rel} дн.`);
    };
    const lead = `<div class="ds-tl">${ev.map(x =>
      `<div class="ds-tl-row is-${x.state}"><span class="ds-tl-date">${e(Dossier._date(x.d))}</span>`
      + `<span class="ds-tl-dot"></span><span class="ds-tl-label">${e(x.label)}`
      + `<span class="ds-tl-rel">${e(relTxt(x.d))}</span></span></div>`).join('')}</div>`;
    const payment = tr.length
      ? `рассрочка · ${tr.length} ${Utils.plural(tr.length, 'транш', 'транша', 'траншей')}`
      : (r.paymentOrder ? String(r.paymentOrder).toLowerCase() : 'единовременно');
    return { title: 'Активность', icon: 'activity', accent: 'deal',
      titleRight: `<span class="ds-card-note">${e(payment)}</span>`, lead };
  },

  // Работники, ФОТ и средняя зарплата — вход для расчёта премии.
  _secStaff(ctx) {
    const e = Dossier._esc;
    const r = ctx.row;
    if (!r) return null;
    const workers = Number(r.workers);
    const fot = Number(r.gfot);
    const avg = (workers > 0 && fot > 0) ? fot / workers / 12 : null;
    const thr = (typeof App !== 'undefined' && App._getLimit) ? (App._getLimit('minAvgSalary') || 85000) : 85000;
    return {
      title: 'Работники и ФОТ', icon: 'users', accent: 'deal',
      rows: [
        ['Количество работников', workers > 0 ? `<span class="ds-v ds-v--num">${e(String(workers))}</span>` : '<span class="ds-dim">—</span>'],
        ['ФОТ (годовой)', fot > 0 ? `<span class="ds-v ds-v--num">${e(Dossier._money(fot))} ₸</span>` : '<span class="ds-dim">—</span>'],
        ['Средняя зарплата', avg
          ? `<span class="ds-v ds-v--num">${e(Dossier._money(Math.round(avg)))} ₸/мес</span>`
            + (avg < thr ? `<span class="ds-vnote ds-bad">ниже 1 МЗП (${Dossier._money(thr)} ₸)</span>` : '')
          : '<span class="ds-dim">нет данных</span>'],
      ],
    };
  },

  // Оплата: порядок, транши и сверка их суммы с премией договора.
  _secPayment(ctx) {
    const e = Dossier._esc;
    const r = ctx.row;
    if (!r) return null;
    const tr = Array.isArray(r.tranches) ? r.tranches : [];
    if (!tr.length && !r.paymentOrder) return null;
    if (!tr.length) {
      return { title: 'Оплата', icon: 'calendar', accent: 'deal', rows: [['Порядок оплаты', `<span class="ds-v">${e(r.paymentOrder)}</span>`]] };
    }
    const sum = tr.reduce((a, t) => a + (Number(t.amount) || 0), 0);
    const prem = Number(r.premiumTotal);
    const mismatch = sum > 0 && isFinite(prem) && Math.abs(sum - prem) > 1;
    // Мини-гистограмма траншей: высота — сумма, синие — уже прошедшие по сроку.
    const nowT = Date.now();
    const maxA = Math.max(...tr.map(t => Number(t.amount) || 0));
    const bars = maxA > 0 ? `<div class="ds-tr-bars">${tr.map((t, i) => {
      const a = Number(t.amount) || 0;
      const d = t.date instanceof Date ? t.date : (t.date ? new Date(t.date) : null);
      const paid = d && !isNaN(d) && d.getTime() <= nowT;
      const h = Math.max(8, Math.round(a / maxA * 44));
      return `<div class="ds-tr-col${paid ? ' is-paid' : ''}" title="${i + 1}-й транш — ${Dossier._esc(Dossier._money(a))} ₸">`
        + `<i style="height:${h}px"></i><b>${i + 1}</b></div>`;
    }).join('')}</div>` : '';
    return {
      title: 'Оплата', icon: 'calendar', accent: 'deal',
      titleRight: `<span class="ds-card-note">${e(r.paymentOrder || 'в рассрочку')}</span>`,
      lead: bars,
      table: {
        head: ['№', 'Дата', 'Сумма'],
        rows: tr.map((t, i) => [String(i + 1), e(Dossier._date(t.date) || '—'),
          `<span class="ds-v--num">${e(Dossier._money(t.amount))} ₸</span>`]),
      },
      rows: [
        ['Итого по траншам', `<span class="ds-v ds-v--num">${e(Dossier._money(sum))} ₸</span>`
          + (mismatch ? '<span class="ds-vnote ds-bad">≠ премии договора</span>' : '')],
      ],
    };
  },

  // Филиалы: все строки одного договора — по ним считаются итоги.
  _secBranches(ctx) {
    const e = Dossier._esc;
    const r = ctx.row;
    const B = Dossier._cB();
    if (!r || !B) return null;
    const group = B._groupByContract().get(r.contractNumber || '') || [r];
    if (group.length < 2) return null;
    return {
      title: 'Филиалы договора', icon: 'layers', accent: 'deal', span: 'full',
      titleRight: `<span class="ds-card-note">${e(String(group.length))} ${Utils.plural(group.length, 'строка', 'строки', 'строк')}</span>`,
      table: {
        head: ['БИН', 'Наименование', 'Класс', 'ФОТ', 'СС', 'СП (с ПК)'],
        rows: group.map(x => [
          `<span class="ds-v--num${Dossier._norm(x.bin) === ctx.id ? ' ds-v' : ''}">${e(x.bin || '—')}</span>`,
          e(x.insurerName || x.excelName || '—'),
          e(String(x.riskClassContragent || x.riskClass || '—')),
          `<span class="ds-v--num">${e(Dossier._money(x.gfot))}</span>`,
          `<span class="ds-v--num">${e(Dossier._money(x.insuranceSum))}</span>`,
          `<span class="ds-v--num">${e(Dossier._money(x.premiumWithCoeff))}</span>`,
        ]),
      },
    };
  },

  // Лимиты АС: попадает ли договор на Андеррайтинговый совет по своей СС.
  _secLimits(ctx) {
    const e = Dossier._esc;
    const r = ctx.row;
    const B = Dossier._cB();
    if (!r || !B || !B._asLimits) return null;
    const { low1_15, low16_22 } = B._asLimits();
    const cls = parseInt(r.riskClass, 10) || 0;
    const applied = (cls >= 16 && cls <= 22) ? low16_22 : low1_15;
    const band = (cls >= 16 && cls <= 22) ? 'класс 16–22' : 'класс 1–15';
    const over = B._overAsLimit(r);
    const aff = Dossier._affiliated(ctx.id);
    return {
      title: 'Лимиты и орган решения', icon: 'shieldCheck', accent: 'risk',
      titleRight: over ? '<span class="ds-pill ds-pill--class">на АС</span>' : '<span class="ds-pill ds-pill--muted">в пределах лимита</span>',
      rows: [
        ['Страховая сумма договора', `<span class="ds-v ds-v--num">${e(Dossier._money(r.insuranceSumTotal))} ₸</span>`],
        ['Решение', over
          ? '<span class="ds-v">Андеррайтинговый совет</span>'
          : '<span class="ds-v">стандартное принятие</span>'],
        aff ? ['Аффилированность', `<span class="ds-bad">да</span><span class="ds-vnote">→ Совет директоров</span>`] : null,
      ].filter(Boolean),
    };
  },

  // 10. Результаты проверки строки — тот же набор правил, что красит таблицу.
  _secChecks(ctx) {
    const e = Dossier._esc;
    const r = ctx.row;
    if (!r || typeof BatchAR === 'undefined') return null;
    const B = BatchAR;
    const errs = [
      [B._okedError(r), 'ОКЭД из выгрузки отсутствует среди ОКЭД компании в stat.gov.kz — значит и класс по нему неверный'],
      [B._classWrongForOked(r), 'Класс профриска не соответствует своему же ОКЭД по классификатору'],
      [B._govDiff(r), 'Гос. участие: выгрузка не совпала с реестром e-Qazyna'],
      [B._residRegDiff(r), 'Резидентство: страна из выгрузки не совпала с ответом egov'],
      [B._pkYoungError(r), 'Понижающий ПК применён к компании моложе порога — скидка не положена'],
      [B._sumError(r), 'Страховая сумма меньше премии или меньше ФОТ'],
      [B._premiumBelowMinError(r), 'Страховая премия ниже 1 МЗП'],
      [!!B._binInvalid(r), 'Некорректный БИН/ИИН контрагента'],
      [!!B._insurerBinInvalidReason(r), 'Некорректный БИН/ИИН страхователя: ' + (B._insurerBinInvalidReason(r) || '')],
      [B._insurerSumMismatch(r), 'СС страхователя ≠ сумме СС контрагентов (допуск ±1 ₸)'],
      [B._insurerPremMismatch(r), 'СП страхователя ≠ сумме СП контрагентов (допуск ±1 ₸)'],
      [B._contrSumLtFotError(r), 'СС контрагента меньше его ФОТ'],
      [B._contrSumDiff(r), 'СС контрагента отличается от расчётной больше чем на 100 ₸'],
      [B._contrPremiumDiff(r), 'СП контрагента ≠ СС × тариф × ПК (допуск ±1 ₸)'],
      [B._contrTariffClassError(r), 'Тариф из выгрузки не соответствует классу контрагента по справочнику'],
      [B._contrClassWrongByBin(r), 'Класс контрагента отсутствует среди классов по его ОКЭД'],
    ].filter(x => x[0]).map(x => ['err', x[1]]);
    const warns = [
      [B._classDiffWarn(r), `Класс страхователя не с наибольшим тарифом среди его ОКЭД (нужен ${B._computedClass(r)})`],
      [B._contrClassDiffByBin(r), `Класс контрагента не с наибольшим тарифом среди его ОКЭД (нужен ${B._contrComputedClass(r)})`],
    ].filter(x => x[0]).map(x => ['warn', x[1]]);
    const all = errs.concat(warns);
    if (!all.length) return null;   // чисто — карточку не показываем, зелёный виден в таблице
    const pkOff = warns.length && B._pkAdjusted(r);
    const rows = all.map(([lvl, txt]) => [
      lvl === 'err' ? '<span class="ds-pill ds-pill--bad">ошибка</span>' : '<span class="ds-pill ds-pill--warn">расхождение</span>',
      e(txt) + (lvl === 'warn' && pkOff ? ' <span class="ds-dim">(не считается расхождением: применён ПК ' + e(String(r.coeff)) + ')</span>' : ''),
    ]);
    const state = B._rowState(r);
    const stateTxt = { err: 'красная (ошибки)', warn: 'жёлтая (расхождения)', ok: 'зелёная (проверено, чисто)', checking: 'проверяется', pending: 'ещё не проверена' }[state] || state;
    return {
      title: 'Результаты проверки строки', icon: 'checkCircle', accent: 'risk', span: 'full',
      note: `строка ${stateTxt}${r._approved ? ' · согласована андеррайтером' : ''}`,
      table: { head: ['Уровень', 'Что не так'], rows },
    };
  },

  // 11. Что откуда взято и когда — чтобы было видно, какие источники отработали.
  _secSources(ctx) {
    const e = Dossier._esc;
    // Колонка «БИН в ответе» — главная страховка от подмены компании: если
    // источник вернул ДРУГОЙ БИН, его наименованию/адресу/руководителю выше
    // верить нельзя (красным). Раньше это была строка в «Идентификации».
    const line = (name, obj, extra) => {
      const st = Dossier._srcState(obj, false);
      return [e(name), st.html, Dossier._binMatch(ctx.id, obj && obj.bin) || '',
        obj && obj._fetchedAt ? e(Dossier._when(obj._fetchedAt)) : (extra || '')];
    };
    const S = Dossier.SRC;
    const rows = [
      line(S.sg, ctx.sg, ctx.sgPending ? 'проверяется' : ''),
      line(S.kyc, ctx.kyc),
      line(S.egov, ctx.egovRaw),
      [e(S.qazyna), ctx.gov ? (ctx.gov.status === 'done' ? '<span class="ds-good">получено</span>' : `<span class="ds-bad">${e(ctx.gov.status)}</span>`) : '<span class="ds-dim">не запрашивалось</span>', '', ''],
      [e(S.gbd) + ' (локально)', (typeof ResidentCheck !== 'undefined' && ResidentCheck.ready())
        ? '<span class="ds-good">индекс загружен</span>' : '<span class="ds-dim">индекс не загружен</span>', '',
        (typeof ResidentCheck !== 'undefined' && ResidentCheck.updatedText && ResidentCheck.updatedText()) ? 'база от ' + e(ResidentCheck.updatedText()) : ''],
      // statsnet медленный (открывает фоновые вкладки) — досье его не дёргает,
      // строка есть только чтобы было видно, что источник существует.
      ctx.statsnet ? [e(S.statsnet), ctx.statsnet.loading ? '<span class="ds-dim">идёт поиск…</span>'
        : (ctx.statsnet.error ? `<span class="ds-bad">${e(ctx.statsnet.error)}</span>` : '<span class="ds-good">получено</span>'), '', ''] : null,
    ].filter(Boolean);
    const bridge = typeof StatGovClient !== 'undefined' && StatGovClient.isAvailable && StatGovClient.isAvailable();
    return {
      title: 'Источники', icon: 'server', accent: 'tech', span: 'wide',
      titleRight: `<span class="ds-card-note">${e(bridge ? 'мост к stat.gov.kz / egov подключён' : 'мост-расширение не подключено — часть источников недоступна')}</span>`,
      table: { head: ['Источник', 'Статус', 'БИН в ответе', 'Получено'], rows },
    };
  },

  // ===== Мелкие помощники =====
  _ok(o) { return !!o && !o.error && o.found !== false; },

  _srcState(o, pending) {
    if (pending) return { html: '<span class="ds-dim">проверяется…</span>', note: '' };
    if (!o) return { html: '<span class="ds-dim">не запрашивалось</span>', note: '' };
    if (o.error || o._error) return { html: `<span class="ds-bad">ошибка: ${Dossier._esc(o.error || o._error)}</span>`, note: '' };
    if (o.found === false) return { html: '<span class="ds-dim">не найдено по этому БИН</span>', note: '' };
    return { html: '<span class="ds-good">получено</span>', note: '' };
  },

  _codeName(code, name) {
    const e = Dossier._esc;
    if (!code && !name) return '';
    return `${code ? `<b>${e(code)}</b>` : ''}${code && name ? ' — ' : ''}${name ? e(name) : ''}`;
  },
  // То же, но текстом — значение поля, по которому источники сравниваются.
  _codeNameTxt(code, name) {
    if (!code && !name) return null;
    return `${code || ''}${code && name ? ' — ' : ''}${name || ''}`;
  },

  // Адрес для сравнения между источниками: регистр и пунктуация не в счёт.
  _addrKey(s) {
    return String(s || '').toUpperCase().replace(/[^A-ZА-ЯЁ0-9]+/g, ' ').trim();
  },

  // БИН из ответа источника: зелёный, если совпал с запрошенным, красный — если нет.
  _binMatch(expected, got) {
    if (!got) return null;
    const g = Dossier._norm(got);
    if (!g) return null;
    return g === Dossier._norm(expected)
      ? `<span class="ds-good">${Dossier._esc(g)}</span>`
      : `<span class="ds-bad">${Dossier._esc(g)} — карточка ДРУГОЙ компании</span>`;
  },

  _flat(v) {
    if (v == null) return '';
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
    return String(v);
  },

  _when(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  // Период действия договора + полоса «сколько прошло / сколько осталось».
  // Андеррайтеру важно с одного взгляда понять, свежий это договор или он уже
  // почти отработал (а если срок истёк — это видно красным).
  _periodHtml(r) {
    const e = Dossier._esc;
    const from = r.periodFrom instanceof Date ? r.periodFrom : (r.periodFrom ? new Date(r.periodFrom) : null);
    const to = r.periodTo instanceof Date ? r.periodTo : (r.periodTo ? new Date(r.periodTo) : null);
    const txt = `<span class="ds-v ds-v--num">${e(Dossier._date(r.periodFrom) || '—')} — ${e(Dossier._date(r.periodTo) || '—')}</span>`;
    if (!from || !to || isNaN(from) || isNaN(to) || to <= from) return txt;
    const DAY = 86400000;
    const total = Math.round((to - from) / DAY);
    const goneRaw = Math.round((Date.now() - from) / DAY);
    const gone = Math.max(0, goneRaw);
    const left = total - goneRaw;
    const pct = Math.max(0, Math.min(100, Math.round((goneRaw / total) * 100)));
    const state = left < 0 ? 'over' : (left <= 30 ? 'soon' : '');
    const tail = left < 0 ? `истёк ${Math.abs(left)} дн. назад` : `осталось ${left} дн.`;
    // Шкала: слева дата начала (0 %), справа дата окончания (100 %), на текущей
    // позиции — точка с подписью «прошло N дн.». Подпись прижимается к своему
    // краю на концах шкалы, чтобы не вылезала за карточку.
    const align = pct < 12 ? 'left:0;transform:none' : (pct > 88 ? 'right:0;left:auto;transform:none' : `left:${pct}%;transform:translateX(-50%)`);
    return txt
      + `<div class="ds-track ${state}">`
      + `<div class="ds-track-bar"><i style="width:${pct}%"></i><b class="ds-track-dot" style="left:${pct}%"></b></div>`
      + `<div class="ds-track-mark" style="${align}">прошло ${gone} дн.</div>`
      + `<div class="ds-track-ends"><span>${e(Dossier._date(r.periodFrom))}</span>`
      + `<span class="ds-track-left">${e(tail)}</span>`
      + `<span>${e(Dossier._date(r.periodTo))}</span></div>`
      + `</div>`;
  },

  // «9 лет 5 мес.» — компактный возраст рядом с датой регистрации.
  _ageShort(regRaw) {
    const t = Dossier._ageNote(regRaw);
    return t ? t.replace(/^возраст на сегодня:\s*/, '').replace(/месяцев|месяца|месяц/g, 'мес.') : '';
  },

  // Справочные наименования длинные («Республиканская собственность», «Нацио-
  // нальные частные нефинансовые корпорации – ОПП») — в карточке нужен смысл,
  // а не полная формулировка; полная остаётся в «Сырых ответах источников».
  _short(name) {
    let s = String(name || '').trim();
    if (!s) return '';
    s = s.replace(/\s*собственность\s*$/i, '')
      .replace(/^Национальные\s+/i, '')
      .replace(/нефинансовые/i, 'нефин.')
      .replace(/корпорации\s*[–—-]\s*ОПП/i, 'корпорации');
    return s.length > 46 ? s.slice(0, 45).trim() + '…' : s;
  },

  // Возраст компании от даты регистрации до сегодня (в досье — справочно;
  // право на ПК считается на дату договора, см. BatchAR._ageRefDate).
  _ageNote(regRaw) {
    if (!regRaw || typeof BatchAR === 'undefined' || !BatchAR._ageText) return '';
    const t = BatchAR._ageText(regRaw, new Date());
    return t ? `возраст на сегодня: ${t}` : '';
  },

  _bestName(ctx) {
    const sg = Dossier._ok(ctx.sg) ? ctx.sg.name : null;
    const kyc = Dossier._ok(ctx.kyc) ? ctx.kyc.name : null;
    const eg = ctx.egovRaw ? (ctx.egovRaw.fullName || ctx.egovRaw.shortName) : null;
    return sg || ctx.nameExport || kyc || eg || '';
  },

  _affiliated(id) {
    return (typeof App !== 'undefined' && App._isAffiliatedBin) ? App._isAffiliatedBin(id) : null;
  },

  // Итоговое резидентство для шапки: egov (авторитет) → локальный ГБД ЮЛ.
  // short — текст для пилюли («Резидент РК»), label — полный вердикт.
  _residency(ctx) {
    if (typeof ResidentCheck === 'undefined') return {};
    const eg = ResidentCheck.egovResolved ? ResidentCheck.egovResolved(ctx.id) : null;
    const v = eg || ResidentCheck.check(ctx.id);
    const tone = v.status === 'resident' ? 'good' : (v.status === 'nonresident' ? 'bad' : 'info');
    const short = v.status === 'resident' ? 'Резидент РК'
      : (v.status === 'nonresident' ? 'Нерезидент'
        : (v.status === 'individual' ? 'Резидентство ИП не определяется' : null));
    return { label: v.label + (eg ? ' · egov' : ''), short, tone };
  },

  _binIssue(ctx) {
    if (typeof BatchAR === 'undefined' || !ctx.row) return null;
    return ctx.side === 'insurer'
      ? BatchAR._insurerBinInvalidReason(ctx.row)
      : (BatchAR._binInvalid(ctx.row) ? 'некорректный БИН/ИИН контрагента' : null);
  },
};

if (typeof window !== 'undefined') window.Dossier = Dossier;
