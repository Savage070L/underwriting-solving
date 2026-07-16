// daip-print.js — вкладка «Печать рекомендации ДАиП».
//
// Отдельный от «Проверки договоров» поток: СВОЙ файл-реестр, БЕЗ проверки
// stat.gov.kz. Печатает по каждому договору ТОЛЬКО секцию «Рекомендация ДАиП»
// (одна на договор, филиалы — внутри) с РЕДАКТИРУЕМЫМ подписантом: ФИО и
// должность (они периодически меняются). Всё в один ZIP.
//
// Переиспользуем BatchReader.parse (тот же парсер выгрузки), ARForm.buildDocx
// (с opts.only='recommendation' и underwriterName/Role), BatchAR._ensureZip
// (ленивая загрузка JSZip) и глобальный saveAs (FileSaver).

const DaipPrint = {
  rows: [],
  _busy: false,

  async loadFile(file) {
    if (!file) return;
    const statusEl = document.getElementById('daip-status');
    try {
      if (statusEl) statusEl.textContent = 'Чтение файла…';
      const buf = await file.arrayBuffer();
      const { rows, total, skipped } = BatchReader.parse(buf);
      DaipPrint.rows = rows || [];
      const zone = document.getElementById('daip-zone');
      if (zone) zone.classList.toggle('loaded', !!total);
      const contracts = DaipPrint.rows.length ? DaipPrint._groupByContract().size : 0;
      if (statusEl) {
        statusEl.textContent = total
          ? `Загружено: ${total} строк ОСНС · договоров: ${contracts}${skipped ? ` (пропущено строк: ${skipped})` : ''}`
          : 'Подходящих строк ОСНС не найдено';
      }
      DaipPrint._updateControls();
    } catch (e) {
      console.error('DAiP load error:', e);
      if (statusEl) statusEl.textContent = 'Ошибка чтения файла: ' + e.message;
      if (typeof App !== 'undefined' && App.showMsg) App.showMsg('Не удалось прочитать реестр: ' + e.message, 'error');
    }
  },

  clear() {
    DaipPrint.rows = [];
    const zone = document.getElementById('daip-zone');
    if (zone) zone.classList.remove('loaded');
    const input = zone ? zone.querySelector('input[type=file]') : null;
    if (input) input.value = '';
    const statusEl = document.getElementById('daip-status');
    if (statusEl) statusEl.textContent = 'Загрузите .xlsx выгрузку';
    DaipPrint._updateControls();
  },

  // Группировка по номеру договора: одна рекомендация на договор (филиалы — внутри).
  _groupByContract() {
    const groups = new Map();
    DaipPrint.rows.forEach((r, i) => {
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

  _fileName(cn, taken) {
    const base = `Рекомендация ДАиП ${String(cn || 'без номера').replace(/[\\/:*?"<>|]/g, '_')}`;
    let name = `${base}.docx`;
    let n = 2;
    while (taken.has(name)) name = `${base} (${n++}).docx`;
    taken.add(name);
    return name;
  },

  _updateControls() {
    const n = DaipPrint.rows.length ? DaipPrint._groupByContract().size : 0;
    const btn = document.getElementById('daip-gen');
    if (btn) {
      btn.disabled = DaipPrint._busy || !n;
      btn.textContent = n ? `Печать рекомендаций ДАиП (${n})` : 'Печать рекомендаций ДАиП';
    }
    const clr = document.getElementById('daip-clear');
    if (clr) clr.style.display = DaipPrint.rows.length ? '' : 'none';
  },

  async generateAll() {
    if (DaipPrint._busy || !DaipPrint.rows.length) return;
    DaipPrint._busy = true;
    DaipPrint._updateControls();
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
      DaipPrint._updateControls();
    }
  },
};

if (typeof window !== 'undefined') window.DaipPrint = DaipPrint;
