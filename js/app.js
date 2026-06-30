// app.js — UI orchestration, file handling, BIN lookup, localStorage caching

const App = {
  // State
  zayavka: null,
  claims: null,
  binData: {         // auto-fetched by BIN
    legalAddress: null,
    govParticipation: null,
  },
  statgov: null,     // auto-fetched from stat.gov.kz via chrome extension
  refData: {
    popravka: null,   // { riskRates: Map, adjustmentCoeffs: matrix }
    normativ: null,   // stored as raw arrayBuffer JSON
    ku: null,
    calculator: null, // array of activity objects
    classifier: null, // ОКЭД → класс риска + название деятельности
    affiliated: null, // [{ id: '12-digit', name }, ...]
    limits: {},       // ручные правки регламентных лимитов (см. LIMITS_DEFAULTS)
    signers: {},      // ручные правки ФИО подписантов (см. SIGNERS_DEFAULTS)
  },
  _rawNormativBuffer: null, // keep raw buffer for date-dependent lookup

  // ===== INITIALIZATION =====
  init() {
    // ИИ-консультант «второго мнения» — слайд-овер панель справа.
    // Промпт строится на лету из текущих данных формы (AIPrompt.build),
    // контроллер общий с дашбордом (createAIConsultant, js/ai-consultant.js).
    App.AI = createAIConsultant(
      () => (App.claims && App.claims.analytics)
        ? AIPrompt.build(App._buildAnalyticsSnapshot())
        : null,
      { onUnavailable: () => App.showMsg('Сначала загрузите историю убытков.', 'error') }
    );
    App.restoreCache();
    App._restoreCase();
    App.restoreVerdict();
    // Финальный прогон зависимостей: после восстановления справочников и
    // кейса убедимся, что превью, кнопки и аналитика отражают актуальное
    // состояние (включая возможные изменения справочников между сессиями).
    App._refreshDerivedData();
    // Состояние раскрытия раздела «Справочники» — восстановить из localStorage,
    // либо умолчание: свёрнут если все 6/6 загружены, иначе раскрыт.
    App._initRefsSection();
    // Активная вкладка-раздел (Справочники / Проверка Договоров / Проверка
    // контрагента / Андеррайтинговое решение).
    App._initTabs();
    // Индикатор подключения к stat.gov.kz в шапке.
    App.STATGOV.init();
  },

  _initRefsSection() {
    const section = document.getElementById('refs-section');
    if (!section) return;
    const saved = localStorage.getItem('refs_section_open');
    // По умолчанию раздел раскрыт; сворачивается только если пользователь явно свернул.
    const open = saved !== '0';
    section.classList.toggle('is-open', open);
  },

  // Клик по заголовку «Справочники» — раскрыть/свернуть.
  // event передаётся чтобы не сработал toggle при клике по дочерним кнопкам.
  toggleRefsSection(event) {
    if (event && event.target && event.target.closest('.btn-clear')) return;
    const section = document.getElementById('refs-section');
    if (!section) return;
    const open = !section.classList.contains('is-open');
    section.classList.toggle('is-open', open);
    localStorage.setItem('refs_section_open', open ? '1' : '0');
  },

  // Клик по заголовку «Проверка Договоров» — раскрыть/свернуть.
  toggleBatchSection(event) {
    if (event && event.target && event.target.closest('.btn-clear')) return;
    const section = document.getElementById('batch-section');
    if (!section) return;
    section.classList.toggle('is-open', !section.classList.contains('is-open'));
  },

  // ===== РАЗДЕЛЫ (ВКЛАДКИ) =====
  // Страница разбита на 4 раздела-вкладки. Состояние App общее и НЕ теряется
  // при переключении — мы лишь показываем/скрываем панели (.tab-panel).
  // Порядок в массиве — визуальный порядок вкладок в шапке.
  TABS: ['contractor', 'contracts', 'decision', 'refs'],

  switchTab(name, scroll = true) {
    if (!App.TABS.includes(name)) name = App.TABS[0];
    App.TABS.forEach(t => {
      const active = (t === name);
      const panel = document.getElementById('tab-' + t);
      const btn = document.getElementById('tabbtn-' + t);
      if (panel) panel.classList.toggle('is-active', active);
      if (btn) {
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      }
    });
    try { localStorage.setItem('active_tab', name); } catch (e) {}
    if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  // Восстановить активную вкладку из localStorage. Умолчание: если справочники
  // загружены не полностью — открыть «Справочники», иначе «Андеррайтинговое решение».
  _initTabs() {
    let name = null;
    try { name = localStorage.getItem('active_tab'); } catch (e) {}
    if (!App.TABS.includes(name)) {
      const count = ['popravka', 'normativ', 'ku', 'calculator', 'classifier', 'affiliated']
        .filter(k => !!App.refData[k]).length;
      name = count < 6 ? 'refs' : 'decision';
    }
    App.switchTab(name, false);
  },

  // ===== СТАТУС ПОДКЛЮЧЕНИЯ К stat.gov.kz =====
  // Индикатор в шапке. Подключение идёт через расширение-мост (StatGovClient):
  // ping → PONG = мост активен. Опрашиваем периодически и при возврате фокуса.
  STATGOV: {
    // checking | online | nologin | unreachable | offline
    state: 'checking',
    _timer: null,
    _busy: false,
    _STATES: ['checking', 'online', 'nologin', 'unreachable', 'offline'],
    _LABELS: {
      checking: 'stat.gov.kz · проверка…',
      online: 'stat.gov.kz · подключено',
      nologin: 'stat.gov.kz · нужен вход по ЭЦП',
      unreachable: 'stat.gov.kz · недоступен',
      offline: 'stat.gov.kz · нет связи',
    },
    _TITLES: {
      checking: 'Проверяем реальное подключение к stat.gov.kz…',
      online: 'stat.gov.kz отвечает, ЭЦП-сессия активна — запросы по БИН пройдут. Нажмите, чтобы перепроверить.',
      nologin: 'Расширение-мост активно, но ЭЦП-сессия не найдена. Откройте stat.gov.kz и войдите в кабинет по ЭЦП, затем нажмите, чтобы перепроверить.',
      unreachable: 'Расширение-мост активно, но stat.gov.kz не отвечает (сеть/блокировка). Нажмите, чтобы перепроверить.',
      offline: 'Расширение «Standard Life — мост к stat.gov.kz» не установлено или выключено. Установите/включите его и нажмите, чтобы перепроверить.',
    },
    // Время последнего УСПЕШНОГО реального лукапа stat.gov. В течение окна доверия
    // (ниже) пассивная health-проверка не понижает статус — реальный лукап важнее
    // (он мог пройти, а лёгкий GET — словить rate-limit/таймаут и дать ложный сбой).
    _lastLookupOk: 0,
    _TRUST_MS: 600000, // 10 минут (> интервала пассивного опроса, чтобы он не сбрасывал рабочий статус)
    init() {
      // Handshake расширения означает лишь «мост установлен» — не статус stat.gov.
      // Поэтому на него запускаем РЕАЛЬНУЮ проверку, а не зеленим индикатор.
      document.addEventListener('sl:bridge-ready', () => App.STATGOV.check());
      App.STATGOV.check();
      // Периодический опрос (редкий, чтобы не долбить stat.gov) + при возврате на вкладку.
      App.STATGOV._timer = setInterval(() => App.STATGOV.check(), 300000);
      window.addEventListener('focus', () => App.STATGOV.check());
    },
    // Вызывается из autoLookupStatGov с результатом РЕАЛЬНОГО запроса по БИН —
    // это самый достоверный сигнал: если данные пришли, stat.gov точно работает.
    noteLookup(ok, errorMsg) {
      if (ok) {
        App.STATGOV._lastLookupOk = Date.now();
        App.STATGOV._set('online');
      } else if (errorMsg && /sessid|ЭЦП|войдите|логин|авториз/i.test(errorMsg)) {
        App.STATGOV._set('nologin');
      }
    },
    async check(manual) {
      if (App.STATGOV._busy) return;
      App.STATGOV._busy = true;
      try {
        if (typeof StatGovClient === 'undefined') { App.STATGOV._set('offline'); return; }
        if (manual || App.STATGOV.state === 'checking') App.STATGOV._set('checking');
        const h = await StatGovClient.health(6000).catch(() => ({ bridge: false }));
        let state;
        if (!h.bridge) state = 'offline';
        else if (h.session) state = 'online';
        else if (h.reachable) state = 'nologin';
        else state = 'unreachable';
        // Окно доверия: недавно прошёл реальный лукап → не понижаем статус из-за
        // пассивной проверки (кроме явного «расширение пропало» = offline).
        if (state !== 'online' && state !== 'offline'
            && (Date.now() - App.STATGOV._lastLookupOk) < App.STATGOV._TRUST_MS) {
          state = 'online';
        }
        App.STATGOV._set(state);
      } finally {
        App.STATGOV._busy = false;
      }
    },
    _set(state) {
      App.STATGOV.state = state;
      const pill = document.getElementById('statgov-pill');
      const text = document.getElementById('statgov-text');
      if (!pill || !text) return;
      App.STATGOV._STATES.forEach(s => pill.classList.remove('is-' + s));
      pill.classList.add('is-' + state);
      text.textContent = App.STATGOV._LABELS[state] || '';
      pill.title = App.STATGOV._TITLES[state] || '';
    },
  },

  // ===== VERDICT SELECTOR =====
  restoreVerdict() {
    const saved = localStorage.getItem('manual_verdict');
    const select = document.getElementById('verdict');
    if (saved && select) {
      select.value = saved;
    }
    App.updateVerdictHint();
  },

  onVerdictChange() {
    const v = document.getElementById('verdict').value;
    if (v && v !== 'auto') {
      localStorage.setItem('manual_verdict', v);
    } else {
      localStorage.removeItem('manual_verdict');
    }
    App.updateVerdictHint();
  },

  // Иконки + цветовое кодирование решения. В auto-режиме иконка/цвет —
  // прогноз решения, чтобы оператору сразу было видно, что предложит система.
  VERDICT_ICONS: {
    accept_standard: '✓',
    accept_adjusted: '⚖',
    reject: '✗',
    defer: '⏸',
    auto: '🤖',
  },

  // Возвращает строку-предупреждение по прогнозному КУ для auto-режима
  // или пустую строку, если КУ нормальный/недоступен. Это дополняет
  // auto-решение более осмысленной картиной — у компании с КУ > 200% явно
  // не «принятие со стандартным коэф.», даже если формула этого не видит.
  _verdictLrWarning() {
    const z = App.zayavka;
    if (!z) return '';
    const a = App.claims && App.claims.analytics;
    if (!a || !a.avgSumPerYear) return '';
    const premium = z.premiumWithCoeff || z.premiumBase || 0;
    if (premium <= 0) return '';
    const lr = 100 * a.avgSumPerYear / premium;
    if (lr >= 300) return `⚠ прогнозный КУ ${lr.toFixed(0)}% — фактический риск экстремальный, рекомендуется отклонение`;
    if (lr >= 150) return `⚠ прогнозный КУ ${lr.toFixed(0)}% — высокий риск, целесообразно отложение или корректировка тарифа`;
    if (lr >= 70)  return `прогнозный КУ ${lr.toFixed(0)}% — повышенный риск`;
    return '';
  },

  updateVerdictHint() {
    const select = document.getElementById('verdict');
    const hint = document.getElementById('verdict-hint');
    const badge = document.getElementById('verdict-badge');
    const card = document.getElementById('verdict-card');
    const iconEl = document.getElementById('verdict-icon');
    if (!select || !hint || !card) return;
    const v = select.value;

    let state = v;            // класс для цветового стиля (.verdict-state--*)
    let badgeText = '';       // лейбл бэйджа справа
    let hintText = '';        // подсказка под селектом
    let icon = App.VERDICT_ICONS[v] || '⚖';

    if (v === 'auto') {
      const z = App.zayavka;
      // Режим быстрой проверки (_lookupOnly) — нет премии/тарифа, авто-вердикт
      // не рассчитываем, показываем нейтральную подсказку.
      if (z && !z._lookupOnly && z.coeff != null) {
        // Используем ЭФФЕКТИВНЫЙ coeffDown — с учётом правил:
        //   - НС за 3 года → скидка не применяется (coeffDown = 0)
        //   - Компания < 3 лет → скидка не применяется
        // Раньше брали z.coeffDown напрямую и для компании с НС
        // получали «Принятие с пониженным», хотя по правилам — стандарт.
        const effCoeff = App._effectiveCoeffInfo
          ? App._effectiveCoeffInfo(z) : { coeffDown: z.coeffDown, noDiscountReason: null };
        const decision = Utils.determineDecision(z.coeff, effCoeff.coeffDown);
        const predicted = Utils.resolveVerdict('auto', decision);
        const label = Utils.VERDICT_LABELS[predicted];
        state = predicted; // цвет = предсказанному решению
        icon = App.VERDICT_ICONS[predicted] || '⚖';
        badgeText = '🤖 АВТО → ' + (predicted === 'accept_standard' ? 'СТАНДАРТ'
          : predicted === 'accept_adjusted' ? 'С КОЭФФИЦИЕНТОМ'
          : predicted === 'reject' ? 'ОТКЛОНИТЬ'
          : predicted === 'defer' ? 'ОТЛОЖИТЬ' : '');
        const safeLabel = label || 'Принятие со стандартным коэффициентом';
        // Поясняем, почему стандарт (если скидку срезали правила) + детали:
        //  - claims: сколько НС (общая цифра по истории + сумма выплат)
        //  - young_company: точная дата регистрации компании из statgov
        let noDiscountNote = '';
        if (effCoeff.noDiscountReason === 'claims') {
          const total = App.claims?.totalClaims || App._effectiveClaimsCount(z) || 0;
          const sumTotal = App.claims?.analytics?.sumTotal3y || 0;
          const sumPart = sumTotal > 0 ? `, на сумму ${Utils.fmtMoney(sumTotal)}` : '';
          noDiscountNote = ` (скидка не применяется — за 3 года ${total} НС${sumPart})`;
        } else if (effCoeff.noDiscountReason === 'young_company') {
          const sg = (App.statgov && !App.statgov.loading && !App.statgov.error && App.statgov.found !== false)
            ? App.statgov : null;
          const regDate = sg?.registrationDate
            ? Utils.fmtDateShort(sg.registrationDate)
            : null;
          const age = effCoeff.ageYears != null ? `${effCoeff.ageYears.toFixed(1)} г.` : null;
          const datePart = regDate ? `, зарегистрирована ${regDate}` : '';
          const agePart = age ? ` (возраст ≈ ${age})` : '';
          noDiscountNote = ` (скидка не применяется — компания младше 3 лет${datePart}${agePart})`;
        }
        const lrWarn = App._verdictLrWarning();
        hintText = `Авто-решение: «${safeLabel}»${noDiscountNote}${lrWarn ? '. ' + lrWarn : ''}. Можно переопределить вручную в списке выше.`;
      } else {
        state = 'auto';
        icon = '🤖';
        badgeText = '🤖 АВТО';
        hintText = 'Решение будет вычислено автоматически по коэффициенту, когда заявка будет загружена и тариф рассчитан.';
      }
    } else {
      // Ручной выбор — bottom-плашка избыточна (значение уже в selectе и в бейдже).
      // Скрываем её, чтобы UI был чище.
      badgeText = '✋ РУЧНОЙ';
      hintText = '';
    }

    // Обнулить старые state-классы и поставить актуальный
    card.className = card.className
      .split(' ')
      .filter(c => !c.startsWith('verdict-state--'))
      .join(' ')
      .trim();
    card.classList.add('verdict-state--' + state);

    if (badge) badge.textContent = badgeText;
    if (iconEl) iconEl.textContent = icon;
    hint.textContent = hintText;
    // Скрыть hint-блок, если текст пустой (ручной выбор)
    hint.style.display = hintText ? '' : 'none';
  },

  // Проверка БИН на присутствие в реестре аффилированных лиц.
  // Возвращает entry {id, name} или null.
  _isAffiliatedBin(bin) {
    if (!bin || !App.refData.affiliated) return null;
    const clean = String(bin).trim().replace(/\s+/g, '');
    return App.refData.affiliated.find(e => e.id === clean) || null;
  },

  // Сводка по «эффективным» финансовым параметрам с учётом всех overrides:
  //   - аффилированное лицо: организация = «СД» (все документы по СД),
  //     НО страховая сумма/премия НЕ форсируются — берутся как ввёл пользователь
  //     (или из заявки). Раньше форсировалась ставка 85 000 ₸/мес — отказались.
  //   - молодая компания / НС: скидка не применяется (через _effectiveCoeffInfo)
  // Используется в showPreview и в _collectData — единый источник правды.
  // Методология ОСНС: премия = СС × тариф, но премия не может быть меньше 1 МЗП.
  // Если СС × тариф < минимума (1 МЗП) — поднимаем СС до (минимум / тариф), тогда
  // премия становится ровно 1 МЗП. В ручном вводе СС изначально = ФОТ, поэтому это и
  // есть правило «ФОТ = СС, но если премия с ФОТ < 85 000 → СС = 85 000 / тариф».
  // Возвращает { insuranceSum, premiumBase } с тиынами. Требует tariff > 0.
  _applyMinPremium(sum, tariff) {
    const minP = App._getLimit('minPremium') || 85000;
    let s = sum;
    let base = App._round2(sum * tariff);
    if (base < minP) {
      s = App._round2(minP / tariff);
      base = App._round2(s * tariff);
    }
    return { insuranceSum: s, premiumBase: base };
  },

  _effectiveFinancials(z) {
    if (!z) return null;
    const aff = App._isAffiliatedBin(z.bin);
    const isAffiliated = !!aff;

    // Тариф из текущего ОКЭДа / справочника
    const resolved = App._resolveOked ? App._resolveOked() : { riskClass: z.riskClass, oked: z.oked };
    const tariff = App._resolveTariff(resolved.riskClass);

    // Страховая сумма — как ввёл пользователь / как в заявке (в ручном вводе = ФОТ).
    // Базовая премия = СС × тариф. По методологии премия не может быть < 1 МЗП:
    // если меньше — СС поднимается до (1 МЗП / тариф), а премия = 1 МЗП.
    let insuranceSum = z.insuranceSum;
    let premiumBase = z.premiumBase;
    if (Number.isFinite(insuranceSum) && Number.isFinite(tariff) && tariff > 0) {
      const m = App._applyMinPremium(insuranceSum, tariff);
      insuranceSum = m.insuranceSum;
      premiumBase = m.premiumBase;
    }

    // Эффективный коэффициент (учёт young/НС)
    const _z2 = { ...z, insuranceSum, premiumBase };
    const effCoeff = App._effectiveCoeffInfo(_z2);

    // Орган: для аффилированных всегда СД, иначе по правилам
    const assetsTenge = App.refData.normativ?.fullAssetsTenge || 0;
    const organ = Utils.determineOrgan(insuranceSum, resolved.riskClass, assetsTenge, isAffiliated);

    return {
      isAffiliated,
      affiliatedEntry: aff,
      insuranceSum,
      tariff,
      premiumBase,
      premiumWithCoeff: effCoeff.premiumWithCoeff,
      coeffDown: effCoeff.coeffDown,
      noDiscountReason: effCoeff.noDiscountReason,
      ageYears: effCoeff.ageYears,
      avgSalary: App._effectiveAvgSalary(z),
      organ,
      docPackage: Utils.determineDocPackage(organ),
    };
  },

  // Эффективные значения коэффициента и премии-с-поправкой с учётом правил:
  //  - НС за последние 3 года → скидка не применяется
  //  - Возраст компании < 3 лет → скидка не применяется (даже при отсутствии НС)
  // Возвращает { coeffDown, premiumWithCoeff, noDiscountReason, ageYears }.
  _effectiveCoeffInfo(z) {
    if (!z) return { coeffDown: 0, premiumWithCoeff: 0, noDiscountReason: null, ageYears: null };
    // Кол-во НС: из файла истории убытков, иначе из ручного ввода (z._manualClaimsCount).
    const claimsCount = App._effectiveClaimsCount(z);
    const sg = (App.statgov && !App.statgov.loading && !App.statgov.error && App.statgov.found !== false)
      ? App.statgov : null;
    const regDateRaw = sg?.registrationDate || null;
    const refDate = z.periodFrom || z.docDate || new Date();
    const ageYears = Utils.companyAgeYears(regDateRaw, refDate);
    const isYoung = ageYears != null && ageYears < App._getLimit('minCompanyAgeYears');
    const noDiscountReason = (claimsCount > 0)
      ? 'claims'
      : (isYoung ? 'young_company' : null);
    // Понижающий коэффициент (скидка):
    //   • явно заданный в заявке (D16 > 0) — приоритет;
    //   • иначе авто-скидка за чистую историю (нет НС) — _getLimit('defaultDiscount'),
    //     по умолчанию 0,1 (ПК 0,9); работает и в ручном вводе (там z.coeffDown=0);
    //   • снимается в 0, если есть НС или компания моложе порога.
    const explicitDown = (z.coeffDown != null && z.coeffDown > 0) ? z.coeffDown : 0;
    const autoDown = App._getLimit('defaultDiscount') || 0;
    const coeffDown = noDiscountReason ? 0 : (explicitDown || autoDown);
    // Премия с ПК пересчитывается от ЭФФЕКТИВНОГО коэффициента — иначе авто-скидка
    // не отразилась бы в сумме (z.premiumWithCoeff мог быть посчитан без скидки —
    // в ручном вводе или при пустом D16). coeffUp (повышающий) учитываем всегда.
    const coeffUp = (z.coeff != null && Number.isFinite(z.coeff)) ? z.coeff : 1;
    let premiumWithCoeff;
    if (z.premiumBase != null && Number.isFinite(z.premiumBase)) {
      premiumWithCoeff = App._round2(z.premiumBase * coeffUp * (1 - coeffDown));
    } else {
      premiumWithCoeff = (z.premiumWithCoeff != null ? z.premiumWithCoeff : z.premiumBase);
    }
    return { coeffDown, premiumWithCoeff, noDiscountReason, ageYears };
  },

  // Эффективная средняя зарплата (₸/мес): из z.avgSalary (manual режим),
  // иначе из ФОТ годового / работников / 12. null если данных нет.
  _effectiveAvgSalary(z) {
    if (!z) return null;
    if (Number.isFinite(z.avgSalary) && z.avgSalary > 0) return z.avgSalary;
    const fot = z.fot != null ? z.fot : z.insuranceSum;
    if (Number.isFinite(fot) && fot > 0 && Number.isFinite(z.workers) && z.workers > 0) {
      return fot / z.workers / 12;
    }
    return null;
  },

  // Дефолтные значения «лимитов процедуры». Пользователь может перебить любой
  // из них через справочник «Лимиты процедуры» (App.refData.limits.<key>);
  // тогда _getLimit(name) вернёт override, иначе — этот дефолт. После загрузки
  // overrides из localStorage значения мутируются в App.AVG_SALARY_THRESHOLD и
  // Utils.LIMIT_* (для обратной совместимости с уже написанным кодом).
  LIMITS_DEFAULTS: {
    minCompanyAgeYears: 3,           // < 3 лет → скидка не применяется
    minAvgSalary: 85000,             // порог alert «низкая ЗП»
    minPremium: 85000,               // минимальная страховая премия = 1 МЗП (методология ОСНС)
    defaultDiscount: 0.1,            // авто-скидка за чистую историю (нет НС) → ПК 0,9
    limitAsLowCls1_15: 2000000000,   // АС: нижний порог, классы 1–15
    limitAsLowCls16_22: 1500000000,  // АС: нижний порог, классы 16–22
    limitAsHigh: 10000000000,        // АС: верхний порог
    limitSdAssetsRatio: 0.25,        // СД: доля от активов (0..1)
  },

  // Эффективное значение лимита: override > default.
  _getLimit(name) {
    const ovr = App.refData.limits && App.refData.limits[name];
    if (ovr != null && Number.isFinite(ovr)) return ovr;
    return App.LIMITS_DEFAULTS[name];
  },

  // Обновляет alert «средняя зарплата ниже X ₸» (для андеррайтера).
  // Порог пока информационный — без эффекта на расчёты.
  AVG_SALARY_THRESHOLD: 85000, // переопределяется при загрузке overrides
  _updateAvgSalaryAlert() {
    const el = document.getElementById('avg-salary-alert');
    if (!el) return;
    const z = App.zayavka;
    const avg = App._effectiveAvgSalary(z);
    if (avg == null || avg >= App.AVG_SALARY_THRESHOLD) {
      el.classList.remove('visible');
      el.innerHTML = '';
      return;
    }
    const fmt = (x) => App._formatMoney(x);
    el.classList.add('visible');
    el.innerHTML =
      `<div class="asa-icon">⚠</div>` +
      `<div class="asa-body">` +
        `<div class="asa-title">Средняя зарплата ниже ${fmt(App.AVG_SALARY_THRESHOLD)} ₸</div>` +
        `<div class="asa-desc">Расчётная средняя ЗП ≈ <b>${fmt(avg)} ₸/мес</b>. Это ниже информационного порога <b>${fmt(App.AVG_SALARY_THRESHOLD)} ₸</b> — обратите внимание андеррайтера.</div>` +
      `</div>`;
  },

  // Обновляет alert «молодая компания» (моложе порога _getLimit('minCompanyAgeYears'),
  // по умолчанию 3 года). Возраст считается на ТЕКУЩУЮ дату (сегодня − дата
  // регистрации из stat.gov.kz). Срабатывает и в режиме быстрой проверки по
  // БИН, и при загруженной заявке. Скидка для таких компаний не применяется.
  _updateYoungCompanyAlert() {
    // Алерт показывается в обеих вкладках с профилем («Проверка контрагента»
    // и «Андеррайтинговое решение») — broadcast по классу .js-young-alert.
    const els = document.querySelectorAll('.js-young-alert');
    if (!els.length) return;
    const hide = () => els.forEach(el => { el.classList.remove('visible'); el.innerHTML = ''; });
    const sg = (App.statgov && !App.statgov.loading && !App.statgov.error && App.statgov.found !== false)
      ? App.statgov : null;
    const regRaw = sg?.registrationDate || null;
    if (!regRaw) { hide(); return; }
    // Возраст на сегодняшнюю дату (а не на дату договора) — для предупреждения.
    const ageYears = Utils.companyAgeYears(regRaw, new Date());
    const threshold = App._getLimit('minCompanyAgeYears');
    if (ageYears == null || ageYears >= threshold) { hide(); return; }
    const regStr = Utils.fmtDateShort(regRaw);
    // После дробного числа — род. падеж ед.ч.: «≈ 2,6 года». Для порога —
    // «моложе 3 лет», «моложе 1 года» (согласование с целым числом).
    const ageStr = ageYears.toFixed(1).replace('.', ',');
    const thresholdWord = Utils.plural(threshold, 'года', 'лет', 'лет');
    const html =
      `<div class="asa-icon">⚠</div>` +
      `<div class="asa-body">` +
        `<div class="asa-title">Молодая компания — моложе ${threshold} ${thresholdWord}</div>` +
        `<div class="asa-desc">Дата регистрации <b>${regStr}</b>, возраст ≈ <b>${ageStr} года</b>. Понижающая скидка не применяется (компания младше ${threshold} ${thresholdWord}) — обратите внимание андеррайтера.</div>` +
      `</div>`;
    els.forEach(el => { el.classList.add('visible'); el.innerHTML = html; });
  },

  // Alert «не загружены Страховые случаи» — информационный, ни на что не влияет
  // (как alert низкой ЗП). Показывается, когда кейс загружен, но история убытков
  // не приложена: авто-решение исходит из того, что НС не было, и применяет
  // скидку — андеррайтеру стоит приложить файл (или убедиться, что НС не было).
  _updateClaimsNotLoadedAlert() {
    const el = document.getElementById('claims-not-loaded-alert');
    if (!el) return;
    const z = App.zayavka;
    // Скрыт, если кейса нет / быстрая проверка / НС загружены / андеррайтер
    // подтвердил галочкой, что НС не было.
    const show = !!z && !z._lookupOnly && App.claims == null && !z._noClaimsAck && z._manualClaimsCount == null;
    if (!show) { el.classList.remove('visible'); el.innerHTML = ''; return; }
    el.classList.add('visible');
    el.innerHTML =
      `<div class="asa-icon">⚠</div>` +
      `<div class="asa-body">` +
        `<div class="asa-title">Вы не загрузили «Страховые случаи»</div>` +
        `<div class="asa-desc">Без приложенной истории убытков расчёт исходит из того, что НС не было (применяется авто-скидка). Пока файл не загружен или не отмечено «Не было страховых случаев», сформировать пакет документов нельзя.</div>` +
        `<label class="asa-ack"><input type="checkbox" onchange="App.ackNoClaims(this.checked)"> Не было страховых случаев</label>` +
      `</div>`;
  },

  // «Ворота» по страховым случаям: формировать пакет документов можно, только
  // когда по НС есть определённость — файл «Страховые случаи» загружен ИЛИ
  // андеррайтер отметил галочкой, что НС не было. Для быстрой проверки по БИН
  // (_lookupOnly) и при отсутствии кейса — не блокирует (кнопки и так выключены).
  _claimsConfirmed() {
    const z = App.zayavka;
    if (!z || z._lookupOnly) return true;
    // Определённость по НС: файл загружен, подтверждено галочкой в алерте, или
    // указано в ручном вводе (z._manualClaimsCount — 0 «не было» либо число).
    return App.claims != null || !!z._noClaimsAck || z._manualClaimsCount != null;
  },

  // Галочка «Не было страховых случаев» в алерте: подтверждает чистую историю,
  // скрывает напоминание и ОТКРЫВАЕТ формирование пакета документов. Флаг живёт
  // на кейсе (z._noClaimsAck) — персистится и сбрасывается при загрузке нового
  // кейса (новый объект zayavka без флага).
  ackNoClaims(checked) {
    if (App.zayavka) App.zayavka._noClaimsAck = !!checked;
    App._persistCase();
    App._updateClaimsNotLoadedAlert();
    App.updateButtons(); // ворота: пере-включить/выключить кнопки генерации
  },

  // ===== UNIVERSAL DERIVED-STATE REFRESH =====
  // Прогоняет всю цепочку зависимостей: ОКЭД→классификатор→тариф→премия,
  // превью, таблица ОКЭДов компании, кнопки (орган зависит от активов),
  // verdict-hint, snapshot аналитики (для inline iframe и standalone window).
  // Вызывается из loadRef / clearOneRef / refreshAll / restoreCache —
  // чтобы любая смена справочника или внешнего источника немедленно
  // отображалась в UI без перезагрузки страницы.
  _refreshDerivedData() {
    // 1. ОКЭД-chain (вызывает _autoSelectActivityByOked, _renderActivityHint,
    //    renderCompanyOkeds, _recalcManualPremium для manual-режима).
    App.onOkedChange();
    // 2. Превью (если есть зайавка)
    if (App.zayavka) App.showPreview();
    // 2b. Блок ИИ-советника по ОКЭД (всегда — '' когда нет компании/ОКЭДов).
    App._renderOkedAdvisor();
    // 3. Кнопки (выбор организации зависит от normativ.fullAssetsTenge)
    App.updateButtons();
    // 4. Verdict-hint
    App.updateVerdictHint();
    // 4b. Alert «средняя ЗП ниже 85 000 ₸» (информационный для андеррайтера)
    App._updateAvgSalaryAlert();
    // 4c. Alert «молодая компания» (моложе 3 лет → скидка не применяется)
    App._updateYoungCompanyAlert();
    // 4d. Alert «не загружены Страховые случаи» (информационный)
    App._updateClaimsNotLoadedAlert();
    // 5. Обновить snapshot аналитики, чтобы при повторном открытии
    //    standalone-окна / iframe — данные были свежие.
    if (App.claims && App.claims.analytics) {
      try {
        localStorage.setItem('analytics_snapshot', JSON.stringify(App._buildAnalyticsSnapshot()));
      } catch (e) { console.warn('Snapshot refresh failed:', e); }
    }
    // 6. Если inline-iframe аналитики открыт — перезагрузить его.
    App._refreshInlineAnalytics();
  },

  // Перезагружает iframe inline-аналитики. Если контейнер открыт —
  // делаем это сразу (видимое обновление). Если закрыт — всё равно
  // помечаем src устаревшим (`_pendingReload`), чтобы при следующем
  // открытии toggleInlineAnalytics() подгрузил свежие данные.
  _refreshInlineAnalytics() {
    if (!App.claims || !App.claims.analytics) return;
    const iframe = document.getElementById('analytics-iframe');
    if (!iframe) return;
    const container = document.getElementById('analytics-inline');
    const isOpen = container && container.classList.contains('is-open');
    if (isOpen) {
      iframe.src = 'analytics.html#inline=1&t=' + Date.now();
    } else {
      // Помечаем, чтобы toggleInlineAnalytics при следующем раскрытии знал,
      // что src нужно перевыставить (он и так это делает, но флаг помогает
      // отслеживать состояние при отладке).
      iframe.dataset.pendingReload = '1';
    }
  },

  // ===== REFERENCE FILE LOADING =====
  async loadRef(type, file) {
    if (!file) return;
    try {
      const buf = await App._readFile(file);
      switch (type) {
        case 'popravka': {
          const result = ExcelReader.readPopravochnyeKoeff(buf);
          App.refData.popravka = result;
          // Cache as JSON-serializable
          const cacheObj = {
            riskRates: Array.from(result.riskRates.entries()),
            adjustmentCoeffs: result.adjustmentCoeffs,
          };
          localStorage.setItem('ref_popravka', JSON.stringify(cacheObj));
          break;
        }
        case 'normativ': {
          // Store raw buffer as base64 for re-reading with docDate
          const base64 = App._arrayBufferToBase64(buf);
          localStorage.setItem('ref_normativ_raw', base64);
          App._rawNormativBuffer = buf;
          // Дата для выборки строки норматива (приоритет):
          //   1. Дата заявки (periodFrom / docDate)
          //   2. Дата, извлечённая из названия файла ("Норматив 01.05.2026.xlsx")
          //   3. null → парсер возьмёт последнюю строку файла
          const filenameDate = App._extractDateFromFilename(file.name);
          const effDate = (App.zayavka && (App.zayavka.periodFrom || App.zayavka.docDate))
            || (filenameDate ? new Date(filenameDate) : null);
          App.refData.normativ = ExcelReader.readNormativ(buf, effDate);
          // Если в самом файле даты нет (или парсер её не нашёл), а имя
          // содержит её — берём из имени.
          if (App.refData.normativ && !App.refData.normativ.date && filenameDate) {
            App.refData.normativ.date = new Date(filenameDate);
          }
          // Поверх Excel — ручные правки (приоритет всегда у override).
          App._applyRefOverrides('normativ');
          // Заполняем инпуты ручного ввода данными из Excel — только пустые
          // (где у пользователя ещё нет override), чтобы он мог их подправить.
          App._prefillRefInputsFromExcel('normativ');
          break;
        }
        case 'ku': {
          const result = ExcelReader.readKuPoKlassam(buf);
          // КУ-файл не содержит даты внутри — берём её из названия
          // («КУ по классам на 01.05.2026.xlsx» → 2026-05-01).
          const filenameDate = App._extractDateFromFilename(file.name);
          if (filenameDate) result.date = new Date(filenameDate);
          App.refData.ku = result;
          localStorage.setItem('ref_ku', JSON.stringify(result));
          App._applyRefOverrides('ku');
          App._prefillRefInputsFromExcel('ku');
          break;
        }
        case 'calculator': {
          const result = ExcelReader.readCalculator(buf);
          App.refData.calculator = result;
          localStorage.setItem('ref_calculator', JSON.stringify(result));
          App.populateActivityDropdown();
          break;
        }
        case 'classifier': {
          const result = ExcelReader.readOkedClassifier(buf);
          App.refData.classifier = result;
          localStorage.setItem('ref_classifier', JSON.stringify(result));
          break;
        }
        case 'affiliated': {
          const result = ExcelReader.readAffiliatedList(buf);
          App.refData.affiliated = result;
          localStorage.setItem('ref_affiliated', JSON.stringify(result));
          break;
        }
      }
      // Сохраняем имя файла, чтобы показывать его и после перезагрузки.
      localStorage.setItem(`ref_${type}_name`, file.name);
      App.updateRefStatus(type, true, file.name);
      App.updateRefBadge();
      // Прогон всей цепочки зависимостей — новый файл сразу отражается в UI.
      App._refreshDerivedData();
      App.showMsg(`Справочник «${file.name}» загружен и применён.`, 'success');
    } catch (e) {
      console.error(`Error loading ${type}:`, e);
      App.showMsg(`Ошибка загрузки ${file.name}: ${e.message}`, 'error');
    }
  },

  // Русские названия справочников — для сообщений и подтверждений.
  REF_LABELS: {
    popravka: 'Поправочные коэффициенты',
    normativ: 'Норматив',
    ku: 'КУ по классам',
    calculator: 'Калькулятор рентабельности',
    classifier: 'Классификатор ОКЭД',
    affiliated: 'Аффилированные лица',
  },

  // ===== CONFIRM DIALOG =====
  // Стилизованное подтверждение разрушающего действия. Возвращает Promise<boolean>.
  // Закрытие по Esc / клику по фону / «Отмена» → false.
  confirmDialog({ title, text, confirmLabel = 'Удалить', icon = '⚠️' } = {}) {
    return new Promise((resolve) => {
      const overlay = document.getElementById('confirm-overlay');
      if (!overlay) { resolve(window.confirm(`${title}\n\n${text || ''}`)); return; }
      document.getElementById('confirm-icon').textContent = icon;
      document.getElementById('confirm-title').textContent = title || '';
      document.getElementById('confirm-text').textContent = text || '';
      const okBtn = document.getElementById('confirm-ok');
      const cancelBtn = document.getElementById('confirm-cancel');
      okBtn.textContent = confirmLabel;

      const done = (result) => {
        overlay.classList.remove('is-open');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onOverlay);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      const onOverlay = (e) => { if (e.target === overlay) done(false); };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      overlay.addEventListener('click', onOverlay);
      document.addEventListener('keydown', onKey);

      overlay.classList.add('is-open');
      // Фокус на «Отмена» — случайный Enter не удалит данные
      cancelBtn.focus();
    });
  },

  // Очищает один справочник (по типу) — для кнопки ❌ на карточке.
  // С подтверждением: случайный клик по ❌ не должен удалять файл из кэша.
  async clearOneRef(type, ev) {
    if (ev) ev.stopPropagation();
    const keys = {
      popravka: 'ref_popravka',
      normativ: 'ref_normativ_raw',
      ku: 'ref_ku',
      calculator: 'ref_calculator',
      classifier: 'ref_classifier',
      affiliated: 'ref_affiliated',
    };
    if (!keys[type]) return;
    const label = App.REF_LABELS[type] || type;
    const fileName = localStorage.getItem(`ref_${type}_name`);
    const ok = await App.confirmDialog({
      title: `Удалить справочник «${label}»?`,
      text: (fileName ? `Файл: ${fileName}\n` : '') +
        'Данные будут удалены из кэша браузера — файл придётся загрузить заново.',
      confirmLabel: 'Удалить',
    });
    if (!ok) return;
    localStorage.removeItem(keys[type]);
    localStorage.removeItem(`ref_${type}_name`);
    // Снимаем и ручные override для норматива/КУ — иначе после очистки файла
    // данные «остаются» в виде смерженных override-значений.
    if (type === 'normativ' || type === 'ku') {
      App.refOverride[type] = {};
      localStorage.removeItem(`ref_${type}_override`);
      // Очистить инпуты ручного ввода
      App.fillRefOverrideInputs(type);
      // И сбросить их placeholder'ы (от Excel-prefill)
      ['date', type === 'normativ' ? 'assets' : 'with', type === 'normativ' ? 'portfolio' : 'without']
        .forEach(suffix => {
          const inp = document.getElementById(`ovr-${type}-${suffix}`);
          if (inp) inp.placeholder = '';
        });
    }
    App.refData[type] = null;
    if (type === 'normativ') App._rawNormativBuffer = null;
    if (type === 'calculator') {
      localStorage.removeItem('selected_activity_idx');
      App.populateActivityDropdown();
    }
    App.updateRefStatus(type, false);
    App.updateRefBadge();
    App._refreshDerivedData();
    App.showMsg(`Справочник «${label}» очищен.`, 'success');
  },

  // Извлекает дату из имени файла справочника. Поддерживает форматы:
  //   "Норматив 01.05.2026.xlsx", "КУ по классам на 01.05.2026.xlsx"
  //   "ku_2026-05.xlsx", "normativ_april.xlsx", "ку май 2026.xlsx"
  // Возвращает ISO-строку "YYYY-MM-DD" или null.
  // Используется в loadRef для нормативa и КУ — даёт fallback-дату, когда
  // в самом файле даты нет или заявка ещё не загружена.
  _extractDateFromFilename(name) {
    if (!name) return null;
    const s = String(name);
    // 1. DD.MM.YYYY / DD-MM-YYYY / DD/MM/YYYY (полная дата)
    let m = s.match(/(\d{1,2})[.\-_/](\d{1,2})[.\-_/](\d{4})/);
    if (m) {
      return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    }
    // 2. YYYY-MM-DD ISO
    m = s.match(/(\d{4})[-_.](\d{1,2})[-_.](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    // 3. YYYY-MM (только год + месяц) — берём 1-е число
    m = s.match(/(20\d{2})[-_.](\d{1,2})\b/);
    if (m) return `${m[1]}-${m[2].padStart(2,'0')}-01`;
    // 4. DD.MM.YY → 20YY
    m = s.match(/\b(\d{1,2})[.\-_/](\d{1,2})[.\-_/](\d{2})\b/);
    if (m) return `20${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    // 5. Названия месяцев на русском + год: «на май 2026», «апрель 26»
    const months = {
      'январ': '01', 'феврал': '02', 'март':  '03', 'апрел': '04',
      'мая':   '05', 'май':    '05', 'июн':   '06', 'июл':   '07',
      'август':'08', 'сентябр':'09', 'октябр':'10', 'ноябр': '11', 'декабр':'12',
    };
    const lower = s.toLowerCase();
    for (const [stem, mm] of Object.entries(months)) {
      if (!lower.includes(stem)) continue;
      const yM = lower.match(/\b(20\d{2})\b/) || lower.match(/\b(\d{2})\b(?!\d)/);
      const yyyy = yM ? (yM[1].length === 4 ? yM[1] : ('20' + yM[1])) : null;
      if (yyyy) return `${yyyy}-${mm}-01`;
    }
    // 6. Названия месяцев на английском (для test-data: normativ_april.xlsx)
    const monthsEn = {
      january: '01', february: '02', march: '03', april: '04',
      may: '05', june: '06', july: '07', august: '08',
      september: '09', october: '10', november: '11', december: '12',
    };
    for (const [name, mm] of Object.entries(monthsEn)) {
      if (!lower.includes(name)) continue;
      const yM = lower.match(/\b(20\d{2})\b/);
      // Если год не указан — используем текущий год.
      const yyyy = yM ? yM[1] : String(new Date().getFullYear());
      return `${yyyy}-${mm}-01`;
    }
    return null;
  },

  // ===== MANUAL OVERRIDE FOR NORMATIV / KU =====
  // Хранилище: App.refOverride[type] = { date?, fullAssetsTenge?, portfolioShare?,
  // lossRatioWith?, lossRatioWithout? }. Ключи, которых нет в объекте, считаются
  // «не переопределёнными» — берём значение из Excel. Объект также сохраняется
  // в localStorage под ключом `ref_${type}_override`.
  //
  // _applyRefOverrides() склеивает Excel-данные с ручными правками: поверх
  // App.refData[type] (содержит данные из файла) накладывает все ключи из
  // App.refOverride[type]. Если файл не загружен — создаёт объект с нуля.
  refOverride: { normativ: {}, ku: {} },

  // Парсинг ввода. Дата возвращается строкой YYYY-MM-DD (как в input type=date),
  // числа — float (с поддержкой запятой как десятичного разделителя).
  // portfolioShare — пользователь вводит проценты (91,4), хранится дробь (0,914),
  // т.к. analytics/snapshot ожидают именно дробь и умножают на 100 при выводе.
  _parseOverrideValue(field, raw) {
    if (raw == null || String(raw).trim() === '') return null;
    if (field === 'date') {
      // Браузерный input[type=date] уже возвращает ISO; на всякий случай
      // принимаем DD.MM.YYYY.
      const s = String(raw).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      const m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/);
      if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
      return null;
    }
    const n = Number(String(raw).replace(',', '.').replace(/\s/g, ''));
    if (!Number.isFinite(n)) return null;
    if (field === 'portfolioShare') return n / 100; // % → доля
    return n;
  },

  // Применяет ручные правки (refOverride[type]) поверх данных из файла
  // (которые ExcelReader уже положил в refData[type]).
  //
  // Сохраняет «чистые» Excel-значения в target._excel перед наложением, чтобы
  // placeholder инпутов ручного ввода мог показывать «Excel: <значение>» даже
  // когда верхний уровень уже переопределён.
  _applyRefOverrides(type) {
    if (!App.refData[type]) {
      // Если файла не было, но есть override — создаём пустой объект.
      if (Object.keys(App.refOverride[type] || {}).length === 0) return;
      App.refData[type] = {};
    }
    const target = App.refData[type];
    // Снимок «как из файла»: один раз при первом вызове после загрузки/restore.
    if (!target._excel) {
      const excel = {};
      for (const k of Object.keys(target)) {
        if (k.startsWith('_')) continue;
        excel[k] = target[k];
      }
      target._excel = excel;
    }
    const ovr = App.refOverride[type] || {};
    for (const [k, v] of Object.entries(ovr)) {
      if (v == null) continue;
      target[k] = v;
      // Производные поля для норматива: при ручном fullAssetsTenge пересчитываем
      // fullAssets (в тыс. тенге) и assets25pct (для совместимости со старым кодом).
      if (type === 'normativ' && k === 'fullAssetsTenge') {
        target.fullAssets = v / 1000;
        target.assets25pct = (v / 1000) * 0.25;
      }
    }
    // Помечаем, какие ключи переопределены — может пригодиться UI/snapshot.
    target._manualKeys = Object.keys(ovr).filter(k => ovr[k] != null);
  },

  // Обработчик oninput на полях ручного ввода. Записывает значение в
  // refOverride[type], применяет переопределения к refData, обновляет UI/превью.
  onRefOverride(type, field, rawValue) {
    if (!App.refOverride[type]) App.refOverride[type] = {};
    const parsed = App._parseOverrideValue(field, rawValue);
    if (parsed == null) {
      delete App.refOverride[type][field];
      // Возвращаем значение из Excel (если файл был загружен) или null.
      App._reloadRefFromExcel(type);
    } else {
      App.refOverride[type][field] = parsed;
      App._reloadRefFromExcel(type);
    }
    // Подсветка поля: если ввод задан — оранжевая рамка.
    const inp = document.getElementById(`ovr-${type}-${App._ovrInputSuffix(field)}`);
    if (inp) inp.classList.toggle('ovr-active', parsed != null);
    // Обновляем ОСТАЛЬНЫЕ инпуты этого блока из свежеперечитанных данных
    // (важно для normativ: смена override-date перечитывает строку файла за
    // другой месяц, и assets/portfolio тоже меняются). Инпут, который сейчас
    // редактируется, _prefillRefInputsFromExcel не трогает (проверка activeElement).
    App._prefillRefInputsFromExcel(type);
    // Сохраняем в localStorage.
    localStorage.setItem(`ref_${type}_override`, JSON.stringify(App.refOverride[type]));
    // Прогон зависимостей — превью, аналитика, бейджи.
    App._refreshDerivedData();
  },

  // Перечитывает Excel-данные (если есть raw-буфер для norm) и поверх кладёт
  // ручные правки. Вызывается после каждого изменения override.
  _reloadRefFromExcel(type) {
    if (type === 'normativ') {
      if (App._rawNormativBuffer) {
        // Дата для вырезки строки: ручная dateOverride > docDate заявки.
        const ovrDate = App.refOverride.normativ?.date;
        const effDate = ovrDate ? new Date(ovrDate)
          : (App.zayavka?.periodFrom || App.zayavka?.docDate || null);
        App.refData.normativ = ExcelReader.readNormativ(App._rawNormativBuffer, effDate);
      } else if (App.refData.normativ && !App.refData.normativ._manualKeys) {
        App.refData.normativ = null;
      }
    } else if (type === 'ku') {
      // КУ хранится как готовый JSON — перечитываем из ref_ku.
      try {
        const raw = localStorage.getItem('ref_ku');
        if (raw) App.refData.ku = JSON.parse(raw);
        else App.refData.ku = null;
      } catch (_) { App.refData.ku = null; }
    }
    App._applyRefOverrides(type);
  },

  // Маппинг field → суффикс id поля ввода (id: ovr-{type}-{suffix}).
  _ovrInputSuffix(field) {
    return ({
      date: 'date',
      fullAssetsTenge: 'assets',
      portfolioShare: 'portfolio',
      lossRatioWith: 'with',
      lossRatioWithout: 'without',
    })[field] || field;
  },

  // Заполняет инпуты ручного ввода значениями из refOverride (для restore).
  fillRefOverrideInputs(type) {
    const ovr = App.refOverride[type] || {};
    const fields = type === 'normativ'
      ? ['date', 'fullAssetsTenge', 'portfolioShare']
      : ['date', 'lossRatioWith', 'lossRatioWithout'];
    for (const f of fields) {
      const inp = document.getElementById(`ovr-${type}-${App._ovrInputSuffix(f)}`);
      if (!inp) continue;
      const v = ovr[f];
      if (v == null) {
        inp.value = '';
        inp.classList.remove('ovr-active');
      } else if (f === 'date') {
        inp.value = String(v);
        inp.classList.add('ovr-active');
      } else if (f === 'portfolioShare') {
        // Хранится как дробь — в инпуте показываем процент.
        inp.value = App._fmtNumWithSpaces(Number((v * 100).toFixed(2)));
        inp.classList.add('ovr-active');
      } else {
        // Большие числа (активы, КУ) — с пробелами в разрядах.
        inp.value = App._fmtNumWithSpaces(v);
        inp.classList.add('ovr-active');
      }
    }
  },

  // На blur пустого инпута — возвращаем значение из Excel (если файл загружен).
  // Так у пользователя в любой момент в инпуте видно эффективное значение.
  _refillIfEmpty(type) {
    App._prefillRefInputsFromExcel(type);
  },

  // ===== ЛИМИТЫ ПРОЦЕДУРЫ (manual override of regulatory thresholds) =====
  // Маппинг: limit key → id инпута + конвертер вход/выход (если значение
  // в инпуте отличается от хранимого: % → доля, и наоборот).
  _LIMIT_INPUTS: {
    minCompanyAgeYears: { id: 'lim-minAge',     toStored: v => v,        toDisplay: v => v },
    minAvgSalary:       { id: 'lim-minSalary',  toStored: v => v,        toDisplay: v => v },
    defaultDiscount:    { id: 'lim-discount',   toStored: v => v / 100,  toDisplay: v => v * 100 },
    limitAsLowCls1_15:  { id: 'lim-asLow1_15',  toStored: v => v,        toDisplay: v => v },
    limitAsLowCls16_22: { id: 'lim-asLow16_22', toStored: v => v,        toDisplay: v => v },
    limitAsHigh:        { id: 'lim-asHigh',     toStored: v => v,        toDisplay: v => v },
    limitSdAssetsRatio: { id: 'lim-sdRatio',    toStored: v => v / 100,  toDisplay: v => v * 100 },
  },

  // Обработчик oninput. Записывает значение в App.refData.limits,
  // мутирует Utils.LIMIT_* и App.AVG_SALARY_THRESHOLD для обратной
  // совместимости, сохраняет в localStorage, перепроверяет зависимости.
  onLimitOverride(name, rawValue) {
    if (!App.refData.limits) App.refData.limits = {};
    const map = App._LIMIT_INPUTS[name];
    if (!map) return;
    const raw = String(rawValue || '').trim();
    if (!raw) {
      delete App.refData.limits[name];
    } else {
      const n = Number(raw.replace(',', '.').replace(/\s/g, ''));
      if (!Number.isFinite(n)) return;
      App.refData.limits[name] = map.toStored(n);
    }
    App._syncLimitsToGlobals();
    App._persistLimits();
    // Подсветка поля
    const inp = document.getElementById(map.id);
    if (inp) inp.classList.toggle('ovr-active', App.refData.limits[name] != null);
    App._updateLimitsStatus();
    App._refreshDerivedData();
  },

  // Мутирует Utils.LIMIT_* и App.AVG_SALARY_THRESHOLD в соответствии с
  // эффективными лимитами. Так весь старый код, который читает эти
  // константы напрямую, начинает использовать пользовательские overrides.
  _syncLimitsToGlobals() {
    if (typeof Utils !== 'undefined') {
      Utils.LIMIT_AS_LOW_CLS_1_15 = App._getLimit('limitAsLowCls1_15');
      Utils.LIMIT_AS_LOW_CLS_16_22 = App._getLimit('limitAsLowCls16_22');
      Utils.LIMIT_AS_HIGH = App._getLimit('limitAsHigh');
      Utils.LIMIT_SD_ASSETS_RATIO = App._getLimit('limitSdAssetsRatio');
    }
    App.AVG_SALARY_THRESHOLD = App._getLimit('minAvgSalary');
  },

  _persistLimits() {
    const lim = App.refData.limits || {};
    if (Object.keys(lim).length === 0) {
      localStorage.removeItem('ref_limits');
    } else {
      localStorage.setItem('ref_limits', JSON.stringify(lim));
    }
  },

  _updateLimitsStatus() {
    const el = document.getElementById('status-limits');
    if (!el) return;
    const count = Object.keys(App.refData.limits || {}).length;
    el.textContent = count === 0 ? 'По умолчанию' : `Изменено: ${count} из 7`;
  },

  // Форматирование числа с пробелами в качестве разделителей разрядов.
  // 10000000000 → "10 000 000 000", 1500.5 → "1 500,5".
  // Парсер игнорирует пробелы (см. _parseOverrideValue), так что введённое
  // «1 000 000» корректно превратится в 1000000.
  _fmtNumWithSpaces(n) {
    if (n == null || !Number.isFinite(n)) return '';
    const [intPart, fracPart] = String(n).split('.');
    const intFmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return fracPart ? `${intFmt},${fracPart}` : intFmt;
  },

  // Заполняет все 6 инпутов: либо override-значением, либо дефолтом.
  _fillLimitsInputs() {
    for (const [name, map] of Object.entries(App._LIMIT_INPUTS)) {
      const inp = document.getElementById(map.id);
      if (!inp) continue;
      if (document.activeElement === inp) continue;
      const ovr = App.refData.limits && App.refData.limits[name];
      const eff = (ovr != null) ? ovr : App.LIMITS_DEFAULTS[name];
      inp.value = App._fmtNumWithSpaces(map.toDisplay(eff));
      inp.classList.toggle('ovr-active', ovr != null);
      // Placeholder показывает дефолт.
      const def = map.toDisplay(App.LIMITS_DEFAULTS[name]);
      inp.placeholder = `По умолч.: ${App._fmtNumWithSpaces(def)}`;
    }
    App._updateLimitsStatus();
  },

  // Сброс всех лимитов к значениям по умолчанию.
  resetLimitsToDefaults(ev) {
    if (ev) ev.stopPropagation();
    App.refData.limits = {};
    App._syncLimitsToGlobals();
    App._persistLimits();
    App._fillLimitsInputs();
    App._refreshDerivedData();
    App.showMsg('Лимиты процедуры сброшены к значениям по умолчанию.', 'success');
  },

  // Восстановление при загрузке страницы.
  _restoreLimits() {
    try {
      const raw = localStorage.getItem('ref_limits');
      App.refData.limits = raw ? (JSON.parse(raw) || {}) : {};
    } catch (_) {
      App.refData.limits = {};
    }
    App._syncLimitsToGlobals();
    App._fillLimitsInputs();
  },

  // ===== ПОДПИСАНТЫ (signatories) =====
  // Дефолтные ФИО всех подписантов и адресатов документов. Когда кто-то уходит
  // в отпуск / на больничный / увольняется — пользователь правит ФИО в карточке
  // «Подписанты», override сохраняется в localStorage и переписывается в
  // Utils.* при загрузке, чтобы все генераторы документов (АР, Заключение,
  // Протокол, СЗ) автоматически использовали новые значения.
  //
  // Роли остаются hardcoded — они меняются редко, а ФИО гораздо чаще.
  SIGNERS_DEFAULTS: {
    // Solo positions
    sdChair:          'М.К. Альжанов',     // Председатель Совета директоров (адресат СЗ на СД)
    pravlenieChair:   'Г. Амерходжаев',    // Председатель Правления (адресат СЗ на Правление)
    daipDirector:     'Джелкобаев Т.К.',   // Директор ДАиП (подписант СЗ)
    upravDir:         'Аринов Д.С.',       // Управляющий директор
    // АС (Андеррайтинговый Совет) — 6 членов + секретарь
    asMember0:        'Амерходжаев Г.Т.',  // Председатель Правления
    asMember1:        'Кныкова А.У.',      // Заместитель Председателя Правления, член Правления
    asMember2:        'Аринов Д.С.',       // Заместитель Председателя Правления, член Правления
    asMember3:        'Уткин А.С.',        // Управляющий директор
    asMember4:        'Осинцев Р.С.',      // Руководитель Службы управления рисками
    asMember5:        'Джелкобаев Т.К.',   // Директор ДАиП
    asSecretary:      'Клейнбок О.И.',     // Секретарь АС
    // Правление (для протокола Правления и СД) — 3 члена + секретарь
    pravlenieMember0: 'Амерходжаев Г.Т.',  // Председатель Правления
    pravlenieMember1: 'Кныкова А.У.',      // Заместитель Председателя Правления, член Правления
    pravlenieMember2: 'Керн Ю.П.',         // Главный бухгалтер, член Правления
    pravlenieSecretary: 'Боева И.В.',      // Секретарь Правления
  },

  // Роли — для отображения в UI и заполнения структур Utils.AS_MEMBERS / PRAVLENIE_MEMBERS.
  SIGNERS_ROLES: {
    sdChair:          'Председатель Совета директоров',
    pravlenieChair:   'Председатель Правления',
    daipDirector:     'Директор ДАиП',
    upravDir:         'Заместитель Председателя Правления, член Правления',
    asMember0:        'Председатель Правления',
    asMember1:        'Заместитель Председателя Правления, член Правления',
    asMember2:        'Заместитель Председателя Правления, член Правления',
    asMember3:        'Управляющий директор',
    asMember4:        'Руководитель Службы управления рисками',
    asMember5:        'Директор ДАиП',
    asSecretary:      'Секретарь Андеррайтингового Совета',
    pravlenieMember0: 'Председатель Правления',
    pravlenieMember1: 'Заместитель Председателя Правления, член Правления',
    pravlenieMember2: 'Главный бухгалтер, член Правления',
    pravlenieSecretary: 'Секретарь Правления',
  },

  // Возвращает ЭФФЕКТИВНОЕ ФИО подписанта.
  // Override может быть строкой (старый формат) или объектом {name, role, skip}.
  _getSigner(key) {
    const ovr = App.refData.signers && App.refData.signers[key];
    if (ovr == null) return App.SIGNERS_DEFAULTS[key];
    if (typeof ovr === 'string') return ovr.trim() || App.SIGNERS_DEFAULTS[key];
    // object form
    return (ovr.name && String(ovr.name).trim()) || App.SIGNERS_DEFAULTS[key];
  },

  // ЭФФЕКТИВНАЯ должность (роль) — для членов АС и Правления её можно
  // переопределить, у solo-подписантов всегда из SIGNERS_ROLES.
  _getSignerRole(key) {
    const ovr = App.refData.signers && App.refData.signers[key];
    if (ovr && typeof ovr === 'object' && ovr.role && String(ovr.role).trim()) {
      return String(ovr.role).trim();
    }
    return App.SIGNERS_ROLES[key];
  },

  // «Пропустить» подписанта (применимо для членов АС/Правления — если кто-то
  // в отпуске или на больничном, его строка не попадёт в документ).
  _isSignerSkipped(key) {
    const ovr = App.refData.signers && App.refData.signers[key];
    return !!(ovr && typeof ovr === 'object' && ovr.skip === true);
  },

  // Переписывает Utils.* константы из эффективных подписантов (override > default).
  // Вызывается после загрузки overrides и после каждого изменения.
  // Для членов АС/Правления применяются 3 типа override: имя, должность, skip.
  // Skip-члены полностью исключаются из массива → в документе их строка
  // не появится (loop по AS_MEMBERS/PRAVLENIE_MEMBERS итерирует только активных).
  _syncSignersToUtils() {
    if (typeof Utils === 'undefined') return;
    // ФИО solo-подписантов и секретарей
    Utils.SD_CHAIR_NAME        = App._getSigner('sdChair');
    Utils.PRAVLENIE_CHAIR_NAME = App._getSigner('pravlenieChair');
    Utils.DAIP_DIRECTOR_NAME   = App._getSigner('daipDirector');
    Utils.UPRAV_DIR_NAME       = App._getSigner('upravDir');
    Utils.AS_SECRETARY         = App._getSigner('asSecretary');
    Utils.PRAVLENIE_SECRETARY  = App._getSigner('pravlenieSecretary');
    // Должности solo-подписантов (могут поменяться при перестановках —
    // например, «Управляющий директор» → «Заместитель Председателя Правления»).
    Utils.SD_CHAIR_ROLE        = App._getSignerRole('sdChair');
    Utils.PRAVLENIE_CHAIR_ROLE = App._getSignerRole('pravlenieChair');
    Utils.DAIP_DIRECTOR_ROLE   = App._getSignerRole('daipDirector');
    Utils.UPRAV_DIR_ROLE       = App._getSignerRole('upravDir');

    const buildMembers = (keys) => keys
      .filter(k => !App._isSignerSkipped(k))
      .map(k => [App._getSignerRole(k), App._getSigner(k)]);

    Utils.AS_MEMBERS = buildMembers(['asMember0','asMember1','asMember2','asMember3','asMember4','asMember5']);
    Utils.PRAVLENIE_MEMBERS = buildMembers(['pravlenieMember0','pravlenieMember1','pravlenieMember2']);
  },

  // Обработчик изменений на инпутах подписанта.
  // field: 'name' | 'role' | 'skip'
  onSignerOverride(key, field, rawValue) {
    if (!App.refData.signers) App.refData.signers = {};
    // Нормализуем существующую запись: если хранится как строка (старый формат),
    // конвертируем в объект {name}.
    let entry = App.refData.signers[key];
    if (typeof entry === 'string') entry = { name: entry };
    if (!entry) entry = {};

    if (field === 'skip') {
      if (rawValue) entry.skip = true;
      else delete entry.skip;
    } else {
      // name или role: пустая строка / равенство дефолту = снять override
      const v = String(rawValue || '').trim();
      const defVal = field === 'role'
        ? App.SIGNERS_ROLES[key]
        : App.SIGNERS_DEFAULTS[key];
      if (!v || v === defVal) {
        delete entry[field];
      } else {
        entry[field] = v;
      }
    }

    // Если объект пустой — снимаем весь override.
    if (Object.keys(entry).length === 0) {
      delete App.refData.signers[key];
    } else {
      App.refData.signers[key] = entry;
    }

    App._syncSignersToUtils();
    App._persistSigners();
    App._updateSignerRowState(key);
    App._updateSignersStatus();
  },

  // Подсветка одного «ряда» подписанта: оранжевая рамка на изменённых
  // полях + затемнение всего ряда если skip=true.
  _updateSignerRowState(key) {
    const row = document.getElementById(`sgn-row-${key}`);
    if (!row) return;
    const isSkipped = App._isSignerSkipped(key);
    row.classList.toggle('signer-row--skipped', isSkipped);

    const ovr = App.refData.signers && App.refData.signers[key];
    const ovrObj = (typeof ovr === 'string') ? { name: ovr } : (ovr || {});
    const nameInp = document.getElementById(`sgn-${key}`);
    const roleInp = document.getElementById(`sgn-role-${key}`);
    if (nameInp) nameInp.classList.toggle('ovr-active', !!ovrObj.name);
    if (roleInp) roleInp.classList.toggle('ovr-active', !!ovrObj.role);
  },

  _persistSigners() {
    const s = App.refData.signers || {};
    if (Object.keys(s).length === 0) {
      localStorage.removeItem('ref_signers');
    } else {
      localStorage.setItem('ref_signers', JSON.stringify(s));
    }
  },

  _updateSignersStatus() {
    const el = document.getElementById('status-signers');
    if (!el) return;
    const signers = App.refData.signers || {};
    const total = Object.keys(App.SIGNERS_DEFAULTS).length;
    const overridden = Object.keys(signers).length;
    const skippedCount = Object.keys(signers).filter(k => App._isSignerSkipped(k)).length;
    if (overridden === 0) {
      el.textContent = 'По умолчанию';
    } else if (skippedCount > 0) {
      el.textContent = `Изменено: ${overridden} из ${total} · в отпуске: ${skippedCount}`;
    } else {
      el.textContent = `Изменено: ${overridden} из ${total}`;
    }
  },

  // Заполнить все инпуты подписантов: name, role (для членов АС/Правл.),
  // skip-чекбокс. Если поле в данный момент в фокусе у пользователя, не
  // переписываем — иначе курсор «прыгает».
  _fillSignersInputs() {
    for (const key of Object.keys(App.SIGNERS_DEFAULTS)) {
      const nameInp = document.getElementById(`sgn-${key}`);
      const roleInp = document.getElementById(`sgn-role-${key}`);
      const skipChk = document.getElementById(`sgn-skip-${key}`);
      if (!nameInp && !roleInp && !skipChk) continue;
      const ovr = App.refData.signers && App.refData.signers[key];
      const ovrObj = (typeof ovr === 'string') ? { name: ovr } : (ovr || {});

      if (nameInp && document.activeElement !== nameInp) {
        nameInp.value = App._getSigner(key);
        nameInp.classList.toggle('ovr-active', !!ovrObj.name);
        nameInp.placeholder = `По умолч.: ${App.SIGNERS_DEFAULTS[key]}`;
      }
      if (roleInp && document.activeElement !== roleInp) {
        roleInp.value = App._getSignerRole(key);
        roleInp.classList.toggle('ovr-active', !!ovrObj.role);
        roleInp.placeholder = `По умолч.: ${App.SIGNERS_ROLES[key]}`;
      }
      if (skipChk) {
        skipChk.checked = !App._isSignerSkipped(key);
      }
      App._updateSignerRowState(key);
    }
    App._updateSignersStatus();
  },

  resetSignersToDefaults(ev) {
    if (ev) ev.stopPropagation();
    App.refData.signers = {};
    App._syncSignersToUtils();
    App._persistSigners();
    App._fillSignersInputs();
    App.showMsg('Подписанты сброшены к значениям по умолчанию.', 'success');
  },

  _restoreSigners() {
    try {
      const raw = localStorage.getItem('ref_signers');
      App.refData.signers = raw ? (JSON.parse(raw) || {}) : {};
    } catch (_) {
      App.refData.signers = {};
    }
    App._syncSignersToUtils();
    App._fillSignersInputs();
  },

  // Восстановление overrides из localStorage. Вызывается из restoreCache.
  _restoreRefOverrides() {
    for (const t of ['normativ', 'ku']) {
      try {
        const raw = localStorage.getItem(`ref_${t}_override`);
        if (raw) {
          App.refOverride[t] = JSON.parse(raw) || {};
          App._applyRefOverrides(t);
          App.fillRefOverrideInputs(t);
        }
      } catch (_) { App.refOverride[t] = {}; }
    }
  },

  // После загрузки Excel — заполняем пустые инпуты ручного ввода значениями
  // из файла (только те поля, которые пользователь ещё НЕ переопределил).
  // Это позволяет пользователю увидеть автозаполненные значения и при
  // необходимости тут же их поправить.
  _prefillRefInputsFromExcel(type) {
    const data = App.refData[type];
    if (!data) return;
    // Используем «чистый» Excel-снимок (без overrides), чтобы placeholder и
    // автозаполнение показывали реальные значения из файла, а не уже
    // переопределённые.
    const excel = data._excel || data;
    const ovr = App.refOverride[type] || {};
    const fmtNum = (v, decimals = 2) => {
      if (v == null || !Number.isFinite(v)) return '';
      // Округляем для удобства, но без лишних нулей.
      return Number(v.toFixed(decimals)).toString().replace('.', ',');
    };
    const fmtDate = (v) => {
      if (!v) return '';
      const d = v instanceof Date ? v : new Date(v);
      if (isNaN(d)) return '';
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${dd}`;
    };
    // Когда у поля НЕТ ручного override — значение в инпуте принадлежит
    // предыдущему Excel-файлу (или пусто). При загрузке нового файла такое
    // значение надо ЗАМЕНИТЬ свежим, иначе пользователь увидит устаревшие
    // данные пока не перезагрузит страницу.
    const setFromExcel = (id, val) => {
      const inp = document.getElementById(id);
      if (!inp) return;
      // Если пользователь сейчас редактирует — не перетираем.
      if (document.activeElement === inp) return;
      inp.value = val || '';
      inp.placeholder = val ? `Excel: ${val}` : '';
    };
    // Поле переопределено вручную — оставляем значение, только обновляем
    // placeholder, чтобы видеть, что лежит «в новом файле».
    const setPlaceholder = (id, val) => {
      const inp = document.getElementById(id);
      if (!inp || !val) return;
      inp.placeholder = `Excel: ${val}`;
    };
    if (type === 'normativ') {
      const dateStr = fmtDate(excel.date);
      // Активы — большое число, разделители разрядов пробелами.
      const assetsStr = excel.fullAssetsTenge != null
        ? App._fmtNumWithSpaces(Math.round(excel.fullAssetsTenge)) : '';
      // portfolioShare хранится как дробь (0.914); в инпуте показываем процент (91,40).
      const portfolioStr = excel.portfolioShare != null
        ? fmtNum(excel.portfolioShare * 100, 2) : '';
      // Если поля переопределены — оставляем как есть; иначе подставляем из Excel.
      if (ovr.date == null) setFromExcel('ovr-normativ-date', dateStr);
      else setPlaceholder('ovr-normativ-date', dateStr);
      if (ovr.fullAssetsTenge == null) setFromExcel('ovr-normativ-assets', assetsStr);
      else setPlaceholder('ovr-normativ-assets', assetsStr);
      if (ovr.portfolioShare == null) setFromExcel('ovr-normativ-portfolio', portfolioStr);
      else setPlaceholder('ovr-normativ-portfolio', portfolioStr);
    } else if (type === 'ku') {
      // КУ-файл сам по себе даты не содержит, но App.refData.ku.date
      // populated из имени файла при загрузке («КУ по классам на 01.05.2026.xlsx»).
      const dateStr = fmtDate(excel.date);
      const withStr = fmtNum(excel.lossRatioWith);
      const withoutStr = fmtNum(excel.lossRatioWithout);
      if (ovr.date == null) setFromExcel('ovr-ku-date', dateStr);
      else setPlaceholder('ovr-ku-date', dateStr);
      if (ovr.lossRatioWith == null) setFromExcel('ovr-ku-with', withStr);
      else setPlaceholder('ovr-ku-with', withStr);
      if (ovr.lossRatioWithout == null) setFromExcel('ovr-ku-without', withoutStr);
      else setPlaceholder('ovr-ku-without', withoutStr);
    }
  },

  // Сброс только «Вид деятельности»: снимает выбор из dropdown, удаляет ручную
  // метку manual_activity_for_oked, перезапускает auto-detect по ОКЭДу.
  resetActivity() {
    localStorage.removeItem('selected_activity_idx');
    localStorage.removeItem('manual_activity_for_oked');
    App._activityAutoForOked = null;
    const select = document.getElementById('activitySelect');
    if (select) select.value = '';
    App._autoSelectActivityByOked();
    App._renderActivityHint();
    App.showMsg('Вид деятельности сброшен — выбор пересчитается по ОКЭДу.', 'success');
  },

  // Сброс только третьего блока: описание рисков (свободный текст) + вердикт.
  // Не трогает заявку, период, ОКЭД и пр. — только пользовательский ввод этого блока.
  // С подтверждением — в описании рисков может быть вручную набранный текст.
  async resetSection3() {
    const riskEl = document.getElementById('riskText');
    const hasText = !!(riskEl && riskEl.value.trim());
    const ok = await App.confirmDialog({
      title: 'Сбросить описание рисков и решение?',
      text: (hasText ? 'Введённый текст описания рисков будет удалён без возможности восстановления. ' : '') +
        'Решение по риску вернётся к «Авто».',
      confirmLabel: 'Сбросить',
    });
    if (!ok) return;
    if (riskEl) riskEl.value = '';
    const verdictSel = document.getElementById('verdict');
    if (verdictSel) verdictSel.value = 'auto';
    localStorage.removeItem('manual_verdict');
    App.updateVerdictHint();
    App.showMsg('Описание рисков и решение сброшены.', 'success');
  },

  // Сбрасывает «надпись над договором» состояния формы: номер документа,
  // описание рисков, вердикт, нерезидент, порядок оплаты, ручной ОКЭД.
  // Период страхования re-вычисляется из docDate (если есть).
  _resetFormState() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('docNumber', '');
    set('riskText', '');
    set('okedInput', '');
    set('paymentOrder', 'Единовременно');
    set('paymentFrequency', 'month');
    const nr = document.getElementById('nonResident');
    if (nr) nr.checked = false;
    const verdictSel = document.getElementById('verdict');
    if (verdictSel) verdictSel.value = 'auto';
    localStorage.removeItem('manual_verdict');
    localStorage.removeItem('manual_activity_for_oked');
    // Период — если есть зайавка с docDate, пересчитываем; иначе очищаем
    if (App.zayavka?.docDate) {
      const { from, to } = App._computePeriodFromDocDate(App.zayavka.docDate);
      App.zayavka.periodFrom = from;
      App.zayavka.periodTo = to;
      App._fillDateInputs();
    } else {
      set('periodFrom', '');
      set('periodTo', '');
    }
    App.onOkedChange();
    App.onPaymentChange();
    App.updateVerdictHint();
  },

  // Принудительное обновление: re-парсит normativ из буфера на текущую дату,
  // re-fetch БИН-лукап + stat.gov.kz, СБРАСЫВАЕТ форму, прогоняет _refreshDerivedData.
  // Работает в т.ч. без зайавки — обновляет всё, что можем.
  refreshAll() {
    // Re-read normativ с учётом текущего периода (если буфер сохранён)
    const effectiveDate = App.zayavka
      ? (App.zayavka.periodFrom || App.zayavka.docDate)
      : null;
    if (App._rawNormativBuffer) {
      App.refData.normativ = ExcelReader.readNormativ(App._rawNormativBuffer, effectiveDate);
      App._applyRefOverrides('normativ');
    }
    // Сброс формы (вердикт, описание, доп. поля) — пользователь явно жмёт «обновить»
    App._resetFormState();
    // Re-fetch внешних источников (если БИН известен)
    const bin = App.zayavka?.bin;
    if (bin) {
      App.autoLookupStatGov(bin);
      App.autoLookupBIN(bin);
    }
    App._refreshDerivedData();
    App.showMsg(
      bin
        ? 'Данные обновлены и форма сброшена: справочники, stat.gov.kz, БИН-лукап, превью, ОКЭДы, тариф, премия.'
        : 'Справочники применены, форма сброшена.',
      'success'
    );
  },

  // Удаляет файл по кейсу (заявка ИЛИ история убытков).
  // Подтверждение запрашивается только при клике из UI (передан ev) —
  // программные вызовы (например, из resetManualForm) проходят без диалога.
  async clearCaseFile(which, ev) {
    if (ev) {
      ev.stopPropagation();
      const label = which === 'zayavka' ? 'Заявка' : 'История убытков';
      const ok = await App.confirmDialog({
        title: `Удалить файл «${label}»?`,
        text: 'Связанные данные (превью, аналитика) будут сброшены — файл придётся загрузить заново.',
        confirmLabel: 'Удалить',
      });
      if (!ok) return;
    }
    if (which === 'zayavka') {
      App.zayavka = null;
      App.statgov = null;
      App.binData = { legalAddress: null, govParticipation: null };
      const zoneZ = document.getElementById('zone-zayavka');
      if (zoneZ) zoneZ.classList.remove('loaded');
      document.getElementById('status-zayavka').textContent = 'Загрузите .xlsm файл';
      document.querySelectorAll('.js-preview-panel').forEach(p => p.classList.remove('visible'));
    } else if (which === 'claims') {
      App.claims = null;
      const zoneC = document.getElementById('zone-claims');
      if (zoneC) zoneC.classList.remove('loaded');
      document.getElementById('status-claims').textContent = 'Загрузите .xls файл';
      document.getElementById('analytics-cta')?.classList.remove('visible');
      document.getElementById('analytics-inline')?.classList.remove('is-open');
      document.body.classList.remove('inline-analytics-open');
    }
    App._persistCase();
    // При удалении файла кейса (заявка/история) тоже надо прокатить
    // полную цепочку — иначе превью и аналитика остаются с данными
    // от ушедшего файла.
    App._refreshDerivedData();
    App.showMsg('Файл удалён.', 'success');
  },

  // ===== CASE-FILE PERSISTENCE =====
  // Save parsed case data so navigation (e.g. "Назад к форме" from analytics) doesn't lose state.
  _persistCase() {
    try {
      const payload = {
        zayavka: App.zayavka ? App._zayavkaToJson(App.zayavka) : null,
        claims: App.claims || null,
        binData: App.binData || null,
        fileNames: {
          zayavka: document.getElementById('status-zayavka')?.textContent || '',
          claims: document.getElementById('status-claims')?.textContent || '',
        },
        savedAt: new Date().toISOString(),
      };
      localStorage.setItem('case_state', JSON.stringify(payload));
    } catch (e) { console.warn('Persist case failed:', e); }
  },
  _zayavkaToJson(z) {
    // _noClaimsAck — транзиентное подтверждение алерта (по сессии), НЕ персистим:
    // после перезагрузки напоминание о незагруженных «Страховых случаях» должно
    // появиться снова (иначе оно бы показывалось ровно один раз за всё время).
    const { _noClaimsAck, ...rest } = z;
    return {
      ...rest,
      docDate: z.docDate ? new Date(z.docDate).toISOString() : null,
      periodFrom: z.periodFrom ? new Date(z.periodFrom).toISOString() : null,
      periodTo: z.periodTo ? new Date(z.periodTo).toISOString() : null,
    };
  },
  _restoreCase() {
    const raw = localStorage.getItem('case_state');
    if (!raw) return;
    try {
      const p = JSON.parse(raw);
      if (p.zayavka) {
        App.zayavka = {
          ...p.zayavka,
          docDate: p.zayavka.docDate ? new Date(p.zayavka.docDate) : null,
          periodFrom: p.zayavka.periodFrom ? new Date(p.zayavka.periodFrom) : null,
          periodTo: p.zayavka.periodTo ? new Date(p.zayavka.periodTo) : null,
        };
        const zoneZ = document.getElementById('zone-zayavka');
        // Кейс из реестра не помечаем зелёным — файл заявки не прикреплялся
        // (зелёным/«loaded» помечаем только реальный файл заявки или ручной ввод).
        if (zoneZ && !App.zayavka._fromRegistry) zoneZ.classList.add('loaded');
        const statusZ = document.getElementById('status-zayavka');
        if (statusZ && p.fileNames?.zayavka) statusZ.textContent = p.fileNames.zayavka.replace(/\s*\(из кэша\)$/, '');
      }
      if (p.claims) {
        App.claims = p.claims;
        const zoneC = document.getElementById('zone-claims');
        if (zoneC) zoneC.classList.add('loaded');
        const statusC = document.getElementById('status-claims');
        if (statusC && p.fileNames?.claims) {
          // Очистим хвосты «(из кэша)» и «(N НС за 3 года)», пересоберём текст
          const baseName = p.fileNames.claims
            .replace(/\s*\(из кэша\)$/, '')
            .replace(/\s*\(\d+\s*НС\s*за\s*\d+\s*года?\)\s*$/i, '');
          const total = App.claims?.totalClaims || 0;
          statusC.textContent = `${baseName} (${total} НС за 3 года)`.trim();
        }
        document.getElementById('analytics-cta')?.classList.add('visible');
      }
      if (p.binData) App.binData = p.binData;
      if (App.zayavka) {
        App._fillDateInputs();
        // Восстановить значения в форме ручного ввода, если кейс был создан вручную
        if (App.zayavka._manual) {
          const binEl = document.getElementById('manualBin');
          const wEl = document.getElementById('manualWorkers');
          const fEl = document.getElementById('manualFot');
          const aEl = document.getElementById('manualAvgSalary');
          const dEl = document.getElementById('manualDocDate');
          if (binEl) binEl.value = App.zayavka.bin || '';
          if (wEl) wEl.value = App.zayavka.workers || '';
          const fotVal = App.zayavka.fot != null ? App.zayavka.fot : App.zayavka.insuranceSum;
          if (fEl) fEl.value = fotVal != null ? App._formatMoney(fotVal) : '';
          if (aEl) aEl.value = App.zayavka.avgSalary != null ? App._formatMoney(App.zayavka.avgSalary) : '';
          if (dEl) dEl.value = App.zayavka.docDate ? App._dateToInputValue(App.zayavka.docDate) : '';
          // Восстановить блок страховых случаев (галочка + количество).
          const chkEl = document.getElementById('manualHasClaims');
          const cntEl = document.getElementById('manualClaimsCount');
          const hasClaims = App.zayavka._manualHasClaims !== false; // умолчание — ВКЛ
          if (chkEl) chkEl.checked = hasClaims;
          if (cntEl) cntEl.value = (hasClaims && App.zayavka._manualClaimsCount) ? String(App.zayavka._manualClaimsCount) : '';
          App.onManualClaimsToggle();
          App._manualPrimary = App.zayavka._manualPrimary || 'fot';
          App._syncManualFields();
          App._updateManualHint();
        }
        App.showPreview();
        // Если БИН уже известен — попытаться (фоном) перезагрузить statgov из расширения.
        if (App.zayavka.bin) App.autoLookupStatGov(App.zayavka.bin);
        // Пересчёт премии для manual режима (тариф мог измениться в справочниках)
        App._recalcManualPremium();
      }
    } catch (e) { console.warn('Restore case failed:', e); }
  },
  // «Очистить кейс» — удаляет заявку и историю убытков разом. С подтверждением.
  async clearCaseCache() {
    const ok = await App.confirmDialog({
      title: 'Очистить файлы кейса?',
      text: 'Заявка и история убытков будут удалены, превью и аналитика — сброшены.',
      confirmLabel: 'Очистить',
    });
    if (!ok) return;
    localStorage.removeItem('case_state');
    App.zayavka = null;
    App.claims = null;
    App.binData = { legalAddress: null, govParticipation: null };
    const zZ = document.getElementById('zone-zayavka');
    const zC = document.getElementById('zone-claims');
    if (zZ) zZ.classList.remove('loaded');
    if (zC) zC.classList.remove('loaded');
    document.getElementById('status-zayavka').textContent = 'Загрузите .xlsm файл';
    document.getElementById('status-claims').textContent = 'Загрузите .xls файл';
    document.getElementById('analytics-cta')?.classList.remove('visible');
    document.getElementById('analytics-inline')?.classList.remove('is-open');
    document.body.classList.remove('inline-analytics-open');
    document.querySelectorAll('.js-preview-panel').forEach(p => p.classList.remove('visible'));
    App._refreshDerivedData();
    App.showMsg('Файлы кейса очищены.', 'success');
  },

  // ===== ZAYAVKA LOADING =====
  async loadZayavka(file) {
    if (!file) return;
    try {
      const buf = await App._readFile(file);
      // Сбрасываем форму перед загрузкой новой зайавки — чтобы вердикт, описание,
      // нерезидент, способ оплаты и др. не «утекали» с предыдущего кейса.
      App._resetFormState();
      App.zayavka = ExcelReader.readZayavka(buf);

      // Период страхования всегда: F3 + 1 день → F3 + 1 год.
      // Продукт ОСНС заключается строго на год; E21/G21 в заявке менеджеры
      // часто не заполняют — игнорируем и считаем от даты подачи заявления.
      if (App.zayavka.docDate) {
        const { from, to } = App._computePeriodFromDocDate(App.zayavka.docDate);
        App.zayavka.periodFrom = from;
        App.zayavka.periodTo = to;
      }

      // Заполняем UI-инпуты вычисленными датами (пользователь может изменить).
      App._fillDateInputs();

      // Update normativ with contract date (теперь всегда есть, если F3 заполнен)
      const effectiveDate = App.zayavka.periodFrom || App.zayavka.docDate;
      if (App._rawNormativBuffer && effectiveDate) {
        App.refData.normativ = ExcelReader.readNormativ(App._rawNormativBuffer, effectiveDate);
        App._applyRefOverrides('normativ');
      }

      // Auto-lookup BIN for address and gov participation
      if (App.zayavka.bin) {
        App.autoLookupBIN(App.zayavka.bin);
        App.autoLookupStatGov(App.zayavka.bin);
        // statsnet — отдельно, дольше (открывает background-вкладки)
        App.autoLookupStatsnet(App.zayavka.bin);
      }

      // Show preview
      App.showPreview();

      // Refresh ОКЭД hint with the value loaded from zayavka
      App.onOkedChange();

      // Sync payment order from zayavka D19 → form dropdown
      const poSelect = document.getElementById('paymentOrder');
      if (poSelect && App.zayavka.paymentOrder) {
        const raw = String(App.zayavka.paymentOrder).trim();
        if (/рассроч/i.test(raw)) {
          poSelect.value = 'В рассрочку';
        } else {
          poSelect.value = 'Единовременно';
        }
        App.onPaymentChange();
      }

      // Update upload status
      const zone = document.getElementById('zone-zayavka');
      zone.classList.add('loaded');
      document.getElementById('status-zayavka').textContent = `${file.name}`;

      App._persistCase();
      // Прогон зависимостей: превью, бейджи, verdict-hint, snapshot аналитики,
      // перезагрузка inline-iframe аналитики (если открыт). Не вызывать
      // отдельные шаги — иначе аналитика остаётся «застывшей» от предыдущего
      // кейса.
      App._refreshDerivedData();
    } catch (e) {
      console.error('Error loading zayavka:', e);
      App.showMsg(`Ошибка загрузки заявки: ${e.message}`, 'error');
    }
  },

  // ===== MANUAL ZAYAVKA INPUT (без файла) =====
  // Пользователь вводит БИН + кол-во работников + ФОТ годовой ИЛИ среднюю ЗП.
  // Из БИНа автоподтягиваются: наименование, ОКЭДы, КРП, КФС, КАТО, адрес, гос.участие.
  // ОКЭД → класс риска → тариф → премия = ФОТ × тариф.

  // Какое из двух полей (fot|avg) ввёл пользователь — определяет, какое второе
  // блокируется и заполняется посчитанным значением. null = оба пустые.
  _manualPrimary: null,

  // Округление до 2 знаков (тиыны) без float-noise. Возвращает Number.
  _round2(x) {
    if (!Number.isFinite(x)) return x;
    return Math.round(x * 100) / 100;
  },

  // Парсит ввод денежной суммы. Принимает "1 234 567,89", "1234567.89", "1234567" и т.п.
  // Пробелы (включая  ), запятая как десятичный разделитель допустимы.
  _parseMoney(s) {
    if (s == null) return NaN;
    const t = String(s).replace(/\s/g, '').replace(/[ ]/g, '').replace(',', '.').replace(/[^\d.\-]/g, '');
    if (!t) return NaN;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  },

  // Форматирует число → "1 234 567,89" (русская локаль, две дроби).
  _formatMoney(n) {
    if (!Number.isFinite(n)) return '';
    return App._round2(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  // Форматирование Number для подстановки в money-input (text-input): "1 234 567,89"
  _toInputNumber(x) {
    if (!Number.isFinite(x)) return '';
    return App._formatMoney(x);
  },

  // Чтение money-input с парсингом
  _readMoneyInput(id) {
    const el = document.getElementById(id);
    if (!el) return NaN;
    return App._parseMoney(el.value);
  },

  // Форматирование на blur — переписывает значение в "1 234 567,89"
  onManualMoneyBlur(field) {
    const id = field === 'fot' ? 'manualFot' : 'manualAvgSalary';
    const el = document.getElementById(id);
    if (!el || el.disabled) return;
    const num = App._parseMoney(el.value);
    if (Number.isFinite(num) && num > 0) {
      el.value = App._formatMoney(num);
    } else if (el.value.trim() === '') {
      // Пусто — оставляем
    }
  },

  // Сброс всех полей ручного ввода + очистка zayavka, если он был manual
  resetManualForm() {
    const ids = ['manualBin', 'manualDocDate', 'manualWorkers', 'manualFot', 'manualAvgSalary'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) { el.value = ''; el.disabled = false; } });
    const tagF = document.getElementById('tag-fot');
    const tagA = document.getElementById('tag-avg');
    if (tagF) tagF.style.display = 'none';
    if (tagA) tagA.style.display = 'none';
    App._manualPrimary = null;
    // Если активная зайавка была manual — снимаем её
    if (App.zayavka && App.zayavka._manual) {
      App.clearCaseFile('zayavka');
    }
    // Сброс блока страховых случаев: галочка ВКЛ (по умолчанию), поле пустое.
    const chk = document.getElementById('manualHasClaims');
    if (chk) chk.checked = true;
    const cnt = document.getElementById('manualClaimsCount');
    if (cnt) cnt.value = '';
    App.onManualClaimsToggle();
    App._updateManualHint();
    App.showMsg('Поля ручного ввода очищены.', 'success');
  },

  // Галочка «Были страховые случаи» в ручном вводе: ВКЛ — показываем поле
  // количества НС; ВЫКЛ — НС не было (поле скрыто). Значение читается на «Применить».
  onManualClaimsToggle() {
    const chk = document.getElementById('manualHasClaims');
    const wrap = document.getElementById('manual-claims-count-wrap');
    const lbl = document.getElementById('manualClaimsLabel');
    const on = !!(chk && chk.checked);
    if (wrap) wrap.style.display = on ? '' : 'none';
    // Подпись отражает состояние: ВКЛ — «Были …», ВЫКЛ — «Не было …».
    if (lbl) lbl.textContent = on ? 'Были страховые случаи (НС)' : 'Не было страховых случаев';
  },

  // Эффективное количество НС за 3 года: из загруженного файла истории убытков,
  // иначе — из ручного ввода (z._manualClaimsCount). 0, если данных нет.
  _effectiveClaimsCount(z) {
    if (App.claims) return App.claims.totalClaims || 0;
    const zz = z || App.zayavka;
    return (zz && zz._manualClaimsCount != null) ? zz._manualClaimsCount : 0;
  },

  // Главный обработчик input для полей ручного ввода.
  // source: 'bin' | 'workers' | 'fot' | 'avg' | 'date' — кто триггернул событие.
  onManualInput(source) {
    const fotEl = document.getElementById('manualFot');
    const avgEl = document.getElementById('manualAvgSalary');
    const wEl = document.getElementById('manualWorkers');
    if (!fotEl || !avgEl || !wEl) return;

    // Смена БИН — потенциально новая компания: переспрашиваем про страховые
    // случаи заново (возвращаем галочку к умолчанию «Были НС» и снимаем
    // подтверждение «НС не было», чтобы напоминание/ворота переоценились).
    if (source === 'bin') {
      const chk = document.getElementById('manualHasClaims');
      if (chk && !chk.checked) {
        chk.checked = true;
        const cnt = document.getElementById('manualClaimsCount');
        if (cnt) cnt.value = '';
        App.onManualClaimsToggle();
      }
      if (App.zayavka && App.zayavka._noClaimsAck) {
        App.zayavka._noClaimsAck = false;
        App._updateClaimsNotLoadedAlert();
        App.updateButtons();
      }
    }

    // Определить primary, исходя из событий пользователя
    if (source === 'fot') {
      const v = App._parseMoney(fotEl.value);
      App._manualPrimary = (fotEl.value.trim() !== '' && Number.isFinite(v) && v > 0) ? 'fot' : null;
    } else if (source === 'avg') {
      const v = App._parseMoney(avgEl.value);
      App._manualPrimary = (avgEl.value.trim() !== '' && Number.isFinite(v) && v > 0) ? 'avg' : null;
    }
    // Если очистили primary — снять primary, разблокировать оба и очистить второе
    if (App._manualPrimary === null && (source === 'fot' || source === 'avg')) {
      fotEl.disabled = false; avgEl.disabled = false;
      const tagF = document.getElementById('tag-fot');
      const tagA = document.getElementById('tag-avg');
      if (tagF) tagF.style.display = 'none';
      if (tagA) tagA.style.display = 'none';
      if (source === 'fot') avgEl.value = '';
      if (source === 'avg') fotEl.value = '';
    }
    App._syncManualFields();
    App._updateManualHint();
  },

  // Применяет правила mutual-exclusive: блокирует второе поле, выставляет
  // посчитанное значение если доступны workers.
  _syncManualFields() {
    const fotEl = document.getElementById('manualFot');
    const avgEl = document.getElementById('manualAvgSalary');
    const wEl = document.getElementById('manualWorkers');
    const tagF = document.getElementById('tag-fot');
    const tagA = document.getElementById('tag-avg');
    if (!fotEl || !avgEl || !wEl) return;

    const workers = Number(wEl.value);
    const okWorkers = Number.isFinite(workers) && workers > 0;
    const fotVal = App._parseMoney(fotEl.value);
    const avgVal = App._parseMoney(avgEl.value);

    // Сброс подписей на «посчитано» (раньше для аффилированных была «фикс. 85 000»)
    if (tagA) tagA.textContent = 'посчитано';
    if (tagF) tagF.textContent = 'посчитано';

    if (App._manualPrimary === 'fot' && Number.isFinite(fotVal) && fotVal > 0) {
      avgEl.disabled = true;
      fotEl.disabled = false;
      if (tagF) tagF.style.display = 'none';
      if (okWorkers) {
        avgEl.value = App._formatMoney(fotVal / workers / 12);
        if (tagA) tagA.style.display = '';
      } else {
        avgEl.value = '';
        if (tagA) tagA.style.display = 'none';
      }
    } else if (App._manualPrimary === 'avg' && Number.isFinite(avgVal) && avgVal > 0) {
      fotEl.disabled = true;
      avgEl.disabled = false;
      if (tagA) tagA.style.display = 'none';
      if (okWorkers) {
        fotEl.value = App._formatMoney(avgVal * workers * 12);
        if (tagF) tagF.style.display = '';
      } else {
        fotEl.value = '';
        if (tagF) tagF.style.display = 'none';
      }
    } else {
      // Нет primary — оба активны и без меток
      fotEl.disabled = false;
      avgEl.disabled = false;
      if (tagF) tagF.style.display = 'none';
      if (tagA) tagA.style.display = 'none';
    }
  },

  // Обновляет нижнюю подсказку (зелёная/красная/нейтральная).
  // Для аффилированных лиц — другая подсказка: фикс. ставка, пакет СД.
  _updateManualHint() {
    const hint = document.getElementById('manual-hint');
    if (!hint) return;
    const bin = (document.getElementById('manualBin')?.value || '').trim();
    const cleanBin = bin.replace(/\s+/g, '');
    const workers = Number(document.getElementById('manualWorkers')?.value);
    const fot = App._readMoneyInput('manualFot');
    const avg = App._readMoneyInput('manualAvgSalary');
    const okBin = /^\d{12}$/.test(cleanBin);
    const okWorkers = Number.isFinite(workers) && workers > 0;
    const hasFot = Number.isFinite(fot) && fot > 0;
    const hasAvg = Number.isFinite(avg) && avg > 0;
    const primary = App._manualPrimary;
    const aff = okBin ? App._isAffiliatedBin(cleanBin) : null;

    let msg = '';
    let cls = '';

    // Success-сообщение «Готово к применению: ФОТ = …» убрано — оно избыточно,
    // т.к. рассчитанные значения уже видны в полях ФОТ/ср.ЗП. Оставляем только
    // ошибки (что не хватает) и note про аффилированность.
    const effFot = primary === 'fot' ? fot : (primary === 'avg' && okWorkers ? avg * workers * 12 : (hasFot ? fot : (hasAvg && okWorkers ? avg * workers * 12 : 0)));
    if (okBin && okWorkers && effFot > 0) {
      if (aff) {
        msg = `⚠ Аффилированное лицо «${aff.name || cleanBin}» — пакет документов будет СД (АР · Заключение · СЗ на Правление · СЗ на СД).`;
        cls = 'manual-input-hint--ok';
      } else {
        msg = '';
        cls = '';
      }
    } else {
      // Подсказку «Не хватает: …» показываем только если оператор уже начал
      // заполнять форму (хотя бы одно поле). На пустой форме — ничего не выводим.
      const anyInput = !!bin
        || !!(document.getElementById('manualWorkers')?.value || '').trim()
        || !!(document.getElementById('manualFot')?.value || '').trim()
        || !!(document.getElementById('manualAvgSalary')?.value || '').trim();
      const missing = [];
      if (!okBin) missing.push(bin ? 'БИН должен быть 12 цифр' : 'БИН');
      if (!okWorkers) missing.push('кол-во работников > 0');
      if (!hasFot && !hasAvg) missing.push('ФОТ или средняя ЗП');
      if (anyInput && missing.length) {
        msg = 'Не хватает: ' + missing.join(', ') + '.';
        cls = 'manual-input-hint--err';
      }
    }

    hint.textContent = msg;
    hint.classList.remove('manual-input-hint--ok', 'manual-input-hint--err');
    if (cls) hint.classList.add(cls);
  },

  // ===== БЫСТРАЯ ПРОВЕРКА ПО БИН/ИИН =====
  // Запускает три параллельные проверки в реестрах (БИН-лукап адреса /
  // stat.gov.kz / гос. участие через e-qazyna) без расчёта тарифа.
  // Результаты выводятся в стандартную панель «Полный профиль компании»
  // (#preview-panel) — ту же, что и при полном вводе, чтобы не дублировать
  // данные отдельной карточкой. Для этого создаётся «лёгкая» зайавка с
  // флагом _lookupOnly (без работников/ФОТ/премии); doc-кнопки для неё
  // остаются выключенными (см. updateButtons / updateVerdictHint).
  async quickLookupByBin() {
    // Поле БИН живёт в разделе «Проверка контрагента» (#contractorBin).
    const binEl = document.getElementById('contractorBin');
    const bin = (binEl?.value || '').trim().replace(/\s+/g, '');
    if (!/^\d{12}$/.test(bin)) {
      App.showMsg('Введите БИН/ИИН (12 цифр) для проверки.', 'error');
      binEl?.focus();
      return;
    }
    // Лёгкая зайавка только для проверки. docDate = сегодня, чтобы возраст
    // компании в алерте «молодая компания» считался на текущую дату.
    App.zayavka = {
      bin,
      _manual: true,
      _lookupOnly: true,
      workers: null,
      insuranceSum: null,
      premiumBase: null,
      premiumWithCoeff: null,
      coeffDown: 0,
      coeff: 1,
      docDate: new Date(),
    };
    App.binData = { legalAddress: null, govParticipation: null, loading: true };
    App.statgov = { loading: true, found: null };
    // Первый рендер: панель «Полный профиль компании» с «(поиск...)».
    App._refreshDerivedData();
    App.showMsg(`Проверяем БИН ${bin} в реестрах…`, 'success');
    // Параллельные проверки. Каждая по готовности сама дёргает showPreview;
    // финальный _refreshDerivedData ниже — чтобы всё сошлось (адрес, гос.
    // участие, ОКЭДы, класс риска, алерт молодой компании).
    await Promise.allSettled([
      App.autoLookupBIN(bin),
      App.autoLookupStatGov(bin),
      App.autoLookupStatsnet(bin),
    ]);
    App._refreshDerivedData();
  },

  applyManualZayavka() {
    const bin = (document.getElementById('manualBin')?.value || '').trim().replace(/\s+/g, '');
    const workersStr = document.getElementById('manualWorkers')?.value;
    const dateStr = document.getElementById('manualDocDate')?.value || '';
    // Страховые случаи: галочка ВКЛ → берём введённое количество; ВЫКЛ → НС не было (0).
    const hasClaimsEl = document.getElementById('manualHasClaims');
    const claimsCntEl = document.getElementById('manualClaimsCount');
    const manualHasClaims = hasClaimsEl ? hasClaimsEl.checked : true;
    const manualClaimsCount = manualHasClaims
      ? Math.max(0, Math.round(Number(claimsCntEl?.value) || 0))
      : 0;

    if (!/^\d{12}$/.test(bin)) {
      App.showMsg('Введите корректный БИН (12 цифр).', 'error');
      return;
    }
    const workers = Number(workersStr);
    if (!Number.isFinite(workers) || workers <= 0) {
      App.showMsg('Введите количество работников (целое число > 0).', 'error');
      return;
    }
    // ФОТ и avg — точная арифметика без округления до целых.
    // Тиыны (2 знака после запятой) сохраняются для всех денежных полей.
    // Для аффилированных лиц особой логики нет — премию вводит пользователь
    // как обычно. Меняется только пакет документов (см. _effectiveFinancials).
    const fotRaw = App._readMoneyInput('manualFot');
    const avgRaw = App._readMoneyInput('manualAvgSalary');
    const primary = App._manualPrimary; // 'fot' | 'avg' | null
    let fot;
    let avgSalary = null;
    if (primary === 'avg') {
      if (!Number.isFinite(avgRaw) || avgRaw <= 0) {
        App.showMsg('Введите среднюю зарплату > 0.', 'error');
        return;
      }
      avgSalary = App._round2(avgRaw);
      fot = App._round2(avgSalary * workers * 12);
    } else {
      // primary='fot' или null — приоритет полю ФОТ
      if (!Number.isFinite(fotRaw) || fotRaw <= 0) {
        if (Number.isFinite(avgRaw) && avgRaw > 0) {
          avgSalary = App._round2(avgRaw);
          fot = App._round2(avgSalary * workers * 12);
        } else {
          App.showMsg('Заполните ФОТ годовой или среднюю зарплату.', 'error');
          return;
        }
      } else {
        fot = App._round2(fotRaw);
        // Производная средняя ЗП (для отображения и аналитики)
        avgSalary = App._round2(fot / workers / 12);
      }
    }

    // Дата заявки — из поля или сегодня. Парсим yyyy-mm-dd как локальную дату.
    let docDate;
    if (dateStr) {
      const [yy, mm, dd] = dateStr.split('-').map(Number);
      if (yy && mm && dd) docDate = new Date(yy, mm - 1, dd);
    }
    if (!docDate || isNaN(docDate)) docDate = new Date();
    const { from, to } = App._computePeriodFromDocDate(docDate);

    App.zayavka = {
      _manual: true,
      _manualPrimary: primary, // запомнить, чтобы корректно восстановить на reload
      // Имя подтянется из statgov (autoLookupStatGov ниже). До этого момента — пусто.
      insurerName: '',
      bin,
      region: '',
      docDate,
      insuranceType: Utils.INSURANCE_TYPE,
      activity: '',
      riskClass: null,
      tariff: null,
      insuranceSum: fot, // с тиынами
      workers: Math.round(workers),
      coeff: 1,
      coeffDown: 0,
      premiumBase: null,
      premiumWithCoeff: null,
      paymentOrder: 'Единовременно',
      govParticipation: '',
      periodFrom: from,
      periodTo: to,
      oked: '',
      // Доп. поля — для UI/аналитики, не используются напрямую генераторами
      fot: fot,
      avgSalary: avgSalary,
      // Страховые случаи из ручного ввода (нет файла истории убытков): влияет на
      // авто-скидку (есть НС → скидки нет) и снимает «ворота» генерации пакета.
      _manualHasClaims: manualHasClaims,
      _manualClaimsCount: manualClaimsCount,
    };

    // Пересчитать норматив на дату договора (если справочник загружен)
    if (App._rawNormativBuffer) {
      App.refData.normativ = ExcelReader.readNormativ(App._rawNormativBuffer, from);
      App._applyRefOverrides('normativ');
    }

    // Подставить даты в инпуты периода страхования
    App._fillDateInputs();

    // Сбросить состояние формы предыдущего кейса (вердикт, описание, нерезидент и пр.).
    // Делаем ПОСЛЕ присвоения App.zayavka, чтобы _resetFormState мог пересчитать
    // период из новой docDate.
    App._resetFormState();

    // Пометить «карточку заявки» как загруженную (ручной ввод тоже считается)
    const zone = document.getElementById('zone-zayavka');
    if (zone) zone.classList.add('loaded');
    const statusZ = document.getElementById('status-zayavka');
    if (statusZ) statusZ.textContent = `Ручной ввод — БИН ${bin}`;

    // Запустить автолукапы (БИН-Worker + stat.gov.kz + statsnet).
    // Эти вызовы async, но они сами синхронно вызывают showPreview/renderCompanyOkeds.
    App.autoLookupBIN(bin);
    App.autoLookupStatGov(bin);
    App.autoLookupStatsnet(bin);

    App._persistCase();
    // Единая точка обновления UI/превью/аналитики/snapshot — иначе при
    // ручном вводе данные у inline-iframe и снапшота остаются от предыдущего
    // кейса.
    App._refreshDerivedData();
    App.showMsg('Данные приняты. Идёт поиск по реестрам — премия пересчитается автоматически.', 'success');
  },

  // Пересчитывает тариф/премию для зайавки в ручном режиме.
  // Вызывается из onOkedChange (которая срабатывает после autoLookupStatGov,
  // загрузки classifier/popravka, и ручных изменений в #okedInput).
  // Методология: СС = ФОТ; премия = СС × тариф; если премия < 1 МЗП → СС = 1 МЗП /
  // тариф (премия = 1 МЗП). СС всегда пересчитываем ОТ ФОТ (z.fot), а не от уже
  // поднятой z.insuranceSum — иначе при смене тарифа сумма «съезжала» бы. Тиыны сохраняем.
  _recalcManualPremium() {
    const z = App.zayavka;
    if (!z || !z._manual) return;
    const resolved = App._resolveOked();
    const tariff = App._resolveTariff(resolved.riskClass);
    let changed = false;
    if (resolved.oked && z.oked !== resolved.oked) { z.oked = resolved.oked; changed = true; }
    if (resolved.riskClass != null && z.riskClass !== resolved.riskClass) { z.riskClass = resolved.riskClass; changed = true; }
    if (resolved.activity && z.activity !== resolved.activity) { z.activity = resolved.activity; changed = true; }
    const baseSum = (z.fot != null && Number.isFinite(z.fot)) ? z.fot : z.insuranceSum;
    if (Number.isFinite(tariff) && tariff > 0 && Number.isFinite(baseSum)) {
      const m = App._applyMinPremium(baseSum, tariff);
      const coeffEff = (z.coeffDown != null && z.coeffDown !== 0) ? (1 - z.coeffDown) : 1;
      const withCoeff = App._round2(m.premiumBase * (z.coeff || 1) * coeffEff);
      if (z.tariff !== tariff) { z.tariff = tariff; changed = true; }
      if (z.insuranceSum !== m.insuranceSum) { z.insuranceSum = m.insuranceSum; changed = true; }
      if (z.premiumBase !== m.premiumBase) { z.premiumBase = m.premiumBase; changed = true; }
      if (z.premiumWithCoeff !== withCoeff) { z.premiumWithCoeff = withCoeff; changed = true; }
    }
    if (changed) {
      App._persistCase();
      // Пересчитанная премия = меняется LR-warning в verdict-hint, обновляется
      // snapshot аналитики, перезагружается inline-iframe — нужно весь цепочку
      // прокатить, а не только showPreview/updateButtons.
      App._refreshDerivedData();
    }
  },

  // ===== CLAIMS LOADING =====
  async loadClaims(file) {
    if (!file) return;
    try {
      const buf = await App._readFile(file);
      App.claims = ExcelReader.readClaimsHistory(buf);

      const zone = document.getElementById('zone-claims');
      zone.classList.add('loaded');
      const cbin = App.claims.clientBin;
      const caseBin = App.zayavka && App.zayavka.bin;
      const mismatch = cbin && caseBin && cbin !== String(caseBin).trim();
      document.getElementById('status-claims').textContent =
        `${file.name} (${App.claims.totalClaims} НС за 3 года)${cbin ? ` — БИН ${cbin}` : ''}${mismatch ? ' ⚠ не совпадает с кейсом' : ''}`;
      if (mismatch) {
        App.showMsg(`Внимание: БИН в файле убытков (${cbin}) не совпадает с БИН кейса (${caseBin}). Возможно, загружен файл другой компании.`, 'error');
      }

      document.getElementById('analytics-cta').classList.add('visible');

      App._persistCase();
      // Полный re-render: превью с новой статистикой НС, verdict-hint
      // (LR-warning меняется при новых выплатах), пересчёт snapshot и
      // принудительная перезагрузка inline-iframe аналитики.
      App._refreshDerivedData();
    } catch (e) {
      console.error('Error loading claims:', e);
      App.showMsg(`Ошибка загрузки истории убытков: ${e.message}`, 'error');
    }
  },

  // ===== РЕЕСТР/ВЫГРУЗКА КАК ИСТОЧНИК КЕЙСА (третий блок «Файлы по кейсу») =====
  // Импорт выгрузки «АндерРешение»: парсим тем же BatchReader, даём выбрать компанию
  // (если строк несколько) и заполняем форму её значениями.
  async loadCaseRegistry(file) {
    if (!file) return;
    try {
      const buf = await App._readFile(file);
      const parsed = BatchReader.parse(buf);
      if (!parsed.rows || !parsed.rows.length) {
        App.showMsg('В выгрузке не найдено строк ОСНС с валидным БИН.', 'error');
        return;
      }
      App.caseRegistry = parsed;
      const zone = document.getElementById('zone-registry');
      if (zone) zone.classList.add('loaded');
      const st = document.getElementById('status-registry');
      if (st) st.textContent = `${file.name} (${parsed.rows.length} ${Utils.plural(parsed.rows.length, 'строка', 'строки', 'строк')})`;
      const filt = document.getElementById('registry-filter');
      if (filt) filt.value = '';
      App._renderRegistryPicker();
      const wrap = document.getElementById('registry-picker-wrap');
      if (wrap) wrap.style.display = parsed.rows.length > 1 ? '' : 'none';
      if (parsed.rows.length === 1) {
        App.applyRegistryRow(0);
      } else {
        App.showMsg(`Загружена выгрузка: ${parsed.rows.length} компаний. Выберите компанию в списке.`, 'success');
      }
    } catch (e) {
      console.error('registry load', e);
      App.showMsg('Не удалось прочитать выгрузку: ' + e.message, 'error');
    }
  },

  // Список компаний из реестра (с фильтром по БИН/названию). Кликабельные строки:
  // БИН + наименование + (регион · ФОТ). DOM-узлы (textContent) — без escape-проблем.
  _renderRegistryPicker() {
    const list = document.getElementById('registry-picker');
    const parsed = App.caseRegistry;
    if (!list || !parsed) return;
    const q = (document.getElementById('registry-filter')?.value || '').trim().toLowerCase();
    list.innerHTML = '';
    let shown = 0;
    parsed.rows.forEach((r, i) => {
      const bin = (r.binInsurer && /^\d{12}$/.test(r.binInsurer)) ? r.binInsurer : r.bin;
      const name = r.insurerNameSt || r.insurerName || '';
      if (q && !`${bin} ${name}`.toLowerCase().includes(q)) return;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'registry-list-item' + (String(i) === String(App._registrySelected) ? ' is-selected' : '');
      item.setAttribute('role', 'option');
      item.dataset.idx = String(i);
      item.onclick = () => App.applyRegistryRow(i);
      const binEl = document.createElement('span'); binEl.className = 'rli-bin'; binEl.textContent = bin || '—';
      const nameEl = document.createElement('span'); nameEl.className = 'rli-name'; nameEl.textContent = name || 'без названия';
      item.append(binEl, nameEl);
      const subParts = [];
      if (r.region) subParts.push(String(r.region));
      if (r.gfot != null && Number.isFinite(r.gfot)) subParts.push('ФОТ ' + App._formatMoney(r.gfot) + ' ₸');
      if (subParts.length) { const s = document.createElement('span'); s.className = 'rli-sub'; s.textContent = subParts.join(' · '); item.append(s); }
      list.appendChild(item);
      shown++;
    });
    if (!shown) {
      const empty = document.createElement('div');
      empty.className = 'registry-list-empty';
      empty.textContent = 'Ничего не найдено';
      list.appendChild(empty);
    }
    const countEl = document.getElementById('registry-count');
    if (countEl) countEl.textContent = q ? `(${shown} из ${parsed.rows.length})` : `(${parsed.rows.length})`;
  },

  // Заполнить форму кейса данными выбранной строки выгрузки.
  // БИН кейса — Страхователя (предмет андеррайтинга); премия/СС пересчитаются по
  // методологии из ФОТ (как в ручном вводе). Период и порядок оплаты — из выгрузки.
  applyRegistryRow(index) {
    const parsed = App.caseRegistry;
    const row = parsed && parsed.rows[Number(index)];
    if (!row) return;
    App._registrySelected = Number(index);
    const bin = (row.binInsurer && /^\d{12}$/.test(row.binInsurer)) ? row.binInsurer : row.bin;
    const insurerName = row.insurerNameSt || row.insurerName || '';
    const from = row.periodFrom || null;
    const to = row.periodTo || null;
    const docDate = from || row.dateContract || new Date();
    App.zayavka = {
      _manual: true, _manualPrimary: 'fot', _fromRegistry: true,
      insurerName, bin,
      region: row.region || '',
      docDate,
      insuranceType: Utils.INSURANCE_TYPE,
      activity: row.activity || '',
      riskClass: parseInt(row.riskClass, 10) || null,
      tariff: (row.tariff != null && Number.isFinite(row.tariff)) ? row.tariff : null,
      insuranceSum: row.insuranceSum,
      workers: row.workers,
      coeff: (row.coeff != null) ? row.coeff : 1,
      coeffDown: 0,
      premiumBase: row.premiumBase,
      premiumWithCoeff: row.premiumWithCoeff,
      paymentOrder: row.paymentOrder || 'Единовременно',
      // Реальные транши рассрочки из выгрузки (Этап{N}Дата/Сумма). Даты — ISO
      // строки, чтобы переживали сериализацию кейса в localStorage.
      tranchesFromFile: (row.tranches && row.tranches.length)
        ? row.tranches.map(t => ({ date: t.date ? t.date.toISOString() : null, amount: t.amount }))
        : null,
      govParticipation: row.govParticipation ? 'Да' : '',
      periodFrom: from, periodTo: to,
      oked: row.oked || '',
      fot: row.gfot,
      avgSalary: (row.gfot && row.workers) ? App._round2(row.gfot / row.workers / 12) : null,
      _manualHasClaims: null, _manualClaimsCount: null,
      // Контрагент — справочно (документ/возраст идут по Страхователю).
      binContragent: row.bin,
      insurerNameContragent: row.insurerName,
    };
    // Сброс состояния формы (после присвоения zayavka — как в applyManualZayavka).
    App._resetFormState();
    // Период — из выгрузки (V/W), а не пересчитанный из docDate.
    if (from) App.zayavka.periodFrom = from;
    if (to) App.zayavka.periodTo = to;
    const okedEl = document.getElementById('okedInput');
    if (okedEl) okedEl.value = row.oked || '';
    App._fillDateInputs();
    const poSelect = document.getElementById('paymentOrder');
    if (poSelect) poSelect.value = /рассроч/i.test(row.paymentOrder || '') ? 'В рассрочку' : 'Единовременно';
    if (App._rawNormativBuffer) {
      App.refData.normativ = ExcelReader.readNormativ(App._rawNormativBuffer, App.zayavka.periodFrom || docDate);
      App._applyRefOverrides('normativ');
    }
    if (bin) { App.autoLookupBIN(bin); App.autoLookupStatGov(bin); App.autoLookupStatsnet(bin); }
    App.onOkedChange();
    App.onPaymentChange();
    // Показать выбранную компанию в форме ручного ввода (данные из реестра) — чтобы
    // было видно, по кому принимается решение, и значения можно было поправить.
    App._fillManualFromZayavka();
    // Источник кейса — реестр, а НЕ файл заявки: карточку «Заявка на андеррайтинг»
    // зелёной («loaded») НЕ помечаем — файл заявки не прикреплялся.
    App._setZayavkaRegistrySource();
    // Подсветить выбранную строку в списке реестра.
    const listEl = document.getElementById('registry-picker');
    if (listEl) listEl.querySelectorAll('.registry-list-item').forEach(el => el.classList.toggle('is-selected', el.dataset.idx === String(index)));
    App._persistCase();
    App._refreshDerivedData();
    App.showMsg(`Загружено из реестра: ${insurerName || bin}. Загрузите файл убытков — он сопоставится по БИН.`, 'success');
  },

  // Заполнить поля формы ручного ввода из текущей App.zayavka (БИН/дата/работники/ФОТ/ЗП).
  _fillManualFromZayavka() {
    const z = App.zayavka; if (!z) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    set('manualBin', z.bin || '');
    set('manualWorkers', z.workers != null ? z.workers : '');
    const fotVal = (z.fot != null) ? z.fot : z.insuranceSum;
    set('manualFot', fotVal != null ? App._formatMoney(fotVal) : '');
    set('manualAvgSalary', z.avgSalary != null ? App._formatMoney(z.avgSalary) : '');
    set('manualDocDate', z.docDate ? App._dateToInputValue(z.docDate) : '');
    App._manualPrimary = z._manualPrimary || 'fot';
    App._syncManualFields && App._syncManualFields();
    App._updateManualHint && App._updateManualHint();
  },

  // Карточка «Заявка» при источнике-реестре: НЕ зелёная (файл не прикреплялся),
  // нейтральный поясняющий статус.
  _setZayavkaRegistrySource() {
    const zone = document.getElementById('zone-zayavka');
    if (zone) zone.classList.remove('loaded');
    const st = document.getElementById('status-zayavka');
    if (st) st.textContent = 'Не требуется — данные из реестра';
  },

  clearCaseRegistry(event) {
    if (event) event.stopPropagation();
    App.caseRegistry = null;
    App._registrySelected = null;
    const zone = document.getElementById('zone-registry');
    if (zone) zone.classList.remove('loaded');
    const st = document.getElementById('status-registry');
    if (st) st.textContent = 'Загрузите .xlsx выгрузку';
    const wrap = document.getElementById('registry-picker-wrap');
    if (wrap) wrap.style.display = 'none';
    const sel = document.getElementById('registry-picker');
    if (sel) sel.innerHTML = '';
    const filt = document.getElementById('registry-filter');
    if (filt) filt.value = '';
  },

  // ===== PREVIEW =====
  showPreview() {
    const z = App.zayavka;
    if (!z) return;
    // Профиль компании рендерится в обе вкладки сразу (раздел «Проверка
    // контрагента» и раздел «Андеррайтинговое решение») — broadcast по классу.
    const panels = document.querySelectorAll('.js-preview-panel');
    const grids = document.querySelectorAll('.js-preview-grid');
    if (!grids.length) return;

    const resolved = App._resolveOked();

    // === Источник истины: stat.gov.kz (если доступен), иначе — заявка ===
    const sg = (App.statgov && !App.statgov.loading && !App.statgov.error && App.statgov.found !== false)
      ? App.statgov : null;

    // Активные значения для документов (через _resolveOked)
    const effOked = resolved.oked || z.oked || '';
    const effClass = resolved.riskClass || z.riskClass;
    const effTariff = App._resolveTariff ? App._resolveTariff(effClass) : null;

    // Имя деятельности для активного ОКЭДа: если primary statgov — okedPrimaryName,
    // иначе из classifier через _collectCompanyOkeds
    let effActivityName = resolved.activity;
    if (sg && effOked === sg.okedPrimaryCode && sg.okedPrimaryName) {
      effActivityName = sg.okedPrimaryName;
    } else if (App._collectCompanyOkeds) {
      const co = App._collectCompanyOkeds().find(o => o.code === effOked);
      if (co && co.name) effActivityName = co.name;
    }

    // Эффективные финансы с учётом overrides (аффилирован, young, НС).
    const effFin = App._effectiveFinancials(z);
    const insurerName = sg?.name ? Utils.formatCompanyName(sg.name) : Utils.formatCompanyName(z.insurerName);

    // Сборка всех ОКЭДов компании (primary + secondary) с их названиями.
    const companyOkeds = App._collectCompanyOkeds ? App._collectCompanyOkeds() : [];
    let okedsBlockHtml = '';
    if (companyOkeds.length > 0) {
      okedsBlockHtml = companyOkeds.map(o => {
        const kindLabel = o.kind === 'primary' ? 'основной' : 'вторичный';
        const isActive = o.code === effOked;
        const activeBadge = isActive ? ' <span class="pi-active-badge">активный</span>' : '';
        // Класс и тариф per-OKED. Тариф — по классу из справочника (как «Страховой
        // тариф» в профиле), fallback на тариф из калькулятора.
        const okCls = (o.riskClass != null) ? o.riskClass : null;
        const okTar = (okCls != null && App._resolveTariff) ? App._resolveTariff(okCls) : null;
        const okTarVal = (okTar != null && !isNaN(okTar)) ? okTar : o.tariff;
        const classStr = okCls != null ? `кл. ${okCls}` : '<span class="muted">—</span>';
        const tariffStr = (okTarVal != null && !isNaN(okTarVal)) ? Utils.fmtPct(okTarVal) : '<span class="muted">—</span>';
        return `<div class="pi-oked-row${isActive ? ' pi-oked-row--active' : ''}">
          <span class="pi-oked-code">${o.code}</span>
          <span class="pi-oked-kind">(${kindLabel})${activeBadge}</span>
          <span class="pi-oked-class">${classStr}</span>
          <span class="pi-oked-tariff">${tariffStr}</span>
          <span class="pi-oked-name">${o.name || '<em class="muted">нет в классификаторе</em>'}</span>
        </div>`;
      }).join('');
    } else if (effOked) {
      const fbClassStr = effClass != null ? `кл. ${effClass}` : '<span class="muted">—</span>';
      const fbTariffStr = (effTariff != null && !isNaN(effTariff)) ? Utils.fmtPct(effTariff) : '<span class="muted">—</span>';
      okedsBlockHtml = `<div class="pi-oked-row pi-oked-row--active">
        <span class="pi-oked-code">${effOked}</span>
        <span class="pi-oked-kind">(активный)</span>
        <span class="pi-oked-class">${fbClassStr}</span>
        <span class="pi-oked-tariff">${fbTariffStr}</span>
        <span class="pi-oked-name">${effActivityName || '<em class="muted">—</em>'}</span>
      </div>`;
    }

    // НС: header + разбивка по годам в multi-line HTML формате.
    let nsHtml = 'НС не было';
    if (App.claims && App.claims.totalClaims > 0) {
      const total = App.claims.totalClaims;
      const byYear = App.claims.analytics?.byYear || [];
      const sumTotal = App.claims.analytics?.sumTotal3y || 0;
      const fmtTg = (v) => Utils.fmtMoney(v);
      const header = `За последние 3 года — <strong>${total} НС</strong> (сумма: ${fmtTg(sumTotal)})`;
      // Полный диапазон периода: "27.05.2023 — 26.05.2024" — чтобы сразу
      // было видно, из какой по какую дату посчитали 12-мес. период.
      // Fallback на короткий label, потом на год (для устаревшего кэша).
      const yearLines = byYear
        .sort((a, b) => a.year - b.year)
        .map(b => `<div class="pi-claims-year"><span class="pi-claims-year-num">${b.labelRange || b.label || b.year}:</span> ${b.cases} НС (${fmtTg(b.sum)})</div>`)
        .join('');
      nsHtml = `<div class="pi-claims-header">${header}</div>${yearLines}`;
    }

    // ========== ОСНОВНАЯ ИНФОРМАЦИЯ (всегда видна) ==========
    // Юридический адрес — ТОЛЬКО из stat.gov.kz (statgov). Без fallback на
    // pk.uchet.kz — это другой источник с другим форматом, и пользователь
    // хочет видеть только данные из официального реестра.
    const statgovLoading = App.statgov?.loading === true;
    const statgovDone = App.statgov && !App.statgov.loading;
    const legalAddress = sg?.legalAddress
      || (statgovLoading ? '(поиск в stat.gov.kz...)' : '—');
    // Гос. участие — статгов не отдаёт, единственный источник pk.uchet.kz worker.
    const binLoading = App.binData?.loading === true;
    const sgGov = App.binData.govParticipation || z.govParticipation
      || (binLoading ? '(поиск...)' : '—');
    const premiumWithCoeffDisplay = (effFin.noDiscountReason || !effFin.coeffDown || effFin.premiumWithCoeff === effFin.premiumBase)
      ? '—'
      : Utils.fmtMoney(effFin.premiumWithCoeff);

    const mainRows = [
      ['БИН', z.bin],
      ['Наименование', insurerName],
      sg?.registrationDate ? ['Дата регистрации', sg.registrationDate] : null,
      ['Юридический адрес', legalAddress],
      ['Гос. участие', sgGov],
      ['Класс риска', effClass || '—'],
      ['Страховой тариф', effTariff != null ? Utils.fmtPct(effTariff) : '—'],
      ['Страховая сумма', Utils.fmtMoney(effFin.insuranceSum)],
      ['Работники', Utils.fmtInteger(z.workers)],
      ['Страховая премия', Utils.fmtMoney(effFin.premiumBase)],
      ['Премия с поправкой', premiumWithCoeffDisplay],
      ['Регион', z.region || '—'],
      ['Период страхования', (z.periodFrom && z.periodTo)
        ? `${Utils.fmtDateShort(z.periodFrom)} — ${Utils.fmtDateShort(z.periodTo)}` : '—'],
      ['Порядок оплаты', z.paymentOrder || '—'],
      ['Страховые случаи', nsHtml],
    ].filter(Boolean);

    // ========== ПОДРОБНОСТИ (скрыты по умолчанию) ==========
    const detailRows = [];
    if (sg?.headFullname) detailRows.push(['ФИО руководителя', sg.headFullname]);
    if (sg?.kato) detailRows.push(['КАТО', sg.kato]);
    if (sg?.krpWithBranchesCode) detailRows.push(['Код КРП (с учётом филиалов)', sg.krpWithBranchesCode]);
    if (sg?.krpWithBranchesName) detailRows.push(['Наименование КРП (с учётом филиалов)', sg.krpWithBranchesName]);
    if (sg?.krpWithoutBranchesCode) detailRows.push(['Код КРП (без учёта филиалов)', sg.krpWithoutBranchesCode]);
    if (sg?.krpWithoutBranchesName) detailRows.push(['Наименование КРП (без учёта филиалов)', sg.krpWithoutBranchesName]);
    if (sg?.kfsCode) detailRows.push(['Код КФС', sg.kfsCode]);
    if (sg?.kfsName) detailRows.push(['Наименование КФС', sg.kfsName]);
    if (sg?.sectorCode) detailRows.push(['Код сектора экономики', sg.sectorCode]);
    if (sg?.sectorName) detailRows.push(['Наименование сектора экономики', sg.sectorName]);
    detailRows.push(['Дата заявки', z.docDate ? Utils.fmtDateShort(z.docDate) : '—']);

    const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    // Денежные поля — выделить моноширинным шрифтом
    const MONEY_FIELDS = new Set(['Страховая сумма', 'Страховая премия', 'Премия с поправкой']);
    // Длинные текстовые поля занимают всю ширину (избегаем колонок с переносами)
    const BIG_FIELDS = new Set(['Наименование', 'Юридический адрес', 'Страховые случаи',
      'Наименование КРП (с учётом филиалов)', 'Наименование КРП (без учёта филиалов)',
      'Наименование КФС', 'Наименование сектора экономики']);
    // SVG-иконка «copy» (двойные прямоугольники) — кладём inline для консистентности
    const COPY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    const renderItems = (rows) => rows.map(([l, v]) => {
      const display = (v == null || v === '') ? '—' : v;
      // Спец-кейс: «Страховые случаи» рендерится как HTML-блок (multi-line)
      // без кнопки копирования (она бы скопировала html-теги).
      if (l === 'Страховые случаи') {
        return `<div class="preview-item preview-item--big preview-item--claims">
          <span class="pi-label">${l}</span>
          <div class="pi-claims-block">${display}</div>
        </div>`;
      }
      const canCopy = display !== '—' && display !== '(поиск...)';
      const copyBtn = canCopy
        ? `<button class="pi-copy" title="Скопировать" onclick="App.copyToClipboard('${escAttr(display)}', this)">${COPY_ICON}</button>`
        : '';
      const cls = ['preview-item'];
      if (MONEY_FIELDS.has(l)) cls.push('preview-item--money');
      if (BIG_FIELDS.has(l)) cls.push('preview-item--big');
      return `<div class="${cls.join(' ')}">
        <span class="pi-label">${l}</span>
        <span class="pi-value-row">
          <span class="pi-value">${display}</span>
          ${copyBtn}
        </span>
      </div>`;
    }).join('');

    // Бейджи no-discount: остался только young_company (возраст компании
    // не виден в основной информации). «Скидка не применяется из-за НС» убрано —
    // эта инфа очевидна из блока «Страховые случаи».
    const badges = [];
    if (effFin.noDiscountReason === 'young_company') {
      badges.push(`<div class="pi-banner pi-banner--warn">⚠ Скидка не применяется: компания младше 3 лет (возраст ≈ ${effFin.ageYears.toFixed(1)} г.)</div>`);
    }

    // Статус-плашка stat.gov.kz (loading/error/not-found)
    let sgStatus = '';
    if (App.statgov?.loading) {
      sgStatus = `<div class="preview-section"><div class="pi-loading">Поиск в реестре stat.gov.kz…</div></div>`;
    } else if (App.statgov?.error) {
      sgStatus = `<div class="preview-section"><div class="pi-warn">⚠ ${App.statgov.error}</div>
        <div class="pi-hint">Установи расширение «Standard Life — мост к stat.gov.kz» и войди в кабинет через ЭЦП.</div></div>`;
    } else if (App.statgov?.found === false) {
      sgStatus = `<div class="preview-section"><div class="pi-warn">БИН ${App.statgov.bin || ''} не найден в реестре stat.gov.kz.</div></div>`;
    }

    // Состояние раскрытия только для «Подробностей» (ОКЭДы теперь всегда видны)
    const detailsOpen = localStorage.getItem('preview_details_open') === '1';

    // ОКЭДы и Подробности объединены в один сворачиваемый блок «Подробности»
    const okedsCount = companyOkeds.length || (effOked ? 1 : 0);
    const okedsSubBlock = `
      <div class="pi-subsection">
        <div class="pi-subsection-title">ОКЭДы и виды деятельности <span class="pi-count">${okedsCount}</span></div>
        ${okedsBlockHtml || '<div class="muted">— нет данных, загрузите заявку или подождите statgov</div>'}
      </div>`;
    const detailsSubBlock = detailRows.length ? `
      <div class="pi-subsection">
        <div class="pi-subsection-title">Реквизиты <span class="pi-count">${detailRows.length}</span></div>
        <div class="pi-subsection-grid">${renderItems(detailRows)}</div>
      </div>` : '';
    const collapsibleTotal = okedsCount + detailRows.length;

    const gridHtml =
      badges.join('') +
      `<div class="preview-section">
        <div class="preview-section-title">Основная информация</div>
        ${renderItems(mainRows)}
        ${okedsSubBlock}
      </div>` +
      (detailRows.length > 0 ? `<div class="preview-section preview-collapsible ${detailsOpen ? 'is-open' : ''}" id="preview-details-section">
        <div class="preview-section-title preview-section-title--clickable" onclick="App.togglePreviewDetails()">
          <span class="section-chevron">▸</span>
          Подробности (руководитель, КРП, КФС, КАТО, сектор, дата заявки)
          <span class="pi-count">${detailRows.length}</span>
        </div>
        <div class="preview-collapsible-body">
          ${detailsSubBlock}
        </div>
      </div>` : '') +
      sgStatus;

    grids.forEach(g => { g.innerHTML = gridHtml; });
    panels.forEach(p => { p.classList.add('visible'); });

    // ===== Фокусный профиль для вкладки «Проверка контрагента» =====
    // Только то, что нужно для проверки контрагента: БИН, наименование, юр. адрес,
    // дата регистрации, гос. участие, ОКЭДы, класс риска, тариф. Без премий,
    // работников, периода и НС — они тут не считаются (lookupOnly).
    const cGrid = document.getElementById('preview-grid-contractor');
    if (cGrid) {
      const regVal = sg?.registrationDate || (statgovLoading ? '(поиск...)' : '—');
      // Первая строка — компактная тройка: БИН · Дата регистрации · Гос. участие.
      const rowKey = renderItems([['БИН', z.bin], ['Дата регистрации', regVal], ['Гос. участие', sgGov]]);
      const rowName = renderItems([['Наименование', insurerName], ['Юридический адрес', legalAddress]]);
      const rowRisk = renderItems([['Класс риска', effClass || '—'], ['Страховой тариф', effTariff != null ? Utils.fmtPct(effTariff) : '—']]);
      // ИИ-советник: подобрать ОКЭД/класс для договора по ОКЭДам + должностям.
      const advisorHtml = App._okedAdvisorHtml();
      const contractorHtml =
        badges.join('') +
        `<div class="preview-section preview-section--contractor">
          <div class="preview-section-title">Информация о контрагенте</div>
          <div class="ci-grid ci-grid--3">${rowKey}</div>
          <div class="ci-grid ci-grid--1">${rowName}</div>
          <div class="ci-grid ci-grid--2">${rowRisk}</div>
          ${okedsSubBlock}
          ${advisorHtml}
        </div>` +
        sgStatus;
      cGrid.innerHTML = contractorHtml;
    }
    // Блок советника на вкладке «Андеррайтинговое решение» (отдельный маунт).
    App._renderOkedAdvisor();
  },

  togglePreviewDetails() {
    // «Подробности» рендерятся в обе панели профиля (одинаковый id) — синхронно
    // переключаем все, чтобы состояние не рассыпалось между вкладками.
    const els = document.querySelectorAll('.preview-collapsible');
    if (!els.length) return;
    const open = !els[0].classList.contains('is-open');
    els.forEach(el => el.classList.toggle('is-open', open));
    localStorage.setItem('preview_details_open', open ? '1' : '0');
  },

  // Открывает выбранный AI-сервис с пред-заполненным промптом про компанию.
  // service: 'chatgpt' | 'gemini' | 'perplexity'
  // Имя приоритетно из stat.gov.kz, fallback на заявку. Промпт также копируется
  // в буфер обмена — если сервис не подхватит ?q=, можно вставить Cmd+V.
  copyAskAiPrompt(service, btn) {
    const z = App.zayavka || {};
    const bin = z.bin || '';
    if (!bin) {
      App.showMsg('Сначала загрузите заявку — нужен БИН/ИИН.', 'error');
      return;
    }
    const sg = (App.statgov && !App.statgov.loading && !App.statgov.error && App.statgov.found !== false) ? App.statgov : null;
    const name = (sg?.name) || z.insurerName || '(имя не известно)';
    const prompt =
      `Расскажи кратко о компании. Наименование: ${name}, БИН: ${bin}. ` +
      `Максимум 4 предложений как один абзац — чем они занимаются ` +
      `и сделай краткий вывод. Используй веб-поиск.`;
    const enc = encodeURIComponent(prompt);
    let url = '';
    switch (service) {
      case 'chatgpt':
        // hints=search активирует режим веб-поиска
        url = `https://chatgpt.com/?hints=search&q=${enc}`;
        break;
      case 'gemini':
        // Gemini не поддерживает ?q= параметр — открываем главную, промпт в буфере.
        url = 'https://gemini.google.com/app';
        break;
      case 'perplexity':
        url = `https://www.perplexity.ai/?q=${enc}`;
        break;
      default:
        url = `https://chatgpt.com/?hints=search&q=${enc}`;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    App.copyToClipboard(prompt, btn);
  },

  // ===== ИИ-подбор ОКЭД/класса для договора =====
  // Строит промпт из ОКЭДов компании (код, наименование, класс, тариф) + место
  // для вставки штатки. Доступен ВСЕГДА, когда в работе есть компания (App.zayavka),
  // независимо от успеха statgov: если ОКЭДов из реестра нет — берём активный ОКЭД
  // (ручной/заявка), иначе оставляем плейсхолдер. null только если компании нет.
  _buildOkedAdvisorPrompt() {
    if (!App.zayavka) return null;
    let okeds = App._collectCompanyOkeds ? App._collectCompanyOkeds() : [];
    if (!okeds.length && App._resolveOked) {
      const r = App._resolveOked();
      if (r && r.oked) {
        okeds = [{ code: r.oked, kind: 'primary', name: r.activity || null, riskClass: (r.riskClass != null ? r.riskClass : null), tariff: null }];
      }
    }
    const lines = okeds.length
      ? okeds.map((o, i) => {
          const kind = o.kind === 'primary' ? 'основной' : 'вторичный';
          const cls = (o.riskClass != null) ? `класс ${o.riskClass}` : 'класс не определён';
          const tarVal = (o.riskClass != null && App._resolveTariff) ? App._resolveTariff(o.riskClass) : o.tariff;
          const tar = (tarVal != null && !isNaN(tarVal)) ? `тариф ${Utils.fmtPct(tarVal)}` : 'тариф не определён';
          return `${i + 1}. ${o.code} — ${o.name || 'наименование не в классификаторе'} (${kind}; ${cls}; ${tar})`;
        }).join('\n')
      : '(ОКЭД не определён — укажите ОКЭД(ы) компании, их класс и тариф)';
    return [
      'Ты — андеррайтер ОСНС (Казахстан).',
      '',
      'Тебе даны зарегистрированные ОКЭД страхователя и штатное расписание.',
      '',
      'Задача: выбери из предоставленных ОКЭД тот, который наиболее точно отражает фактическую деятельность работников, и укажи итоговый ОКЭД, класс риска и тариф для заключения договора ОСНС.',
      '',
      'Формат ответа:',
      '① Таблица: Должность | Фактический вид деятельности | Примененимый ОКЭД',
      '② Обоснование выбора (3–5 предложений)',
      '③ Итог: ОКЭД / Класс риска / Тариф',
      '',
      'Если ни один ОКЭД не соответствует факту — укажи это явно.',
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      'ОКЭДЫ СТРАХОВАТЕЛЯ:',
      lines,
      '',
      'ШТАТНОЕ РАСПИСАНИЕ (приведено ниже текстом ИЛИ приложено отдельным скриншотом/фото — если приложено изображение, распознай должности и их численность с него):',
      '[ВСТАВЬТЕ ШТАТКУ ТЕКСТОМ — ЛИБО ПРИКРЕПИТЕ СКРИНШОТ/ФОТО ШТАТНОГО РАСПИСАНИЯ]',
    ].join('\n');
  },

  _AI_LABELS: { chatgpt: 'ChatGPT', gemini: 'Gemini', perplexity: 'Perplexity', grok: 'Grok' },

  // Открывает выбранный ИИ-сервис с уже вставленным промптом + копирует в буфер.
  askOkedAdvisor(service, btn) {
    const prompt = App._buildOkedAdvisorPrompt();
    if (!prompt) {
      App.showMsg('Сначала проверьте компанию по БИН — нужны ОКЭДы.', 'error');
      return;
    }
    const enc = encodeURIComponent(prompt);
    // ?q= префилл. Кириллица в encodeURIComponent раздувает длину (1 символ → 6),
    // поэтому держим запас: лимит ~8000. Если не уместилось — открываем без
    // префилла; промпт всё равно в буфере (его можно вставить вручную).
    const fits = enc.length <= 8000;
    let url;
    switch (service) {
      case 'gemini':     url = 'https://gemini.google.com/app'; break; // ?q= не поддерживает — только буфер
      case 'perplexity': url = fits ? `https://www.perplexity.ai/?q=${enc}` : 'https://www.perplexity.ai/'; break;
      case 'grok':       url = fits ? `https://grok.com/?q=${enc}` : 'https://grok.com/'; break;
      case 'chatgpt':
      default:           url = fits ? `https://chatgpt.com/?q=${enc}` : 'https://chatgpt.com/';
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    App.copyToClipboard(prompt, btn);
    App.showMsg(`Промпт скопирован в буфер и открыт в ${App._AI_LABELS[service] || 'ИИ'}. Вставьте штатное расписание и нажмите «Отправить».`, 'success');
  },

  // Копирует промпт ОКЭД-советника в буфер (кнопка «Скопировать промпт»).
  copyOkedAdvisorPrompt(btn) {
    const prompt = App._buildOkedAdvisorPrompt();
    if (!prompt) { App.showMsg('Сначала проверьте компанию по БИН — нужны ОКЭДы.', 'error'); return; }
    App.copyToClipboard(prompt, btn);
  },

  // HTML блока ИИ-советника (кнопки сервисов + «Скопировать промпт»). '' если нет ОКЭДов.
  _okedAdvisorHtml() {
    if (!App._buildOkedAdvisorPrompt()) return '';
    const copyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    return `
      <div class="oked-advisor">
        <div class="oked-advisor-top">
          <div class="oked-advisor-title">ИИ-Советник по подбору ОКЭДа</div>
          <button type="button" class="oked-advisor-copy" onclick="App.copyOkedAdvisorPrompt(this)" title="Скопировать промпт в буфер">${copyIcon}<span>Скопировать промпт</span></button>
        </div>
        <div class="oked-advisor-grid">
          <button type="button" class="ai-chip ai-chip--chatgpt" onclick="App.askOkedAdvisor('chatgpt', this)"><span class="ai-chip-dot" aria-hidden="true"></span><span>Спросить у ChatGPT</span></button>
          <button type="button" class="ai-chip ai-chip--gemini" onclick="App.askOkedAdvisor('gemini', this)"><span class="ai-chip-dot" aria-hidden="true"></span><span>Спросить у Gemini</span></button>
          <button type="button" class="ai-chip ai-chip--perplexity" onclick="App.askOkedAdvisor('perplexity', this)"><span class="ai-chip-dot" aria-hidden="true"></span><span>Спросить у Perplexity</span></button>
          <button type="button" class="ai-chip ai-chip--grok" onclick="App.askOkedAdvisor('grok', this)"><span class="ai-chip-dot" aria-hidden="true"></span><span>Спросить у Grok</span></button>
        </div>
      </div>`;
  },

  // Рендерит блок советника в маунт на вкладке «Андеррайтинговое решение»
  // (перед «1. Параметры страхования»). На вкладке контрагента блок вшит в профиль.
  _renderOkedAdvisor() {
    const mount = document.getElementById('oked-advisor-mount');
    if (mount) mount.innerHTML = App._okedAdvisorHtml();
  },

  // Копирует значение в буфер обмена. Показывает анимацию на кнопке.
  copyToClipboard(text, btn) {
    const decoded = String(text).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const showOk = () => {
      if (!btn) return;
      const orig = btn.textContent;
      btn.textContent = '✓';
      btn.classList.add('pi-copy--ok');
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove('pi-copy--ok');
      }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(decoded).then(showOk).catch(() => {
        // Fallback на устаревший API
        const ta = document.createElement('textarea');
        ta.value = decoded;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); showOk(); } catch (e) {}
        document.body.removeChild(ta);
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = decoded;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); showOk(); } catch (e) {}
      document.body.removeChild(ta);
    }
  },

  // ===== DATES (F3 + период страхования) =====
  _computePeriodFromDocDate(docDate) {
    const d = new Date(docDate);
    const from = new Date(d);
    from.setDate(from.getDate() + 1);
    const to = new Date(from);
    to.setFullYear(to.getFullYear() + 1);
    return { from, to };
  },

  // Превращает Date в yyyy-mm-dd (формат HTML date input).
  _dateToInputValue(d) {
    if (!d) return '';
    const dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt)) return '';
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  },

  _fillDateInputs() {
    const z = App.zayavka;
    if (!z) return;
    const inFrom = document.getElementById('periodFrom');
    const inTo = document.getElementById('periodTo');
    if (inFrom) inFrom.value = App._dateToInputValue(z.periodFrom);
    if (inTo) inTo.value = App._dateToInputValue(z.periodTo);
  },

  // Ручной триггер statsnet-лукапа (кнопка рядом с dropdown «Вид деятельности»).
  // Принудительно перетирает ручной выбор: пользователь явно нажал «найти отрасль»,
  // значит хочет применить результат statsnet поверх любого предыдущего выбора.
  // Если результат окажется ошибочным — пользователь снова вручную выберет нужный.
  async manualStatsnetLookup(btn) {
    const bin = App.zayavka?.bin;
    if (!bin) {
      App.showMsg('Сначала загрузите заявку — нужен БИН.', 'error');
      return;
    }
    // Снять маркер «ручной выбор для этого ОКЭДа», чтобы _applyStatsnetIndustry
    // не короткозамкнул и применил найденную «Отрасль».
    localStorage.removeItem('manual_activity_for_oked');
    App._activityAutoForOked = null;
    if (btn) {
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = '⏳ Ищем…';
      try {
        await App.autoLookupStatsnet(bin);
        if (App.statsnet?.found && App.statsnet?.industry) {
          App.showMsg(`Отрасль найдена: «${App.statsnet.industry}» — применено`, 'success');
        } else if (App.statsnet?.error) {
          App.showMsg(App.statsnet.error, 'error');
        } else {
          App.showMsg('Отрасль на statsnet не найдена.', 'error');
        }
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    } else {
      await App.autoLookupStatsnet(bin);
    }
  },

  // ===== AUTO LOOKUP via Chrome extension (statsnet.co — «Отрасль») =====
  // Открывает background-вкладку с Яндекс-поиском, находит ссылку на statsnet,
  // парсит «Отрасль», закрывает вкладку. Если «Отрасль» совпадает с одной из
  // 17 категорий калькулятора — выставляет её в dropdown «Вид деятельности»
  // (только если пользователь не сделал ручной выбор для этого ОКЭДа).
  async autoLookupStatsnet(bin) {
    App.statsnet = { loading: true };
    App._renderActivityDiagnostics(); // показать «⏳ идёт поиск»
    if (typeof StatGovClient === 'undefined') {
      App.statsnet = { error: 'Расширение не подключено', loading: false };
      App._renderActivityDiagnostics();
      return;
    }
    try {
      const data = await StatGovClient.lookupStatsnet(bin);
      App.statsnet = { ...data, loading: false };
      // Применяем «Отрасль» к dropdown, если совпадает с категорией калькулятора
      if (data?.found && data.industry) {
        App._applyStatsnetIndustry(data.industry);
      }
    } catch (e) {
      App.statsnet = { error: e.message, loading: false };
    }
    App.showPreview();
    // Перерисовать диагностику — теперь известен результат statsnet
    App._renderActivityDiagnostics();
  },

  // Сравнение «Отрасль» из statsnet с категориями калькулятора.
  // Алгоритм матчинга (по убыванию приоритета):
  //   1. Точное совпадение нормализованных строк
  //   2. Одна строка является подстрокой другой (~contains)
  //   3. Перекрытие значащих слов (длиной ≥ 4 символов) ≥ 60%
  // Выбирается категория с максимальным score.
  _applyStatsnetIndustry(industry) {
    if (!industry) return;
    const matched = App._findActivityByIndustry(industry);
    if (matched == null) return; // нет совпадения — оставим текущий выбор
    // Не перезаписываем ручной выбор пользователя
    const resolved = App._resolveOked();
    if (resolved.oked && localStorage.getItem('manual_activity_for_oked') === resolved.oked) {
      return;
    }
    // Применяем
    const select = document.getElementById('activitySelect');
    if (select) {
      select.value = String(matched.idx);
      localStorage.setItem('selected_activity_idx', String(matched.idx));
      App._activityAutoForOked = resolved.oked;
    }
    App._renderActivityHint();
  },

  // Возвращает {idx, score, kind, name} или null
  _findActivityByIndustry(industry) {
    const activities = App._calcActivities ? App._calcActivities() : [];
    if (!activities.length) return null;
    const norm = (s) => String(s || '').toLowerCase()
      .replace(/[«»"',.():;–—-]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    const words = (s) => norm(s).split(/\s+/).filter(w => w.length >= 4);
    const target = norm(industry);
    const targetWords = words(industry);

    // Этап 1: exact match
    for (let i = 0; i < activities.length; i++) {
      if (norm(activities[i].name) === target) {
        return { idx: i, score: 1.0, kind: 'exact', name: activities[i].name };
      }
    }

    // Этап 2: contains — но только если совпадение однозначно (1 категория)
    const containsHits = activities
      .map((a, idx) => ({ idx, name: a.name, n: norm(a.name) }))
      .filter(c => c.n.length > 5 && (c.n.includes(target) || target.includes(c.n)));
    if (containsHits.length === 1) {
      const c = containsHits[0];
      return { idx: c.idx, score: 0.9, kind: 'contains', name: c.name };
    }

    // Этап 3: word overlap — выбираем категорию с максимальным score ≥ 40%.
    // Если target имеет < 2 значащих слов — overlap не применяем (слишком общее).
    // Если у двух категорий одинаковый максимальный score — ambiguous → null.
    if (targetWords.length < 2) return null;

    const scored = [];
    activities.forEach((a, idx) => {
      const aw = words(a.name);
      if (!aw.length) return;
      const setA = new Set(aw);
      const setT = new Set(targetWords);
      let common = 0;
      for (const w of setA) if (setT.has(w)) common++;
      const denom = Math.min(setA.size, setT.size);
      const overlap = denom > 0 ? common / denom : 0;
      if (overlap >= 0.4) {
        scored.push({ idx, score: overlap, kind: 'overlap-' + common + '/' + denom, name: a.name });
      }
    });
    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);
    // Если есть несколько с тем же максимальным score — неоднозначно
    if (scored.length > 1 && scored[1].score === scored[0].score) return null;
    return scored[0];
  },

  // ===== AUTO LOOKUP via Chrome extension (stat.gov.kz) =====
  // Требует установленного расширения «Standard Life — мост к stat.gov.kz».
  async autoLookupStatGov(bin) {
    App.statgov = { loading: true };
    App.showPreview();
    App.renderCompanyOkeds();
    if (typeof StatGovClient === 'undefined') {
      App.statgov = { error: 'StatGovClient не подключён', loading: false };
      App.showPreview();
      App.renderCompanyOkeds();
      return;
    }
    try {
      const data = await StatGovClient.lookup(bin);
      // Для ИП (и части ТОО) поля «Юридический адрес» нет — берём «Местонахождение».
      if (data && !data.error && !data.legalAddress) {
        data.legalAddress = Utils.statgovLegalAddress(data);
      }
      App.statgov = { ...data, loading: false };
      App.STATGOV.noteLookup(true);
    } catch (e) {
      App.statgov = { error: e.message, loading: false };
      App.STATGOV.noteLookup(false, e.message);
    }
    // statgov.name подставляем только в внутренние данные (App.zayavka.insurerName),
    // чтобы оно отразилось в preview / analytics / документах. Input-поле
    // manualName НЕ трогаем — оно остаётся для случая, когда пользователь хочет
    // ввести имя вручную (например, если расширение не установлено).
    if (App.statgov?.name && !App.statgov.error
        && App.zayavka && App.zayavka._manual && !App.zayavka.insurerName) {
      App.zayavka.insurerName = App.statgov.name;
      App._persistCase();
    }
    App.showPreview();
    App.renderCompanyOkeds();
    // После того как statgov загружен, _resolveOked() начнёт возвращать max-class ОКЭД —
    // пересинхронизируем hint и автовыбор вида деятельности.
    App.onOkedChange();
  },

  // Рендерит таблицу «ОКЭДы компании» под полем «Номер АР».
  renderCompanyOkeds() {
    const section = document.getElementById('company-okeds-section');
    const tbody = document.getElementById('company-okeds-body');
    if (!section || !tbody) return;
    const list = App._collectCompanyOkeds();
    if (!list.length) {
      section.style.display = 'none';
      tbody.innerHTML = '';
      return;
    }
    section.style.display = '';
    const resolved = App._resolveOked();
    const activeOked = resolved.oked;
    const fmtNum = (v) => v != null ? Number(v).toFixed(3).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',') : '—';
    const fmtTariff = (v) => v != null ? (v * 100).toFixed(2).replace('.', ',') + '%' : '—';
    tbody.innerHTML = list.map(o => {
      const isActive = o.code === activeOked;
      const cls = isActive ? 'active' : '';
      const badge = isActive ? '<span class="oked-active-badge">активный</span>' : '';
      return `<tr class="${cls}">
        <td><strong>${o.code}</strong> ${badge}</td>
        <td>${o.name || '<span class="muted">— нет в классификаторе</span>'}</td>
        <td>${fmtNum(o.deathRate)}</td>
        <td>${fmtNum(o.injuryRate)}</td>
        <td>${o.riskClass != null ? '<strong>' + o.riskClass + '</strong>' : '—'}</td>
        <td>${fmtTariff(o.tariff)}</td>
        <td>${o.kind === 'primary' ? 'осн.' : 'втор.'}</td>
      </tr>`;
    }).join('');
  },

  // ===== AUTO BIN LOOKUP via Cloudflare Worker proxy =====
  // Change this URL after deploying the worker
  WORKER_URL: 'https://bin-lookup.toibaev-kuanysh-617.workers.dev',

  async autoLookupBIN(bin) {
    // Loading-флаг: чтобы preview мог показать «(поиск...)» только пока запрос
    // реально в полёте. По завершении (успех/ошибка) переключается в false —
    // и preview покажет «—» / «не определено» если данных не нашлось.
    App.binData = { legalAddress: null, govParticipation: null, loading: true };
    App.showPreview();

    try {
      const resp = await fetch(App.WORKER_URL + '?bin=' + bin);
      if (!resp.ok) throw new Error('Worker returned ' + resp.status);

      const data = await resp.json();

      // Address from pk.uchet.kz
      if (data.address && data.address.address) {
        App.binData.legalAddress = data.address.address;
      }

      // Gov participation from e-Qazyna
      if (data.gov) {
        if (data.gov.found === false) {
          App.binData.govParticipation = 'Нет';
        } else if (data.gov.share) {
          App.binData.govParticipation = data.gov.share;
        } else if (data.gov.found) {
          App.binData.govParticipation = 'Да (доля не определена)';
        }
      }
    } catch (e) {
      console.warn('BIN lookup failed:', e.message);
    } finally {
      App.binData.loading = false;
    }

    // Refresh preview with new data
    App.showPreview();
  },

  // Собирает snapshot для аналитики на основе ВСЕХ актуальных значений:
  // ручной ОКЭД, выбранный вид деятельности, переопределённый тариф/период,
  // statgov-данные (имя, ОКЭДы компании, КРП, КФС, ...).
  _buildAnalyticsSnapshot() {
    const z = App.zayavka || {};
    const resolved = App._resolveOked();
    const effOked = resolved.oked || z.oked || '';
    const effRC = resolved.riskClass || z.riskClass;
    // Деятельность: для primary statgov — точное название из реестра
    const sg = (App.statgov && !App.statgov.loading && !App.statgov.error && App.statgov.found !== false)
      ? App.statgov : null;
    let effActivity = resolved.activity;
    if (sg && effOked === sg.okedPrimaryCode && sg.okedPrimaryName) {
      effActivity = sg.okedPrimaryName;
    }
    // Даты — приоритет инпутов формы
    const periodFromInput = document.getElementById('periodFrom')?.value;
    const periodToInput = document.getElementById('periodTo')?.value;
    const periodFrom = periodFromInput ? new Date(periodFromInput) : z.periodFrom;
    const periodTo = periodToInput ? new Date(periodToInput) : z.periodTo;
    // Имя — ТОЛЬКО из statgov (с fallback на ручной ввод insurerName)
    const insurerName = (sg && sg.name) || z.insurerName || '';
    const legalAddress = (sg && sg.legalAddress) || '';
    // Эффективные финансы — учитывают affiliated override / overrides из manual режима
    // (insuranceSum / premiumBase / premiumWithCoeff / tariff / organ).
    // Это ключ к корректным данным аналитики в manual-режиме.
    const effFin = App._effectiveFinancials ? App._effectiveFinancials({ ...z, periodFrom, periodTo }) : null;
    const effTariff = effFin?.tariff ?? (App._resolveTariff ? App._resolveTariff(effRC) : null);
    const effInsuranceSum = effFin?.insuranceSum ?? z.insuranceSum ?? 0;
    const effPremiumBase = effFin?.premiumBase ?? z.premiumBase ?? 0;
    const effPremiumWithCoeff = effFin?.premiumWithCoeff ?? z.premiumWithCoeff ?? 0;
    const effCoeffDown = effFin?.coeffDown ?? z.coeffDown ?? 0;

    return {
      generatedAt: new Date().toISOString(),
      zayavka: {
        insurerName,
        bin: z.bin || '',
        workers: z.workers || 0,
        riskClass: effRC || '',
        oked: effOked,
        activity: effActivity || '',
        region: z.region || '',
        insuranceSum: effInsuranceSum,
        premiumBase: effPremiumBase,
        premiumWithCoeff: effPremiumWithCoeff,
        periodFrom: periodFrom ? new Date(periodFrom).toISOString() : null,
        periodTo: periodTo ? new Date(periodTo).toISOString() : null,
        tariff: effTariff,
        coeff: z.coeff || null,
        coeffDown: effCoeffDown,
        paymentOrder: z.paymentOrder || '',
        docDate: z.docDate ? new Date(z.docDate).toISOString() : null,
        govParticipation: App.binData.govParticipation || z.govParticipation || '',
        legalAddress,
        // Источники активного ОКЭДа (manual / statgov-max-class / zayavka)
        okedSource: resolved.source || 'unknown',
        // Доп. поля для manual-режима, чтобы аналитика могла отметить особенности
        isManual: !!z._manual,
        isAffiliated: !!effFin?.isAffiliated,
        affiliatedName: effFin?.affiliatedEntry?.name || null,
        noDiscountReason: effFin?.noDiscountReason || null,
        companyAgeYears: effFin?.ageYears || null,
        avgSalary: z.avgSalary || null,
        fot: z.fot || null,
      },
      verdict: document.getElementById('verdict')?.value || 'auto',
      popravka: App.refData.popravka ? {
        baseTariff: App.refData.popravka.riskRates ? App.refData.popravka.riskRates.get(effRC) : null,
        allTariffs: App.refData.popravka.riskRates
          ? Array.from(App.refData.popravka.riskRates.entries()).map(([cls, rate]) => ({ cls, rate }))
          : [],
      } : null,
      analytics: App.claims.analytics,
      normativ: App.refData.normativ ? {
        date: App.refData.normativ.date,
        fullAssetsTenge: App.refData.normativ.fullAssetsTenge,
        fullAssets: App.refData.normativ.fullAssets,
        portfolioShare: App.refData.normativ.portfolioShare,
      } : null,
      ku: App.refData.ku ? {
        lossRatioWith: App.refData.ku.lossRatioWith,
        lossRatioWithout: App.refData.ku.lossRatioWithout,
      } : null,
      activity: App._getSelectedActivity(),
      // Новое: statgov + ОКЭДы компании
      statgov: sg ? {
        name: sg.name,
        bin: sg.bin,
        registrationDate: sg.registrationDate,
        legalAddress: sg.legalAddress,
        headFullname: sg.headFullname,
        okedPrimaryCode: sg.okedPrimaryCode,
        okedPrimaryName: sg.okedPrimaryName,
        okedSecondaryCodes: sg.okedSecondaryCodes || [],
        krpWithBranchesCode: sg.krpWithBranchesCode,
        krpWithBranchesName: sg.krpWithBranchesName,
        krpWithoutBranchesCode: sg.krpWithoutBranchesCode,
        krpWithoutBranchesName: sg.krpWithoutBranchesName,
        kato: sg.kato,
        kfsCode: sg.kfsCode,
        kfsName: sg.kfsName,
        sectorCode: sg.sectorCode,
        sectorName: sg.sectorName,
      } : null,
      companyOkeds: (() => {
        let okeds = App._collectCompanyOkeds ? App._collectCompanyOkeds() : [];
        // Если statgov не загружен но ОКЭД известен (manual-ввод) — синтезируем
        // single-entry для аналитики из classifier+popravka+calculator.
        if (okeds.length === 0 && effOked) {
          const classifier = App.refData.classifier || [];
          const found = Utils.lookupOked ? Utils.lookupOked(effOked, classifier) : null;
          const calcMap = App._calcOkedMap ? App._calcOkedMap() : {};
          const calc = calcMap[effOked];
          const calcActivity = (calc && typeof calc === 'object') ? calc : null;
          const popTariff = (effRC && App.refData.popravka?.riskRates)
            ? App.refData.popravka.riskRates.get(effRC) : null;
          okeds = [{
            code: effOked,
            kind: 'primary',
            name: found?.name || calcActivity?.activityName || calcActivity?.okedName || null,
            riskClass: effRC || calcActivity?.riskClass || null,
            tariff: popTariff || calcActivity?.tariff || null,
            deathRate: calcActivity?.deathRate ?? null,
            injuryRate: calcActivity?.injuryRate ?? null,
          }];
        }
        return okeds;
      })(),
    };
  },

  // ===== OPEN ANALYTICS DASHBOARD =====
  openAnalytics() {
    if (!App.claims || !App.claims.analytics) {
      App.showMsg('Сначала загрузите историю убытков.', 'error');
      return;
    }
    localStorage.setItem('analytics_snapshot', JSON.stringify(App._buildAnalyticsSnapshot()));
    window.open('analytics.html', '_blank');
  },

  // ===== TOGGLE INLINE ANALYTICS =====
  toggleInlineAnalytics() {
    if (!App.claims || !App.claims.analytics) {
      App.showMsg('Сначала загрузите историю убытков.', 'error');
      return;
    }
    const container = document.getElementById('analytics-inline');
    const hint = document.getElementById('inline-hint');
    const iframe = document.getElementById('analytics-iframe');
    if (container.classList.contains('is-open')) {
      container.classList.remove('is-open');
      document.body.classList.remove('inline-analytics-open');
      hint.textContent = '↓ показать';
      return;
    }
    localStorage.setItem('analytics_snapshot', JSON.stringify(App._buildAnalyticsSnapshot()));
    iframe.src = 'analytics.html#inline=1&t=' + Date.now(); // force reload via hash
    container.classList.add('is-open');
    // FAB «Спросить ИИ» на родительской странице — виден, пока аналитика развёрнута
    // (внутри iframe position:fixed не работает: iframe растянут на высоту контента).
    document.body.classList.add('inline-analytics-open');
    hint.textContent = '↑ свернуть';
    // Auto-resize iframe to its content's height so внутренний скроллбар не появляется.
    // Same-origin iframe — можно читать contentDocument напрямую.
    const resizeIframe = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        const h = Math.max(
          doc.body?.scrollHeight || 0,
          doc.documentElement?.scrollHeight || 0
        );
        if (h > 0) iframe.style.height = (h + 16) + 'px';
      } catch (e) { /* same-origin should always work */ }
    };
    // На load и далее периодически (контент может асинхронно добавляться:
    // charts, lazy sections). ResizeObserver если доступен — наблюдаем за body.
    iframe.addEventListener('load', () => {
      resizeIframe();
      try {
        const body = iframe.contentDocument?.body;
        if (body && window.ResizeObserver) {
          if (App._inlineResizeObserver) App._inlineResizeObserver.disconnect();
          App._inlineResizeObserver = new ResizeObserver(() => resizeIframe());
          App._inlineResizeObserver.observe(body);
        }
        // На всякий случай — несколько отложенных пересчётов (для шрифтов/картинок)
        [150, 400, 800, 1500].forEach(t => setTimeout(resizeIframe, t));
      } catch (e) { /* ignore */ }
    }, { once: true });
    setTimeout(() => container.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  },

  // ===== GENERATE AR =====
  async generateAR() {
    try {
      const data = App._collectData();
      if (!data) return;

      const blob = await ARGenerator.generate(data);
      const fileName = `АР ${Utils.formatCompanyName(data.insurerName)}.docx`;
      saveAs(blob, fileName);
      App.showMsg(`${fileName} сформирован!`, 'success');
    } catch (e) {
      console.error('AR generation error:', e);
      App.showMsg(`Ошибка генерации АР: ${e.message}`, 'error');
    }
  },

  // ===== GENERATE ZAKLYUCHENIE =====
  async generateZakl() {
    try {
      const data = App._collectData();
      if (!data) return;

      const blob = await ZaklGenerator.generate(data);
      const fileName = `заключение ${Utils.formatCompanyName(data.insurerName)}.docx`;
      saveAs(blob, fileName);
      App.showMsg(`${fileName} сформирован!`, 'success');
    } catch (e) {
      console.error('Zakl generation error:', e);
      App.showMsg(`Ошибка генерации Заключения: ${e.message}`, 'error');
    }
  },

  // ===== GENERATE PROTOCOL =====
  async generateProtocol() {
    try {
      const data = App._collectData();
      if (!data) return;

      const blob = await ProtocolGenerator.generate(data);
      const fileName = `протокол ${Utils.formatCompanyName(data.insurerName)}.docx`;
      saveAs(blob, fileName);
      App.showMsg(`${fileName} сформирован!`, 'success');
    } catch (e) {
      console.error('Protocol generation error:', e);
      App.showMsg(`Ошибка генерации Протокола: ${e.message}`, 'error');
    }
  },

  // ===== GENERATE СЗ на Правление =====
  async generateSzPravlenie() {
    try {
      const data = App._collectData();
      if (!data) return;
      const blob = await SZGenerator.generate(data, 'pravlenie');
      const fileName = `СЗ на Правление ${Utils.formatCompanyName(data.insurerName)}.docx`;
      saveAs(blob, fileName);
      App.showMsg(`${fileName} сформирован!`, 'success');
    } catch (e) {
      console.error('СЗ на Правление generation error:', e);
      App.showMsg(`Ошибка генерации СЗ на Правление: ${e.message}`, 'error');
    }
  },

  // ===== GENERATE СЗ на СД =====
  async generateSzSd() {
    try {
      const data = App._collectData();
      if (!data) return;
      const blob = await SZGenerator.generate(data, 'sd');
      const fileName = `СЗ на СД ${Utils.formatCompanyName(data.insurerName)}.docx`;
      saveAs(blob, fileName);
      App.showMsg(`${fileName} сформирован!`, 'success');
    } catch (e) {
      console.error('СЗ на СД generation error:', e);
      App.showMsg(`Ошибка генерации СЗ на СД: ${e.message}`, 'error');
    }
  },

  // ===== СКАЧАТЬ АНАЛИТИКУ В PDF =====
  // Раньше тут была попытка вручную собрать PDF через pdfMake (9 секций) —
  // дашборд содержит ~40 карточек, поэтому документ выходил наполовину
  // пустой. Текущая реализация открывает analytics.html в скрытом iframe
  // с параметром ?exportPdf=<имя>; страница рендерит весь дашборд, ловит
  // его html2canvas-ом и собирает реальный PDF через jsPDF. Так в файл
  // попадают ВСЕ секции аналитики ровно в том виде, в котором они на экране.
  async downloadAnalyticsPdf(btn) {
    if (!App.claims || !App.claims.analytics) {
      App.showMsg('Сначала загрузите историю убытков.', 'error');
      return;
    }
    const origText = btn?.innerHTML;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="dla-spinner"></span> Готовим PDF…';
    }
    const setBtnText = (t) => {
      if (btn) btn.innerHTML = `<span class="dla-spinner"></span> ${t}`;
    };

    // Сохраняем snapshot — iframe прочитает его из localStorage и отрендерит дашборд.
    localStorage.setItem('analytics_snapshot', JSON.stringify(App._buildAnalyticsSnapshot()));

    const z = App.zayavka || {};
    const companyName = Utils.formatCompanyName((App.statgov?.name) || z.insurerName || z.bin || 'компания');
    const dateStr = new Date().toLocaleDateString('ru-RU').replace(/\//g, '-');
    const fileName = `Аналитика ${companyName} от ${dateStr}.pdf`;

    let iframe = null;
    let onMsg = null;
    try {
      iframe = document.createElement('iframe');
      // Фиксированная десктопная ширина 1280px — внутри iframe мы навешиваем
      // body.is-pdf-mode с `width: 1280px !important` на .dash, чтобы row-2
      // раскладка с двумя колонками точно отрендерилась, а не мобильным
      // стеком. Высоту делаем большой, чтобы дашборд уложился без скролла —
      // иначе offsetHeight некоторых секций может оказаться 0.
      iframe.setAttribute('width', '1280');
      iframe.setAttribute('height', '3000');
      iframe.style.cssText = 'position:fixed;left:-99999px;top:0;width:1280px;height:3000px;border:0;opacity:0;pointer-events:none;';
      // Hash, not query-string — npx http-server returns 404 on URLs with `?`.
      iframe.src = `analytics.html#exportPdf=${encodeURIComponent(fileName)}&inline=1`;

      await new Promise((resolve, reject) => {
        // На реальной машине пакет из ~42 секций снимается за 15–25 сек,
        // но под Chrome DevTools / CDP-отладчиком html2canvas замедляется
        // в десятки раз — даём щедрый запас.
        const TIMEOUT_MS = 5 * 60 * 1000;
        const timeoutId = setTimeout(() => {
          reject(new Error('Таймаут генерации PDF (>5 минут)'));
        }, TIMEOUT_MS);
        onMsg = (e) => {
          if (!iframe || e.source !== iframe.contentWindow) return;
          const data = e.data || {};
          if (data.type === 'pdf-progress' && data.text) {
            setBtnText(data.text);
          } else if (data.type === 'pdf-done') {
            clearTimeout(timeoutId);
            // Браузеры (Chrome в т.ч.) блокируют <a download> клик из
            // offscreen-iframe — поэтому фактическое сохранение делает
            // родительский window, у которого ещё жив user gesture.
            try {
              if (data.buffer) {
                const blob = new Blob([data.buffer], { type: 'application/pdf' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = data.filename || fileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }
              resolve();
            } catch (saveErr) {
              reject(saveErr);
            }
          } else if (data.type === 'pdf-error') {
            clearTimeout(timeoutId);
            reject(new Error(data.message || 'Ошибка экспорта'));
          }
        };
        window.addEventListener('message', onMsg);
        document.body.appendChild(iframe);
      });

      App.showMsg(`${fileName} скачан.`, 'success');
    } catch (e) {
      console.error('PDF generation error:', e);
      App.showMsg(`Ошибка генерации PDF: ${e.message}`, 'error');
    } finally {
      if (onMsg) window.removeEventListener('message', onMsg);
      if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origText;
      }
    }
  },

  // ===== COLLECT ALL DATA =====
  _collectData() {
    const z = App.zayavka;
    if (!z) {
      App.showMsg('Загрузите заявку на андеррайтинг.', 'error');
      return null;
    }

    const docNumber = document.getElementById('docNumber').value.trim();
    if (!docNumber) {
      App.showMsg('Укажите номер документа.', 'error');
      return null;
    }

    // Tariff: prefer the value entered manually in заявка (D12).
    // Only fall back to справочник (по риск-классу) when zayavka has no tariff.
    // Note: effective risk class is resolved further below via _resolveOked();
    // the справочник lookup happens after we know it.

    // Даты: docDate = F3 из заявки (для шапки документа).
    // Период страхования: приоритет на UI-инпуты (ручной ввод), fallback на
    // App.zayavka.periodFrom/periodTo, которые в loadZayavka уже вычислены как
    // F3 + 1 день / F3 + 1 год.
    const periodFromInput = document.getElementById('periodFrom')?.value;
    const periodToInput = document.getElementById('periodTo')?.value;
    const docDate = z.docDate || null;
    let periodFrom = periodFromInput ? new Date(periodFromInput) : z.periodFrom;
    let periodTo = periodToInput ? new Date(periodToInput) : z.periodTo;
    if (docDate && (!periodFrom || !periodTo)) {
      const p = App._computePeriodFromDocDate(docDate);
      if (!periodFrom) periodFrom = p.from;
      if (!periodTo) periodTo = p.to;
    }

    // Apply ОКЭД override (manual input > zayavka). Resolves class+name via classifier.
    const resolved = App._resolveOked();
    const effectiveOked = resolved.oked;
    const effectiveRiskClass = resolved.riskClass;
    const effectiveActivity = resolved.activity;

    // Тариф «связан» с активным ОКЭДом — см. _resolveTariff().
    const tariff = App._resolveTariff(effectiveRiskClass);

    // Activity for death/injury rates — picked manually from dropdown (sourced from Лист2 of калькулятор).
    let selectedActivity = App._getSelectedActivity();

    // docDate уже определён выше из инпута (или z.docDate). На случай отсутствия —
    // используем periodFrom как fallback.
    const effectiveDocDate = docDate || periodFrom;
    // Перетираем z.docDate, чтобы итоговый объект (через ...z потом docDate) был
    // согласован с тем, что показывает UI.
    z.docDate = effectiveDocDate;

    // Эффективные финансы и организация — централизованно через _effectiveFinancials.
    // Для аффилированных лиц: страх.сумма = 85 000 × работники × 12, орган = СД.
    // Для молодых компаний (< 3 лет) или с НС: скидка не применяется.
    const _zWithDates = { ...z, periodFrom, docDate: effectiveDocDate };
    const effFin = App._effectiveFinancials(_zWithDates);
    const effectiveCoeffDown = effFin.coeffDown;
    const premiumWithCoeff = effFin.premiumWithCoeff;
    const noDiscountReason = effFin.noDiscountReason;
    const effectiveInsuranceSum = effFin.insuranceSum;
    const effectivePremiumBase = effFin.premiumBase;
    const forcedOrgan = effFin.organ; // 'sd' для аффилированных, иначе из правил
    const isAffiliated = effFin.isAffiliated;
    const affiliatedEntry = effFin.affiliatedEntry;
    const regDateRaw = (App.statgov && !App.statgov.loading && !App.statgov.error && App.statgov.found !== false)
      ? App.statgov.registrationDate : null;
    const ageRefDate = periodFrom || effectiveDocDate || new Date();

    // Payment schedule (form takes priority over zayavka D19)
    const formOrder = document.getElementById('paymentOrder')?.value || 'Единовременно';
    const formFreq = document.getElementById('paymentFrequency')?.value || 'month';
    let paymentOrderEff = formOrder;
    let paymentFreqEff = null;
    let paymentTranches = null;
    let paymentScheduleText = paymentOrderEff;
    if (paymentOrderEff === 'В рассрочку') {
      // Приоритет — РЕАЛЬНЫЕ транши из выгрузки (колонки Этап{N}Дата/Сумма).
      // Кол-во траншей = число заполненных этапов; даты и суммы — как в файле.
      const fileTr = Array.isArray(z.tranchesFromFile)
        ? z.tranchesFromFile.filter(t => t && t.date) : null;
      if (fileTr && fileTr.length) {
        paymentTranches = fileTr.map(t => new Date(t.date));
        const n = fileTr.length;
        const parts = fileTr.map((t, i) => {
          const amt = (t.amount != null) ? ` — ${Utils.fmtMoney(t.amount)}` : '';
          return `${i + 1} транш: ${Utils.fmtDateShort(new Date(t.date))}${amt}`;
        });
        paymentScheduleText = `В рассрочку (${Utils.pluralize(n, 'транш', 'транша', 'траншей')}): ${parts.join('; ')}`;
      } else {
        paymentFreqEff = formFreq;
        paymentTranches = Utils.calcPaymentTranches(formFreq, periodFrom, periodTo);
        paymentScheduleText = `В рассрочку (${Utils.PAYMENT_FREQ_LABELS[formFreq]}): ${Utils.formatPaymentSchedule(paymentTranches, formFreq)}`;
      }
    }

    // Источник имени, юр. адреса, региона и деятельности: ТОЛЬКО stat.gov.kz
    // (реестр считается единственно достоверным). pk.uchet.kz больше не fallback.
    const sg = (App.statgov && !App.statgov.loading && !App.statgov.error && App.statgov.found !== false)
      ? App.statgov : null;
    // Fallback на «(наименование не определено)» — иначе в СЗ строки вроде
    // «сделки с компанией – ${companyName}» дают «– .» при пустом name.
    const insurerName = (sg && sg.name) || z.insurerName || '(наименование не определено)';
    const legalAddress = (sg && sg.legalAddress) || '-';
    const headFullname = (sg && sg.headFullname) || null;

    // Регион: заявка E3 → первая часть юр. адреса из stat.gov.kz.
    // Адрес: «ТУРКЕСТАНСКАЯ ОБЛАСТЬ, ТУРКЕСТАН Г.А., ...» — берём до запятой.
    let region = z.region;
    if ((!region || region === '-') && sg && sg.legalAddress) {
      const firstPart = String(sg.legalAddress).split(',')[0].trim();
      if (firstPart) region = firstPart;
    }

    // Деятельность: для активного ОКЭДа, если это primary stat.gov.kz —
    // берём statgov-имя (специфичное), иначе fallback на classifier name.
    let activity = effectiveActivity;
    if (sg && effectiveOked && effectiveOked === sg.okedPrimaryCode && sg.okedPrimaryName) {
      activity = sg.okedPrimaryName;
    }

    return {
      ...z,
      insurerName,
      region,
      oked: effectiveOked || z.oked,
      riskClass: effectiveRiskClass,
      activity,
      docDate: effectiveDocDate,
      docNumber,
      legalAddress,
      headFullname,
      statgov: sg, // полный объект — для генераторов, которые захотят что-то ещё
      nonResident: document.getElementById('nonResident').checked,
      isAffiliated,
      affiliatedName: affiliatedEntry ? affiliatedEntry.name : null,
      // Эффективные финансы (overrides для аффилированных): перетирают z.insuranceSum / premiumBase
      insuranceSum: effectiveInsuranceSum,
      premiumBase: effectivePremiumBase,
      // Орган: 'sd' для аффилированных, иначе по правилам
      organ: forcedOrgan,
      paymentOrder: paymentOrderEff,
      paymentFrequency: paymentFreqEff,
      paymentTranches: paymentTranches ? paymentTranches.map(d => d.toISOString()) : null,
      paymentScheduleText,
      periodFrom,
      periodTo,
      coeffDown: effectiveCoeffDown,
      noDiscountReason, // 'claims' | 'young_company' | null
      companyAgeYears: Utils.companyAgeYears(regDateRaw, ageRefDate),
      premiumWithCoeff,
      tariff,
      claims: App.claims,
      // Сводка НС: из файла истории убытков; иначе из ручного ввода
      // (z._manualClaimsCount). Без данных и при 0 — «НС не было».
      claimsSummary: App.claims
        ? App.claims.summaryText
        : (z._manualClaimsCount > 0
            ? `За последние 3 года: ${Utils.pluralize(z._manualClaimsCount, 'страховой случай', 'страховых случая', 'страховых случаев')}`
            : 'НС не было'),
      normativ: App.refData.normativ,
      ku: App.refData.ku,
      selectedActivity,
      riskText: document.getElementById('riskText').value.trim(),
      govParticipation: App.binData.govParticipation || z.govParticipation || '-',
      verdict: document.getElementById('verdict').value,
    };
  },

  // ===== UI HELPERS =====
  updateRefStatus(type, loaded, fileName) {
    const zone = document.getElementById(`zone-${type}`);
    const status = document.getElementById(`status-${type}`);
    if (loaded) {
      zone.classList.add('loaded');
      status.textContent = fileName || 'Загружен';
    } else {
      zone.classList.remove('loaded');
      status.textContent = 'Не загружен';
    }
  },

  updateRefBadge() {
    let count = 0;
    if (App.refData.popravka) count++;
    if (App.refData.normativ) count++;
    if (App.refData.ku) count++;
    if (App.refData.calculator) count++;
    if (App.refData.classifier) count++;
    if (App.refData.affiliated) count++;
    document.getElementById('ref-badge').textContent = `${count}/6 загружено`;
  },

  updateButtons() {
    // Лёгкая «зайавка только для проверки» (_lookupOnly) не должна включать
    // кнопки генерации документов — у неё нет работников/премии.
    const hasZayavka = !!App.zayavka && !App.zayavka._lookupOnly;
    // Формирование пакета документов заблокировано, пока не сняты «ворота» по НС
    // (файл «Страховые случаи» загружен ИЛИ отмечено «Не было страховых случаев»).
    const canGen = hasZayavka && App._claimsConfirmed();
    document.getElementById('btnAR').disabled = !canGen;
    document.getElementById('btnZakl').disabled = !canGen;
    const btnProto = document.getElementById('btnProtocol');
    const btnSzPr = document.getElementById('btnSzPravlenie');
    const btnSzSd = document.getElementById('btnSzSd');

    // Determine organ from current data — учитывает affiliated override.
    // Используем _effectiveFinancials, чтобы для аффилированных всегда был СД,
    // а страх. сумма пересчитана от 85 000 × работники × 12.
    let organ = null;
    let pkg = ['ar', 'zakl'];
    if (hasZayavka) {
      const effFin = App._effectiveFinancials(App.zayavka);
      organ = effFin.organ;
      pkg = effFin.docPackage;
    }

    if (btnProto) btnProto.disabled = !canGen || !pkg.includes('protocol');
    if (btnSzPr) btnSzPr.disabled = !canGen || !pkg.includes('sz_pravlenie');
    if (btnSzSd) btnSzSd.disabled = !canGen || !pkg.includes('sz_sd');

    // Show/hide buttons depending on package
    const setHidden = (el, hide) => { if (el) el.style.display = hide ? 'none' : ''; };
    setHidden(btnProto, !pkg.includes('protocol'));
    setHidden(btnSzPr, !pkg.includes('sz_pravlenie'));
    setHidden(btnSzSd, !pkg.includes('sz_sd'));

    // Update organ-banner with determined body
    const banner = document.getElementById('organ-banner');
    if (banner) {
      const isAff = hasZayavka && App._isAffiliatedBin(App.zayavka.bin);
      if (organ && organ !== 'standard') {
        banner.style.display = 'block';
        banner.className = 'organ-banner organ-banner--' + organ;
        const descr = isAff
          ? `Совет директоров (аффилированное лицо)`
          : Utils.describeOrgan(organ);
        banner.innerHTML = `<strong>Определён орган:</strong> ${descr}`;
      } else if (organ === 'standard' && hasZayavka) {
        banner.style.display = 'block';
        banner.className = 'organ-banner organ-banner--standard';
        banner.innerHTML = `<strong>Стандартная процедура.</strong>`;
      } else {
        banner.style.display = 'none';
      }
    }
  },

  showMsg(text, type) {
    const el = document.getElementById('msg');
    el.textContent = text;
    el.className = `msg ${type}`;
    setTimeout(() => { el.className = 'msg'; }, 5000);
  },

  // ===== Resolve effective ОКЭД, риск-класс и название деятельности =====
  // Приоритет:
  //   1. Manual ОКЭД из инпута (явное намерение оператора)
  //   2. ОКЭД с максимальным классом среди всех ОКЭДов компании из stat.gov.kz
  //      (основной + все вторичные), если они есть и классификатор загружен
  //   3. ОКЭД из заявки
  _resolveOked() {
    const z = App.zayavka || {};
    const manual = (document.getElementById('okedInput')?.value || '').trim();
    let oked = manual;
    let source = 'manual';

    if (!oked) {
      const company = App._collectCompanyOkeds();
      const withCls = company.filter(o => o.riskClass != null);
      if (withCls.length > 0) {
        // Активный ОКЭД — с НАИБОЛЬШИМ ТАРИФОМ (а не номером класса): маппинг
        // класс→тариф немонотонный (класс 13 = 1,29% выше, чем класс 16 = 1,17%).
        // Тай-брейк при равных тарифах — больший номер класса.
        withCls.sort((a, b) => {
          const ta = App._tariffByClass(a.riskClass);
          const tb = App._tariffByClass(b.riskClass);
          const tav = (ta != null) ? ta : -Infinity;
          const tbv = (tb != null) ? tb : -Infinity;
          if (tbv !== tav) return tbv - tav;
          return b.riskClass - a.riskClass;
        });
        oked = withCls[0].code;
        source = 'statgov-max-tariff';
      }
    }

    if (!oked) {
      oked = z.oked || '';
      source = oked ? 'zayavka' : 'empty';
    }

    let riskClass = z.riskClass;
    let activity = z.activity;
    if (oked && App.refData.classifier) {
      const found = Utils.lookupOked(oked, App.refData.classifier);
      if (found) {
        riskClass = found.cls;
        activity = found.name;
        source += '+classifier';
      }
    }
    return { oked, riskClass, activity, source };
  },

  // Собирает список всех ОКЭДов компании из stat.gov.kz и обогащает
  // классификатором (класс, тариф) + калькулятором (смертность, травматизм).
  // Возвращает: [{code, kind: 'primary'|'secondary', name, riskClass, deathRate, injuryRate, tariff}, ...]
  _collectCompanyOkeds() {
    const sg = App.statgov;
    if (!sg || sg.loading || sg.error || sg.found === false) return [];
    const items = [];
    if (sg.okedPrimaryCode) {
      items.push({ code: String(sg.okedPrimaryCode), kind: 'primary' });
    }
    const seen = new Set([sg.okedPrimaryCode].filter(Boolean).map(String));
    for (const code of sg.okedSecondaryCodes || []) {
      const c = String(code);
      if (seen.has(c)) continue;
      seen.add(c);
      items.push({ code: c, kind: 'secondary' });
    }
    const okedMap = App._calcOkedMap ? App._calcOkedMap() : {};
    const classifier = App.refData.classifier || [];
    return items.map(it => {
      // Калькулятор (Лист3) даёт смерть/травму/класс/тариф per-OKED — приоритет.
      const calc = okedMap[it.code]; // объект { activityName, deathRate, injuryRate, riskClass, tariff }
      // Классификатор — fallback по имени деятельности и тарифу.
      const clsLookup = Utils.lookupOked(it.code, classifier);
      const classifierEntry = classifier.find(e => !e.isPrefix && e.okedRaw === it.code);
      return {
        code: it.code,
        kind: it.kind,
        name: clsLookup?.name || calc?.okedName || null,
        riskClass: (calc?.riskClass != null ? calc.riskClass : null) ?? clsLookup?.cls ?? null,
        deathRate: calc?.deathRate ?? null,
        injuryRate: calc?.injuryRate ?? null,
        tariff: (calc?.tariff != null ? calc.tariff : null) ?? classifierEntry?.tariff ?? null,
        activityName: calc?.activityName || null,
      };
    });
  },

  // ===== PAYMENT ORDER + FREQUENCY HANDLERS =====
  onPaymentChange() {
    const order = document.getElementById('paymentOrder')?.value || 'Единовременно';
    const wrap = document.getElementById('payment-frequency-wrap');
    const preview = document.getElementById('payment-preview');
    if (!wrap) return;
    const editor = document.getElementById('manual-tranches');
    if (order === 'В рассрочку') {
      wrap.style.display = '';                 // периодичность — кнопка авто-заполнения
      if (editor) editor.style.display = '';
      if (preview) preview.innerHTML = '';
      const z = App.zayavka;
      // Транши ещё не заданы (ни из файла, ни вручную) → авто-заполнить по периодичности.
      if (z && (!Array.isArray(z.tranchesFromFile) || z.tranchesFromFile.length === 0)) {
        App.fillTranchesByFreq();
      } else {
        App.renderManualTranches();
      }
    } else {
      wrap.style.display = 'none';
      if (editor) editor.style.display = 'none';
      if (preview) preview.innerHTML = '';
    }
  },

  // ===== РЕДАКТОР ТРАНШЕЙ РАССРОЧКИ =====
  // Источник правды — App.zayavka.tranchesFromFile ([{date: ISO, amount: number|null}]).
  // Тот же массив, что приходит из выгрузки (Этап{N}) и используется в _collectData.
  _caseTranches() {
    const z = App.zayavka;
    if (!z) return null;
    if (!Array.isArray(z.tranchesFromFile)) z.tranchesFromFile = [];
    return z.tranchesFromFile;
  },
  // ISO → значение <input type=date> (локальная дата YYYY-MM-DD).
  _isoToDateInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },
  // Значение <input type=date> → ISO локальной полуночи (как у траншей из файла).
  _dateInputToIso(val) {
    if (!val) return null;
    const d = new Date(val + 'T00:00:00');
    return isNaN(d) ? null : d.toISOString();
  },
  renderManualTranches() {
    const list = document.getElementById('manual-tranches-list');
    const hint = document.getElementById('manual-tranches-hint');
    const cnt = document.getElementById('mt-count');
    if (!list) return;
    const tr = App._caseTranches();
    if (tr == null) {
      list.innerHTML = '';
      if (cnt) cnt.textContent = '';
      if (hint) hint.textContent = 'Сначала примените данные по компании (кнопка «Применить» / выбор из реестра).';
      return;
    }
    list.innerHTML = tr.map((t, i) => `
      <div class="mt-row">
        <span class="mt-num">${i + 1}</span>
        <input type="date" class="mt-date" value="${App._isoToDateInput(t.date)}" onchange="App.updateManualTranche(${i},'date',this.value)" aria-label="Дата транша ${i + 1}">
        <input type="text" class="mt-amount" inputmode="decimal" placeholder="Сумма, ₸ (необязательно)" value="${t.amount != null ? App._formatMoney(t.amount) : ''}" oninput="App.updateManualTranche(${i},'amount',this.value)" onblur="App._mtAmountBlur(${i})" aria-label="Сумма транша ${i + 1}">
        <button type="button" class="mt-del" title="Удалить транш" onclick="App.removeManualTranche(${i})">✕</button>
      </div>`).join('');
    if (cnt) cnt.textContent = tr.length ? `(${Utils.pluralize(tr.length, 'транш', 'транша', 'траншей')})` : '';
    if (hint) hint.textContent = tr.length
      ? 'Кол-во траншей = число строк. Уберите/добавьте строки и правьте даты/суммы под фактический график.'
      : 'Нажмите «+ Транш» или «↻ По периодичности», чтобы задать график.';
  },
  addManualTranche() {
    const tr = App._caseTranches();
    if (tr == null) { App.showMsg('Сначала примените данные по компании.', 'error'); return; }
    tr.push({ date: null, amount: null });
    App.renderManualTranches();
    App._persistCase();
  },
  removeManualTranche(i) {
    const tr = App._caseTranches();
    if (tr == null) return;
    tr.splice(i, 1);
    App.renderManualTranches();
    App._persistCase();
  },
  updateManualTranche(i, field, val) {
    const tr = App._caseTranches();
    if (tr == null || !tr[i]) return;
    if (field === 'date') {
      tr[i].date = App._dateInputToIso(val);
    } else if (field === 'amount') {
      const n = App._parseMoney(val);
      tr[i].amount = Number.isFinite(n) ? n : null;
    }
    App._persistCase();
    // Не пере-рендерим целиком (потеряли бы фокус) — обновляем только счётчик.
    const cnt = document.getElementById('mt-count');
    if (cnt && field === 'date') cnt.textContent = tr.length ? `(${Utils.pluralize(tr.length, 'транш', 'транша', 'траншей')})` : '';
  },
  _mtAmountBlur(i) {
    const tr = App._caseTranches();
    if (tr == null || !tr[i]) return;
    const inputs = document.querySelectorAll('#manual-tranches-list .mt-amount');
    if (inputs[i]) inputs[i].value = (tr[i].amount != null) ? App._formatMoney(tr[i].amount) : '';
  },
  // Заполнить транши датами по выбранной периодичности (суммы пустые — заполнит оператор).
  fillTranchesByFreq() {
    const tr = App._caseTranches();
    if (tr == null) { App.showMsg('Сначала примените данные по компании.', 'error'); return; }
    const z = App.zayavka;
    const freq = document.getElementById('paymentFrequency')?.value || 'month';
    const dates = Utils.calcPaymentTranches(freq, z.periodFrom, z.periodTo);
    z.tranchesFromFile = dates.map(d => ({ date: d.toISOString(), amount: null }));
    App.renderManualTranches();
    App._persistCase();
  },

  // ===== ОКЭД INPUT HANDLER =====
  onOkedChange() {
    const input = document.getElementById('okedInput');
    const hint = document.getElementById('oked-hint');
    const result = document.getElementById('oked-result');
    if (!input || !result) return;
    const code = input.value.trim();
    if (!code) {
      // Empty — fall back to zayavka
      result.innerHTML = '';
      result.classList.remove('visible', 'oked-result--found', 'oked-result--missing');
      if (hint) hint.textContent = '';
    } else if (!App.refData.classifier) {
      if (hint) hint.textContent = '';
      result.classList.add('visible', 'oked-result--missing');
      result.classList.remove('oked-result--found');
      result.innerHTML = '<span class="oked-warn">⚠ Загрузите справочник «Классификатор ОКЭД» для поиска класса и деятельности</span>';
    } else {
      if (hint) hint.textContent = '';
      const found = Utils.lookupOked(code, App.refData.classifier);
      if (found) {
        result.classList.add('visible', 'oked-result--found');
        result.classList.remove('oked-result--missing');
        const sourceTag = found.source === 'exact'
          ? '<span class="oked-source oked-source--exact">точное совпадение</span>'
          : '<span class="oked-source oked-source--prefix">по префиксу</span>';
        result.innerHTML = `
          <div class="oked-found-line">
            <span class="oked-label">Класс риска:</span>
            <strong class="oked-cls">${found.cls}</strong>
            ${sourceTag}
          </div>
          <div class="oked-found-line">
            <span class="oked-label">Деятельность:</span>
            <strong class="oked-name">${found.name}</strong>
          </div>`;
      } else {
        result.classList.add('visible', 'oked-result--missing');
        result.classList.remove('oked-result--found');
        result.innerHTML = `<span class="oked-warn">⚠ ОКЭД «${code}» не найден в классификаторе</span>`;
      }
    }
    // После определения эффективного ОКЭДа — auto-выбор activity, всегда.
    // Resolved ОКЭД может быть из заявки даже когда ручной инпут пуст.
    App._autoSelectActivityByOked();
    App._renderActivityHint();
    App.renderCompanyOkeds();
    // Для ручного режима пересчитать премию (после resolved ОКЭД/класса)
    App._recalcManualPremium();
  },

  // ===== ACTIVITY DROPDOWN =====
  // Структура App.refData.calculator:
  //   { activities: [{ name, deathRate, injuryRate }, ...], okedMap: { '07298': 'имя', ... } }
  // Backward-compat: если в кэше лежит массив — оборачиваем.
  _calcActivities() {
    const c = App.refData.calculator;
    if (!c) return [];
    if (Array.isArray(c)) return c;
    return c.activities || [];
  },
  _calcOkedMap() {
    const c = App.refData.calculator;
    if (!c || Array.isArray(c)) return {};
    return c.okedMap || {};
  },

  // Trackers
  _activityAutoForOked: null,  // ОКЭД, для которого dropdown был выставлен авто
  _lastResolvedOked: null,     // последний resolved ОКЭД (для UI и сравнений)

  populateActivityDropdown() {
    const select = document.getElementById('activitySelect');
    if (!select) return;
    const list = App._calcActivities();
    if (!list.length) {
      select.innerHTML = '<option value="">— загрузите справочник «Калькулятор рентабельности» —</option>';
      return;
    }
    const prev = localStorage.getItem('selected_activity_idx');
    const opts = ['<option value="">— не выбрано —</option>'];
    list.forEach((a, i) => {
      const death = (a.deathRate || 0).toFixed(3).replace('.', ',');
      const injury = (a.injuryRate || 0).toFixed(3).replace('.', ',');
      opts.push(`<option value="${i}">${a.name} (смерть ${death} / травма ${injury})</option>`);
    });
    select.innerHTML = opts.join('');
    if (prev != null && list[Number(prev)]) {
      select.value = prev;
    }
    // Auto-detect по ОКЭД (если ОКЭД уже известен и не было ручного выбора).
    App._autoSelectActivityByOked();
    App._renderActivityHint();
  },

  // user-driven event (onchange="App.onActivityChange()" в html)
  onActivityChange() {
    const select = document.getElementById('activitySelect');
    if (!select) return;
    const idx = select.value;
    if (idx === '' || idx == null) {
      localStorage.removeItem('selected_activity_idx');
      localStorage.removeItem('manual_activity_for_oked');
      App._activityAutoForOked = null;
    } else {
      localStorage.setItem('selected_activity_idx', String(idx));
      // Если пользователь сам поменял — помечаем как ручной для текущего ОКЭДа.
      if (App._lastResolvedOked) {
        localStorage.setItem('manual_activity_for_oked', App._lastResolvedOked);
      }
      App._activityAutoForOked = null;
    }
    App._renderActivityHint();
  },

  // Диагностика выбора «Вид деятельности» — лог под dropdown.
  // Объясняет ОПЕРАТОРУ:
  //   1. что сказал statsnet (найдена ли отрасль для текущего БИНа)
  //   2. что есть в таблице калькулятора по текущему ОКЭДу
  //   3. что в итоге выбрано и почему именно так
  // Особенно полезно когда auto-detect не сработал — видно, в чём причина.
  _renderActivityDiagnostics() {
    const el = document.getElementById('activity-diagnostics');
    if (!el) return;
    const bin = App.zayavka?.bin || '—';
    const resolved = App._resolveOked ? App._resolveOked() : {};
    const oked = resolved.oked || '';
    const okedMap = App._calcOkedMap();
    const calcLoaded = !!App.refData?.calculator;
    const select = document.getElementById('activitySelect');
    const selIdx = select?.value;
    const activities = App._calcActivities();
    const selActivity = (selIdx !== '' && selIdx != null) ? activities[Number(selIdx)] : null;

    // --- 1. statsnet ---
    const sn = App.statsnet || null;
    let snLine, snCls;
    if (!sn) {
      snLine = '— ещё не запускался (нажмите «🔎 Найти отрасль через statsnet»)';
      snCls = 'ad-value--muted';
    } else if (sn.loading) {
      snLine = '⏳ идёт поиск (statsnet.co через background-вкладку)…';
      snCls = 'ad-value--muted';
    } else if (sn.error) {
      snLine = `⚠ ${sn.error}`;
      snCls = 'ad-value--warn';
    } else if (sn.found === false) {
      snLine = `⚠ по БИН ${bin} отрасль не найдена в statsnet.co`;
      snCls = 'ad-value--warn';
    } else if (sn.found && sn.industry) {
      // Был ли match с категориями калькулятора?
      const match = App._findActivityByIndustry ? App._findActivityByIndustry(sn.industry) : null;
      if (match) {
        snLine = `✓ найдено «${sn.industry}» → совпало с категорией №${match.idx + 1} «${match.name}» (${match.kind}, score ${match.score.toFixed(2)})`;
        snCls = 'ad-value--ok';
      } else {
        snLine = `✓ найдено «${sn.industry}», но НЕ совпало ни с одной из ${activities.length} категорий калькулятора — нужен ручной выбор`;
        snCls = 'ad-value--warn';
      }
    } else {
      snLine = '—';
      snCls = 'ad-value--muted';
    }

    // --- 2. Таблица (калькулятор Лист3 — okedMap) ---
    let tableLine, tableCls;
    if (!calcLoaded) {
      tableLine = '⚠ калькулятор рентабельности не загружен — загрузите справочник';
      tableCls = 'ad-value--err';
    } else if (!oked) {
      tableLine = '— ОКЭД не определён (загрузите заявку или укажите вручную)';
      tableCls = 'ad-value--muted';
    } else if (okedMap[oked]) {
      const entry = okedMap[oked];
      const name = (entry && typeof entry === 'object') ? entry.activityName : entry;
      const idx = activities.findIndex(a => a.name === name);
      tableLine = `✓ по ОКЭД ${oked} → «${name}»${idx >= 0 ? ` (категория №${idx + 1})` : ' (категория не нашлась в списке Лист2)'}`;
      tableCls = 'ad-value--ok';
    } else {
      // Нет в okedMap — ищем по префиксу для подсказки
      const prefixHits = Object.keys(okedMap).filter(k => k.startsWith(String(oked).slice(0, 2))).slice(0, 3);
      tableLine = `⚠ для ОКЭД ${oked} нет маппинга в калькуляторе (Лист3)`;
      if (prefixHits.length) {
        tableLine += `. Близкие ОКЭДы с маппингом: ${prefixHits.join(', ')}`;
      }
      tableCls = 'ad-value--warn';
    }

    // --- 3. Причина почему не выбрано (если не выбрано). «Итог» строка убрана —
    //        выбранная деятельность видна в самом dropdown выше.
    let reasonLine = '';
    if (!selActivity) {
      if (!calcLoaded) reasonLine = 'Причина: калькулятор не загружен.';
      else if (!oked) reasonLine = 'Причина: ОКЭД не определён.';
      else if (!okedMap[oked]) reasonLine = `Причина: ОКЭД ${oked} отсутствует в маппинге калькулятора, statsnet ${(sn?.found ? 'не дал совпадения' : 'не нашёл отрасль')} — выберите вид деятельности вручную.`;
      else reasonLine = 'Причина: не выбрано (хотя маппинг по ОКЭДу есть — кликните «Применить» или сбросьте ручную метку).';
    }

    const row = (label, value, cls) =>
      `<div class="ad-row"><span class="ad-label">${label}</span><span class="ad-value ${cls || ''}">${value}</span></div>`;

    el.classList.add('visible');
    el.innerHTML =
      `<div class="ad-title">🔍 Диагностика выбора деятельности</div>` +
      row('statsnet:', snLine, snCls) +
      row('таблица:', tableLine, tableCls) +
      (reasonLine ? `<div class="ad-hint">${reasonLine}</div>` : '');
  },

  _renderActivityHint() {
    const select = document.getElementById('activitySelect');
    const result = document.getElementById('activity-result');
    if (!select || !result) return;
    const idx = select.value;
    if (idx === '' || idx == null) {
      result.classList.remove('visible', 'oked-result--found');
      result.innerHTML = '';
      // Диагностика всё равно рендерится — оператор должен видеть «почему не выбрано»
      App._renderActivityDiagnostics();
      return;
    }
    const a = App._calcActivities()[Number(idx)];
    if (!a) return;

    // Контекст по самой компании: ОКЭД-название (из stat.gov.kz если активный
    // ОКЭД совпадает с primary; иначе из ОКЭД-classifier через _collectCompanyOkeds),
    // класс риска, тариф.
    const resolved = App._resolveOked ? App._resolveOked() : {};
    const oked = resolved.oked || '—';
    let okedName = resolved.activity || '—';
    const sg = App.statgov && !App.statgov.loading && !App.statgov.error ? App.statgov : null;
    if (sg && resolved.oked === sg.okedPrimaryCode && sg.okedPrimaryName) {
      // Для primary берём специфичное название из stat.gov.kz
      okedName = sg.okedPrimaryName;
    } else {
      // Для secondary или ручного — ищем имя через _collectCompanyOkeds (он сам
      // соберёт name из classifier).
      const company = App._collectCompanyOkeds ? App._collectCompanyOkeds() : [];
      const found = company.find(o => o.code === resolved.oked);
      if (found && found.name) okedName = found.name;
    }
    const riskClass = resolved.riskClass || '—';
    const tariff = App._resolveTariff(resolved.riskClass);
    const tariffStr = tariff != null ? Utils.fmtPct(tariff) : '—';

    const isAuto = App._isAutoActivityForOked(resolved.oked);
    const sourceTag = isAuto
      ? '<span class="oked-source oked-source--exact">авто по ОКЭД</span>'
      : '<span class="oked-source oked-source--prefix">выбрано вручную</span>';

    result.classList.add('visible', 'oked-result--found');
    result.classList.remove('oked-result--missing');
    result.innerHTML = `
      <div class="oked-found-line">
        <span class="oked-label">ОКЭД ${oked}:</span> <strong>${okedName}</strong>
      </div>
      <div class="oked-found-line">
        <span class="oked-label">Класс риска:</span> <strong>${riskClass}</strong>
        &nbsp;&nbsp;<span class="oked-label">Тариф:</span> <strong>${tariffStr}</strong>
        &nbsp;&nbsp;${sourceTag}
      </div>`;
    // Параллельно рисуем диагностику (statsnet/таблица/итог)
    App._renderActivityDiagnostics();
  },

  // Auto-detect = true, если для текущего ОКЭДа нет manual marker в localStorage
  // И в окед-маппинге калькулятора этот ОКЭД присутствует.
  _isAutoActivityForOked(oked) {
    if (!oked) return false;
    const okedMap = App._calcOkedMap();
    if (!okedMap[oked]) return false;
    return localStorage.getItem('manual_activity_for_oked') !== oked;
  },

  // Тариф «связан» с активным ОКЭДом.
  // Если ОКЭД остался из заявки (source = 'zayavka') — используем z.tariff (D12).
  // Если ОКЭД изменился (manual, statgov-max-class, override) — пересчитываем
  // через справочник/классификатор по новому классу.
  // Страховой тариф по номеру класса напрямую из справочника «Поправочные
  // коэффициенты» (без обращения к _resolveOked — иначе рекурсия). Возвращает
  // долю (напр. 0.0129) или null. Используется для выбора класса с макс. тарифом.
  _tariffByClass(cls) {
    const rr = App.refData && App.refData.popravka && App.refData.popravka.riskRates;
    if (!rr || cls == null) return null;
    const t = rr.get(cls);
    return Number.isFinite(t) ? t : null;
  },

  _resolveTariff(riskClass) {
    const z = App.zayavka || {};
    const resolved = App._resolveOked ? App._resolveOked() : { source: 'zayavka' };
    const okedFromZayavka = resolved.source && resolved.source.startsWith('zayavka');

    if (okedFromZayavka && z.tariff != null && z.tariff !== '') {
      const t = Number(z.tariff);
      if (Number.isFinite(t)) return t;
    }
    if (App.refData.popravka && App.refData.popravka.riskRates && riskClass) {
      const t = App.refData.popravka.riskRates.get(riskClass);
      if (Number.isFinite(t)) return t;
    }
    if (App.refData.classifier && resolved.oked) {
      const entry = App.refData.classifier.find(e => !e.isPrefix && e.okedRaw === String(resolved.oked));
      if (entry && Number.isFinite(entry.tariff)) return entry.tariff;
    }
    // Last-resort fallback на z.tariff если ничего не нашли
    if (z.tariff != null && z.tariff !== '') {
      const t = Number(z.tariff);
      if (Number.isFinite(t)) return t;
    }
    return null;
  },

  _getSelectedActivity() {
    const idx = localStorage.getItem('selected_activity_idx');
    const list = App._calcActivities();
    if (idx != null && list[Number(idx)]) {
      return list[Number(idx)];
    }
    return null;
  },

  // Авто-выбор activity по ОКЭД (если есть маппинг в калькуляторе).
  // НЕ трогает выбор, если для текущего ОКЭДа уже был ручной (manual_activity_for_oked).
  _autoSelectActivityByOked() {
    const select = document.getElementById('activitySelect');
    if (!select) return;
    const okedMap = App._calcOkedMap();
    const list = App._calcActivities();
    if (!list.length) return;

    const resolved = App._resolveOked ? App._resolveOked() : { oked: null };
    const oked = resolved.oked;
    App._lastResolvedOked = oked;
    if (!oked || !okedMap[oked]) return;

    // Если для этого ОКЭДа уже был ручной выбор — не перезаписываем.
    if (localStorage.getItem('manual_activity_for_oked') === oked) {
      // Но если он раньше был auto, сейчас уже не auto — снять метку.
      App._activityAutoForOked = null;
      return;
    }

    // okedMap[oked] — это объект { activityName, ... } после миграции на Лист3
    const entry = okedMap[oked];
    const name = (entry && typeof entry === 'object') ? entry.activityName : entry; // обр. совм. со строкой
    const idx = list.findIndex(a => a.name === name);
    if (idx >= 0) {
      select.value = String(idx);
      localStorage.setItem('selected_activity_idx', String(idx));
      App._activityAutoForOked = oked;
    }
  },

  // ===== CACHE MANAGEMENT =====
  restoreCache() {
    try {
      const nameOf = (t) => localStorage.getItem(`ref_${t}_name`) || 'Загружен';
      // Popravka
      const popravkaStr = localStorage.getItem('ref_popravka');
      if (popravkaStr) {
        const obj = JSON.parse(popravkaStr);
        App.refData.popravka = {
          riskRates: new Map(obj.riskRates),
          adjustmentCoeffs: obj.adjustmentCoeffs,
        };
        App.updateRefStatus('popravka', true, nameOf('popravka'));
      }

      // Normativ raw buffer
      const normativBase64 = localStorage.getItem('ref_normativ_raw');
      if (normativBase64) {
        App._rawNormativBuffer = App._base64ToArrayBuffer(normativBase64);
        App.refData.normativ = ExcelReader.readNormativ(App._rawNormativBuffer);
        App.updateRefStatus('normativ', true, nameOf('normativ'));
      }

      // KU
      const kuStr = localStorage.getItem('ref_ku');
      if (kuStr) {
        App.refData.ku = JSON.parse(kuStr);
        App.updateRefStatus('ku', true, nameOf('ku'));
      }

      // Manual overrides (normativ + ku) — поверх Excel-данных. Должно идти
      // после восстановления normativ/ku, иначе _applyRefOverrides не найдёт
      // куда писать. fillRefOverrideInputs работает с DOM, в этой точке
      // index.html уже отрисован (restoreCache вызывается из init).
      App._restoreRefOverrides();
      // Также показываем в инпутах автозаполненные значения из Excel
      // (для тех полей, что не переопределены вручную).
      App._prefillRefInputsFromExcel('normativ');
      App._prefillRefInputsFromExcel('ku');

      // Лимиты процедуры — overrides → Utils/App + заполнение инпутов.
      App._restoreLimits();

      // Подписанты — overrides → Utils.* (имена в АР, СЗ, Протоколе, Заключении).
      App._restoreSigners();

      // Calculator
      const calcStr = localStorage.getItem('ref_calculator');
      if (calcStr) {
        App.refData.calculator = JSON.parse(calcStr);
        App.updateRefStatus('calculator', true, nameOf('calculator'));
        App.populateActivityDropdown();
      }

      // Classifier
      const classifierStr = localStorage.getItem('ref_classifier');
      if (classifierStr) {
        App.refData.classifier = JSON.parse(classifierStr);
        App.updateRefStatus('classifier', true, nameOf('classifier'));
      }

      // Affiliated persons list
      const affiliatedStr = localStorage.getItem('ref_affiliated');
      if (affiliatedStr) {
        App.refData.affiliated = JSON.parse(affiliatedStr);
        App.updateRefStatus('affiliated', true, nameOf('affiliated'));
      }

      App.updateRefBadge();
    } catch (e) {
      console.error('Cache restore error:', e);
    }
  },

  // «Очистить кэш» в шапке раздела «Справочники». Удаляет ВСЕ справочники
  // и связанные настройки — поэтому обязательно с подтверждением.
  async clearCache() {
    const loaded = ['popravka', 'normativ', 'ku', 'calculator', 'classifier', 'affiliated']
      .filter(t => !!App.refData[t])
      .map(t => App.REF_LABELS[t] || t);
    const ok = await App.confirmDialog({
      title: 'Очистить весь кэш справочников?',
      text: (loaded.length
        ? `Будут удалены все загруженные справочники (${loaded.length} из 6):\n${loaded.join(', ')}.\n`
        : 'Будут удалены все сохранённые данные справочников.\n') +
        'А также ручные вводы, лимиты и подписанты. Файлы придётся загрузить заново.',
      confirmLabel: 'Очистить всё',
    });
    if (!ok) return;
    localStorage.removeItem('ref_popravka');
    localStorage.removeItem('ref_normativ_raw');
    localStorage.removeItem('ref_ku');
    localStorage.removeItem('ref_calculator');
    localStorage.removeItem('ref_classifier');
    localStorage.removeItem('ref_affiliated');
    localStorage.removeItem('ref_normativ_override');
    localStorage.removeItem('ref_ku_override');
    localStorage.removeItem('ref_limits');
    localStorage.removeItem('ref_signers');
    localStorage.removeItem('manual_verdict');
    localStorage.removeItem('selected_activity_idx');
    ['popravka', 'normativ', 'ku', 'calculator', 'classifier', 'affiliated']
      .forEach(t => localStorage.removeItem(`ref_${t}_name`));
    localStorage.removeItem('manual_activity_for_oked');
    App.refData = { popravka: null, normativ: null, ku: null, calculator: null, classifier: null, affiliated: null, limits: {}, signers: {} };
    App.refOverride = { normativ: {}, ku: {} };
    App._rawNormativBuffer = null;
    ['popravka', 'normativ', 'ku', 'calculator', 'classifier', 'affiliated'].forEach(t => App.updateRefStatus(t, false));
    App.updateRefBadge();
    App.populateActivityDropdown();
    // Сбросить override-инпуты + лимиты + подписанты
    App.fillRefOverrideInputs('normativ');
    App.fillRefOverrideInputs('ku');
    App._syncLimitsToGlobals();
    App._fillLimitsInputs();
    App._syncSignersToUtils();
    App._fillSignersInputs();
    const verdictSel = document.getElementById('verdict');
    if (verdictSel) verdictSel.value = 'auto';
    App.updateVerdictHint();
    App.showMsg('Кэш очищен.', 'success');
  },

  // ===== FILE UTILS =====
  _readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(new Uint8Array(e.target.result));
      reader.onerror = () => reject(new Error('Ошибка чтения файла'));
      reader.readAsArrayBuffer(file);
    });
  },

  _arrayBufferToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  },

  _base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  },
};

// Initialize on load
document.addEventListener('DOMContentLoaded', App.init);
