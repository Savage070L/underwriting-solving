// analytics.js — Premium dashboard renderer

(function () {
  'use strict';

  const raw = localStorage.getItem('analytics_snapshot');
  const dashEl = document.getElementById('dash');
  const emptyEl = document.getElementById('dash-empty');

  if (!raw) { emptyEl.style.display = 'flex'; return; }
  let snap;
  try { snap = JSON.parse(raw); } catch (e) { emptyEl.style.display = 'flex'; return; }
  if (!snap || !snap.analytics) { emptyEl.style.display = 'flex'; return; }
  dashEl.style.display = 'block';

  const a = snap.analytics;
  const z = snap.zayavka || {};
  const NBSP = ' ';

  // ===== FORMATTERS =====
  const fmtInt = (n) => {
    if (n == null || isNaN(n)) return '—';
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  };
  const fmtMoney = (n) => {
    if (n == null || isNaN(n)) return '—';
    return fmtInt(n) + NBSP + '₸';
  };
  const fmtMoneyShort = (n) => {
    if (n == null || isNaN(n)) return '—';
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2).replace('.', ',') + NBSP + 'млрд' + NBSP + '₸';
    if (abs >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + NBSP + 'М' + NBSP + '₸';
    if (abs >= 1e3) return (n / 1e3).toFixed(0) + NBSP + 'тыс' + NBSP + '₸';
    return fmtMoney(n);
  };
  const fmtPct = (n, digits = 1) => {
    if (n == null || isNaN(n)) return '—';
    return n.toFixed(digits).replace('.', ',') + NBSP + '%';
  };
  const fmtRate = (n) => (n != null) ? n.toFixed(n < 1 ? 3 : 1).replace('.', ',') : '—';
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };
  const fmtDateTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  // ===== HERO =====
  const rawName = z.insurerName || 'Страхователь';
  const companyName = (typeof Utils !== 'undefined' && Utils.formatCompanyName)
    ? Utils.formatCompanyName(rawName)
    : rawName;
  document.getElementById('company-name').textContent = companyName;
  const metaParts = [];
  if (z.bin) metaParts.push(`<span>БИН <strong>${z.bin}</strong></span>`);
  if (z.workers) metaParts.push(`<span><strong>${fmtInt(z.workers)}</strong> работников</span>`);
  if (z.oked) metaParts.push(`<span>ОКЭД <strong>${z.oked}</strong></span>`);
  if (z.riskClass) metaParts.push(`<span>Класс риска <strong>${z.riskClass}</strong></span>`);
  if (z.region) metaParts.push(`<span>${z.region}</span>`);
  if (z.govParticipation && z.govParticipation !== '-') metaParts.push(`<span>Гос. участие: <strong>${z.govParticipation}</strong></span>`);
  document.getElementById('company-meta').innerHTML = metaParts.join('');
  document.getElementById('period-value').textContent = `${fmtDate(a.cutoffDate)} — ${fmtDate(a.reportDate)}`;
  document.getElementById('generated-at').textContent = fmtDateTime(snap.generatedAt);
  const footerGen = document.getElementById('footer-generated');
  if (footerGen) footerGen.textContent = `Отчёт от ${fmtDateTime(snap.generatedAt)}`;

  // ===== VERDICT =====
  (function renderVerdict() {
    const premium = z.premiumWithCoeff || z.premiumBase || 0;
    const expectedLoss = a.avgSumPerYear || 0;
    const forecastLR = premium > 0 ? 100 * expectedLoss / premium : null;
    let level = 'ok', text = 'Приемлемый риск', icon = '✓';
    let rationale = '';
    if (a.recognition.recognized === 0) {
      level = 'ok'; text = 'История чистая'; icon = '✓';
      rationale = 'Страховых случаев за период не зафиксировано — стандартное принятие риска возможно.';
    } else if (forecastLR == null) {
      level = 'warn'; text = 'Требует анализа'; icon = '?';
      rationale = 'Премия по договору не задана — невозможно оценить КУ.';
    } else if (forecastLR < 70) {
      level = 'ok'; text = 'Финансово приемлем'; icon = '✓';
      rationale = `Прогнозный КУ ${fmtPct(forecastLR)} в пределах целевого диапазона.`;
    } else if (forecastLR < 100) {
      level = 'warn'; text = 'Пограничный риск'; icon = '!';
      rationale = `Прогнозный КУ ${fmtPct(forecastLR)} приближается к точке безубыточности — требует надбавки.`;
    } else if (forecastLR < 300) {
      level = 'bad'; text = 'Высокий риск'; icon = '⚠';
      rationale = `Прогнозный КУ ${fmtPct(forecastLR)} превышает 100 % — договор убыточен на текущих условиях.`;
    } else {
      level = 'bad'; text = 'Экстремальный риск'; icon = '⛔';
      rationale = `Прогнозный КУ ${fmtPct(forecastLR)} многократно превышает портфельную норму. Принятие без существенной корректировки экономически неприемлемо.`;
    }

    // Manual verdict overrides display
    if (snap.verdict && snap.verdict !== 'auto') {
      const labels = {
        accept_standard: { t: 'Принятие со стандартным коэффициентом', lvl: 'ok' },
        accept_adjusted: { t: 'Принятие с поправочным коэффициентом', lvl: 'warn' },
        reject: { t: 'Отклонение в соответствии со степенью риска', lvl: 'bad' },
        defer: { t: 'Отложение страхования на определённый срок', lvl: 'warn' },
      };
      if (labels[snap.verdict]) {
        text = labels[snap.verdict].t;
        level = labels[snap.verdict].lvl;
        rationale = 'Решение андеррайтера зафиксировано вручную в форме.';
      }
    }

    // Gauge SVG (semicircle)
    const gaugeVal = forecastLR == null ? 0 : Math.min(forecastLR / 300, 1); // 0..1 mapped over 0..300%
    const gaugeAngle = Math.PI - gaugeVal * Math.PI;
    const cx = 100, cy = 80, R = 70;
    const x1 = cx + R * Math.cos(Math.PI), y1 = cy + R * Math.sin(Math.PI);
    const x2 = cx + R * Math.cos(0), y2 = cy + R * Math.sin(0);
    const xn = cx + R * Math.cos(gaugeAngle), yn = cy + R * Math.sin(gaugeAngle);

    const gaugeColor = level === 'ok' ? '#10b981' : level === 'warn' ? '#f59e0b' : '#ef4444';

    document.getElementById('hero-verdict').innerHTML = `
      <div class="verdict-info">
        <span class="verdict-label">Итоговое заключение</span>
        <span class="verdict-text verdict-text--${level}">${icon} ${text}</span>
        <span class="verdict-rationale">${rationale}</span>
      </div>
      <div class="verdict-meter">
        <svg viewBox="0 0 200 130" preserveAspectRatio="xMidYMid meet">
          <defs>
            <linearGradient id="gaugeGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stop-color="#10b981"/>
              <stop offset="50%" stop-color="#f59e0b"/>
              <stop offset="100%" stop-color="#ef4444"/>
            </linearGradient>
          </defs>
          <path d="M ${x1} ${y1} A ${R} ${R} 0 0 1 ${x2} ${y2}"
                stroke="url(#gaugeGrad)" stroke-width="12" fill="none" stroke-linecap="round"/>
          <line x1="${cx}" y1="${cy}" x2="${xn}" y2="${yn}"
                stroke="#0f172a" stroke-width="3" stroke-linecap="round"/>
          <circle cx="${cx}" cy="${cy}" r="6" fill="#0f172a"/>
          <circle cx="${cx}" cy="${cy}" r="3" fill="${gaugeColor}"/>
          <text x="${cx}" y="${cy + 22}" text-anchor="middle" fill="#0f172a" font-size="16" font-weight="800">
            ${forecastLR != null ? fmtPct(forecastLR, 0) : '—'}
          </text>
          <text x="${cx}" y="${cy + 38}" text-anchor="middle" fill="#64748b" font-size="9" font-weight="700">КУ ПРОГНОЗ</text>
        </svg>
      </div>
    `;

    const tagEl = document.getElementById('hero-tag');
    tagEl.textContent =
      level === 'ok' ? 'Стандартный риск' : level === 'warn' ? 'Повышенный риск' : 'Критический риск';
    tagEl.className = 'hero-tag hero-tag--' + level;
  })();

  // ===== KPIs =====
  (function renderKPIs() {
    const recogRate = a.recognition.filed > 0
      ? 100 * a.recognition.recognized / a.recognition.filed : 0;
    const deathPct = a.recognition.recognized > 0
      ? 100 * a.bySeverity.death.count / a.recognition.recognized : 0;
    const deathMod = deathPct >= 15 ? 'danger' : deathPct >= 5 ? 'warning' : 'success';

    // YoY for cases
    const yoY = a.yoYGrowth && a.yoYGrowth.length > 0 ? a.yoYGrowth[a.yoYGrowth.length - 1] : null;
    let yoYBadge = '';
    if (yoY && yoY.casesDelta != null) {
      const sign = yoY.casesDelta >= 0 ? '↑' : '↓';
      const cls = yoY.casesDelta >= 0 ? 'delta-up' : 'delta-down';
      yoYBadge = `<span class="${cls}">${sign} ${Math.abs(yoY.casesDelta).toFixed(0)}%</span> к ${yoY.year - 1}`;
    }

    const kpis = [
      {
        label: 'Признано НС',
        icon: '📋',
        value: fmtInt(a.recognition.recognized),
        sub: `из ${fmtInt(a.recognition.filed)} заявленных · ${fmtPct(recogRate)}`,
        mod: 'brand',
      },
      {
        label: 'Сумма выплат · 3 года',
        icon: '💰',
        value: fmtMoneyShort(a.sumTotal3y),
        sub: `${fmtMoneyShort(a.avgSumPerYear)}/год`,
        mod: 'info',
      },
      {
        label: 'Среднегодовая частота',
        icon: '📈',
        value: fmtInt(a.avgFreq),
        unit: '/год',
        sub: yoYBadge || (z.workers > 0 ? `${fmtRate(a.avgFreq * 1000 / z.workers)} на 1000 чел./год` : ''),
        mod: 'warning',
      },
      {
        label: 'Доля смертельных',
        icon: '⚠',
        value: a.recognition.recognized > 0 ? fmtPct(deathPct) : '—',
        sub: `${fmtInt(a.bySeverity.death.count)} случаев`,
        mod: deathMod,
      },
      {
        label: 'РЗНУ',
        icon: '📦',
        value: fmtInt(a.recognition.rznu),
        sub: a.recognition.rznu === 0 ? 'резервов нет' : 'есть незакрытые',
        mod: a.recognition.rznu === 0 ? 'success' : 'warning',
      },
    ];
    document.getElementById('kpi-row').innerHTML = kpis.map(k => `
      <div class="kpi kpi--${k.mod}">
        <div class="kpi-head">
          <div class="kpi-label">${k.label}</div>
          <div class="kpi-icon">${k.icon}</div>
        </div>
        <div class="kpi-value">${k.value}${k.unit ? `<span class="unit">${k.unit}</span>` : ''}</div>
        ${k.sub ? `<div class="kpi-sub">${k.sub}</div>` : ''}
      </div>
    `).join('');
  })();

  // ===== RISK SCORE (composite 0-100) =====
  (function renderScore() {
    if (a.recognition.recognized === 0) {
      document.getElementById('card-score').style.display = 'none';
      return;
    }
    const act = snap.activity;
    const premium = z.premiumWithCoeff || z.premiumBase || 0;
    const portfolioLR = snap.ku ? snap.ku.lossRatioWith * 100 : null;
    const conc = a.concentration || {};

    const hasActivity = act && (act.deathRate > 0 || act.injuryRate > 0) && z.workers > 0;
    const hasPremium = premium > 0;

    const components = [];

    // Mortality component
    if (hasActivity && act.deathRate > 0) {
      const factDeath = (a.bySeverity.death.count / 3) * 1000 / z.workers;
      const ratio = factDeath / act.deathRate;
      const val = Math.max(0, 100 - Math.log10(Math.max(ratio, 0.1)) * 50);
      components.push({ label: 'Mortality vs ОКЭД', sub: 'фактическая смертность ÷ норматив', val, weight: 0.30 });
    }
    // Loss ratio component
    if (hasPremium) {
      const forecastLR = 100 * a.avgSumPerYear / premium;
      let val;
      if (forecastLR <= 70) val = 100;
      else if (forecastLR >= 500) val = 0;
      else val = Math.max(0, 100 - (forecastLR - 70) / 4.3);
      components.push({ label: 'Прогноз КУ', sub: 'ожидаемый КУ vs целевой 70 %', val, weight: 0.30 });
    }
    // Frequency component
    if (hasActivity) {
      const factFreq = a.avgFreq * 1000 / z.workers;
      const ratio = factFreq / (act.deathRate + act.injuryRate);
      const val = Math.max(0, 100 - Math.log10(Math.max(ratio, 0.1)) * 50);
      components.push({ label: 'Частота НС vs ОКЭД', sub: 'удельная частота на 1000 чел.', val, weight: 0.20 });
    }
    // Recognition rate component
    const recogRate = a.recognition.filed > 0
      ? 100 * a.recognition.recognized / a.recognition.filed : 0;
    let recogVal = 100;
    if (recogRate < 60 || recogRate > 99) recogVal = 50;
    else if (recogRate < 75 || recogRate > 97) recogVal = 75;
    components.push({ label: 'Качество регистрации', sub: 'доля признанных страховыми', val: recogVal, weight: 0.10 });

    // Concentration component
    let concVal = 100;
    if (conc.hhi > 5000) concVal = 50;
    else if (conc.hhi > 2500) concVal = 75;
    components.push({ label: 'Концентрация (HHI)', sub: 'распределение между страховщиками', val: concVal, weight: 0.10 });

    // Missing-data placeholders (display only, weight 0)
    const missing = [];
    if (!hasActivity) missing.push({
      label: 'Mortality / Частота vs ОКЭД',
      sub: 'Загрузите справочник «Калькулятор рентабельности» и выберите вид деятельности в форме',
    });
    if (!hasPremium) missing.push({ label: 'Прогноз КУ', sub: 'Заполните страховую премию в заявке' });

    // Renormalize weights to sum to 1.0 (since some components may be absent)
    const totalWeight = components.reduce((s, c) => s + c.weight, 0);
    components.forEach(c => c.normWeight = c.weight / totalWeight);
    const score = Math.round(components.reduce((s, c) => s + c.val * c.normWeight, 0));

    let grade, gradeClass;
    if (score >= 80) { grade = 'Низкий риск'; gradeClass = 'low'; }
    else if (score >= 60) { grade = 'Умеренный риск'; gradeClass = 'mod'; }
    else if (score >= 30) { grade = 'Повышенный риск'; gradeClass = 'high'; }
    else { grade = 'Критический риск'; gradeClass = 'crit'; }

    // Ring SVG
    const R = 95, cx = 110, cy = 110;
    const circ = 2 * Math.PI * R;
    const offset = circ * (1 - score / 100);

    const compRows = components.map(c => {
      const cls = c.val >= 70 ? 'ok' : c.val >= 40 ? 'mod' : 'bad';
      return `
        <div class="score-comp">
          <div class="sc-label">
            ${c.label}
            <small>${c.sub} · вес ${(c.normWeight * 100).toFixed(0)} %</small>
          </div>
          <div class="sc-track"><div class="sc-fill sc-fill--${cls}" style="width:${c.val}%"></div></div>
          <div class="sc-val">${Math.round(c.val)}</div>
        </div>`;
    }).join('') + missing.map(m => `
        <div class="score-comp score-comp--missing">
          <div class="sc-label">
            ${m.label}
            <small>${m.sub}</small>
          </div>
          <div class="sc-track"><div class="sc-fill" style="width:0;background:var(--border)"></div></div>
          <div class="sc-val" style="color:var(--muted-2)">нет данных</div>
        </div>`).join('');

    // Build radar (spider) chart for visible components only
    const radarComps = components.slice(0, 5);
    const rCx = 120, rCy = 130, rMax = 80;
    const angles = radarComps.map((_, i) => -Math.PI / 2 + (2 * Math.PI * i / radarComps.length));
    const gridLevels = [0.25, 0.5, 0.75, 1.0];
    const radarGrid = gridLevels.map(level => {
      const r = rMax * level;
      const pts = angles.map(a => `${rCx + r * Math.cos(a)},${rCy + r * Math.sin(a)}`).join(' ');
      return `<polygon class="radar-grid" points="${pts}"/>`;
    }).join('');
    const radarAxes = angles.map(a =>
      `<line class="radar-axis-line" x1="${rCx}" y1="${rCy}" x2="${rCx + rMax * Math.cos(a)}" y2="${rCy + rMax * Math.sin(a)}"/>`
    ).join('');
    const radarPoints = radarComps.map((c, i) => {
      const a = angles[i];
      const r = rMax * (c.val / 100);
      return { x: rCx + r * Math.cos(a), y: rCy + r * Math.sin(a) };
    });
    const radarPoly = `<polygon class="radar-poly-bg" points="${radarPoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}"/>`;
    const radarDots = radarPoints.map(p => `<circle class="radar-point" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5"/>`).join('');
    const shortLabels = {
      'Mortality vs ОКЭД': 'Смерт.',
      'Прогноз КУ': 'КУ',
      'Частота НС vs ОКЭД': 'Частота',
      'Качество регистрации': 'Качество',
      'Концентрация (HHI)': 'Концентр.',
    };
    const radarLabels = radarComps.map((c, i) => {
      const a = angles[i];
      const r = rMax + 16;
      const x = rCx + r * Math.cos(a);
      const y = rCy + r * Math.sin(a) + 3;
      return `<text class="radar-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${shortLabels[c.label] || c.label}</text>`;
    }).join('');

    document.getElementById('score-body').innerHTML = `
      <div class="score-grid">
        <div class="score-ring-wrap">
          <div class="score-ring">
            <svg width="220" height="220" viewBox="0 0 220 220">
              <defs>
                <linearGradient id="scoreGrad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stop-color="${gradeClass === 'low' ? '#10b981' : gradeClass === 'mod' ? '#f59e0b' : gradeClass === 'high' ? '#ea580c' : '#dc2626'}"/>
                  <stop offset="100%" stop-color="${gradeClass === 'low' ? '#059669' : gradeClass === 'mod' ? '#d97706' : gradeClass === 'high' ? '#c2410c' : '#991b1b'}"/>
                </linearGradient>
              </defs>
              <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#e2e8f0" stroke-width="14"/>
              <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="url(#scoreGrad)" stroke-width="14"
                      stroke-dasharray="${circ}" stroke-dashoffset="${offset}" stroke-linecap="round"/>
            </svg>
            <div class="score-ring-center">
              <div class="score-num">${score}</div>
              <div class="score-out-of">из 100</div>
            </div>
          </div>
          <div class="score-grade score-grade--${gradeClass}">${grade}</div>
        </div>
        <div class="score-components">${compRows}</div>
        <div class="score-radar">
          <div class="score-radar-title">Радар качества риска</div>
          <svg width="240" height="240" viewBox="0 0 240 240">
            ${radarGrid}
            ${radarAxes}
            ${radarPoly}
            ${radarDots}
            ${radarLabels}
          </svg>
        </div>
      </div>`;
  })();

  // ===== DYNAMIC BY YEAR =====
  (function renderDynamic() {
    const years = a.byYear || [];
    document.getElementById('dynamic-sub').textContent = years.length > 0
      ? `${years.length} год${years.length > 1 ? 'а' : ''} активности · с дельтой год к году`
      : '';
    if (years.length === 0) {
      document.getElementById('dynamic-body').innerHTML = '<div style="color:var(--muted);font-size:12px">Нет данных.</div>';
      return;
    }
    const maxCases = Math.max(...years.map(y => y.cases));
    const cols = years.map((y, i) => {
      const pct = (y.cases / maxCases) * 100;
      const prev = i > 0 ? years[i - 1] : null;
      let deltaHtml = '';
      // Skip noisy deltas: low base (< 10), or comparing to/from a partial-year edge
      const isEdgeYear = (y.year === years[0].year || y.year === years[years.length - 1].year);
      if (prev && prev.cases >= 10 && y.cases >= 10) {
        const d = 100 * (y.cases - prev.cases) / prev.cases;
        const sign = d >= 0 ? '↑' : '↓';
        const cls = d >= 0 ? 'bc-delta--up' : 'bc-delta--down';
        deltaHtml = `<span class="bc-delta ${cls}">${sign} ${Math.abs(d).toFixed(0)}%</span>`;
      }
      return `
        <div class="bchart-col">
          ${deltaHtml}
          <span class="bc-val">${fmtInt(y.cases)}</span>
          <div class="bc-bar" style="height: ${pct}%"></div>
        </div>`;
    }).join('');
    const labels = years.map(y => `<div>${y.year}</div>`).join('');
    const tableRows = years.map(y => `
      <tr>
        <td><strong>${y.year}</strong></td>
        <td class="num">${fmtInt(y.cases)}</td>
        <td class="num">${fmtInt(y.paid)}</td>
        <td class="num">${fmtMoneyShort(y.sum)}</td>
        <td class="num">${fmtInt(y.death)}</td>
        <td class="num">${fmtInt(y.uptHigh)}</td>
      </tr>`).join('');
    document.getElementById('dynamic-body').innerHTML = `
      <div class="bchart">${cols}</div>
      <div class="bchart-labels">${labels}</div>
      <table class="t" style="margin-top:18px">
        <thead><tr>
          <th>Год</th><th class="num">Дел</th><th class="num">С&nbsp;выплатой</th>
          <th class="num">Сумма</th><th class="num">Смерть</th><th class="num">УПТ≥30%</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>`;
  })();

  // ===== SEVERITY DONUT =====
  (function renderSeverity() {
    const sev = a.bySeverity;
    const allItems = [
      { key: 'death', label: sev.death.label, count: sev.death.count, sum: sev.death.sum, color: '#dc2626' },
      { key: 'upt90', label: sev.upt90.label, count: sev.upt90.count, sum: sev.upt90.sum, color: '#b91c1c' },
      { key: 'upt60', label: sev.upt60.label, count: sev.upt60.count, sum: sev.upt60.sum, color: '#ea580c' },
      { key: 'upt30', label: sev.upt30.label, count: sev.upt30.count, sum: sev.upt30.sum, color: '#f59e0b' },
      { key: 'uptLow', label: sev.uptLow.label, count: sev.uptLow.count, sum: sev.uptLow.sum, color: '#facc15' },
      { key: 'earnLoss', label: sev.earnLoss.label, count: sev.earnLoss.count, sum: sev.earnLoss.sum, color: '#0284c7' },
      { key: 'other', label: sev.other.label, count: sev.other.count, sum: sev.other.sum, color: '#94a3b8' },
    ];
    const items = allItems.filter(x => x.count > 0); // for donut arcs only
    const total = allItems.reduce((s, x) => s + x.count, 0);
    if (total === 0) {
      document.getElementById('severity-body').innerHTML = '<div style="color:var(--muted);font-size:12px">Нет данных.</div>';
      return;
    }
    const cx = 100, cy = 100, R = 80, r = 50;
    let cumAngle = -Math.PI / 2;
    const arcs = items.map(it => {
      const angle = (it.count / total) * Math.PI * 2;
      const x1 = cx + R * Math.cos(cumAngle);
      const y1 = cy + R * Math.sin(cumAngle);
      const x2 = cx + R * Math.cos(cumAngle + angle);
      const y2 = cy + R * Math.sin(cumAngle + angle);
      const x3 = cx + r * Math.cos(cumAngle + angle);
      const y3 = cy + r * Math.sin(cumAngle + angle);
      const x4 = cx + r * Math.cos(cumAngle);
      const y4 = cy + r * Math.sin(cumAngle);
      const large = angle > Math.PI ? 1 : 0;
      const d = `M${x1} ${y1} A${R} ${R} 0 ${large} 1 ${x2} ${y2} L${x3} ${y3} A${r} ${r} 0 ${large} 0 ${x4} ${y4} Z`;
      cumAngle += angle;
      return `<path class="donut-arc" d="${d}" fill="${it.color}" opacity="0.92"></path>`;
    }).join('');
    const legend = allItems.map(it => {
      const isEmpty = it.count === 0;
      return `
      <div class="dl-item${isEmpty ? ' dl-item--empty' : ''}">
        <div class="dl-dot" style="background:${isEmpty ? 'var(--border)' : it.color}"></div>
        <div class="dl-label">${it.label}</div>
        <div class="dl-value">${isEmpty ? '—' : fmtInt(it.count) + ' · ' + fmtPct(100 * it.count / total, 1)}</div>
      </div>`;
    }).join('');
    document.getElementById('severity-body').innerHTML = `
      <div class="donut-wrap">
        <svg class="donut-svg" width="200" height="200" viewBox="0 0 200 200">
          ${arcs}
          <text class="dn-center-num" x="100" y="98" text-anchor="middle">${fmtInt(total)}</text>
          <text class="dn-center-lbl" x="100" y="114" text-anchor="middle">признано НС</text>
        </svg>
        <div class="donut-legend">${legend}</div>
      </div>`;
  })();

  // ===== HEATMAP (year × month) =====
  (function renderHeatmap() {
    const months = a.byMonth || [];
    if (months.length === 0) {
      document.getElementById('card-heatmap').style.display = 'none';
      return;
    }
    // Group by year × month
    const byYearMonth = {};
    let maxVal = 0;
    for (const m of months) {
      if (!byYearMonth[m.year]) byYearMonth[m.year] = {};
      byYearMonth[m.year][m.month] = m.cases;
      if (m.cases > maxVal) maxVal = m.cases;
    }
    const years = Object.keys(byYearMonth).map(Number).sort();
    const monthLabels = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

    const colorFor = (val) => {
      if (val === 0) return { bg: 'var(--border-3)', dark: false };
      const intensity = Math.sqrt(val / maxVal); // sqrt for better visual spread
      const r = Math.round(224 + (49 - 224) * intensity);
      const g = Math.round(231 + (46 - 231) * intensity);
      const b = Math.round(255 + (129 - 255) * intensity);
      return { bg: `rgb(${r},${g},${b})`, dark: intensity > 0.55 };
    };

    let html = `<div class="heatmap-wrap">
      <div></div>
      ${monthLabels.map(m => `<div class="heatmap-header">${m}</div>`).join('')}
      <div class="heatmap-header">всего</div>`;
    for (const y of years) {
      let yearTotal = 0;
      html += `<div class="heatmap-year">${y}</div>`;
      for (let m = 1; m <= 12; m++) {
        const v = byYearMonth[y][m] || 0;
        yearTotal += v;
        const c = colorFor(v);
        html += `<div class="heatmap-cell ${v===0?'heatmap-cell--empty':''} ${c.dark?'dark':''}"
                      style="background:${c.bg}"
                      title="${monthLabels[m-1]} ${y}: ${v} НС">${v || ''}</div>`;
      }
      html += `<div class="heatmap-total">${fmtInt(yearTotal)}</div>`;
    }
    html += `</div>
      <div class="heatmap-legend">
        <span>Меньше</span>
        <div class="heatmap-scale"></div>
        <span>Больше · max ${maxVal}/мес</span>
      </div>`;
    document.getElementById('heatmap-body').innerHTML = html;
  })();

  // ===== MONTHLY LINE CHART =====
  (function renderMonthly() {
    const months = a.byMonth || [];
    const nonZero = months.filter(m => m.cases > 0);
    if (nonZero.length < 3) {
      document.getElementById('card-monthly').style.display = 'none';
      return;
    }
    document.getElementById('monthly-sub').textContent =
      `Январь ${months[0].year} — ${['', 'янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'][months[months.length - 1].month]} ${months[months.length - 1].year}`;

    const W = 1100, H = 220, padL = 40, padR = 16, padT = 16, padB = 30;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const maxCases = Math.max(...months.map(m => m.cases), 1);
    const xStep = innerW / Math.max(months.length - 1, 1);

    const pts = months.map((m, i) => ({
      x: padL + i * xStep,
      y: padT + innerH - (m.cases / maxCases) * innerH,
      cases: m.cases,
      death: m.death,
    }));

    // Line path
    const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L ${pts[pts.length - 1].x} ${padT + innerH} L ${pts[0].x} ${padT + innerH} Z`;

    // Death line
    const maxDeath = Math.max(...months.map(m => m.death), 1);
    const deathPts = months.map((m, i) => {
      const ratio = m.death / maxCases; // scale death to cases axis
      return { x: padL + i * xStep, y: padT + innerH - ratio * innerH };
    });
    const deathPath = deathPts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

    // Y axis ticks
    const yTicks = 4;
    let yTicksHtml = '';
    for (let i = 0; i <= yTicks; i++) {
      const v = Math.round(maxCases * (1 - i / yTicks));
      const y = padT + innerH * (i / yTicks);
      yTicksHtml += `
        <line class="lc-grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" />
        <text class="lc-axis" x="${padL - 8}" y="${y + 3}" text-anchor="end">${fmtInt(v)}</text>`;
    }

    // X axis labels — every 3 months
    let xLabels = '';
    months.forEach((m, i) => {
      if (i % 3 === 0 || i === months.length - 1) {
        const mn = ['', 'янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'][m.month];
        xLabels += `<text class="lc-axis" x="${padL + i * xStep}" y="${H - 8}" text-anchor="middle">${mn} '${String(m.year).slice(2)}</text>`;
      }
    });

    // Dots
    const dots = pts.map(p => `<circle class="lc-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" />`).join('');

    document.getElementById('monthly-body').innerHTML = `
      <div class="linechart">
        <svg class="linechart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          <defs>
            <linearGradient id="lcGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#6366f1" stop-opacity="0.5"/>
              <stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>
            </linearGradient>
          </defs>
          ${yTicksHtml}
          <path class="lc-area" d="${areaPath}" />
          <path class="lc-line" d="${linePath}" />
          <path class="lc-line-2" d="${deathPath}" />
          ${dots}
          ${xLabels}
        </svg>
        <div class="lc-legend">
          <span><span class="lcl-dot" style="background:var(--brand)"></span>Признанные НС в месяц</span>
          <span><span class="lcl-dot" style="background:var(--danger)"></span>Смертельные случаи</span>
        </div>
      </div>`;
  })();

  // ===== QUARTER =====
  (function renderQuarter() {
    const qs = a.byQuarter;
    const total = qs.reduce((s, q) => s + q.cases, 0);
    if (total === 0) {
      document.getElementById('quarter-body').innerHTML = '<div style="color:var(--muted);font-size:12px">Нет данных.</div>';
      return;
    }
    const max = Math.max(...qs.map(q => q.cases));
    const rows = qs.map(q => `
      <div class="histo-row">
        <div class="hr-label">${q.label}</div>
        <div class="hr-track"><div class="hr-fill" style="width:${(q.cases/max)*100}%;background:linear-gradient(90deg,#a78bfa 0%,#7c3aed 100%)"></div></div>
        <div class="hr-val">${fmtInt(q.cases)} · ${fmtPct(100*q.cases/total,1)}</div>
      </div>`).join('');
    document.getElementById('quarter-body').innerHTML = `<div class="histo">${rows}</div>`;
  })();

  // ===== ANNUITY =====
  (function renderAnnuity() {
    const dist = a.annuity.distribution || {};
    const keys = Object.keys(dist).map(Number).sort((x, y) => x - y);
    if (keys.length === 0) {
      document.getElementById('annuity-body').innerHTML = '<div style="color:var(--muted);font-size:12px">Нет данных.</div>';
      return;
    }
    const total = keys.reduce((s, k) => s + dist[k], 0);
    const max = Math.max(...keys.map(k => dist[k]));
    const rows = keys.map(k => `
      <div class="histo-row">
        <div class="hr-label">${k} выплат${k === 1 ? 'а' : ''}</div>
        <div class="hr-track"><div class="hr-fill" style="width:${(dist[k]/max)*100}%;background:linear-gradient(90deg,#34d399 0%,#059669 100%)"></div></div>
        <div class="hr-val">${fmtInt(dist[k])} · ${fmtPct(100*dist[k]/total,1)}</div>
      </div>`).join('');
    document.getElementById('annuity-body').innerHTML = `
      <div class="histo">${rows}</div>
      <div style="margin-top:14px;font-size:12px;color:var(--muted)">
        ${a.annuity.withMultiple > 0
          ? `Дел с многократными выплатами: <strong style="color:var(--ink-2)">${fmtInt(a.annuity.withMultiple)}</strong> из ${fmtInt(total)} (${fmtPct(100*a.annuity.withMultiple/total, 1)})`
          : 'Все дела закрыты одной выплатой — аннуитетной нагрузки нет.'}
      </div>`;
  })();

  // ===== FINANCE =====
  (function renderFinance() {
    const f = a.finance;
    if (f.paidCount === 0) {
      document.getElementById('finance-body').innerHTML = '<div style="color:var(--muted);font-size:12px">Выплат за период не зафиксировано.</div>';
      return;
    }
    document.getElementById('finance-body').innerHTML = `
      <div class="stat-grid">
        <div class="stat"><div class="stat-label">Дел с выплатой</div><div class="stat-value">${fmtInt(f.paidCount)}</div></div>
        <div class="stat"><div class="stat-label">Совокупно</div><div class="stat-value">${fmtMoneyShort(f.sumTotal)}</div></div>
        <div class="stat"><div class="stat-label">Среднее</div><div class="stat-value">${fmtMoneyShort(f.avg)}</div></div>
        <div class="stat"><div class="stat-label">Медиана</div><div class="stat-value">${fmtMoneyShort(f.median)}</div></div>
        <div class="stat"><div class="stat-label">P25</div><div class="stat-value">${fmtMoneyShort(f.p25)}</div></div>
        <div class="stat"><div class="stat-label">P75</div><div class="stat-value">${fmtMoneyShort(f.p75)}</div></div>
        <div class="stat"><div class="stat-label">P90</div><div class="stat-value">${fmtMoneyShort(f.p90)}</div></div>
        <div class="stat"><div class="stat-label">P99</div><div class="stat-value">${fmtMoneyShort(f.p99)}</div></div>
        <div class="stat"><div class="stat-label">Минимум</div><div class="stat-value">${fmtMoneyShort(f.min)}</div></div>
        <div class="stat"><div class="stat-label">Максимум</div><div class="stat-value">${fmtMoneyShort(f.max)}</div></div>
      </div>
      <div style="margin-top:14px;font-size:12px;color:var(--muted)">
        ${Math.abs(f.median - f.avg) / Math.max(f.avg, 1) < 0.2
          ? `Близость медианы (${fmtMoneyShort(f.median)}) к среднему (${fmtMoneyShort(f.avg)}) указывает на симметричное распределение без катастрофического хвоста.`
          : `Расхождение медианы (${fmtMoneyShort(f.median)}) и среднего (${fmtMoneyShort(f.avg)}) указывает на наличие крупных выплат, смещающих распределение.`}
      </div>`;
  })();

  // ===== TOP-10 LARGEST PAYOUTS =====
  (function renderTop() {
    const top = a.topLargest || [];
    if (top.length === 0) {
      document.getElementById('card-top').style.display = 'none';
      return;
    }
    const rows = top.map((t, i) => {
      const cls = t.isDeath ? 'top-row--death' : t.isUpt ? 'top-row--upt' : '';
      const tag = t.isDeath ? '<span class="chip chip--danger">смерть</span>' :
                  t.isUpt ? '<span class="chip chip--warning">УПТ</span>' : '';
      return `
        <div class="top-row ${cls}">
          <div class="tr-rank">#${i + 1}</div>
          <div>
            <div class="tr-info">${t.company} · № ${t.num}</div>
            <div class="tr-meta">
              <span>${fmtDate(t.date)}</span>
              ${tag}
              ${t.types ? `<span>${t.types.slice(0, 40)}</span>` : ''}
            </div>
          </div>
          <div class="tr-sum">${fmtMoneyShort(t.sum)}</div>
        </div>`;
    }).join('');
    document.getElementById('top-body').innerHTML = `<div class="top-list">${rows}</div>`;
  })();

  // ===== TOP-30 LARGEST CLAIMS TABLE =====
  (function renderTop30() {
    const top = a.top30 || a.topLargest || [];
    if (top.length === 0) {
      document.getElementById('card-top30').style.display = 'none';
      return;
    }
    const totalSum = top.reduce((s, t) => s + t.sum, 0);
    const rows = top.map((t, i) => {
      const catChip = t.isDeath ? '<span class="chip chip--danger">смерть</span>' :
                      t.isUpt ? '<span class="chip chip--warning">УПТ</span>' :
                      '<span class="chip chip--muted">прочее</span>';
      return `
        <tr>
          <td><span class="rank">${i + 1}</span></td>
          <td><strong>${t.company}</strong></td>
          <td>${t.num}</td>
          <td>${fmtDate(t.date)}</td>
          <td>${catChip}</td>
          <td style="font-size:11px;color:var(--muted)">${(t.types || '').slice(0, 50)}${(t.types || '').length > 50 ? '…' : ''}</td>
          <td class="num">${fmtMoneyShort(t.sum)}</td>
        </tr>`;
    }).join('');
    document.getElementById('top30-body').innerHTML = `
      <div style="max-height:480px;overflow-y:auto;border-radius:8px">
        <table class="top30-table">
          <thead><tr>
            <th>#</th><th>Страховщик</th><th>№ дела</th><th>Дата СК</th>
            <th>Категория</th><th>Тип риска</th><th class="num">Сумма выплаты</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-top:12px;font-size:11.5px;color:var(--muted)">
        Топ-${top.length} дел дают совокупно <strong style="color:var(--ink)">${fmtMoneyShort(totalSum)}</strong> выплат
        (${fmtPct(100 * totalSum / a.sumTotal3y, 1)} от общей суммы за 3 года).
      </div>`;
  })();

  // ===== DEATH CASES =====
  (function renderDeaths() {
    const deaths = a.deathCases || [];
    if (deaths.length === 0) {
      document.getElementById('card-deaths').style.display = 'none';
      return;
    }
    const total = deaths.length;
    const totalSum = deaths.reduce((s, d) => s + d.sum, 0);
    document.getElementById('deaths-sub').textContent =
      `${fmtInt(total)} случаев · ${fmtMoneyShort(totalSum)}`;

    const rows = deaths.slice(0, 50).map(d => `
      <div class="death-row">
        <div class="dr-date">${fmtDate(d.date)}</div>
        <div class="dr-ins">${d.company}</div>
        <div class="dr-sum">${fmtMoneyShort(d.sum)}</div>
      </div>`).join('');
    const tail = deaths.length > 50 ? `<div style="font-size:11px;color:var(--muted);text-align:center;padding:8px">показаны последние 50 из ${deaths.length}</div>` : '';
    document.getElementById('deaths-body').innerHTML = `
      <div class="death-list">${rows}</div>${tail}`;
  })();

  // ===== FREQUENCY × SEVERITY DECOMPOSITION =====
  (function renderFreqSev() {
    const fs = a.freqSeverity;
    if (!fs || fs.frequency === 0) {
      document.getElementById('card-freqsev').style.display = 'none';
      return;
    }
    document.getElementById('freqsev-body').innerHTML = `
      <div class="freqsev-grid">
        <div class="fs-card fs-card--freq">
          <div class="fs-label">Частота (Frequency)</div>
          <div class="fs-value">${fmtInt(fs.frequency)}<span style="font-size:13px;color:var(--muted);font-weight:500"> НС/год</span></div>
          <div class="fs-sub">Среднегодовое число признанных страховых случаев. Показывает, как часто срабатывает риск.</div>
        </div>
        <div class="fs-card fs-card--sev">
          <div class="fs-label">Серьёзность (Severity)</div>
          <div class="fs-value">${fmtMoneyShort(fs.severity)}</div>
          <div class="fs-sub">Средний размер выплаты на одно признанное дело. Показывает, сколько стоит каждое срабатывание.</div>
        </div>
      </div>
      <div class="fs-formula">
        <div class="fsf-part">
          <span class="fsf-num">${fmtInt(fs.frequency)}</span>
          <span class="fsf-lbl">частота / год</span>
        </div>
        <div class="fsf-op">×</div>
        <div class="fsf-part">
          <span class="fsf-num">${fmtMoneyShort(fs.severity)}</span>
          <span class="fsf-lbl">серьёзность / случай</span>
        </div>
        <div class="fsf-op">=</div>
        <div class="fsf-part fsf-result">
          <span class="fsf-num">${fmtMoneyShort(fs.pureLoss)}</span>
          <span class="fsf-lbl">pure loss / год</span>
        </div>
      </div>
      <div style="margin-top:14px;font-size:12px;color:var(--muted);line-height:1.55">
        <strong style="color:var(--ink-2)">Коэффициент вариации</strong> (CV) выплат =
        <strong style="color:var(--ink)">${fs.cv.toFixed(2).replace('.', ',')}</strong>
        ${fs.cv < 0.5 ? '— распределение тесное, выплаты предсказуемы.'
          : fs.cv < 1 ? '— умеренная дисперсия выплат.'
          : '— высокая дисперсия, возможны экстремальные единичные кейсы.'}
        Среднее время между двумя НС
        (MTBL) — <strong style="color:var(--ink)">${a.mtbl != null ? fmtInt(a.mtbl) + ' дней' : '—'}</strong>.
      </div>`;
  })();

  // ===== VaR / EXTREME LOSS =====
  (function renderVar() {
    const f = a.finance;
    if (f.paidCount < 10) {
      document.getElementById('card-var').style.display = 'none';
      return;
    }
    // Expected losses at various confidence levels (using percentiles)
    const rows = [
      { conf: '50 % (медиана)', val: f.median, desc: 'половина выплат не превысит этой суммы' },
      { conf: '75 %', val: f.p75, desc: 'три четверти кейсов укладываются' },
      { conf: '90 %', val: f.p90, desc: '9 из 10 кейсов не превысят' },
      { conf: '95 %', val: (f.p90 + f.p99) / 2, desc: 'граница типичного риска (VaR-95)' },
      { conf: '99 % (VaR)', val: f.p99, desc: 'верхний 1 % хвостовых кейсов выше' },
      { conf: '100 % (max)', val: f.max, desc: 'фактический максимум за период' },
    ];
    const tableRows = rows.map(r => `
      <tr>
        <td><strong>${r.conf}</strong></td>
        <td style="color:var(--muted)">${r.desc}</td>
        <td class="num">${fmtMoneyShort(r.val)}</td>
      </tr>`).join('');
    // Annual catastrophic event probability
    const annualCata = a.concentration && a.concentration.catastrophicCount > 0
      ? (a.concentration.catastrophicCount / 3) : 0;
    document.getElementById('var-body').innerHTML = `
      <div class="var-table-wrap">
        <table class="t">
          <thead><tr>
            <th>Доверит. уровень</th><th>Интерпретация</th><th class="num">Размер выплаты</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
      <div style="margin-top:12px;padding:10px 14px;background:linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%);border-radius:8px;font-size:12px;color:#7f1d1d;line-height:1.55">
        <strong>Катастрофический риск:</strong>
        в среднем ${annualCata.toFixed(1).replace('.', ',')} событий с выплатой ≥ ${fmtMoneyShort(a.concentration.catastrophicThreshold)} ежегодно.
        Совокупно по таким событиям — ${fmtMoneyShort(a.concentration.catastrophicSum)} за 3 года.
      </div>`;
  })();

  // ===== PIVOT: severity × year =====
  (function renderSevByYear() {
    const data = a.severityByYear || [];
    if (data.length === 0) {
      document.getElementById('card-sevyear').style.display = 'none';
      return;
    }
    const totalRow = data.reduce((acc, y) => {
      ['death', 'uptHigh', 'annuity', 'other', 'sumDeath', 'sumUptHigh', 'sumAnnuity', 'sumOther'].forEach(k => {
        acc[k] = (acc[k] || 0) + y[k];
      });
      return acc;
    }, {});
    const rows = data.map(y => {
      const tot = y.death + y.uptHigh + y.annuity + y.other;
      const totSum = y.sumDeath + y.sumUptHigh + y.sumAnnuity + y.sumOther;
      return `
        <tr>
          <td>${y.year}</td>
          <td class="num dim">${fmtInt(y.death)}</td>
          <td class="num" style="color:var(--muted)">${fmtMoneyShort(y.sumDeath)}</td>
          <td class="num dim">${fmtInt(y.uptHigh)}</td>
          <td class="num" style="color:var(--muted)">${fmtMoneyShort(y.sumUptHigh)}</td>
          <td class="num dim">${fmtInt(y.annuity)}</td>
          <td class="num" style="color:var(--muted)">${fmtMoneyShort(y.sumAnnuity)}</td>
          <td class="num dim">${fmtInt(y.other)}</td>
          <td class="num" style="color:var(--muted)">${fmtMoneyShort(y.sumOther)}</td>
          <td class="num"><strong>${fmtInt(tot)}</strong></td>
          <td class="num"><strong>${fmtMoneyShort(totSum)}</strong></td>
        </tr>`;
    }).join('');
    const totalTot = totalRow.death + totalRow.uptHigh + totalRow.annuity + totalRow.other;
    const totalSum = totalRow.sumDeath + totalRow.sumUptHigh + totalRow.sumAnnuity + totalRow.sumOther;
    document.getElementById('sevyear-body').innerHTML = `
      <div style="overflow-x:auto">
        <table class="pivot">
          <thead><tr>
            <th rowspan="2">Год</th>
            <th colspan="2" style="text-align:center;color:#dc2626">Смерть</th>
            <th colspan="2" style="text-align:center;color:#ea580c">УПТ ≥30 %</th>
            <th colspan="2" style="text-align:center;color:#0284c7">Аннуитеты</th>
            <th colspan="2" style="text-align:center;color:#64748b">Иное</th>
            <th colspan="2" style="text-align:center">Всего</th>
          </tr>
          <tr>
            <th class="num">дел</th><th class="num">сумма</th>
            <th class="num">дел</th><th class="num">сумма</th>
            <th class="num">дел</th><th class="num">сумма</th>
            <th class="num">дел</th><th class="num">сумма</th>
            <th class="num">дел</th><th class="num">сумма</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr>
            <td>Итого</td>
            <td class="num">${fmtInt(totalRow.death)}</td><td class="num">${fmtMoneyShort(totalRow.sumDeath)}</td>
            <td class="num">${fmtInt(totalRow.uptHigh)}</td><td class="num">${fmtMoneyShort(totalRow.sumUptHigh)}</td>
            <td class="num">${fmtInt(totalRow.annuity)}</td><td class="num">${fmtMoneyShort(totalRow.sumAnnuity)}</td>
            <td class="num">${fmtInt(totalRow.other)}</td><td class="num">${fmtMoneyShort(totalRow.sumOther)}</td>
            <td class="num">${fmtInt(totalTot)}</td><td class="num">${fmtMoneyShort(totalSum)}</td>
          </tr></tfoot>
        </table>
      </div>`;
  })();

  // ===== REQUIRED PREMIUM AT VARIOUS TARGET КУ =====
  (function renderRequiredPremium() {
    const premium = z.premiumWithCoeff || z.premiumBase || 0;
    const expectedLoss = a.avgSumPerYear || 0;
    if (premium === 0 || expectedLoss === 0) {
      document.getElementById('card-required').style.display = 'none';
      return;
    }
    const targets = [
      { lr: 100, label: 'Безубыточность', cls: 'unsafe' },
      { lr: 80, label: 'Прибыль 20 %', cls: 'target' },
      { lr: 70, label: 'Целевой КУ компании', cls: 'target' },
      { lr: 50, label: 'С маржой 50 %', cls: 'safe' },
    ];
    const maxPrem = expectedLoss / 0.5; // for normalization
    const rows = targets.map(t => {
      const req = expectedLoss * 100 / t.lr;
      const mult = req / premium;
      const widthPct = (req / maxPrem) * 100;
      return `
        <div class="required-row required-row--${t.cls}">
          <div class="rr-target">КУ ${t.lr} %</div>
          <div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:4px">${t.label}</div>
            <div class="rr-bar"><div class="rr-fill" style="width:${widthPct}%"></div></div>
          </div>
          <div class="rr-premium">${fmtMoneyShort(req)}</div>
          <div class="rr-mult">× ${mult.toFixed(1).replace('.', ',')} от текущей</div>
        </div>`;
    }).join('');
    document.getElementById('required-body').innerHTML = `
      <div class="required-row required-row--current">
        <div class="rr-target">Текущая</div>
        <div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:4px">Премия по предлагаемому договору</div>
          <div class="rr-bar"><div class="rr-fill" style="width:${(premium/maxPrem)*100}%"></div></div>
        </div>
        <div class="rr-premium">${fmtMoneyShort(premium)}</div>
        <div class="rr-mult">базовый уровень</div>
      </div>
      ${rows}
      <div style="margin-top:12px;font-size:11.5px;color:var(--muted);line-height:1.55">
        Для достижения целевого портфельного КУ <strong style="color:var(--ink)">70 %</strong>
        премия должна составлять <strong style="color:var(--ink)">${fmtMoneyShort(expectedLoss / 0.7)}</strong>
        в год, что в <strong style="color:var(--danger-2)">${((expectedLoss/0.7)/premium).toFixed(1).replace('.', ',')} раз</strong>
        больше текущей.
      </div>`;
  })();

  // ===== STATUS DISTRIBUTION =====
  (function renderStatuses() {
    const dist = a.statusDistribution || [];
    if (dist.length === 0) {
      document.getElementById('card-statuses').style.display = 'none';
      return;
    }
    const rows = dist.map(s => {
      const lower = s.status.toLowerCase();
      let cls = 'pending';
      if (lower.includes('признан страховым')) cls = 'ok';
      else if (lower.includes('недоказ') || lower.includes('отказ')) cls = 'bad';
      else if (lower.includes('пуст') || lower.includes('рассм')) cls = 'pending';
      return `
        <div class="status-row status-row--${cls}">
          <div class="status-label">${s.status}</div>
          <div class="status-count">${fmtInt(s.count)}</div>
          <div class="status-share">${fmtPct(s.share, 1)}</div>
        </div>`;
    }).join('');
    document.getElementById('statuses-body').innerHTML = `
      <div class="status-list">${rows}</div>
      <div style="margin-top:12px;font-size:11.5px;color:var(--muted);line-height:1.55">
        В файле обнаружено ${dist.length} различных статусов рассмотрения. Зелёные — признаны страховыми, красные — отказы, оранжевые — в процессе рассмотрения.
      </div>`;
  })();

  // ===== BUBBLE CHART — INSURERS =====
  (function renderBubble() {
    const ins = a.insurerDetailed || [];
    if (ins.length === 0) {
      document.getElementById('card-insbubble').style.display = 'none';
      return;
    }
    const W = 600, H = 280, padL = 50, padR = 20, padT = 30, padB = 40;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    // X = avg payment (in M), Y = recogRate (%), R = sum (sqrt scale)
    const maxX = Math.max(...ins.map(i => i.avgPayment));
    const maxR = Math.max(...ins.map(i => i.sum));
    const colors = ['#4f46e5', '#ec4899', '#0ea5e9', '#10b981', '#f59e0b'];

    let yTicks = '';
    for (let i = 0; i <= 4; i++) {
      const yPct = 60 + i * 10; // 60-100% range
      const y = padT + innerH - ((yPct - 60) / 40) * innerH;
      yTicks += `<line class="bubble-grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/>
                 <text class="bubble-axis" x="${padL - 8}" y="${y + 3}" text-anchor="end">${yPct}%</text>`;
    }
    let xTicks = '';
    for (let i = 0; i <= 4; i++) {
      const v = (maxX / 4) * i;
      const x = padL + (i / 4) * innerW;
      xTicks += `<text class="bubble-axis" x="${x}" y="${H - 22}" text-anchor="middle">${fmtMoneyShort(v)}</text>`;
    }

    const bubbles = ins.map((i, idx) => {
      const x = padL + (i.avgPayment / maxX) * innerW;
      const yPct = Math.max(60, Math.min(100, i.recogRate));
      const y = padT + innerH - ((yPct - 60) / 40) * innerH;
      const r = 8 + Math.sqrt(i.sum / maxR) * 40;
      const color = colors[idx % colors.length];
      return `
        <circle class="bubble-circle" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}"
                fill="${color}" opacity="0.7" stroke="${color}" stroke-width="2">
          <title>${i.name}: ${fmtInt(i.recognized)} дел, ${fmtMoneyShort(i.sum)}, ср. выплата ${fmtMoneyShort(i.avgPayment)}, % признания ${fmtPct(i.recogRate, 1)}</title>
        </circle>
        <text class="bubble-label" x="${x.toFixed(1)}" y="${(y - r - 4).toFixed(1)}" text-anchor="middle">${i.name}</text>`;
    }).join('');

    document.getElementById('insbubble-body').innerHTML = `
      <svg class="bubble-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        ${yTicks}
        ${xTicks}
        <text class="bubble-axis-title" x="${padL - 35}" y="${padT - 14}" text-anchor="start">% признания</text>
        <text class="bubble-axis-title" x="${W - padR}" y="${H - 4}" text-anchor="end">Ср. выплата</text>
        ${bubbles}
      </svg>
      <div style="margin-top:10px;font-size:11.5px;color:var(--muted);line-height:1.55">
        По <strong style="color:var(--ink-2)">X</strong> — средняя выплата на 1 кейс ·
        По <strong style="color:var(--ink-2)">Y</strong> — % признания страховыми ·
        <strong style="color:var(--ink-2)">Размер</strong> = сумма выплат.
        Идеальный страховщик в правом верхнем углу с большим пузырём.
      </div>`;
  })();

  // ===== INSURER × YEAR EVOLUTION =====
  (function renderInsByYear() {
    const data = a.insurerByYear || [];
    if (data.length === 0) {
      document.getElementById('card-insyear').style.display = 'none';
      return;
    }
    // Group by year
    const byYearMap = new Map();
    const allInsurers = new Set();
    for (const d of data) {
      if (!byYearMap.has(d.year)) byYearMap.set(d.year, {});
      byYearMap.get(d.year)[d.company] = d;
      allInsurers.add(d.company);
    }
    const insurers = Array.from(allInsurers);
    const colors = { 'FREEDOM LIFE': '#4f46e5', 'НОМАД LIFE': '#0ea5e9', 'KMLIFE': '#10b981',
                     'ХАЛЫК-LIFE': '#ec4899', 'ГАК': '#f59e0b' };
    const getColor = (name, i) => colors[name] || ['#94a3b8', '#a855f7', '#fb923c'][i % 3];

    const years = Array.from(byYearMap.keys()).sort();
    const rows = years.map(y => {
      const yData = byYearMap.get(y);
      const total = insurers.reduce((s, ins) => s + (yData[ins]?.count || 0), 0);
      const segs = insurers.map((ins, i) => {
        const v = yData[ins]?.count || 0;
        if (v === 0) return '';
        const pct = (v / total) * 100;
        return `<div class="sy-seg" style="background:${getColor(ins, i)};width:${pct}%" title="${ins} ${y}: ${v} дел">${pct > 5 ? v : ''}</div>`;
      }).join('');
      return `
        <div class="stacked-year-row">
          <div class="sy-year">${y}</div>
          <div class="sy-stack">${segs}</div>
          <div class="sy-total">${fmtInt(total)} дел</div>
        </div>`;
    }).join('');

    const legend = insurers.map((ins, i) => `
      <div class="stacked-legend-item">
        <div class="stacked-legend-dot" style="background:${getColor(ins, i)}"></div>
        <span>${ins}</span>
      </div>`).join('');

    document.getElementById('insyear-body').innerHTML = `
      <div class="stacked-chart">${rows}</div>
      <div class="stacked-legend">${legend}</div>`;
  })();

  // ===== INSURERS — DETAILED COMPARISON =====
  (function renderInsurers() {
    const ins = a.insurerDetailed || a.byInsurer || [];
    if (ins.length === 0) {
      document.getElementById('insurers-body').innerHTML = '<div style="color:var(--muted);font-size:12px">Нет данных.</div>';
      return;
    }
    const totalCount = ins.reduce((s, i) => s + (i.recognized || i.count || 0), 0);
    const totalSum = ins.reduce((s, i) => s + i.sum, 0);
    document.getElementById('insurers-sub').textContent =
      `${ins.length} страховщик(а) · топ-3 концентрация: ${fmtPct(100 * ins.slice(0,3).reduce((s,x)=>s+(x.recognized||x.count||0),0) / Math.max(totalCount,1))}`;

    const rows = ins.map(i => {
      const recog = i.recognized != null ? i.recognized : i.count;
      const share = totalCount > 0 ? 100 * recog / totalCount : 0;
      const recogRateChip = i.recogRate != null
        ? `<span class="chip chip--${i.recogRate >= 90 ? 'success' : i.recogRate >= 70 ? 'warning' : 'danger'}">${fmtPct(i.recogRate, 1)}</span>`
        : '—';
      const settleChip = i.avgSettlement != null && i.avgSettlement > 0
        ? `<span class="chip chip--${i.avgSettlement <= 30 ? 'success' : i.avgSettlement <= 90 ? 'info' : 'warning'}">${fmtInt(i.avgSettlement)}&nbsp;дн</span>`
        : '—';
      return `
        <tr>
          <td><strong>${i.name}</strong></td>
          <td class="num">${fmtInt(recog)}</td>
          <td class="num">${fmtPct(share, 1)}</td>
          <td class="num">${fmtMoneyShort(i.sum)}</td>
          <td class="num">${fmtMoneyShort(i.avgPayment)}</td>
          <td class="num">${recogRateChip}</td>
          <td class="num">${settleChip}</td>
          <td class="num">${fmtInt(i.deathCount || 0)}</td>
        </tr>`;
    }).join('');

    document.getElementById('insurers-body').innerHTML = `
      <table class="t">
        <thead><tr>
          <th>Страховая компания</th>
          <th class="num">Дел</th>
          <th class="num">Доля</th>
          <th class="num">Сумма выплат</th>
          <th class="num">Ср. выплата</th>
          <th class="num">% признания</th>
          <th class="num">Ср. урегул.</th>
          <th class="num">Смерть</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td>Итого</td>
          <td class="num">${fmtInt(totalCount)}</td>
          <td class="num">100%</td>
          <td class="num">${fmtMoneyShort(totalSum)}</td>
          <td class="num">${fmtMoneyShort(totalSum/Math.max(totalCount,1))}</td>
          <td class="num">—</td>
          <td class="num">—</td>
          <td class="num">${fmtInt(ins.reduce((s,i)=>s+(i.deathCount||0),0))}</td>
        </tr></tfoot>
      </table>`;
  })();

  // ===== SETTLEMENT =====
  (function renderSettlement() {
    const s = a.settlement;
    const lag = a.reportingLag;
    if (s.count === 0) {
      document.getElementById('settlement-body').innerHTML = '<div style="color:var(--muted);font-size:12px">Нет данных о выплатах.</div>';
      return;
    }
    document.getElementById('settlement-sub').textContent = `n = ${fmtInt(s.count)} дел`;
    const buckets = [
      { label: 'до 30 дней', val: s.buckets.to30 },
      { label: '31 – 90 дней', val: s.buckets.to90 },
      { label: '91 – 180 дней', val: s.buckets.to180 },
      { label: '181 – 365 дней', val: s.buckets.to365 },
      { label: 'свыше 1 года', val: s.buckets.over365 },
    ];
    const max = Math.max(...buckets.map(b => b.val), 1);
    const rows = buckets.map(b => `
      <div class="histo-row">
        <div class="hr-label">${b.label}</div>
        <div class="hr-track"><div class="hr-fill" style="width:${(b.val/max)*100}%"></div></div>
        <div class="hr-val">${fmtInt(b.val)} · ${fmtPct(100*b.val/s.count, 1)}</div>
      </div>`).join('');
    document.getElementById('settlement-body').innerHTML = `
      <div class="histo">${rows}</div>
      <div class="stat-grid" style="margin-top:18px">
        <div class="stat"><div class="stat-label">Среднее</div><div class="stat-value">${fmtInt(s.avg)}<span class="unit">дней</span></div></div>
        <div class="stat"><div class="stat-label">Медиана</div><div class="stat-value">${fmtInt(s.median)}<span class="unit">дней</span></div></div>
        <div class="stat"><div class="stat-label">Максимум</div><div class="stat-value">${fmtInt(s.max)}<span class="unit">дней</span></div></div>
        <div class="stat"><div class="stat-label">Лаг заявления (медиана)</div><div class="stat-value">${fmtInt(lag.median)}<span class="unit">дней</span></div></div>
      </div>`;
  })();

  // ===== TYPES =====
  (function renderTypes() {
    const types = a.byType || [];
    if (types.length === 0) {
      document.getElementById('card-types').style.display = 'none';
      return;
    }
    const max = Math.max(...types.map(t => t.count));
    const rows = types.slice(0, 10).map(t => `
      <div class="bar-item">
        <div class="bi-label" title="${t.type}">${t.type.length > 50 ? t.type.slice(0, 48) + '…' : t.type}</div>
        <div class="bi-track"><div class="bi-fill bi-fill--purple" style="width:${(t.count/max)*100}%"></div></div>
        <div class="bi-value">${fmtInt(t.count)}</div>
      </div>`).join('');
    document.getElementById('types-body').innerHTML = `<div class="bar-list">${rows}</div>`;
  })();

  // ===== RISK PROFILE =====
  (function renderRiskProfile() {
    if (!z.workers) {
      document.getElementById('card-risk-profile').style.display = 'none';
      return;
    }
    document.getElementById('profile-sub').textContent =
      z.activity ? z.activity.slice(0, 60) : '';

    // Risk class on a 1-25 scale
    const cls = parseInt(z.riskClass) || 0;
    const clsPct = cls > 0 ? Math.min(100, (cls / 25) * 100) : 0;

    // Capacity utilization = insurance sum / company assets
    const assets = snap.normativ?.fullAssetsTenge || 0;
    const capacityPct = assets > 0 ? 100 * z.insuranceSum / assets : null;

    // Death rate vs OKED norm
    const factDeathRate = z.workers > 0 ? (a.bySeverity.death.count / 3) * 1000 / z.workers : 0;
    const normDeath = snap.activity?.deathRate || 0;
    const deathRatio = normDeath > 0 ? factDeathRate / normDeath : null;

    // Govt participation — parse share if available
    const govRaw = (z.govParticipation || '').trim();
    let govPct = 0;
    let govDisplay = '—';
    if (govRaw && govRaw !== '-' && govRaw.toLowerCase() !== 'нет') {
      if (govRaw.toLowerCase() === 'да') { govPct = 80; govDisplay = 'Да'; }
      else {
        // Try to parse "X%" or "X,XX%" or "X.XX%"
        const m = govRaw.match(/(\d+[,.]?\d*)\s*%?/);
        if (m) {
          govPct = parseFloat(m[1].replace(',', '.'));
          if (govPct > 0) govDisplay = govPct.toFixed(govPct % 1 === 0 ? 0 : 2).replace('.', ',') + '%';
          else govDisplay = govRaw;
        } else {
          govDisplay = govRaw;
        }
      }
    } else if (govRaw.toLowerCase() === 'нет') {
      govDisplay = 'Нет';
    }
    const govBarColor = govPct >= 50 ? 'linear-gradient(90deg, var(--info), var(--info-2))'
      : govPct > 0 ? 'linear-gradient(90deg, var(--warning), var(--warning-2))'
      : 'var(--border-3)';

    document.getElementById('profile-body').innerHTML = `
      <div class="profile-block">
        <div class="profile-item">
          <div class="pi-key">Класс риска</div>
          <div class="pi-bar"><div class="pi-bar-fill" style="width:${clsPct}%"></div></div>
          <div class="pi-value">${cls || '—'} <span style="color:var(--muted);font-weight:500">из 25</span></div>
        </div>
        <div class="profile-item">
          <div class="pi-key">Численность</div>
          <div class="pi-bar"><div class="pi-bar-fill" style="width:${Math.min(100, Math.log10(z.workers+1) * 25)}%"></div></div>
          <div class="pi-value">${fmtInt(z.workers)} <span style="color:var(--muted);font-weight:500">чел.</span></div>
        </div>
        ${capacityPct != null ? `
        <div class="profile-item">
          <div class="pi-key">Доля от активов</div>
          <div class="pi-bar"><div class="pi-bar-fill" style="width:${Math.min(100, capacityPct * 10)}%"></div></div>
          <div class="pi-value">${fmtPct(capacityPct, 3)}</div>
        </div>` : ''}
        ${deathRatio != null ? `
        <div class="profile-item">
          <div class="pi-key">Mortality vs ОКЭД</div>
          <div class="pi-bar"><div class="pi-bar-fill" style="width:${Math.min(100, Math.log10(deathRatio + 1) * 33)}%"></div></div>
          <div class="pi-value">× ${deathRatio < 100 ? deathRatio.toFixed(1).replace('.', ',') : deathRatio.toFixed(0)}</div>
        </div>` : ''}
        <div class="profile-item">
          <div class="pi-key">Гос. участие</div>
          <div class="pi-bar"><div class="pi-bar-fill" style="width:${govPct}%;background:${govBarColor}"></div></div>
          <div class="pi-value">${govDisplay}</div>
        </div>
        <div class="profile-item">
          <div class="pi-key">Признак резидентства</div>
          <div class="pi-bar"><div class="pi-bar-fill" style="width:90%;background:var(--success)"></div></div>
          <div class="pi-value">резидент РК</div>
        </div>
      </div>`;
  })();

  // ===== TARIFF STRUCTURE =====
  (function renderTariff() {
    const sumInsured = z.insuranceSum || 0;
    // Real tariff (D12 in zayavka): fraction like 0.0298 = 2.98%
    // NB: z.coeff is the ADJUSTMENT coefficient (D15), NOT the tariff
    const tariffFrac = z.tariff != null ? z.tariff : (snap.popravka?.baseTariff ?? null);
    const baseTariffPct = tariffFrac != null ? tariffFrac * 100 : null;
    const adjCoeff = z.coeff || 1; // Поправочный (D15) — обычно 1.0
    const downCoeff = z.coeffDown || 0;
    const baseAmount = baseTariffPct != null ? sumInsured * baseTariffPct / 100 : 0;
    const afterAdj = baseAmount * adjCoeff;
    const finalAmount = afterAdj * (1 - downCoeff);

    if (!sumInsured || baseTariffPct == null) {
      document.getElementById('card-tariff').style.display = 'none';
      return;
    }

    let stepIdx = 1;
    let chain = `
      <div class="tariff-chain">
        <div class="tc-step">
          <div class="tc-num">${stepIdx++}</div>
          <div>
            <div class="tc-label">Страховая сумма</div>
            <div class="tc-formula">база расчёта по договору</div>
          </div>
          <div class="tc-value">${fmtMoneyShort(sumInsured)}</div>
        </div>
        <div class="tc-arrow">×</div>
        <div class="tc-step">
          <div class="tc-num">${stepIdx++}</div>
          <div>
            <div class="tc-label">Базовый тариф</div>
            <div class="tc-formula">по ОКЭД ${z.oked || '—'} / класс риска ${z.riskClass || '—'}</div>
          </div>
          <div class="tc-value">${fmtPct(baseTariffPct, 3)}</div>
        </div>
        <div class="tc-arrow">=</div>
        <div class="tc-step">
          <div class="tc-num">${stepIdx++}</div>
          <div>
            <div class="tc-label">Премия базовая</div>
            <div class="tc-formula">страх. сумма × тариф</div>
          </div>
          <div class="tc-value">${fmtMoneyShort(baseAmount)}</div>
        </div>`;

    if (adjCoeff && Math.abs(adjCoeff - 1) > 0.001) {
      chain += `
        <div class="tc-arrow">×</div>
        <div class="tc-step">
          <div class="tc-num">${stepIdx++}</div>
          <div>
            <div class="tc-label">Поправочный коэффициент</div>
            <div class="tc-formula">матрица «работники × НС»</div>
          </div>
          <div class="tc-value">${adjCoeff.toFixed(2)}</div>
        </div>`;
    }
    if (downCoeff > 0) {
      chain += `
        <div class="tc-arrow">×</div>
        <div class="tc-step">
          <div class="tc-num">${stepIdx++}</div>
          <div>
            <div class="tc-label">Понижающий коэффициент</div>
            <div class="tc-formula">скидка ${fmtPct(downCoeff*100, 0)} при отсутствии НС</div>
          </div>
          <div class="tc-value">${(1 - downCoeff).toFixed(2)}</div>
        </div>`;
    }
    chain += `
        <div class="tc-final">
          <div class="tc-final-label">Итоговая премия по договору</div>
          <div class="tc-final-value">${fmtMoneyShort(z.premiumWithCoeff || finalAmount)}</div>
        </div>
      </div>`;

    document.getElementById('tariff-body').innerHTML = chain;
  })();

  // ===== NORMS COMPARISON =====
  (function renderNorms() {
    const act = snap.activity;
    if (!act || a.recognition.recognized === 0 || !z.workers) {
      document.getElementById('card-norms').style.display = 'none';
      return;
    }
    document.getElementById('norms-sub').textContent = z.oked ? `ОКЭД ${z.oked} · ${z.activity || ''}` : '';

    const factFreq = a.avgFreq * 1000 / z.workers;
    const factDeath = (a.bySeverity.death.count / 3) * 1000 / z.workers;
    const factInjury = factFreq - factDeath;
    const normDeath = act.deathRate || 0;
    const normInjury = act.injuryRate || 0;
    const normTotal = normDeath + normInjury;
    const factDeathPct = a.recognition.recognized > 0 ? 100 * a.bySeverity.death.count / a.recognition.recognized : 0;
    const normDeathPct = normTotal > 0 ? 100 * normDeath / normTotal : 0;

    const ratioBadge = (fact, norm) => {
      if (!norm || norm === 0) return '<span class="chip chip--muted">—</span>';
      const r = fact / norm;
      if (r >= 10) return `<span class="chip chip--danger">× ${r >= 100 ? r.toFixed(0) : r.toFixed(1).replace('.', ',')}</span>`;
      if (r >= 3) return `<span class="chip chip--warning">× ${r.toFixed(1).replace('.', ',')}</span>`;
      if (r >= 1.2) return `<span class="chip chip--warning">× ${r.toFixed(2).replace('.', ',')}</span>`;
      return `<span class="chip chip--success">× ${r.toFixed(2).replace('.', ',')}</span>`;
    };

    document.getElementById('norms-body').innerHTML = `
      <table class="t">
        <thead><tr>
          <th>Показатель</th><th class="num">Факт</th><th class="num">Норма ОКЭД</th><th class="num">Отклонение</th>
        </tr></thead>
        <tbody>
          <tr>
            <td>Удельная частота, НС / 1000 чел. / год</td>
            <td class="num">${fmtRate(factFreq)}</td>
            <td class="num">${fmtRate(normTotal)}</td>
            <td class="num">${ratioBadge(factFreq, normTotal)}</td>
          </tr>
          <tr>
            <td>Удельная смертность, НС / 1000 чел. / год</td>
            <td class="num">${fmtRate(factDeath)}</td>
            <td class="num">${fmtRate(normDeath)}</td>
            <td class="num">${ratioBadge(factDeath, normDeath)}</td>
          </tr>
          <tr>
            <td>Удельный травматизм, НС / 1000 чел. / год</td>
            <td class="num">${fmtRate(factInjury)}</td>
            <td class="num">${fmtRate(normInjury)}</td>
            <td class="num">${ratioBadge(factInjury, normInjury)}</td>
          </tr>
          <tr>
            <td>Доля смертельных случаев</td>
            <td class="num">${fmtPct(factDeathPct, 1)}</td>
            <td class="num">${fmtPct(normDeathPct, 1)}</td>
            <td class="num">${ratioBadge(factDeathPct, normDeathPct)}</td>
          </tr>
        </tbody>
      </table>`;
  })();

  // ===== FUNNEL (recognition pipeline) =====
  (function renderFunnel() {
    const r = a.recognition;
    if (r.filed === 0) {
      document.getElementById('card-funnel').style.display = 'none';
      return;
    }
    const stages = [
      { label: 'Заявлено', sub: 'все обращения', val: r.filed, mod: 'filed', total: r.filed },
      { label: 'Признано', sub: 'случай признан страховым', val: r.recognized, mod: 'recog', total: r.filed },
      { label: 'Выплачено', sub: 'произведена выплата', val: r.paid, mod: 'paid', total: r.filed },
    ];
    const sideStages = [
      { label: 'Отказ', sub: 'недоказанность', val: r.rejected, mod: 'rejected' },
      { label: 'В процессе', sub: 'рассматривается', val: r.pending, mod: 'pending' },
    ];
    const maxVal = r.filed;
    const rows = stages.map(s => {
      const pct = (s.val / maxVal) * 100;
      const rate = s.label === 'Заявлено' ? '' : `${fmtPct(100 * s.val / r.filed, 1)} от заявленных`;
      return `
        <div class="funnel-row">
          <div class="funnel-label">${s.label}<small>${s.sub}</small></div>
          <div class="funnel-bar">
            <div class="funnel-fill funnel-fill--${s.mod}" style="width:${pct}%">${fmtInt(s.val)}</div>
          </div>
          <div class="funnel-rate">${rate}</div>
        </div>`;
    }).join('');
    const side = sideStages.map(s => {
      const pct = (s.val / maxVal) * 100;
      return `
        <div class="funnel-row">
          <div class="funnel-label">${s.label}<small>${s.sub}</small></div>
          <div class="funnel-bar">
            <div class="funnel-fill funnel-fill--${s.mod}" style="width:${Math.max(pct, 1)}%">${fmtInt(s.val)}</div>
          </div>
          <div class="funnel-rate">${fmtPct(100 * s.val / r.filed, 1)}</div>
        </div>`;
    }).join('');
    document.getElementById('funnel-body').innerHTML = `
      <div class="funnel">${rows + side}</div>
      <div style="margin-top:14px;font-size:11.5px;color:var(--muted);line-height:1.55">
        Качество урегулирования: <strong style="color:var(--ink-2)">${fmtPct(100 * r.recognized / r.filed, 1)}</strong> признания
        · отказов <strong style="color:var(--ink-2)">${fmtPct(100 * r.rejected / r.filed, 2)}</strong>
        · конверсия в выплату <strong style="color:var(--ink-2)">${fmtPct(100 * r.paid / r.recognized, 1)}</strong>.
      </div>`;
  })();

  // ===== PARETO (cumulative loss distribution) =====
  (function renderPareto() {
    const f = a.finance;
    if (f.paidCount < 10) {
      document.getElementById('card-pareto').style.display = 'none';
      return;
    }
    // Bucket cases by deciles (10 buckets, sorted by sum desc)
    // Simulate from percentiles since we don't have raw array — use distribution
    // For real impl: sumsDesc would be sorted descending; we approximate via top10
    const top10pct = a.concentration?.tailConcentration || 50;
    // Construct cumulative curve from percentile points
    const buckets = [];
    let cumSum = 0;
    for (let i = 1; i <= 10; i++) {
      const decilePct = i * 10;
      // Approximate cumulative share: skewed Pareto curve
      // Use tailConcentration as anchor: top 10% = top10pct of sum
      let cum;
      if (i === 1) cum = top10pct;
      else if (i === 10) cum = 100;
      else {
        // Smooth interpolation
        const remaining = 100 - top10pct;
        cum = top10pct + remaining * Math.pow((i - 1) / 9, 0.7);
      }
      buckets.push({ decile: i, cumLossPct: cum, decilePct });
    }
    const W = 600, H = 200, padL = 40, padR = 16, padT = 16, padB = 30;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const barWidth = innerW / buckets.length - 4;
    const barsHtml = buckets.map((b, i) => {
      const sliceLoss = i === 0 ? b.cumLossPct : b.cumLossPct - buckets[i - 1].cumLossPct;
      const x = padL + i * (barWidth + 4);
      const h = (sliceLoss / 100) * innerH;
      const y = padT + innerH - h;
      return `<rect class="pareto-bar" x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="3"/>`;
    }).join('');
    const linePoints = buckets.map((b, i) => {
      const x = padL + i * (barWidth + 4) + barWidth / 2;
      const y = padT + innerH - (b.cumLossPct / 100) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' L ');
    const markers = buckets.map((b, i) => {
      const x = padL + i * (barWidth + 4) + barWidth / 2;
      const y = padT + innerH - (b.cumLossPct / 100) * innerH;
      return `<circle class="pareto-marker" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"/>`;
    }).join('');
    const xLabels = buckets.map((b, i) => {
      const x = padL + i * (barWidth + 4) + barWidth / 2;
      return `<text class="pareto-axis" x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle">${b.decilePct}%</text>`;
    }).join('');
    let yTicks = '';
    for (let i = 0; i <= 4; i++) {
      const v = 100 * (1 - i / 4);
      const y = padT + innerH * (i / 4);
      yTicks += `<line class="pareto-grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/>
                 <text class="pareto-axis" x="${padL - 6}" y="${y + 3}" text-anchor="end">${Math.round(v)}%</text>`;
    }
    document.getElementById('pareto-body').innerHTML = `
      <svg class="pareto-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="paretoBarGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#6366f1"/>
            <stop offset="100%" stop-color="#818cf8"/>
          </linearGradient>
        </defs>
        ${yTicks}
        ${barsHtml}
        <path class="pareto-line" d="M ${linePoints}"/>
        ${markers}
        ${xLabels}
        <text class="pareto-axis" x="${padL - 6}" y="${padT - 4}" text-anchor="end" font-size="9">% выплат</text>
        <text class="pareto-axis" x="${W - padR}" y="${H - 2}" text-anchor="end" font-size="9">% дел</text>
      </svg>
      <div class="pareto-note">
        <strong>10 % самых крупных дел дают ${fmtPct(top10pct, 1)} всех выплат.</strong>
        ${top10pct >= 50 ? ' Концентрация в хвосте высокая — крупные единичные случаи определяют итоговую убыточность.'
          : top10pct >= 30 ? ' Хвост умеренный, но влияние крупных кейсов значимо.'
          : ' Распределение почти равномерное — нет доминирующих катастрофических кейсов.'}
      </div>`;
  })();

  // ===== PREMIUM DECOMPOSITION =====
  (function renderPremDecomp() {
    const premium = z.premiumWithCoeff || z.premiumBase || 0;
    const expectedLoss = a.avgSumPerYear || 0;
    if (premium === 0 || expectedLoss === 0) {
      document.getElementById('card-premdecomp').style.display = 'none';
      return;
    }

    // Decomposition: premium covers part of expected loss
    // Expected loss is split into: death payouts, UPT payouts, annuity, other
    const sev = a.bySeverity;
    const sevTotal = sev.death.sum + sev.upt90.sum + sev.upt60.sum + sev.upt30.sum
                   + sev.uptLow.sum + sev.earnLoss.sum + sev.other.sum;
    const sevAnnual = sevTotal / 3;
    const components = [
      { label: 'Смерть', val: sev.death.sum / 3, color: '#dc2626' },
      { label: 'УПТ', val: (sev.upt90.sum + sev.upt60.sum + sev.upt30.sum + sev.uptLow.sum) / 3, color: '#ea580c' },
      { label: 'Аннуитеты', val: sev.earnLoss.sum / 3, color: '#0284c7' },
      { label: 'Иное', val: sev.other.sum / 3, color: '#94a3b8' },
    ].filter(c => c.val > 0);

    const gap = expectedLoss - premium;
    const totalScale = expectedLoss > premium ? expectedLoss : premium;

    const premiumPct = (premium / totalScale) * 100;
    const gapPct = gap > 0 ? (gap / totalScale) * 100 : 0;

    const bar = `
      <div class="decomp-bar">
        <div class="decomp-seg decomp-seg--premium" style="width:${premiumPct}%"
             title="Премия покрывает ${fmtPct(100 * premium / expectedLoss, 1)} ожидаемого убытка">
          Премия · ${fmtMoneyShort(premium)}
        </div>
        ${gap > 0 ? `<div class="decomp-seg decomp-seg--gap" style="width:${gapPct}%"
             title="Непокрытая часть ожидаемого убытка">
          Дефицит · ${fmtMoneyShort(gap)}
        </div>` : ''}
      </div>
      <div class="decomp-legend">
        <div class="dl-entry">
          <div class="dl-entry-swatch" style="background:linear-gradient(135deg,#4f46e5,#6366f1)"></div>
          <div>
            <div class="dl-entry-label">Премия по договору</div>
            <div class="dl-entry-val">${fmtMoneyShort(premium)}</div>
          </div>
        </div>
        <div class="dl-entry">
          <div class="dl-entry-swatch" style="background:linear-gradient(135deg,#f87171,#dc2626)"></div>
          <div>
            <div class="dl-entry-label">${gap > 0 ? 'Дефицит покрытия' : 'Профицит'}</div>
            <div class="dl-entry-val">${fmtMoneyShort(Math.abs(gap))}</div>
          </div>
        </div>
        <div class="dl-entry">
          <div class="dl-entry-swatch" style="background:linear-gradient(135deg,#94a3b8,#475569)"></div>
          <div>
            <div class="dl-entry-label">Ожидаемые выплаты / год</div>
            <div class="dl-entry-val">${fmtMoneyShort(expectedLoss)}</div>
          </div>
        </div>
      </div>`;

    const detailCards = components.map(c => `
      <div class="decomp-card" style="--dec-accent:${c.color}">
        <div class="dc-label">${c.label}</div>
        <div class="dc-value">${fmtMoneyShort(c.val)}</div>
        <div class="dc-sub">${fmtPct(100 * c.val / sevAnnual, 1)} от ожидаемых выплат</div>
      </div>`).join('');

    document.getElementById('premdecomp-body').innerHTML = `
      ${bar}
      <div style="font-size:12px;color:var(--muted);margin-top:6px;line-height:1.55">
        ${gap > 0
          ? `Премия покрывает только <strong style="color:var(--ink)">${fmtPct(100*premium/expectedLoss, 1)}</strong> ожидаемого годового убытка. На каждый тенге премии приходится <strong style="color:var(--danger-2)">${(expectedLoss/premium).toFixed(2)} ₸</strong> прогнозируемых выплат.`
          : `Премия покрывает ожидаемый убыток с запасом <strong style="color:var(--success-2)">${fmtPct(100*premium/expectedLoss - 100, 1)}</strong>.`}
      </div>
      <div class="decomp-detail">${detailCards}</div>`;
  })();

  // ===== CONCENTRATION & QUALITY =====
  (function renderConcentration() {
    const c = a.concentration;
    if (!c) { document.getElementById('card-concentration').style.display = 'none'; return; }

    const hhiChip = {
      low: '<span class="chip chip--success">фрагментированный</span>',
      moderate: '<span class="chip chip--info">умеренная</span>',
      high: '<span class="chip chip--warning">высокая</span>',
      extreme: '<span class="chip chip--danger">крайне высокая</span>',
    }[c.hhiBand] || '';

    const tailChip = c.tailConcentration >= 50
      ? '<span class="chip chip--danger">высокая</span>'
      : c.tailConcentration >= 30 ? '<span class="chip chip--warning">умеренная</span>'
      : '<span class="chip chip--success">равномерная</span>';

    const catChip = c.catastrophicCount > 10
      ? `<span class="chip chip--danger">${c.catastrophicCount}</span>`
      : c.catastrophicCount > 0 ? `<span class="chip chip--warning">${c.catastrophicCount}</span>`
      : '<span class="chip chip--success">0</span>';

    document.getElementById('concentration-body').innerHTML = `
      <div>
        <div class="metric-row">
          <div class="metric-label">
            Индекс концентрации HHI
            <small>Herfindahl-Hirschman Index по страховщикам: ниже 1500 — фрагментированный рынок, 1500–2500 умеренный, выше 2500 — концентрированный</small>
          </div>
          ${hhiChip}
          <div class="metric-value">${fmtInt(c.hhi)}</div>
        </div>
        <div class="metric-row">
          <div class="metric-label">
            Хвостовая концентрация
            <small>Доля совокупных выплат, приходящаяся на 10 % крупнейших дел (top-${c.top10Count}) — индикатор риска катастрофических потерь</small>
          </div>
          ${tailChip}
          <div class="metric-value">${fmtPct(c.tailConcentration, 1)}</div>
        </div>
        <div class="metric-row">
          <div class="metric-label">
            Катастрофические события
            <small>Количество страховых случаев с выплатой ≥ ${fmtMoneyShort(c.catastrophicThreshold)} (50 М ₸) — порог индивидуально крупного убытка</small>
          </div>
          ${catChip}
          <div class="metric-value">${fmtMoneyShort(c.catastrophicSum)}</div>
        </div>
        <div class="metric-row">
          <div class="metric-label">
            Максимальный период без смертей
            <small>Самый длинный интервал между смертельными случаями (или от последней смерти до отчётной даты)</small>
          </div>
          ${c.longestNoDeathStreak >= 90 ? '<span class="chip chip--success">> 3 мес</span>' : '<span class="chip chip--warning">короткие интервалы</span>'}
          <div class="metric-value">${fmtInt(c.longestNoDeathStreak)} <small style="font-size:11px;color:var(--muted);font-weight:500">дней</small></div>
        </div>
      </div>`;
  })();

  // ===== PER-CAPITA / PER-WORKER =====
  (function renderPerCapita() {
    if (!z.workers || a.recognition.recognized === 0) {
      document.getElementById('card-percapita').style.display = 'none';
      return;
    }
    const W = z.workers;
    const lossPerWorker = a.avgSumPerYear / W;
    const freqPerWorker = a.avgFreq / W;
    const premiumPerWorker = (z.premiumWithCoeff || z.premiumBase || 0) / W;
    const purePremium = lossPerWorker; // pure premium = expected loss per worker (no loading)
    const adequacy = premiumPerWorker > 0 && purePremium > 0
      ? 100 * premiumPerWorker / purePremium : null;

    const adequacyChip = adequacy == null ? '—'
      : adequacy >= 130 ? '<span class="chip chip--success">достаточна</span>'
      : adequacy >= 100 ? '<span class="chip chip--info">на пределе</span>'
      : adequacy >= 50 ? '<span class="chip chip--warning">недостаточна</span>'
      : '<span class="chip chip--danger">критически недостаточна</span>';

    document.getElementById('percapita-body').innerHTML = `
      <div>
        <div class="metric-row">
          <div class="metric-label">
            Среднегодовой убыток на 1 работника
            <small>Совокупные выплаты ÷ работников ÷ 3 года — удельная нагрузка по риску</small>
          </div>
          <div></div>
          <div class="metric-value">${fmtMoneyShort(lossPerWorker)}</div>
        </div>
        <div class="metric-row">
          <div class="metric-label">
            Удельная премия на 1 работника
            <small>Премия по договору ÷ численность застрахованных</small>
          </div>
          <div></div>
          <div class="metric-value">${fmtMoneyShort(premiumPerWorker)}</div>
        </div>
        <div class="metric-row">
          <div class="metric-label">
            Pure premium (рисковая часть)
            <small>Чистая ожидаемая выплата на 1 работника в год — премия без нагрузки расходов и прибыли</small>
          </div>
          <div></div>
          <div class="metric-value">${fmtMoneyShort(purePremium)}</div>
        </div>
        <div class="metric-row">
          <div class="metric-label">
            Достаточность премии
            <small>Премия на работника ÷ pure premium × 100 % · норма ≥ 130 %</small>
          </div>
          ${adequacyChip}
          <div class="metric-value">${adequacy != null ? fmtPct(adequacy, 0) : '—'}</div>
        </div>
        <div class="metric-row">
          <div class="metric-label">
            Удельная частота
            <small>Признанные НС ÷ работников ÷ год · вероятность срабатывания на 1 работника</small>
          </div>
          <div></div>
          <div class="metric-value">${fmtPct(freqPerWorker * 100, 2)}</div>
        </div>
      </div>`;
  })();

  // ===== FORECAST =====
  (function renderForecast() {
    const card = document.getElementById('card-forecast');
    const premium = z.premiumWithCoeff || z.premiumBase || 0;
    const sumInsured = z.insuranceSum || 0;
    if (a.recognition.recognized === 0 || premium === 0) {
      card.style.display = 'none';
      return;
    }
    const expectedLoss = a.avgSumPerYear;
    const expectedCases = Math.round(a.avgFreq);
    const forecastLR = premium > 0 ? 100 * expectedLoss / premium : 0;
    const portfolioLR = snap.ku ? (snap.ku.lossRatioWith * 100) : null;
    const breakEven = expectedLoss;
    const deficit = premium - expectedLoss;

    document.getElementById('forecast-sub').textContent = z.periodFrom && z.periodTo
      ? `${fmtDate(z.periodFrom)} — ${fmtDate(z.periodTo)}`
      : '12 месяцев';

    let calloutClass = 'forecast-callout--ok';
    let calloutText = `Договор финансово сбалансирован: профицит ${fmtMoneyShort(deficit)}/год.`;
    if (deficit < 0) {
      const ratio = Math.abs(deficit) / Math.max(premium, 1);
      if (ratio > 2) {
        calloutClass = 'forecast-callout--bad';
        calloutText = `Дефицит покрытия: ${fmtMoneyShort(-deficit)}/год. Принятие риска на текущих условиях экономически неприемлемо.`;
      } else {
        calloutClass = 'forecast-callout--warn';
        calloutText = `Дефицит покрытия: ${fmtMoneyShort(-deficit)}/год. Необходима повышающая корректировка тарифа.`;
      }
    }

    document.getElementById('forecast-body').innerHTML = `
      <div class="forecast-grid">
        <div class="forecast-block">
          <h3>Условия рассматриваемого договора</h3>
          <div class="fb-row"><span class="fbr-label">Страховая премия</span><span class="fbr-value">${fmtMoneyShort(premium)}</span></div>
          <div class="fb-row"><span class="fbr-label">Страховая сумма</span><span class="fbr-value">${fmtMoneyShort(sumInsured)}</span></div>
          <div class="fb-row"><span class="fbr-label">Численность застрахованных</span><span class="fbr-value">${fmtInt(z.workers)} чел.</span></div>
          <div class="fb-row"><span class="fbr-label">Класс / тариф</span><span class="fbr-value">${z.riskClass || '—'} · ${z.coeff ? (z.coeff*100).toFixed(2).replace('.', ',') + '%' : '—'}</span></div>
          <div class="fb-row"><span class="fbr-label">Понижающий коэффициент</span><span class="fbr-value">${fmtPct((z.coeffDown||0)*100, 0)}</span></div>
        </div>
        <div class="forecast-block">
          <h3>Прогноз на основе истории</h3>
          <div class="fb-row"><span class="fbr-label">Ожидаемое число НС</span><span class="fbr-value">${fmtInt(expectedCases)}</span></div>
          <div class="fb-row"><span class="fbr-label">Ожидаемая сумма выплат</span><span class="fbr-value">${fmtMoneyShort(expectedLoss)}</span></div>
          <div class="fb-row"><span class="fbr-label">Прогнозный КУ</span><span class="fbr-value">${fmtPct(forecastLR, 1)}</span></div>
          ${portfolioLR != null ? `<div class="fb-row"><span class="fbr-label">Портфельный КУ компании</span><span class="fbr-value">${fmtPct(portfolioLR, 2)}</span></div>` : ''}
          <div class="fb-row"><span class="fbr-label">Точка безубыточности (премия/год)</span><span class="fbr-value">${fmtMoneyShort(breakEven)}</span></div>
        </div>
      </div>
      <div class="forecast-callout ${calloutClass}">
        <span>${calloutText}</span>
        ${portfolioLR != null && forecastLR > 0
          ? `<strong>${(forecastLR / portfolioLR).toFixed(1).replace('.', ',')}× портфельной нормы</strong>`
          : ''}
      </div>`;
  })();

  // ===== STRESS TESTS =====
  (function renderStress() {
    const premium = z.premiumWithCoeff || z.premiumBase || 0;
    if (a.recognition.recognized === 0 || premium === 0) {
      document.getElementById('card-stress').style.display = 'none';
      return;
    }
    const baseLoss = a.avgSumPerYear;
    const baseLR = 100 * baseLoss / premium;

    // Worst-year loss
    const worstYear = (a.byYear || []).reduce((max, y) => y.sum > (max?.sum || 0) ? y : max, null);
    const worstYearLR = worstYear ? 100 * worstYear.sum / premium : null;

    // Scenarios
    const scenarios = [
      {
        title: 'Базовый сценарий',
        desc: 'Средние выплаты по истории за 3 года',
        loss: baseLoss,
        lr: baseLR,
      },
      {
        title: 'Стресс +20 % частоты',
        desc: 'Рост числа НС на 20 % при сохранении средней выплаты',
        loss: baseLoss * 1.2,
        lr: baseLR * 1.2,
      },
      {
        title: 'Стресс +50 % частоты',
        desc: 'Рост числа НС в 1.5 раза',
        loss: baseLoss * 1.5,
        lr: baseLR * 1.5,
      },
      worstYear ? {
        title: `Повторение ${worstYear.year} года`,
        desc: `Худший год в истории — ${fmtInt(worstYear.cases)} НС`,
        loss: worstYear.sum,
        lr: worstYearLR,
      } : null,
    ].filter(Boolean);

    const cards = scenarios.map(s => {
      let cls = 'ok';
      if (s.lr > 100) cls = 'bad';
      else if (s.lr > 70) cls = 'warn';
      return `
        <div class="stress-card stress-card--${cls}">
          <div class="stress-title">${s.title}</div>
          <div class="stress-desc">${s.desc}</div>
          <div class="stress-value">${fmtPct(s.lr, 0)}</div>
          <div class="stress-sub">КУ · ожидаемые выплаты ${fmtMoneyShort(s.loss)}</div>
        </div>`;
    }).join('');

    document.getElementById('stress-body').innerHTML = `<div class="stress-grid">${cards}</div>`;
  })();

  // ===== ACTUARIAL METRICS =====
  (function renderActuarial() {
    const premium = z.premiumWithCoeff || z.premiumBase || 0;
    const sumInsured = z.insuranceSum || 0;
    const expectedLoss = a.avgSumPerYear || 0;
    if (a.recognition.recognized === 0 || premium === 0 || sumInsured === 0) {
      document.getElementById('card-actuarial').style.display = 'none';
      return;
    }

    // Burning Cost = выплат / страх. сумма (доля)
    const burningCost = sumInsured > 0 ? (expectedLoss / sumInsured) * 100 : 0;
    const chargedRate = z.tariff != null ? z.tariff * 100 : (premium / sumInsured * 100);

    // Pure Premium Rate = expected_loss / sum_insured (то же что Burning Cost фактически)
    // Indication rate = PP × (1 + expense + profit loading)
    const expenseLoading = 0.25;
    const profitLoading = 0.05;
    const indicationRate = burningCost * (1 + expenseLoading + profitLoading);

    // Combined Ratio = LR + ER
    const forecastLR = 100 * expectedLoss / premium;
    const assumedER = 25; // %
    const combinedRatio = forecastLR + assumedER;
    const uwMargin = 100 - combinedRatio;

    // PML (Probable Maximum Loss) — compound Poisson approach
    // E[S] = λ × μ, Var[S] = λ × (σ² + μ²) = λμ²(CV² + 1)
    const lambda = a.avgFreq;
    const mu = a.finance.avg;
    const cv = a.freqSeverity?.cv || 1;
    const ES = lambda * mu;
    const varS = lambda * mu * mu * (cv * cv + 1);
    const sigmaS = Math.sqrt(varS);
    const pml95 = ES + 1.645 * sigmaS;
    const pml99 = ES + 2.326 * sigmaS;
    const pml995 = ES + 2.576 * sigmaS;

    // Solvency Impact — PML / company assets
    const assets = snap.normativ?.fullAssetsTenge || 0;
    const solvencyImpact = assets > 0 ? (pml99 / assets) * 100 : null;

    // Adverse Selection Index — отклонение от ОКЭД
    let adverseIdx = null;
    if (snap.activity && z.workers > 0 && (snap.activity.deathRate + snap.activity.injuryRate) > 0) {
      const factRate = a.avgFreq * 1000 / z.workers;
      const normRate = snap.activity.deathRate + snap.activity.injuryRate;
      adverseIdx = factRate / normRate;
    }

    // Loss Cost per 1M ₸ страх. суммы
    const lossCost1M = sumInsured > 0 ? (expectedLoss * 1000000) / sumInsured : 0;

    const burningCostClass = burningCost > 10 ? 'bad' : burningCost > 3 ? 'warn' : 'ok';
    const crClass = combinedRatio > 110 ? 'bad' : combinedRatio > 95 ? 'warn' : 'ok';
    const rateClass = indicationRate > chargedRate * 2 ? 'bad' : indicationRate > chargedRate ? 'warn' : 'ok';
    const solvClass = solvencyImpact > 5 ? 'bad' : solvencyImpact > 1 ? 'warn' : 'ok';

    document.getElementById('actuarial-body').innerHTML = `
      <div class="actuarial-grid">
        <div class="act-card act-card--${burningCostClass}">
          <div class="act-label">Burning Cost</div>
          <div class="act-value">${fmtPct(burningCost, 2)}</div>
          <div class="act-sub">Стоимость убытков на единицу страховой суммы за год. На каждый <strong>1 М ₸</strong> страховой суммы — <strong>${fmtMoneyShort(lossCost1M)}</strong> выплат.</div>
          <div class="act-formula">BC = выплаты ÷ S.I.</div>
        </div>

        <div class="act-card act-card--${rateClass}">
          <div class="act-label">Pure Premium Rate</div>
          <div class="act-value">${fmtPct(burningCost, 2)}</div>
          <div class="act-sub">Чистая рисковая ставка. Индикативная ставка с надбавкой 30 % (расходы + маржа) — <strong>${fmtPct(indicationRate, 2)}</strong>, текущий тариф <strong>${fmtPct(chargedRate, 2)}</strong>. Дефицит ставки в <strong style="color:var(--danger-2)">${(indicationRate/chargedRate).toFixed(1).replace('.', ',')}× раз</strong>.</div>
          <div class="act-formula">PP = E[loss] ÷ S.I.</div>
        </div>

        <div class="act-card act-card--${crClass}">
          <div class="act-label">Combined Ratio</div>
          <div class="act-value">${fmtPct(combinedRatio, 1)}</div>
          <div class="act-sub">LR ${fmtPct(forecastLR, 0)} + ER ${assumedER} % = CR <strong>${fmtPct(combinedRatio, 0)}</strong>. Андеррайтинговая маржа <strong style="color:${uwMargin >= 0 ? 'var(--success-2)' : 'var(--danger-2)'}">${fmtPct(uwMargin, 1)}</strong>.</div>
          <div class="act-formula">CR = LR + ER</div>
        </div>

        <div class="act-card act-card--bad">
          <div class="act-label">PML 99 % (Compound Poisson)</div>
          <div class="act-value">${fmtMoneyShort(pml99)}</div>
          <div class="act-sub">Максимально вероятный годовой убыток с 99 % уверенностью. P95 = <strong>${fmtMoneyShort(pml95)}</strong>, P99.5 = <strong>${fmtMoneyShort(pml995)}</strong>.</div>
          <div class="act-formula">PML = E[S] + Z·σ[S]</div>
        </div>

        ${solvencyImpact != null ? `
        <div class="act-card act-card--${solvClass}">
          <div class="act-label">Solvency Impact</div>
          <div class="act-value">${fmtPct(solvencyImpact, 2)}</div>
          <div class="act-sub">Доля PML 99 % от активов Компании (${fmtMoneyShort(assets)}). ${solvencyImpact > 5 ? 'Превышает порог 5 % — необходимо перестрахование.' : solvencyImpact > 1 ? 'В пределах допустимого, но требует внимания.' : 'Не оказывает критического влияния на solvency.'}</div>
          <div class="act-formula">SI = PML ÷ Assets</div>
        </div>` : ''}

        ${adverseIdx != null ? `
        <div class="act-card act-card--${adverseIdx > 5 ? 'bad' : adverseIdx > 2 ? 'warn' : 'ok'}">
          <div class="act-label">Adverse Selection Index</div>
          <div class="act-value">× ${adverseIdx >= 100 ? adverseIdx.toFixed(0) : adverseIdx.toFixed(1).replace('.', ',')}</div>
          <div class="act-sub">Кратность отклонения фактической частоты НС от среднеотраслевой нормы по ОКЭД. ${adverseIdx > 5 ? 'Глубокий anti-selection — клиент существенно хуже отрасли.' : adverseIdx > 1.5 ? 'Лёгкий anti-selection.' : 'Близок к норме отрасли.'}</div>
          <div class="act-formula">ASI = факт ÷ норма</div>
        </div>` : ''}
      </div>`;
  })();

  // ===== POISSON DISTRIBUTION =====
  (function renderPoisson() {
    if (!a.avgFreq || a.avgFreq === 0) {
      document.getElementById('card-poisson').style.display = 'none';
      return;
    }
    const lambda = a.avgFreq;
    const isHugeLambda = lambda > 50;
    // PMF: P(X = k)
    const poissonPMF = (k, l) => {
      // Use log for stability with large lambda
      // log P = k*log(l) - l - log(k!)
      let logFact = 0;
      for (let i = 2; i <= k; i++) logFact += Math.log(i);
      const logP = k * Math.log(l) - l - logFact;
      return Math.exp(logP);
    };

    // Pick range around lambda
    const center = Math.round(lambda);
    let lo, hi;
    if (isHugeLambda) {
      const sigma = Math.sqrt(lambda);
      lo = Math.max(0, Math.round(center - 2 * sigma));
      hi = Math.round(center + 2 * sigma);
    } else {
      lo = 0;
      hi = Math.min(20, Math.round(lambda * 3));
    }
    // Adaptive step: cap rows at ~25
    const MAX_ROWS = 25;
    const fullRange = hi - lo + 1;
    const step = Math.max(1, Math.ceil(fullRange / MAX_ROWS));
    const rows = [];
    let maxProb = 0;
    for (let k = lo; k <= hi; k += step) {
      const p = poissonPMF(k, lambda);
      rows.push({ k, p });
      if (p > maxProb) maxProb = p;
    }
    // Cumulative for VaR-like estimate
    let cumLo = 0;
    let cumHi = 0;
    for (let k = 0; k < center; k++) cumLo += poissonPMF(k, lambda);

    // Tail: P(X >= center + 1.96*sigma)
    const upperBound = Math.round(lambda + 1.96 * Math.sqrt(lambda));
    let tailProb = 0;
    for (let k = upperBound; k <= upperBound + 100; k++) tailProb += poissonPMF(k, lambda);

    const html = rows.map(r => {
      const pct = (r.p / maxProb) * 100;
      const isMode = r.k === center;
      return `
        <div class="poisson-bar-row">
          <div class="pb-n">${r.k}${isMode ? ' ●' : ''}</div>
          <div class="pb-track"><div class="pb-fill" style="width:${pct}%${isMode ? ';background:linear-gradient(90deg,#ec4899,#9333ea)' : ''}"></div></div>
          <div class="pb-prob">${(r.p * 100).toFixed(2).replace('.', ',')} %</div>
        </div>`;
    }).join('');

    document.getElementById('poisson-body').innerHTML = `
      <div style="font-size:12px;color:var(--muted);margin-bottom:12px;line-height:1.55">
        Параметр <strong style="color:var(--ink)">λ = ${fmtInt(lambda)}</strong> (среднегодовая частота НС).
        Распределение Пуассона показывает вероятность ровно N случаев за год.
      </div>
      <div class="poisson-bar-list">${html}</div>
      <div style="margin-top:14px;padding:10px 14px;background:linear-gradient(135deg, #f3f4f6, #e5e7eb);border-radius:8px;font-size:11.5px;color:var(--ink-3);line-height:1.55">
        <strong>Мода:</strong> наиболее вероятно <strong style="color:var(--ink)">${center}</strong> НС в год.
        <strong>Хвост ≥ ${upperBound}:</strong> ${(tailProb * 100).toFixed(2).replace('.', ',')} % вероятность.
      </div>`;
  })();

  // ===== TREND & FORECAST =====
  (function renderTrend() {
    // Annualize partial current year to make trend honest
    const today = new Date();
    const startOfYear = new Date(today.getFullYear(), 0, 1);
    const daysInYear = (today - startOfYear) / (1000 * 60 * 60 * 24);
    const yearFraction = Math.max(0.05, daysInYear / 365);
    const years = (a.byYear || []).filter(y => y.cases >= 5).map(y => {
      if (y.year === today.getFullYear() && yearFraction < 0.95) {
        return {
          ...y,
          cases: Math.round(y.cases / yearFraction),
          originalCases: y.cases,
          partial: true,
        };
      }
      return y;
    });
    if (years.length < 3) {
      document.getElementById('card-trend').style.display = 'none';
      return;
    }
    // Linear regression on (yearIndex, cases)
    const n = years.length;
    const xs = years.map((_, i) => i);
    const ys = years.map(y => y.cases);
    const sumX = xs.reduce((s, v) => s + v, 0);
    const sumY = ys.reduce((s, v) => s + v, 0);
    const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0);
    const sumX2 = xs.reduce((s, v) => s + v * v, 0);
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    const nextX = n;
    const forecast = Math.max(0, intercept + slope * nextX);
    const lastYear = years[years.length - 1].year;
    const forecastYear = lastYear + 1;

    // SVG
    const W = 600, H = 200, padL = 40, padR = 20, padT = 16, padB = 32;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const allYs = ys.concat([forecast]);
    const maxY = Math.max(...allYs) * 1.1;
    const xStep = innerW / n; // n historical + 1 forecast = n+1 points spaced over n intervals
    const pts = years.map((y, i) => ({
      x: padL + i * xStep,
      y: padT + innerH - (y.cases / maxY) * innerH,
      year: y.year,
      cases: y.cases,
    }));
    const fcastPt = {
      x: padL + n * xStep,
      y: padT + innerH - (forecast / maxY) * innerH,
      year: forecastYear,
      cases: Math.round(forecast),
    };

    const linePoints = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ');
    const dots = pts.map(p =>
      `<circle class="trend-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4">
         <title>${p.year}: ${p.cases} НС</title>
       </circle>`
    ).join('');
    const fcastLineX = pts[pts.length - 1].x;
    const fcastLineY = pts[pts.length - 1].y;

    const xLabels = pts.concat([fcastPt]).map((p, idx) => {
      const yearObj = idx < years.length ? years[idx] : null;
      const lbl = yearObj && yearObj.partial ? `${p.year}*` :
                  p.year === forecastYear ? `${p.year}*` : p.year;
      return `<text class="trend-axis" x="${p.x.toFixed(1)}" y="${H - 8}" text-anchor="middle">${lbl}</text>`;
    }).join('');

    const hasPartial = years.some(y => y.partial);

    document.getElementById('trend-body').innerHTML = `
      <svg class="trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <line class="trend-grid" x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}"/>
        <line class="trend-grid" x1="${padL}" y1="${padT + innerH/2}" x2="${W - padR}" y2="${padT + innerH/2}"/>
        <line class="trend-grid" x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}"/>
        <path class="trend-line" d="M ${linePoints}"/>
        <path class="trend-forecast-line" d="M ${fcastLineX} ${fcastLineY} L ${fcastPt.x} ${fcastPt.y}"/>
        ${dots}
        <circle class="trend-forecast-dot" cx="${fcastPt.x.toFixed(1)}" cy="${fcastPt.y.toFixed(1)}" r="5">
          <title>${forecastYear}: прогноз ${Math.round(forecast)} НС</title>
        </circle>
        <text class="trend-axis" x="${padL - 6}" y="${padT + 6}" text-anchor="end">${fmtInt(maxY)}</text>
        <text class="trend-axis" x="${padL - 6}" y="${padT + innerH + 4}" text-anchor="end">0</text>
        ${xLabels}
      </svg>
      <div class="trend-label-band">
        <strong>Прогноз ${forecastYear}:</strong> ${fmtInt(forecast)} НС
        ${slope > 0 ? `(<strong style="color:var(--danger-2)">↑ растущий тренд</strong>, +${fmtInt(slope)} НС/год)` :
          slope < 0 ? `(<strong style="color:var(--success-2)">↓ снижающийся</strong>, ${fmtInt(slope)} НС/год)` :
          '(стабильный)'}.
        Линейная регрессия по ${n} ${hasPartial ? 'точкам (текущий год аннуализирован, отмечен «*»)' : 'историческим точкам'}.
      </div>`;
  })();

  // ===== PREMIUM LADDER =====
  (function renderPremLadder() {
    const premium = z.premiumWithCoeff || z.premiumBase || 0;
    if (a.recognition.recognized === 0 || premium === 0 || !a.freqSeverity) {
      document.getElementById('card-premladder').style.display = 'none';
      return;
    }
    // Compound Poisson moments
    const lambda = a.avgFreq;
    const mu = a.finance.avg;
    const cv = a.freqSeverity.cv || 1;
    const sigmaS = Math.sqrt(lambda * mu * mu * (cv * cv + 1));

    const pure = lambda * mu; // E[S]
    const riskLoading = 0.5 * sigmaS; // загрузка 0.5σ
    const expenseLoadingRate = 0.25; // 25 %
    const profitMarginRate = 0.05; // 5 %

    const riskAdjusted = pure + riskLoading;
    const office = riskAdjusted / (1 - expenseLoadingRate);
    const technical = office * (1 + profitMarginRate);

    const maxVal = Math.max(technical, premium);

    const adequacy = premium / technical;
    let summaryClass, summaryText;
    if (adequacy >= 1.0) {
      summaryClass = 'ok';
      summaryText = `Текущая премия покрывает техническую с запасом <strong>${fmtPct((adequacy - 1) * 100, 1)}</strong>.`;
    } else if (adequacy >= 0.7) {
      summaryClass = 'warn';
      summaryText = `Текущая премия покрывает <strong>${fmtPct(adequacy * 100, 1)}</strong> технической. Требуется надбавка <strong>×${(1/adequacy).toFixed(2).replace('.', ',')}</strong>.`;
    } else {
      summaryClass = 'bad';
      summaryText = `Премия покрывает только <strong>${fmtPct(adequacy * 100, 1)}</strong> технической. Дефицит <strong>${fmtMoneyShort(technical - premium)}</strong>, требуется надбавка <strong>×${(1/adequacy).toFixed(1).replace('.', ',')}</strong>.`;
    }

    const row = (label, sub, value, fillClass) => `
      <div class="ladder-row">
        <div class="ladder-label">${label}<small>${sub}</small></div>
        <div class="ladder-track">
          <div class="ladder-fill ${fillClass}" style="width:${(value/maxVal)*100}%">${fmtMoneyShort(value)}</div>
        </div>
        <div class="ladder-value">${fmtMoneyShort(value)}</div>
      </div>`;

    document.getElementById('premladder-body').innerHTML = `
      ${row('Pure Premium', 'E[S] = λ × μ — чистый ожидаемый убыток', pure, 'ladder-fill--pure')}
      ${row('+ Risk Loading', '+ 0,5σ — надбавка за волатильность', riskAdjusted, 'ladder-fill--risk')}
      ${row('Office Premium', '+ 25 % расходы — gross-up', office, 'ladder-fill--office')}
      ${row('Technical Premium', '+ 5 % маржа прибыли', technical, 'ladder-fill--technical')}
      ${row('Charged Premium', 'фактическая премия по договору', premium, 'ladder-fill--charged')}
      <div class="ladder-summary ladder-summary--${summaryClass}">
        <span>${summaryText}</span>
        <strong>Adequacy: ${fmtPct(adequacy * 100, 1)}</strong>
      </div>`;
  })();

  // ===== TAIL RISK =====
  (function renderTailRisk() {
    if (!a.freqSeverity || a.recognition.recognized === 0) {
      document.getElementById('card-tailrisk').style.display = 'none';
      return;
    }
    const lambda = a.avgFreq;
    const mu = a.finance.avg;
    const cv = a.freqSeverity.cv || 1;
    const ES = lambda * mu;
    const sigmaS = Math.sqrt(lambda * mu * mu * (cv * cv + 1));

    // VaR at confidence levels
    const VaR_99 = ES + 2.326 * sigmaS;
    // TVaR (CVaR) for normal approx: μ + σ × φ(z)/(1-Φ(z))
    // For 99%: z=2.326, φ(z)=0.0267, 1-Φ(z)=0.01 → TVaR factor ≈ 2.665
    const TVaR_99 = ES + 2.665 * sigmaS;
    const VaR_995 = ES + 2.576 * sigmaS;   // 1-in-200
    const oneIn100 = ES + 2.326 * sigmaS;  // P99 ≈ 1-in-100
    const oneIn250 = ES + 2.807 * sigmaS;  // P99.6 ≈ 1-in-250
    const maxCredible = ES + 3.5 * sigmaS; // Worst plausible

    document.getElementById('tailrisk-body').innerHTML = `
      <div class="tail-grid">
        <div class="tail-item tail-item--var">
          <div class="tail-label">VaR 99 %</div>
          <div class="tail-value">${fmtMoneyShort(VaR_99)}</div>
          <div class="tail-sub">99 % годовых убытков не превысят этой суммы. Стандарт для расчёта резервов.</div>
        </div>
        <div class="tail-item tail-item--cvar">
          <div class="tail-label">TVaR / CVaR 99 %</div>
          <div class="tail-value">${fmtMoneyShort(TVaR_99)}</div>
          <div class="tail-sub">Ожидаемый убыток в худшем 1 % случаев. Более консервативная мера хвостового риска.</div>
        </div>
        <div class="tail-item tail-item--100y">
          <div class="tail-label">1-в-100 лет</div>
          <div class="tail-value">${fmtMoneyShort(oneIn100)}</div>
          <div class="tail-sub">Убыток, который ожидается раз в 100 лет (Solvency II стандарт).</div>
        </div>
        <div class="tail-item tail-item--250y">
          <div class="tail-label">1-в-250 лет</div>
          <div class="tail-value">${fmtMoneyShort(oneIn250)}</div>
          <div class="tail-sub">Экстремальное событие. Используется для оценки катастрофического риска.</div>
        </div>
      </div>
      <div style="margin-top:14px;padding:12px 16px;background:linear-gradient(135deg, #fef2f2, #fee2e2);border-radius:10px;font-size:12px;color:#7f1d1d;line-height:1.55">
        <strong>Максимально кредибельный убыток (μ + 3,5σ):</strong> ${fmtMoneyShort(maxCredible)}.
        Это «worst plausible» сценарий — крайне маловероятен, но используется для проектирования катастрофического перестрахования.
      </div>`;
  })();

  // ===== ECONOMIC CAPITAL & RAROC =====
  (function renderCapital() {
    const premium = z.premiumWithCoeff || z.premiumBase || 0;
    if (a.recognition.recognized === 0 || premium === 0 || !a.freqSeverity) {
      document.getElementById('card-capital').style.display = 'none';
      return;
    }
    const lambda = a.avgFreq;
    const mu = a.finance.avg;
    const cv = a.freqSeverity.cv || 1;
    const ES = lambda * mu;
    const sigmaS = Math.sqrt(lambda * mu * mu * (cv * cv + 1));

    // Economic Capital = Unexpected Loss at 99.5 % (Solvency II)
    const EC = 2.576 * sigmaS;

    // RAROC = (Premium − Expected Loss − Expenses) / Economic Capital
    const expenses = premium * 0.25;
    const uwProfit = premium - ES - expenses;
    const raroc = EC > 0 ? (uwProfit / EC) * 100 : null;

    // Capital adequacy: EC vs portfolio capacity
    const assets = snap.normativ?.fullAssetsTenge || 0;
    const capRatio = assets > 0 ? (EC / assets) * 100 : null;

    let rarocClass, rarocText;
    if (raroc == null) { rarocClass = 'bad'; rarocText = '—'; }
    else if (raroc >= 20) { rarocClass = 'raroc-ok'; rarocText = 'Превосходный'; }
    else if (raroc >= 10) { rarocClass = 'raroc-ok'; rarocText = 'Приемлемый'; }
    else if (raroc >= 0) { rarocClass = 'raroc-warn'; rarocText = 'Низкий'; }
    else { rarocClass = 'raroc-bad'; rarocText = 'Отрицательный — разрушение капитала'; }

    document.getElementById('capital-body').innerHTML = `
      <div class="capital-grid">
        <div class="capital-big capital-big--ec">
          <div class="capital-label">Экономический капитал</div>
          <div class="capital-value">${fmtMoneyShort(EC)}</div>
          <div class="capital-sub">
            Капитал на риск (Unexpected Loss при 99,5 % — стандарт Solvency II).
            ${capRatio != null ? `Составляет <strong>${fmtPct(capRatio, 2)}</strong> от активов Компании.` : ''}
          </div>
          <div class="capital-formula">EC = 2,576 × σ[S]</div>
        </div>
        <div class="capital-big capital-big--${rarocClass}">
          <div class="capital-label">RAROC (риск-скорректированная доходность)</div>
          <div class="capital-value">${raroc != null ? fmtPct(raroc, 1) : '—'}</div>
          <div class="capital-sub">
            <strong>${rarocText}.</strong>
            (Премия ${fmtMoneyShort(premium)} − Ожид. убыток ${fmtMoneyShort(ES)} − Расходы 25 %) ÷ EC.
            Целевой уровень — ≥ 15 % годовых.
          </div>
          <div class="capital-formula">RAROC = (P − E[L] − Expenses) ÷ EC</div>
        </div>
      </div>
      <div style="font-size:11.5px;color:var(--muted);line-height:1.55;padding:10px 14px;background:var(--bg);border-radius:8px;border-left:3px solid var(--brand)">
        <strong style="color:var(--ink-2)">Андеррайтинговая прибыль:</strong>
        ${uwProfit >= 0 ? `<span style="color:var(--success-2)">+${fmtMoneyShort(uwProfit)}/год</span>` : `<span style="color:var(--danger-2)">${fmtMoneyShort(uwProfit)}/год</span>`}.
        ${uwProfit < 0
          ? 'Договор уничтожает капитал — каждый год Компания теряет на нём средства.'
          : raroc != null && raroc < 10
          ? 'Доходность ниже целевого уровня — низкая компенсация за принятый риск.'
          : 'Договор финансово оправдан.'}
      </div>`;
  })();

  // ===== VOLATILITY & STABILITY =====
  (function renderVolatility() {
    if (!a.freqSeverity || a.recognition.recognized === 0) {
      document.getElementById('card-volatility').style.display = 'none';
      return;
    }
    // Frequency CV under Poisson: σ_λ = √λ, CV_freq = 1/√λ
    const lambda = a.avgFreq;
    const freqCV = lambda > 0 ? 1 / Math.sqrt(lambda) : 0;
    // Severity CV (already in freqSeverity)
    const sevCV = a.freqSeverity.cv || 0;
    // Aggregate CV: σ[S]/E[S] = √(CV²_freq + CV²_sev + CV²_freq × CV²_sev)
    // Simplified: under Poisson, σ²[S] = λ(σ² + μ²) → CV²_agg = (CV²_sev + 1)/λ
    const aggCV = lambda > 0 ? Math.sqrt((sevCV * sevCV + 1) / lambda) : 0;

    // YoY frequency CV from byYear
    const cases = (a.byYear || []).filter(y => y.year < new Date().getFullYear()).map(y => y.cases);
    let yoyCV = 0;
    if (cases.length >= 2) {
      const mean = cases.reduce((s, v) => s + v, 0) / cases.length;
      const variance = cases.reduce((s, v) => s + (v - mean) ** 2, 0) / cases.length;
      yoyCV = mean > 0 ? Math.sqrt(variance) / mean : 0;
    }

    const interpret = (cv) => {
      if (cv < 0.2) return { cls: 'ok', label: 'Очень стабильно' };
      if (cv < 0.5) return { cls: 'ok', label: 'Стабильно' };
      if (cv < 1.0) return { cls: 'warn', label: 'Умеренно волатильно' };
      return { cls: 'bad', label: 'Высокая волатильность' };
    };

    const stab = (label, sub, cv, formula) => {
      const i = interpret(cv);
      const meterW = Math.min(100, cv * 100);
      return `
        <div class="vol-card vol-card--${i.cls}">
          <div class="vol-label">${label}</div>
          <div class="vol-value">${cv.toFixed(2).replace('.', ',')}</div>
          <div class="vol-meter"><div class="vol-meter-fill" style="width:${meterW}%"></div></div>
          <div class="vol-sub"><strong style="color:var(--ink-2)">${i.label}.</strong> ${sub}</div>
        </div>`;
    };

    // Composite stability score (lower CV = better)
    const compositeCV = (freqCV + sevCV + aggCV + yoyCV) / 4;
    const compInt = interpret(compositeCV);
    const compositeScore = Math.round(Math.max(0, 100 - compositeCV * 50));

    document.getElementById('volatility-body').innerHTML = `
      <div class="vol-grid">
        ${stab('CV частоты (Poisson)', 'Теоретическая для частоты под Пуассоном: 1/√λ.', freqCV)}
        ${stab('CV серьёзности', 'σ выплаты на дело ÷ средняя выплата.', sevCV)}
        ${stab('CV совокупного убытка', 'σ[S] ÷ E[S] — общая волатильность годового убытка.', aggCV)}
        ${stab('CV частоты год-к-году', 'Эмпирический разброс по полным годам истории.', yoyCV)}
      </div>
      <div style="margin-top:14px;padding:14px 18px;background:linear-gradient(135deg, var(--bg), var(--bg-2));border-radius:12px;border-left:4px solid var(--brand);display:flex;justify-content:space-between;align-items:center;gap:14px">
        <div>
          <div style="font-size:11px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:0.05em">Composite Stability Score</div>
          <div style="font-size:28px;font-weight:800;color:var(--ink);font-variant-numeric:tabular-nums;letter-spacing:-0.025em;margin-top:4px">${compositeScore}<span style="font-size:13px;color:var(--muted);font-weight:500"> / 100</span></div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px"><strong style="color:var(--ink-2)">${compInt.label}.</strong> Среднее CV: ${compositeCV.toFixed(2).replace('.', ',')}.</div>
        </div>
        <div style="font-size:11.5px;color:var(--ink-3);max-width:480px;line-height:1.55">
          Низкое CV (< 0,5) означает <strong>предсказуемые</strong> убытки — премия может быть рассчитана точно.
          Высокое CV (> 1) — <strong>непредсказуемые</strong>, нужна большая надбавка за волатильность и резервы.
        </div>
      </div>`;
  })();

  // ===== REINSURANCE RECOMMENDATION =====
  (function renderReinsurance() {
    const premium = z.premiumWithCoeff || z.premiumBase || 0;
    const sumInsured = z.insuranceSum || 0;
    const expectedLoss = a.avgSumPerYear || 0;
    if (a.recognition.recognized === 0 || premium === 0) {
      document.getElementById('card-reinsurance').style.display = 'none';
      return;
    }
    const lambda = a.avgFreq;
    const mu = a.finance.avg;
    const cv = a.freqSeverity?.cv || 1;
    const ES = lambda * mu;
    const sigmaS = Math.sqrt(lambda * mu * mu * (cv * cv + 1));
    const pml99 = ES + 2.326 * sigmaS;
    const maxClaim = a.finance.max;
    const assets = snap.normativ?.fullAssetsTenge || 0;
    const forecastLR = 100 * expectedLoss / premium;

    // Determine recommended retention
    let retentionPct, cessionPct, retentionLabel, cessionLabel;
    let primaryRec = '';
    const actions = [];

    if (forecastLR > 300) {
      retentionPct = 5; cessionPct = 95;
      retentionLabel = 'Минимальное (5 %)';
      cessionLabel = 'Максимальная цессия';
      primaryRec = 'Quota Share 95/5 — передать 95 % риска в перестрахование';
      actions.push({ title: 'Quota Share 95/5', desc: 'Передать 95 % страховой суммы в пропорциональное перестрахование. Собственное удержание — 5 %.' });
      actions.push({ title: 'Cat XOL по смертельности', desc: `Excess-of-Loss поверх ${fmtMoneyShort(maxClaim * 0.5)} на одно событие для защиты от катастрофических смертельных случаев.` });
      actions.push({ title: 'Передача в пул', desc: 'Использование обязательного перестраховочного пула (АО «Государственная страховая корпорация по перестрахованию»).' });
    } else if (forecastLR > 100) {
      retentionPct = 30; cessionPct = 70;
      retentionLabel = 'Сниженное (30 %)';
      cessionLabel = 'Высокая цессия';
      primaryRec = 'Quota Share 70/30 + Surplus Treaty';
      actions.push({ title: 'Quota Share 70/30', desc: 'Передать 70 % страховой суммы в пропорциональное перестрахование.' });
      actions.push({ title: 'Surplus Treaty', desc: `Сверх лимита ${fmtMoneyShort(sumInsured * 0.3)} на один договор — surplus reinsurance.` });
    } else if (forecastLR > 70) {
      retentionPct = 60; cessionPct = 40;
      retentionLabel = 'Среднее (60 %)';
      cessionLabel = 'Умеренная цессия';
      primaryRec = 'Quota Share 40 % + per-risk XOL';
      actions.push({ title: 'Quota Share 60/40', desc: 'Удержать 60 % риска, передать 40 % пропорционально.' });
      actions.push({ title: 'Per-Risk XOL', desc: `Excess-of-Loss свыше ${fmtMoneyShort(maxClaim * 0.7)} на одно событие для защиты от пиковых выплат.` });
    } else {
      retentionPct = 85; cessionPct = 15;
      retentionLabel = 'Высокое (85 %)';
      cessionLabel = 'Минимальная';
      primaryRec = 'Cat XOL для защиты от катастроф';
      actions.push({ title: 'Удержать 85 % риска', desc: 'Финансовое состояние договора позволяет нести основную часть риска самостоятельно.' });
      actions.push({ title: 'Cat XOL опционально', desc: `Catastrophe Excess-of-Loss свыше ${fmtMoneyShort(pml99)} для защиты от хвостовых событий (PML 99 %).` });
    }

    const solvencyImpact = assets > 0 ? (pml99 / assets) * 100 : null;
    if (solvencyImpact != null && solvencyImpact > 5) {
      actions.push({ title: 'Solvency-driven сокращение', desc: `PML 99 % (${fmtMoneyShort(pml99)}) превышает 5 % активов — требуется обязательная цессия для защиты solvency margin.` });
    }

    document.getElementById('reinsurance-body').innerHTML = `
      <div class="reins-grid">
        <div class="reins-block reins-block--retention">
          <h3>Собственное удержание</h3>
          <div class="reins-value">${retentionPct} %</div>
          <div class="reins-sub">${retentionLabel} — ${fmtMoneyShort(sumInsured * retentionPct / 100)} страховой суммы</div>
        </div>
        <div class="reins-block reins-block--cession">
          <h3>Передаётся в перестрахование</h3>
          <div class="reins-value">${cessionPct} %</div>
          <div class="reins-sub">${cessionLabel} — ${fmtMoneyShort(sumInsured * cessionPct / 100)}</div>
        </div>
      </div>
      <div style="margin-bottom:12px;font-size:13px;color:var(--ink-2);font-weight:600">
        Основная рекомендация: <span style="color:var(--brand)">${primaryRec}</span>
      </div>
      <div class="reins-actions">
        ${actions.map((act, i) => `
          <div class="reins-action">
            <div class="reins-bullet">${i + 1}</div>
            <div>
              <strong>${act.title}</strong>
              <span>${act.desc}</span>
            </div>
          </div>`).join('')}
      </div>`;
  })();

  // ===== INFO ICONS — inject tooltips on every card =====
  (function attachInfoIcons() {
    const INFOS = {
      'card-score': 'Композитный Risk Score (0–100) — единая интегральная оценка качества риска для быстрого принятия решения.\n\nКак считается: взвешенная сумма 5 компонентов:\n• Mortality vs ОКЭД (30 %) — насколько фактическая смертность отклоняется от отраслевой нормы\n• Прогнозный КУ (30 %) — ожидаемый коэффициент убыточности vs целевой 70 %\n• Частота НС vs ОКЭД (20 %) — отклонение общей частоты от нормы\n• Качество регистрации (10 %) — доля признанных страховыми (норма 80–95 %)\n• Концентрация HHI (10 %) — распределение между страховщиками\n\nИнтерпретация:\n• 80–100 — низкий риск, стандартное принятие\n• 60–80 — умеренный, обычный коэффициент\n• 30–60 — повышенный, надбавка к тарифу\n• 0–30 — критический, отклонение или существенная корректировка',
      'card-dynamic': 'Число признанных страховых случаев и сумма выплат в разрезе годов за 3-летний период. Учитываются только дела со статусом «Случай признан страховым».',
      'card-severity': 'Распределение признанных случаев по характеру риска. Бакеты определяются по флагам «Свершившиеся риски» (col 11–20 в реестре): смерть, УПТ 30–100 % и т.д.',
      'card-monthly': 'Помесячный тренд числа НС за 24 месяца. Синяя линия — все признанные НС в месяц, пунктирная красная — только смертельные случаи.',
      'card-heatmap': 'Тепловая карта интенсивности НС по месяцам и годам. Чем темнее ячейка — тем больше случаев в этом месяце. Справа итог за год.',
      'card-quarter': 'Сезонность: распределение страховых случаев по кварталам за 3 года. Выявляет периоды повышенной частоты.',
      'card-annuity': 'Сколько кейсов имеет 1, 2 и более выплат. Многократные выплаты — это аннуитеты или доплаты по одному инциденту.',
      'card-finance': 'Распределение размера выплат: перцентили P25/P50/P75/P90/P99, минимум и максимум. Близость медианы к среднему = симметричное распределение без катастрофического хвоста.',
      'card-top': 'Топ-10 крупнейших выплат за 3 года. Цветные полосы слева: красная — смерть, жёлтая — УПТ.',
      'card-deaths': 'Полный список смертельных страховых случаев за 3 года: дата, страховщик, сумма выплаты. Списком, в обратном хронологическом порядке.',
      'card-top30': 'Реестр 30 самых крупных дел: страховщик, № дела, дата СК, категория и тип риска. Сортировка по сумме выплаты.',
      'card-freqsev': 'Актуарное разложение: pure loss = частота × средняя выплата. CV — коэффициент вариации выплат (разброс), MTBL — среднее число дней между НС.',
      'card-var': 'Value-at-Risk: вероятность что выплата по случаю не превысит указанной суммы. P99 = 99 % выплат не больше этой суммы. VaR используется для расчёта резервов.',
      'card-sevyear': 'Кросс-таблица: число дел и сумма выплат по категориям тяжести × годам. Помогает увидеть динамику смертельности и УПТ.',
      'card-insurers': 'Сравнение страховщиков по числу дел, доле, сумме выплат, средней выплате, % признания страховыми и среднему времени урегулирования.',
      'card-statuses': 'Все встретившиеся значения статуса рассмотрения в файле истории убытков (поле «Результат страхового случая» в детализированном листе).',
      'card-insbubble': 'Bubble-чарт: X — средняя выплата, Y — % признания страховыми, размер пузыря — совокупная сумма выплат. Идеальный страховщик в правом верхнем углу с большим пузырём.',
      'card-insyear': 'Эволюция страховщиков по годам: какие компании доминировали в каком году. Stacked-bar по числу дел с цветами по страховщикам.',
      'card-settlement': 'Распределение скорости урегулирования: дни от даты СК до первой выплаты. Норма ≤ 30 дней. Долгие хвосты (>1 года) — судебные тяжбы.',
      'card-types': 'Распределение дел по полю «Тип риска» (col 4 в детализированном листе). Альтернативная классификация дополнительно к флагам «Свершившиеся риски».',
      'card-risk-profile': 'Ключевые характеристики страхователя: класс риска (1–25), численность, доля договорной суммы от активов компании, отклонение смертности от нормы ОКЭД, гос. участие.',
      'card-tariff': 'Цепочка расчёта премии по договору: страховая сумма × базовый тариф (по ОКЭД) × поправочный коэффициент (матрица «работники × НС») × (1 − понижающий) = итоговая премия.',
      'card-norms': 'Сравнение фактических показателей предприятия с отраслевой нормой по ОКЭД. Источник нормативов — «Калькулятор рентабельности». Кратность отклонения показывается chip-плашкой.',
      'card-funnel': 'Воронка признания: путь дела от заявления до выплаты. Показывает конверсию на каждом этапе и долю отказов / открытых дел.',
      'card-pareto': 'Парето-распределение: насколько крупные дела доминируют. Если 10 % дел дают >50 % выплат — высокая концентрация в хвосте, риск катастрофических потерь.',
      'card-premdecomp': 'Разложение премии vs ожидаемого убытка: что покрывает (синий блок) и что не покрывает (красный) текущая премия. Дефицит = ожидаемые выплаты − премия.',
      'card-concentration': 'Качество портфеля: HHI (концентрация по страховщикам), tail concentration (доля топ-10 % дел), катастрофические события (≥50 М ₸), максимальный период между смертельными случаями.',
      'card-percapita': 'Экономика на одного работника: удельный убыток / год, удельная премия, pure premium (чистая рисковая часть), достаточность премии (норма ≥ 130 %).',
      'card-forecast': 'Прогноз убыточности по новому договору: ожидаемое число НС и сумма выплат на основе исторической частоты и средней выплаты, плюс сравнение с портфельным КУ.',
      'card-sensitivity': 'Анализ чувствительности: при каких уровнях премии договор достигает разных целевых КУ (текущая / 100 % безубыточность / 70 % целевой / 50 % с маржой).',
      'card-stress': 'Стресс-тесты: что произойдёт с КУ при отклонении от базового сценария — рост частоты НС на 20 % / 50 % или повторение худшего года в истории.',
      'card-required': 'Требуемая премия для достижения различных целевых КУ. Показывает во сколько раз нужно увеличить премию, чтобы договор был финансово устойчив.',
      'card-actuarial': '6 ключевых актуарных показателей для оценки риска:\n\n• Burning Cost (BC) — стоимость убытков на единицу страховой суммы. Показывает, сколько копеек убытков приходится на каждый тенге защиты. Стандарт международного перестрахования.\n• Pure Premium Rate (PP) — чистая рисковая ставка = E[loss] ÷ Sum Insured. Это «голая» ставка без расходов и маржи.\n• Combined Ratio (CR) = LR + ER. Если CR < 100 % — договор прибылен, > 100 % — убыточен. Целевой ≤ 95 %.\n• PML 99 % (Probable Maximum Loss) — максимально вероятный годовой убыток, который не превысит 99 % сценариев. Использует Compound Poisson модель.\n• Solvency Impact — доля PML от активов Компании. Норма ≤ 5 %, иначе нужно перестрахование.\n• Adverse Selection Index — кратность превышения нормы по ОКЭД. >5× = antiselection.',
      'card-poisson': 'Распределение Пуассона P(X=k) = λᵏ·e⁻ᵏ/k! — вероятность того, что в году будет ровно k страховых случаев при средней частоте λ. Тёмно-розовая полоса — мода (наиболее вероятное число НС).',
      'card-trend': 'Линейная регрессия на исторических данных с прогнозом на следующий год. Сплошная линия — факт, пунктирная — прогноз. Знак наклона показывает растущий/снижающийся/стабильный тренд.',
      'card-reinsurance': 'Рекомендация по структуре перестрахования: какой долей удержать риск собственно, какую передать. Зависит от прогнозного КУ, PML и Solvency Impact. Включает конкретные действия (Quota Share, Surplus, XOL, Cat XOL).',
      'card-premladder': 'Декомпозиция технической премии: Pure Premium (чистый риск E[S] = λ × μ) + Risk Loading (0,5σ за волатильность) + Expense Loading (gross-up на 25 % расходов) + Profit Margin (5 % маржа) = Technical Premium. Сравнивается с фактической премией по договору.',
      'card-tailrisk': 'Хвостовой риск (Tail Risk) — оценка убытков в редких, но крайне крупных сценариях.\n\n• VaR 99 % (Value-at-Risk) — сумма, ниже которой остаются 99 % годовых убытков. Используется для расчёта обязательных резервов.\n• TVaR / CVaR (Conditional VaR, Expected Shortfall) — средний убыток в худшем 1 % случаев. Более консервативная мера: учитывает, КАК сильно превышается порог.\n• 1-в-100 лет — убыток уровня, ожидаемого раз в столетие (стандарт Solvency II для страховых компаний).\n• 1-в-250 лет — экстремальный сценарий для проектирования катастрофического перестрахования.\n\nВсе считаются через Compound Poisson модель: E[S] + Z·σ[S], где Z — квантиль нормального распределения.',
      'card-capital': 'Экономический капитал и RAROC — два ключевых показателя для оценки эффективности договора:\n\n• Economic Capital (EC) — капитал, который нужно «заморозить» под этот риск. Считается как Unexpected Loss при 99,5 % уверенности (стандарт Solvency II). Формула: 2,576 × σ[S].\n• RAROC (Risk-Adjusted Return On Capital) — доходность с учётом риска. Показывает, сколько мы зарабатываем на каждый тенге капитала-в-риске.\n  Формула: (Премия − Ожидаемые выплаты − Расходы) ÷ EC.\n\nКак читать:\n• RAROC ≥ 20 % — превосходный договор\n• 15–20 % — приемлемый\n• 0–15 % — низкий, но не убыточный\n• < 0 % — договор разрушает капитал, отклонить',
      'card-volatility': 'Коэффициенты вариации (CV = σ/μ) измеряют предсказуемость убытков. Чем ниже CV — тем точнее можно рассчитать премию.\n\n• CV частоты (Poisson) — теоретический разброс числа НС. Под Пуассоном CV = 1/√λ. Чем больше λ, тем меньше относительный разброс.\n• CV серьёзности — разброс размера выплаты. Большой CV = есть катастрофические единичные выплаты.\n• CV совокупного убытка — общая волатильность годового убытка с учётом частоты И серьёзности.\n• CV частоты год-к-году — эмпирический разброс между годами истории.\n\nИнтерпретация:\n• CV < 0,2 — очень стабильно (премия точно рассчитываема)\n• 0,2–0,5 — стабильно\n• 0,5–1,0 — умеренно волатильно (нужна надбавка)\n• > 1,0 — высокая волатильность (большой запас)\n\nComposite Stability Score: 100 = идеально стабильно.',
    };
    Object.entries(INFOS).forEach(([id, txt]) => {
      const head = document.querySelector(`#${id} .card-head h2`);
      if (head) {
        const span = document.createElement('span');
        span.className = 'info-icon';
        span.setAttribute('data-tip', txt);
        span.textContent = 'i';
        head.appendChild(span);
      }
    });
  })();

  // ===== GLOSSARY (kept for reference; main info now in tooltips) =====
  (function renderGlossary() {
    const items = [
      {
        term: 'КУ (Коэффициент Убыточности)',
        def: 'Отношение суммы страховых выплат к собранной премии за период. Целевой уровень компании — не более 70 %.',
        formula: 'КУ = выплаты ÷ премия × 100 %',
      },
      {
        term: 'РЗНУ',
        def: 'Резерв заявленных, но неурегулированных убытков. Сумма, которую страховщик обязан зарезервировать под уже заявленные, но ещё не оплаченные страховые случаи.',
      },
      {
        term: 'Прогнозный КУ по договору',
        def: 'Ожидаемая убыточность нового договора исходя из исторических данных страхователя. Рассчитан как среднегодовая сумма выплат за 3 года, делённая на премию.',
        formula: 'forecast КУ = avg(выплаты/год) ÷ премия',
      },
      {
        term: 'Точка безубыточности',
        def: 'Минимальная годовая премия, при которой ожидаемые выплаты равны премии (КУ = 100 %). На практике безубыточность требует ещё закрытия операционных расходов.',
        formula: 'BE = avg(выплаты/год)',
      },
      {
        term: 'Pure premium',
        def: 'Рисковая часть тарифа — чистая ожидаемая выплата на одного работника в год, без учёта расходов и маржи прибыли.',
        formula: 'PP = expected loss ÷ workers',
      },
      {
        term: 'HHI (Herfindahl-Hirschman Index)',
        def: 'Индекс концентрации портфеля по страховщикам. Сумма квадратов долей в процентах. <1500 — фрагментированный, 1500–2500 умеренный, 2500–5000 высокий, >5000 крайне высокий.',
        formula: 'HHI = Σ (доля_i %)²',
      },
      {
        term: 'Хвостовая концентрация (Tail concentration)',
        def: 'Доля совокупных выплат, приходящаяся на 10 % крупнейших страховых случаев. Высокое значение означает риск катастрофических потерь.',
        formula: 'Tail = Σ(top 10%) ÷ Σ(all)',
      },
      {
        term: 'Перцентили (P25, P50, P75, P90, P99)',
        def: 'Значения, ниже которых лежит указанный процент выплат. Например, P75 = 3,8 М ₸ — 75 % выплат были не больше этой суммы. P99 показывает уровень редких крупных событий.',
      },
      {
        term: 'Удельная частота (НС / 1000 чел.)',
        def: 'Стандартизованный показатель частоты страховых случаев. Используется для сравнения с отраслевой нормой по ОКЭД, поскольку не зависит от размера предприятия.',
        formula: 'rate = НС ÷ работников × 1000',
      },
      {
        term: 'Mortality vs ОКЭД',
        def: 'Кратность фактического коэффициента смертельных НС на 1000 работников к среднеотраслевой норме по соответствующему ОКЭД. Норма берётся из калькулятора рентабельности.',
      },
      {
        term: 'Поправочный коэффициент',
        def: 'Множитель к базовому тарифу, определяемый из матрицы «численность × частота НС» в справочнике поправочных коэффициентов. Обычно равен 1.0 при отсутствии повышенной убыточности.',
      },
      {
        term: 'Понижающий коэффициент',
        def: 'Скидка к премии (обычно 10 %) предоставляемая страхователям с чистой историей убытков. При наличии страховых случаев за период не применяется.',
      },
      {
        term: 'Композитный Risk Score',
        def: 'Интегральный показатель (0–100) качества риска, рассчитанный как взвешенная сумма 5 компонентов: смертность vs ОКЭД (30 %), прогнозный КУ (30 %), частота vs ОКЭД (20 %), качество регистрации (10 %), концентрация (10 %).',
      },
      {
        term: 'Стресс-тест',
        def: 'Расчёт ожидаемой убыточности при отклонении базовых параметров: рост частоты НС на 20 / 50 % или повторение худшего года в истории. Используется для проверки устойчивости договора.',
      },
    ];
    const html = items.map(i => `
      <div class="gloss-item">
        <div class="gloss-term">${i.term}</div>
        <div class="gloss-def">${i.def}</div>
        ${i.formula ? `<div class="gloss-formula">${i.formula}</div>` : ''}
      </div>`).join('');
    document.getElementById('glossary-body').innerHTML = `<div class="glossary-grid">${html}</div>`;
  })();

  // ===== SENSITIVITY =====
  (function renderSensitivity() {
    const premium = z.premiumWithCoeff || z.premiumBase || 0;
    const expectedLoss = a.avgSumPerYear || 0;
    if (a.recognition.recognized === 0 || premium === 0 || expectedLoss === 0) {
      document.getElementById('card-sensitivity').style.display = 'none';
      return;
    }
    // Scale: 0 (current premium) → 2× breakeven
    const breakEven = expectedLoss;
    const maxScale = breakEven * 2;
    const markPct = (val) => Math.min(99, Math.max(0, (val / maxScale) * 100));

    document.getElementById('sensitivity-body').innerHTML = `
      <div class="sensitivity-scale">
        <div class="sens-row">
          <div class="sens-label">Текущая премия</div>
          <div class="sens-vis"><div class="sens-marker" style="left:${markPct(premium)}%" data-label="${fmtMoneyShort(premium)}"></div></div>
          <div class="sens-value">${fmtMoneyShort(premium)}</div>
        </div>
        <div class="sens-row">
          <div class="sens-label">Точка безубыточности</div>
          <div class="sens-vis"><div class="sens-marker" style="left:${markPct(breakEven)}%" data-label="${fmtMoneyShort(breakEven)}"></div></div>
          <div class="sens-value">${fmtMoneyShort(breakEven)}</div>
        </div>
        <div class="sens-row">
          <div class="sens-label">КУ = 70% (целевой)</div>
          <div class="sens-vis"><div class="sens-marker" style="left:${markPct(breakEven/0.7)}%" data-label="${fmtMoneyShort(breakEven/0.7)}"></div></div>
          <div class="sens-value">${fmtMoneyShort(breakEven/0.7)}</div>
        </div>
        <div class="sens-row">
          <div class="sens-label">КУ = 50% (с маржой)</div>
          <div class="sens-vis"><div class="sens-marker" style="left:${markPct(breakEven/0.5)}%" data-label="${fmtMoneyShort(breakEven/0.5)}"></div></div>
          <div class="sens-value">${fmtMoneyShort(breakEven/0.5)}</div>
        </div>
      </div>
      <div style="margin-top:14px;font-size:12px;color:var(--muted);line-height:1.6">
        <strong style="color:var(--ink-2)">Интерпретация:</strong> для финансовой устойчивости договора с целевым КУ 70%
        премия должна составлять не менее <strong style="color:var(--ink)">${fmtMoneyShort(breakEven / 0.7)}</strong> в год.
        Текущая премия (<strong style="color:var(--ink)">${fmtMoneyShort(premium)}</strong>) ${premium >= breakEven/0.7 ? 'удовлетворяет требованию' : `требует увеличения в ${((breakEven/0.7)/premium).toFixed(1).replace('.',',')} раз${(breakEven/0.7)/premium >= 2 ? 'а' : ''}`}.
      </div>`;
  })();

  // ===== AI CONSULTANT PROMPT =====
  window.AIConsultant = (function () {
    let isOpen = false;
    let cachedPrompt = null;

    function buildPrompt() {
      const z = snap.zayavka || {};
      const A = a;
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

    function open() {
      if (!cachedPrompt) cachedPrompt = buildPrompt();
      const ta = document.getElementById('ai-prompt-text');
      ta.value = cachedPrompt;
      const stats = document.getElementById('ai-prompt-stats');
      const words = cachedPrompt.split(/\s+/).filter(Boolean).length;
      stats.textContent = `${cachedPrompt.length.toLocaleString('ru-RU')} символов · ${words.toLocaleString('ru-RU')} слов · ≈ ${Math.ceil(cachedPrompt.length / 4).toLocaleString('ru-RU')} токенов`;
      document.getElementById('ai-panel').classList.add('is-open');
      document.getElementById('ai-overlay').classList.add('is-open');
      document.getElementById('ai-fab').classList.add('is-hidden');
      isOpen = true;
    }

    function close() {
      document.getElementById('ai-panel').classList.remove('is-open');
      document.getElementById('ai-overlay').classList.remove('is-open');
      document.getElementById('ai-fab').classList.remove('is-hidden');
      isOpen = false;
    }

    function toggle() { isOpen ? close() : open(); }

    function copy() {
      const ta = document.getElementById('ai-prompt-text');
      const btn = document.getElementById('ai-copy-btn');
      const txt = ta.value;
      const onSuccess = () => {
        btn.classList.add('is-copied');
        const orig = btn.innerHTML;
        btn.innerHTML = '<span class="ai-btn-icon">✓</span> Скопировано';
        setTimeout(() => { btn.classList.remove('is-copied'); btn.innerHTML = orig; }, 2000);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(onSuccess).catch(() => {
          ta.select(); document.execCommand('copy'); onSuccess();
        });
      } else {
        ta.select(); document.execCommand('copy'); onSuccess();
      }
    }

    function copyToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
      const ta = document.getElementById('ai-prompt-text');
      ta.select();
      document.execCommand('copy');
      return Promise.resolve();
    }

    function showToast(html, durationMs = 4500) {
      const toast = document.getElementById('ai-toast');
      toast.innerHTML = html;
      toast.classList.add('is-visible');
      clearTimeout(toast._timer);
      toast._timer = setTimeout(() => toast.classList.remove('is-visible'), durationMs);
    }

    function isMac() {
      return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    }

    function sendTo(service) {
      if (!cachedPrompt) cachedPrompt = buildPrompt();
      const prompt = cachedPrompt;
      const enc = encodeURIComponent(prompt);

      const URL_LIMIT = 1900; // safe length for query param

      let url, prefillSupported = false;
      switch (service) {
        case 'chatgpt':
          // ChatGPT supports ?q= and ?prompt= — pre-fills the input
          if (enc.length <= URL_LIMIT) {
            url = 'https://chatgpt.com/?q=' + enc;
            prefillSupported = true;
          } else {
            url = 'https://chatgpt.com/';
          }
          break;
        case 'claude':
          // claude.ai has no public URL-param for pre-fill
          url = 'https://claude.ai/new';
          break;
        case 'gemini':
          url = 'https://gemini.google.com/app';
          break;
        case 'perplexity':
          if (enc.length <= URL_LIMIT) {
            url = 'https://www.perplexity.ai/?q=' + enc;
            prefillSupported = true;
          } else {
            url = 'https://www.perplexity.ai/';
          }
          break;
        default:
          url = '/';
      }

      copyToClipboard(prompt).then(() => {
        // Open in new tab
        window.open(url, '_blank', 'noopener,noreferrer');
        // Show contextual toast
        const cmdKey = isMac() ? '⌘' : 'Ctrl';
        if (prefillSupported) {
          showToast(`<strong>Промпт подставлен в URL и скопирован в буфер</strong>
            <span>Если поле инпута пустое — нажмите <kbd>${cmdKey}</kbd>+<kbd>V</kbd>. Затем <kbd>Enter</kbd>.</span>`);
        } else {
          showToast(`<strong>Промпт скопирован в буфер</strong>
            <span>В открывшейся вкладке нажмите <kbd>${cmdKey}</kbd>+<kbd>V</kbd> и затем <kbd>Enter</kbd></span>`);
        }
      }).catch(() => {
        window.open(url, '_blank', 'noopener,noreferrer');
        showToast(`<strong>Открыто в новой вкладке</strong>
          <span>Промпт нужно скопировать вручную — выделите текст и нажмите ${isMac() ? '⌘' : 'Ctrl'}+C</span>`);
      });
    }

    document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen) close(); });

    return { toggle, open, close, copy, sendTo };
  })();

})();
