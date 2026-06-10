// ai-prompt.js — построение промпта «второго мнения» для ИИ-консультанта.
// Зависит ТОЛЬКО от snapshot'а аналитики (см. App._buildAnalyticsSnapshot),
// поэтому используется с двух страниц:
//   - analytics.html (дашборд, snapshot из localStorage)
//   - index.html (главная форма, snapshot строится на лету)

(function () {
  'use strict';

  function build(snap) {
    if (!snap || !snap.analytics) return null;
    const A = snap.analytics;
    const z = snap.zayavka || {};
    const sev = A.bySeverity || {};
    const conc = A.concentration || {};
    const fs = A.freqSeverity || {};
    const settl = A.settlement || {};
    const lag = A.reportingLag || {};
    const premium = z.premiumWithCoeff || z.premiumBase || 0;
    const sumInsured = z.insuranceSum || 0;
    const lambda = A.avgFreq || 0;
    const mu = A.finance?.avg || 0;
    const cv = fs.cv || 1;
    const portfolioLR = snap.ku ? snap.ku.lossRatioWith * 100 : null;
    const assets = snap.normativ?.fullAssetsTenge || 0;

    const fmtT = (n) => n != null ? Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₸' : '—';
    const fmtT_M = (n) => {
      if (n == null) return '—';
      const abs = Math.abs(n);
      if (abs >= 1e9) return (n / 1e9).toFixed(2).replace('.', ',') + ' млрд ₸';
      if (abs >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' М ₸';
      if (abs >= 1e3) return (n / 1e3).toFixed(0) + ' тыс ₸';
      return fmtT(n);
    };
    const pct = (n, d = 1) => n != null ? n.toFixed(d).replace('.', ',') + ' %' : '—';
    const num = (n) => n != null ? Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : '—';
    const date = (iso) => {
      if (!iso) return '—';
      const d = new Date(iso);
      return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    };

    const insurerLines = (A.byInsurer || []).slice(0, 5).map((i, idx) =>
      `  • Страховщик #${idx + 1}: ${num(i.count)} дел, ${fmtT_M(i.sum)} выплат, ср. выплата ${fmtT_M(i.avgPayment)}`
    ).join('\n');
    const yearLines = (A.byYear || []).map(y =>
      `  • ${y.year}: ${num(y.cases)} признанных НС, ${num(y.paid)} с выплатой, выплат ${fmtT_M(y.sum)}, смертельных ${num(y.death)}, УПТ≥30% ${num(y.uptHigh)}`
    ).join('\n');
    const quarterLines = (A.byQuarter || []).map(q =>
      `  • ${q.label}: ${num(q.cases)} НС, ${fmtT_M(q.sum)}`
    ).join('\n');

    const sevDeath = sev.death?.count || 0;
    const sevDeathSum = sev.death?.sum || 0;
    const sevUpt90 = sev.upt90?.count || 0;
    const sevUpt60 = sev.upt60?.count || 0;
    const sevUpt30 = sev.upt30?.count || 0;
    const sevUptHigh = sevUpt90 + sevUpt60 + sevUpt30;
    const sevUptHighSum = (sev.upt90?.sum || 0) + (sev.upt60?.sum || 0) + (sev.upt30?.sum || 0);
    const sevEarn = sev.earnLoss?.count || 0;
    const sevEarnSum = sev.earnLoss?.sum || 0;
    const sevOther = sev.other?.count || 0;
    const sevOtherSum = sev.other?.sum || 0;

    const L = [];
    L.push('Ты опытный независимый андеррайтер обязательного страхования работника от несчастных случаев (ОСНС) в Казахстане.');
    L.push('');
    L.push('Применимое законодательство:');
    L.push('• Закон РК «Об обязательном страховании работника от несчастных случаев при исполнении им трудовых (служебных) обязанностей» от 7 февраля 2005 года № 30-III');
    L.push('• Социальный кодекс РК (в части статьи 195-1 и соответствующих рисков)');
    L.push('• Нормативные правовые акты Агентства РК по регулированию и развитию финансового рынка (АРРФР)');
    L.push('• Стандарты Solvency II как методологическая база для актуарных расчётов');
    L.push('');
    L.push('Я предоставлю обезличенные данные. Твоя задача:');
    L.push('1. Самостоятельно рассчитать ключевые актуарные показатели (Burning Cost, Pure Premium, КУ, PML, Combined Ratio, RAROC, Economic Capital).');
    L.push('2. Дать независимое заключение, опирающееся на цифры и НПА РК, а не на готовые «выводы».');
    L.push('3. Обосновать каждую рекомендацию конкретной формулой, ссылкой на отраслевую норму или нормативно-правовым актом.');
    L.push('4. Сохранять нейтральность: не пытаться оправдать или забраковать договор заранее.');
    L.push('5. Если данных недостаточно или есть логические нестыковки — указать прямо.');
    L.push('');
    L.push('═════════════════════════════════════════');
    L.push('  1. ПРОФИЛЬ РИСКА');
    L.push('═════════════════════════════════════════');
    if (z.oked) L.push(`• ОКЭД: ${z.oked}`);
    if (z.activity) L.push(`• Вид деятельности: ${z.activity}`);
    if (z.riskClass) L.push(`• Класс профессионального риска: ${z.riskClass} (из 25)`);
    if (z.workers) L.push(`• Численность застрахованных: ${num(z.workers)} чел.`);
    if (z.region) L.push(`• Регион / филиал: ${z.region}`);
    if (z.govParticipation) L.push(`• Государственное участие: ${z.govParticipation}`);

    L.push('');
    L.push('═════════════════════════════════════════');
    L.push('  2. УСЛОВИЯ РАССМАТРИВАЕМОГО ДОГОВОРА');
    L.push('═════════════════════════════════════════');
    L.push(`• Страховая сумма (S.I.): ${fmtT(sumInsured)}`);
    if (z.tariff != null) L.push(`• Базовый тариф по ОКЭД: ${pct(z.tariff * 100, 3)}`);
    if (z.coeff != null) L.push(`• Поправочный коэффициент (по матрице «работники × НС»): ${z.coeff}`);
    if (z.coeffDown != null) L.push(`• Понижающий коэффициент: ${pct((z.coeffDown || 0) * 100, 0)}`);
    L.push(`• Премия по договору (P): ${fmtT(premium)}`);
    if (z.periodFrom && z.periodTo) L.push(`• Период страхования: ${date(z.periodFrom)} – ${date(z.periodTo)} (12 месяцев)`);
    if (z.paymentOrder) L.push(`• Порядок оплаты: ${z.paymentOrder}`);

    L.push('');
    L.push('═════════════════════════════════════════');
    L.push('  3. СТАТИСТИКА УБЫТКОВ ЗА 3 ГОДА (СЫРЫЕ ДАННЫЕ)');
    L.push('═════════════════════════════════════════');
    L.push(`Период анализа: ${date(A.cutoffDate)} – ${date(A.reportDate)}`);
    L.push('');
    L.push('A. ОБЪЁМЫ:');
    L.push(`  • Заявленных страховых случаев: ${num(A.recognition.filed)}`);
    L.push(`  • Признано страховыми: ${num(A.recognition.recognized)}`);
    L.push(`  • Отказов (недоказанность): ${num(A.recognition.rejected)}`);
    L.push(`  • На рассмотрении: ${num(A.recognition.pending)}`);
    L.push(`  • С произведённой выплатой: ${num(A.recognition.paid)}`);
    L.push(`  • РЗНУ на отчётную дату: ${num(A.recognition.rznu)}`);
    L.push(`  • За последние 12 мес.: ${num(A.last12?.cases)} НС, ${fmtT_M(A.last12?.sum)}`);

    L.push('');
    L.push('B. ФИНАНСОВЫЕ ВЫПЛАТЫ:');
    L.push(`  • Совокупная сумма выплат за 3 года: ${fmtT(A.sumTotal3y)}`);
    L.push(`  • Среднегодовая сумма (E[S] годовая): ${fmtT(A.avgSumPerYear)}`);
    L.push(`  • Среднегодовая частота (λ): ${num(lambda)} НС/год`);
    L.push(`  • Средняя выплата на дело (μ): ${fmtT(mu)}`);
    L.push(`  • Медиана выплаты: ${fmtT(A.finance.median)}`);
    L.push(`  • Минимум / Максимум: ${fmtT(A.finance.min)} / ${fmtT(A.finance.max)}`);
    L.push(`  • Перцентили: P25 ${fmtT(A.finance.p25)} · P75 ${fmtT(A.finance.p75)} · P90 ${fmtT(A.finance.p90)} · P99 ${fmtT(A.finance.p99)}`);
    L.push(`  • Коэффициент вариации выплат (CV_severity): ${cv.toFixed(2).replace('.', ',')}`);

    L.push('');
    L.push('C. СТРУКТУРА ПО ТЯЖЕСТИ (категориальная):');
    L.push(`  • Смерть: ${num(sevDeath)} случаев, сумма ${fmtT_M(sevDeathSum)}`);
    L.push(`  • УПТ 90–100 %: ${num(sevUpt90)}`);
    L.push(`  • УПТ 60–89 %: ${num(sevUpt60)}`);
    L.push(`  • УПТ 30–59 %: ${num(sevUpt30)}`);
    L.push(`  • УПТ ≥ 30 % суммарно: ${num(sevUptHigh)} случаев, сумма ${fmtT_M(sevUptHighSum)}`);
    L.push(`  • Утрата заработка > 1 года (аннуитеты): ${num(sevEarn)}, сумма ${fmtT_M(sevEarnSum)}`);
    L.push(`  • Иное / неклассифицированное: ${num(sevOther)}, сумма ${fmtT_M(sevOtherSum)}`);

    L.push('');
    L.push('D. ДИНАМИКА ПО ГОДАМ:');
    L.push(yearLines || '  • (нет данных)');

    if (A.byQuarter && A.byQuarter.some(q => q.cases > 0)) {
      L.push('');
      L.push('E. СЕЗОННОСТЬ (по кварталам за 3 года):');
      L.push(quarterLines);
    }

    if ((A.byInsurer || []).length > 0) {
      const concName = conc.hhiBand === 'low' ? 'фрагментированный портфель'
        : conc.hhiBand === 'moderate' ? 'умеренная концентрация'
        : conc.hhiBand === 'high' ? 'высокая концентрация'
        : 'крайне высокая концентрация';
      L.push('');
      L.push('F. РАСПРЕДЕЛЕНИЕ ПО СТРАХОВЩИКАМ (обезличено):');
      L.push(`  Индекс Herfindahl-Hirschman HHI = ${num(conc.hhi)} (${concName})`);
      L.push(insurerLines);
    }

    L.push('');
    L.push('G. ОПЕРАЦИОННЫЕ ХАРАКТЕРИСТИКИ:');
    if (settl.count) {
      L.push(`  • Время урегулирования (СК → первая выплата): среднее ${num(settl.avg)} дней, медиана ${num(settl.median)} дней, максимум ${num(settl.max)} дней`);
      L.push(`  • Распределение: до 30 дн. ${num(settl.buckets?.to30)}, 31–90 ${num(settl.buckets?.to90)}, 91–180 ${num(settl.buckets?.to180)}, 181–365 ${num(settl.buckets?.to365)}, >365 ${num(settl.buckets?.over365)}`);
    }
    if (lag.count) {
      L.push(`  • Лаг заявления (СК → ввод в систему): среднее ${num(lag.avg)} дн., медиана ${num(lag.median)} дн., макс ${num(lag.max)} дн.`);
    }
    if (A.annuity) {
      L.push(`  • Аннуитетная нагрузка: ${num(A.annuity.withMultiple)} дел с >1 выплат`);
    }

    L.push('');
    L.push('H. КОНЦЕНТРАЦИЯ И ХВОСТОВОЙ РИСК:');
    L.push(`  • Tail concentration (топ 10 % дел по сумме): ${pct(conc.tailConcentration, 1)} от совокупных выплат`);
    L.push(`  • Катастрофические события (выплата ≥ 50 М ₸): ${num(conc.catastrophicCount)} дел, ${fmtT_M(conc.catastrophicSum)}`);
    L.push(`  • Максимальный период без смертельных случаев: ${num(conc.longestNoDeathStreak)} дней`);

    L.push('');
    L.push('═════════════════════════════════════════');
    L.push('  4. ОТРАСЛЕВОЙ И ПОРТФЕЛЬНЫЙ КОНТЕКСТ');
    L.push('═════════════════════════════════════════');
    if (snap.activity) {
      L.push(`Норма по ОКЭД ${z.oked || ''} (из калькулятора рентабельности):`);
      L.push(`  • Коэффициент смертельных НС: ${snap.activity.deathRate?.toFixed(3).replace('.', ',') || '—'} на 1000 чел./год`);
      L.push(`  • Коэффициент травматизма: ${snap.activity.injuryRate?.toFixed(3).replace('.', ',') || '—'} на 1000 чел./год`);
      L.push(`  • Суммарная норма: ${((snap.activity.deathRate || 0) + (snap.activity.injuryRate || 0)).toFixed(3).replace('.', ',')} НС на 1000 чел./год`);
    } else {
      L.push('(Отраслевые нормы по ОКЭД не предоставлены — используй стандартные среднеотраслевые ставки для ОСНС в РК.)');
    }
    L.push('');
    L.push('Портфельные показатели страховой компании:');
    if (portfolioLR != null) L.push(`  • Коэффициент убыточности портфеля ОСНС: ${pct(portfolioLR, 2)} (с учётом доли перестраховщика)`);
    if (assets) L.push(`  • Активы Компании в страховых резервах: ${fmtT(assets)}`);
    L.push('  • Целевой уровень КУ Компании: ≤ 70 %');
    L.push('  • Регуляторный лимит Андеррайтингового Совета: страховая сумма ≤ 3 млрд ₸');
    L.push('  • Свыше 3 млрд ₸ — требуется одобрение Правления');

    L.push('');
    L.push('═════════════════════════════════════════');
    L.push('  ЗАДАНИЕ');
    L.push('═════════════════════════════════════════');
    L.push('');
    L.push('ШАГ 1. САМОСТОЯТЕЛЬНЫЙ РАСЧЁТ КЛЮЧЕВЫХ МЕТРИК');
    L.push('Рассчитай и приведи численно (с формулами и подстановкой):');
    L.push('  a) Burning Cost = совокупные выплаты за 3 года ÷ 3 ÷ страховая сумма');
    L.push('  b) Pure Premium Rate = E[S]/год ÷ страховая сумма');
    L.push('  c) Прогнозный коэффициент убыточности (Loss Ratio) = E[S]/год ÷ Премия');
    L.push('  d) Combined Ratio = LR + 25 % (типовой Expense Ratio для ОСНС в РК)');
    L.push('  e) Compound Poisson моменты: E[S] = λ × μ, σ²[S] = λ × μ² × (CV² + 1)');
    L.push('  f) PML 99 % = E[S] + 2,326 × σ[S]');
    L.push('  g) TVaR 99 % (Expected Shortfall) = E[S] + 2,665 × σ[S]');
    L.push('  h) Economic Capital (Solvency II 99,5 %) = 2,576 × σ[S]');
    L.push('  i) RAROC = (Премия − E[S] − Расходы 25 %) ÷ EC');
    L.push('  j) Solvency Impact = PML 99 % ÷ Активы Компании');
    L.push('  k) Adverse Selection Index = Фактическая частота ÷ Норма ОКЭД (кратность)');
    L.push('  l) Sufficiency Ratio = Текущая премия ÷ (E[S]/0,7) для целевого КУ 70 %');
    L.push('');
    L.push('ШАГ 2. СОПОСТАВЛЕНИЕ С НОРМАМИ');
    L.push('  • Сравни рассчитанные показатели с нормами по ОКЭД и портфельными значениями.');
    L.push('  • Оцени отклонение по 4-балльной шкале:');
    L.push('    — норма (×1–×1,5)');
    L.push('    — умеренное (×1,5–×3)');
    L.push('    — повышенное (×3–×10)');
    L.push('    — критическое (×10+)');
    L.push('');
    L.push('ШАГ 3. ПРОВЕРКА СООТВЕТСТВИЯ ЗАКОНОДАТЕЛЬСТВУ');
    L.push('Оцени, соответствует ли договор требованиям:');
    L.push('  • Закон РК № 30-III от 07.02.2005 — корректность тарифной классификации по ОКЭД, расчёта страховой суммы (минимум 10 МЗП на работника при УПТ), порядка определения страховой премии');
    L.push('  • Социальный кодекс РК — покрытие рисков по ст. 195-1 (расширенные риски)');
    L.push('  • НПА АРРФР — лимиты собственного удержания, требования к перестрахованию, нормативы достаточности маржи платёжеспособности');
    L.push('  • Регуляторный лимит АС (3 млрд ₸) — кто компетентен принять решение');
    L.push('');
    L.push('ШАГ 4. НЕЗАВИСИМОЕ ЗАКЛЮЧЕНИЕ');
    L.push('  • Дай свой композитный риск-скор от 0 до 100 (твоя методика, описать веса)');
    L.push('  • Выбери ОДИН из 4 вердиктов и обоснуй:');
    L.push('    1) Принятие со стандартным тарифом');
    L.push('    2) Принятие с повышающим коэффициентом (указать кратность × N)');
    L.push('    3) Отклонение по степени риска (привести 3 главных причины)');
    L.push('    4) Отложение (указать какие данные нужны)');
    L.push('  • Все рекомендации обоснуй: цифры → метод → закон');
    L.push('');
    L.push('ШАГ 5. ПЛАН ПЕРЕСТРАХОВАНИЯ (если принимаешь риск)');
    L.push('  • Тип передачи: Quota Share / Surplus Treaty / Per-Risk XOL / Cat XOL / комбинация');
    L.push('  • Конкретные лимиты в тенге (точка прикрепления, лимит цессии)');
    L.push('  • Процент собственного удержания');
    L.push('  • Обоснование выбора по Solvency Impact и регуляторным требованиям АРРФР');
    L.push('  • Учти возможность передачи в обязательный пул через АО «Государственная страховая корпорация по перестрахованию»');
    L.push('');
    L.push('ШАГ 6. ДОПОЛНИТЕЛЬНЫЕ ДАННЫЕ');
    L.push('Какие документы и данные стоит запросить у страхователя перед окончательным решением:');
    L.push('  • Документы по охране труда (СОУТ, инструктажи, средства защиты)');
    L.push('  • Статистика травматизма по подразделениям и категориям работников');
    L.push('  • План мероприятий по снижению травматизма');
    L.push('  • Информация о субподрядных организациях');
    L.push('  • Программа добровольного медицинского страхования (как индикатор отношения к безопасности)');
    L.push('  • Что ещё? — добавь от себя');
    L.push('');
    L.push('ШАГ 7. УСЛОВИЯ МИНИМАЛЬНОГО ПРИНЯТИЯ');
    L.push('Если изменения нужны — какая МИНИМАЛЬНАЯ корректировка делает риск приемлемым:');
    L.push('  • Премия — на сколько увеличить?');
    L.push('  • Страховая сумма — на сколько уменьшить?');
    L.push('  • Перестрахование — какая доля цессии минимальна?');
    L.push('  • Понижающий/поправочный коэффициент — пересмотреть?');
    L.push('Приоритизируй меры по эффективности и реализуемости.');
    L.push('');
    L.push('═════════════════════════════════════════');
    L.push('  ТРЕБОВАНИЯ К ОТВЕТУ');
    L.push('═════════════════════════════════════════');
    L.push('• Каждая цифра должна быть рассчитана из приведённых выше данных и показана как формула + подстановка.');
    L.push('• Каждая рекомендация обоснована: «согласно X (закон/норма/расчёт) → следует Y».');
    L.push('• Нейтральность: не оправдывай и не браковай заранее. Опирайся только на цифры и НПА.');
    L.push('• Если в данных есть логические нестыковки или подозрительные значения — укажи прямо.');
    L.push('• Если данных недостаточно для уверенного вывода — скажи какие нужны.');
    L.push('• Формат ответа: структурированный (по шагам 1–7), с числами в виде «формула → подстановка → результат».');

    return L.join('\n');
  }

  window.AIPrompt = { build };
})();
