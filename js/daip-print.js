// daip-print.js — вкладка «Печать рекомендации ДАиП».
//
// Реестр берётся из вкладки «Проверка договоров» (общий BatchAR.rows) — своей
// загрузки файла тут НЕТ. Проверка stat.gov.kz НЕ требуется. По каждому договору
// печатается ТОЛЬКО секция «Рекомендация ДАиП» (одна на договор, филиалы —
// внутри) с РЕДАКТИРУЕМЫМ подписантом: ФИО и должность (периодически меняются).
// Всё в один ZIP.
//
// Переиспользуем ARForm.buildDocx (opts.only='recommendation' + underwriterName/
// Role), BatchAR._ensureZip (ленивая загрузка JSZip) и глобальный saveAs.

const DaipPrint = {
  _busy: false,

  // Строки реестра — из «Проверки договоров».
  _rows() {
    return (typeof BatchAR !== 'undefined' && Array.isArray(BatchAR.rows)) ? BatchAR.rows : [];
  },

  // Группировка по номеру договора: одна рекомендация на договор (филиалы — внутри).
  _groupByContract() {
    const groups = new Map();
    DaipPrint._rows().forEach((r, i) => {
      const key = r.contractNumber || `__no_${r.bin}_${i}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });
    return groups;
  },

  // ФИО и должность подписанта из полей (пустые → дефолт внутри ARForm).
  _signer() {
    return {
      name: (document.getElementById('daip-signer-name')?.value || '').trim(),
      role: (document.getElementById('daip-signer-role')?.value || '').trim(),
    };
  },

  // Обновить статус/кнопку по текущему реестру. Вызывается при переключении на
  // вкладку (App.switchTab) и после загрузки/очистки реестра в «Проверке договоров».
  refresh() {
    const rows = DaipPrint._rows();
    const contracts = rows.length ? DaipPrint._groupByContract().size : 0;
    const statusEl = document.getElementById('daip-status');
    if (statusEl) {
      statusEl.style.display = rows.length ? '' : 'none';
      statusEl.textContent = rows.length
        ? `Реестр из «Проверки договоров»: ${rows.length} строк ОСНС · договоров: ${contracts}`
        : '';
    }
    const emptyEl = document.getElementById('daip-empty');
    if (emptyEl) emptyEl.style.display = rows.length ? 'none' : '';
    const btn = document.getElementById('daip-gen');
    if (btn) {
      btn.disabled = DaipPrint._busy || !contracts;
      btn.textContent = contracts ? `Печать рекомендаций ДАиП (${contracts})` : 'Печать рекомендаций ДАиП';
    }
  },

  _fileName(cn, taken) {
    const base = `Рекомендация ДАиП ${String(cn || 'без номера').replace(/[\\/:*?"<>|]/g, '_')}`;
    let name = `${base}.docx`;
    let n = 2;
    while (taken.has(name)) name = `${base} (${n++}).docx`;
    taken.add(name);
    return name;
  },

  async generateAll() {
    const rows = DaipPrint._rows();
    if (DaipPrint._busy || !rows.length) return;
    DaipPrint._busy = true;
    DaipPrint.refresh();
    const progress = document.getElementById('daip-progress');
    const bar = document.getElementById('daip-progress-bar');
    const txt = document.getElementById('daip-progress-text');
    if (progress) progress.style.display = 'block';
    const { name, role } = DaipPrint._signer();
    try {
      await BatchAR._ensureZip();
      const zip = new window.JSZip();
      const taken = new Set();
      const groups = [...DaipPrint._groupByContract().entries()];
      const N = groups.length;
      for (let i = 0; i < N; i++) {
        const [cn, group] = groups[i];
        if (txt) txt.textContent = `Печать ${i + 1} из ${N} — договор ${cn}`;
        if (bar) bar.style.width = Math.round((i / N) * 100) + '%';
        const blob = await ARForm.buildDocx(group[0], {
          only: 'recommendation',
          underwriterName: name,
          underwriterRole: role,
          filials: group.slice(1),
          printAlert: false,
        });
        zip.file(DaipPrint._fileName(cn, taken), blob, { compression: 'STORE' });
        if (i % 15 === 14) await new Promise(r => setTimeout(r, 0)); // уступаем UI
      }
      if (txt) txt.textContent = 'Упаковка ZIP…';
      if (bar) bar.style.width = '100%';
      const out = await zip.generateAsync({ type: 'blob' });
      const t = new Date();
      const stamp = `${String(t.getDate()).padStart(2, '0')}.${String(t.getMonth() + 1).padStart(2, '0')}.${t.getFullYear()}`;
      saveAs(out, `Рекомендации ДАиП ${stamp} (${N}).zip`);
      if (typeof App !== 'undefined' && App.showMsg) App.showMsg(`Готово: ${N} рекомендаций ДАиП.`, 'success');
    } catch (e) {
      console.error('DAiP generate error:', e);
      if (typeof App !== 'undefined' && App.showMsg) App.showMsg('Ошибка генерации: ' + e.message, 'error');
    } finally {
      DaipPrint._busy = false;
      if (progress) progress.style.display = 'none';
      DaipPrint.refresh();
    }
  },
};

if (typeof window !== 'undefined') window.DaipPrint = DaipPrint;
