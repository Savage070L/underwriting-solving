// daip-print.js — вкладка «Печать рекомендации ДАиП».
//
// Реестр берётся из вкладки «Проверка договоров» (общий BatchAR.rows) — своей
// загрузки файла тут НЕТ. Проверка stat.gov.kz НЕ требуется.
//
// Структура документа — ПОЛНАЯ форма ARForm (Рекомендация ДАиП → Заключение
// подразделения по управлению рисками → Андеррайтинговое решение), ровно та же,
// что печатает «Проверка договоров». Отличия этой вкладки только два:
//   1) печатаем ВСЕ договоры, включая красные (в «Проверке договоров» красные
//      исключаются из печати);
//   2) подписант РЕДАКТИРУЕМЫЙ — ФИО и должность (периодически меняются).
// Один документ на договор (филиалы — внутри), всё в один ZIP.
//
// Переиспользуем ARFormPdf.buildPdf (underwriterName/Role), BatchAR._ensureZip
// (ленивая загрузка JSZip) и глобальный saveAs.
//
// ГОДОВОЙ РЕЕСТР. Два узких места, из-за которых пакет на 20 000+ договоров
// раньше не печатался вообще, а не «печатался медленно»:
//   • ПАМЯТЬ. Архив целиком собирался в памяти вкладки (JSZip), а документ весит
//     ~120 КБ — на годовом реестре это гигабайты, и ZIP не получался.
//     Теперь: Chrome/Edge — File System Access API, архив пишется в выбранный
//     файл ПОТОКОМ (js/zip-stream.js), память ровная (~60 МБ на любом объёме);
//     Firefox/Safari (такой записи нет) — пакет режется на части по CHUNK.
//   • ВРЕМЯ. Документ строится ~120 мс, то есть 20 000 в один поток — это
//     40–50 минут при мёртвом интерфейсе. Теперь печать раздаётся воркерам по
//     числу ядер (js/daip-worker.js) — те же 20 000 за 5–7 минут.
// Пакетный генератор без браузера (tools/daip-batch/print-daip.js) остался для
// разовых прогонов из терминала; вкладка в нём больше не нуждается.

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
    // Подписант по умолчанию — из «Справочников» (App._getSigner), а не жёстко
    // вписанный в разметку: раньше в поле стоял «Бурханов Д.К.», и он ПЕРЕБИВАЛ
    // справочник, потому что значение поля идёт в opts.underwriterName.
    // Заполняем только пустое поле — правку пользователя не затираем.
    const nameInp = document.getElementById('daip-signer-name');
    if (nameInp && !nameInp.value.trim() && typeof App !== 'undefined' && App._getSigner) {
      // Справочник «Рекомендация ДАиП», а не «Директор ДАиП» — Рекомендацию и
      // СЗ/Протокол подписывают разные люди.
      const ref = App._getSigner('daipUnderwriter');
      if (ref) { nameInp.value = ref; nameInp.placeholder = `Из справочника: ${ref}`; }
    }
    // Должность — оттуда же и по той же причине: вписанная в разметку строка
    // ушла бы в opts.underwriterRole и перебила справочник.
    const roleInp = document.getElementById('daip-signer-role');
    if (roleInp && !roleInp.value.trim() && typeof App !== 'undefined' && App._getSignerRole) {
      const ref = App._getSignerRole('daipUnderwriter');
      if (ref) { roleInp.value = ref; roleInp.placeholder = `Из справочника: ${ref}`; }
    }
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

  // Санитайзер имени — общий с «Проверкой договоров» (BatchAR._safeName):
  // «/» в номере договора → дефис, прочие запрещённые символы → «_».
  // Занятость имени проверяем БЕЗ учёта регистра: два номера, отличающихся
  // только регистром буквы, дали бы в архиве два имени, а при распаковке на
  // macOS/Windows (регистр не различается) второй документ затёр бы первый.
  _fileName(cn, taken) {
    const base = `Рекомендация ДАиП ${BatchAR._safeName(cn) || 'без номера'}`;
    let name = `${base}.pdf`;
    let n = 2;
    while (taken.has(name.toLowerCase())) name = `${base} (${n++}).pdf`;
    taken.add(name.toLowerCase());
    return name;
  },

  // Сколько договоров кладём в один ZIP, когда архив собирается В ПАМЯТИ (JSZip).
  // Ограничение не выдумано: JSZip склеивает готовый архив в памяти вкладки, а
  // документ весит ~120 КБ, поэтому пакет на 20 000+ договоров (годовой реестр)
  // не собирался вообще — вкладка упиралась в лимит памяти. 1500 документов ≈
  // 180 МБ на архив: собирается всегда, между частями память освобождается.
  // Это ЗАПАСНОЙ путь; Chrome и Edge пишут один архив прямо на диск (см. ниже).
  CHUNK: 1500,

  _stamp() {
    const t = new Date();
    return `${String(t.getDate()).padStart(2, '0')}.${String(t.getMonth() + 1).padStart(2, '0')}.${t.getFullYear()}`;
  },

  // Файл для записи архива прямо на диск (File System Access API). Так пакет
  // любого размера уходит одним ZIP, а память вкладки не растёт.
  // Вызывать СРАЗУ по клику: диалог требует «свежего» действия пользователя и
  // после первого await уже не откроется.
  // Нет поддержки (Firefox, Safari, страница по file://) → null, дальше JSZip.
  async _pickZipFile(suggestedName) {
    if (typeof window.showSaveFilePicker !== 'function') return null;
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'ZIP-архив', accept: { 'application/zip': ['.zip'] } }],
      });
      return await handle.createWritable();
    } catch (e) {
      // AbortError — пользователь закрыл диалог: это не ошибка, печать отменяем.
      if (e && e.name === 'AbortError') return 'aborted';
      console.warn('showSaveFilePicker недоступен:', e);
      return null;
    }
  },

  async generateAll() {
    const rows = DaipPrint._rows();
    if (DaipPrint._busy || !rows.length) return;
    const groups = [...DaipPrint._groupByContract().entries()];
    const N = groups.length;
    if (!N) return;

    // Диалог выбора файла — первым делом, до любого await (см. _pickZipFile).
    const stamp = DaipPrint._stamp();
    const sink = await DaipPrint._pickZipFile(`Рекомендации ДАиП ${stamp} (${N}).zip`);
    if (sink === 'aborted') return;

    DaipPrint._busy = true;
    DaipPrint.refresh();
    const progress = document.getElementById('daip-progress');
    const bar = document.getElementById('daip-progress-bar');
    const txt = document.getElementById('daip-progress-text');
    if (progress) progress.style.display = 'block';
    const { name, role } = DaipPrint._signer();
    const setProgress = (i, suffix) => {
      if (txt) txt.textContent = `Печать ${i} из ${N}${suffix || ''}`;
      if (bar) bar.style.width = Math.round((i / N) * 100) + '%';
    };
    let pool = null;
    try {
      // Факсимиле готовим один раз на весь пакет, а не на каждый документ.
      const signatures = await ARFormPdf._signaturesDataUrl();
      const opts = { underwriterName: name, underwriterRole: role, printAlert: false, signatures };
      // Задания считаем ЗАРАНЕЕ: имя файла присваивается в порядке реестра, и
      // от того, какой воркер напечатает договор раньше, оно не зависит.
      const taken = new Set();
      const jobs = groups.map(([cn, group]) => ({
        cn, row: group[0], filials: group.slice(1), file: DaipPrint._fileName(cn, taken),
      }));
      pool = await DaipPrint._startPool(opts, setProgress);
      const made = sink
        ? await DaipPrint._streamToFile(jobs, sink, opts, setProgress, pool)
        : await DaipPrint._zipInChunks(jobs, opts, setProgress, stamp, pool);
      if (typeof App !== 'undefined' && App.showMsg) {
        const note = [made.note, pool ? `потоков: ${pool.size}` : 'один поток'].filter(Boolean).join(', ');
        App.showMsg(`Готово: ${made.count} рекомендаций ДАиП (${note}).`, 'success');
      }
    } catch (e) {
      console.error('DAiP generate error:', e);
      if (typeof App !== 'undefined' && App.showMsg) App.showMsg('Ошибка генерации: ' + e.message, 'error');
    } finally {
      DaipPrint._stopPool(pool);
      DaipPrint._busy = false;
      if (progress) progress.style.display = 'none';
      DaipPrint.refresh();
    }
  },

  // ===== Параллельная печать =====
  // Один документ строится ~120 мс, поэтому годовой реестр в одном потоке —
  // это 40–50 минут при заблокированном интерфейсе. Печать раздаём воркерам
  // (js/daip-worker.js) по числу ядер: на 20 000 договоров выходит 5–7 минут.
  // Одно ядро оставляем странице, чтобы прогресс и прокрутка не замирали.
  MAX_WORKERS: 8,

  _workerCount() {
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    return Math.max(1, Math.min(cores - 1, DaipPrint.MAX_WORKERS));
  },

  // Поднимает пул воркеров. Любая осечка (нет Worker, страница по file://,
  // ошибка загрузки модулей) — не ошибка печати: возвращаем null и печатаем в
  // главном потоке, как раньше.
  async _startPool(opts, setProgress) {
    if (typeof Worker === 'undefined') return null;
    const n = DaipPrint._workerCount();
    if (n < 2) return null;
    if (setProgress) setProgress(0, ` — запуск ${n} потоков`);
    const resident = new URL('data/gbd_ul_bins.bin', document.baseURI).href;
    const workers = [];
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker('js/daip-worker.js');
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('воркер не ответил')), 30000);
          w.onmessage = (e) => {
            if (e.data && e.data.type === 'ready') { clearTimeout(t); resolve(); }
            else if (e.data && e.data.type === 'error') { clearTimeout(t); reject(new Error(e.data.message)); }
          };
          w.onerror = (e) => { clearTimeout(t); reject(new Error(e.message || 'ошибка воркера')); };
          w.postMessage({
            type: 'init',
            signatures: opts.signatures,
            underwriterName: opts.underwriterName,
            underwriterRole: opts.underwriterRole,
            residentDataUrl: resident,
            residentMetaUrl: new URL('data/gbd_ul_meta.json', document.baseURI).href,
          });
        });
        workers.push(w);
      }
      return { workers, size: workers.length };
    } catch (e) {
      console.warn('Печать ДАиП: воркеры недоступны, печатаю в один поток:', e);
      workers.forEach(w => w.terminate());
      return null;
    }
  },

  _stopPool(pool) {
    if (pool) pool.workers.forEach(w => { w.onmessage = null; w.onerror = null; w.terminate(); });
  },

  // Печатает задания и отдаёт каждый готовый документ в onPdf(file, bytes).
  // Воркер получает следующий договор только ПОСЛЕ того, как его результат
  // записан: так в памяти живёт максимум по одному документу на поток, сколько
  // бы договоров ни было в пакете.
  async _produce(jobs, opts, onPdf, onProgress, pool) {
    if (!pool) {
      for (let i = 0; i < jobs.length; i++) {
        const j = jobs[i];
        const blob = await ARFormPdf.buildPdf(j.row, { ...opts, filials: j.filials });
        await onPdf(j.file, new Uint8Array(await blob.arrayBuffer()));
        onProgress(i + 1, j.cn);
        if (i % 15 === 14) await new Promise(r => setTimeout(r, 0)); // уступаем UI
      }
      return { failed: [] };
    }
    let next = 0, done = 0;
    const failed = [];
    await new Promise((resolve, reject) => {
      let live = pool.workers.length;
      const finish = () => { if (--live === 0) resolve(); };
      pool.workers.forEach((w) => {
        const feed = () => {
          if (next >= jobs.length) { finish(); return; }
          const job = jobs[next++];
          w._job = job;
          w.postMessage({ type: 'print', id: job.file, row: job.row, filials: job.filials });
        };
        w.onmessage = async (e) => {
          const m = e.data || {};
          try {
            if (m.type === 'done') await onPdf(w._job.file, new Uint8Array(m.bytes));
            else if (m.type === 'error') failed.push(`${w._job.cn}: ${m.message}`);
            onProgress(++done, w._job.cn);
            feed();
          } catch (err) { reject(err); }
        };
        w.onerror = (e) => reject(new Error(e.message || 'ошибка воркера'));
        feed();
      });
      if (!jobs.length) resolve();
    });
    return { failed };
  },

  // Прогресс с темпом и остатком времени: на годовом реестре печать идёт
  // минуты, и без оценки непонятно, работает оно вообще или зависло.
  _progressReporter(total, setProgress, prefix) {
    const t0 = Date.now();
    let lastPaint = 0;
    return (done, cn) => {
      const now = Date.now();
      if (done < total && now - lastPaint < 250) return;   // чаще 4 раз в секунду не рисуем
      lastPaint = now;
      const rate = done / Math.max(0.001, (now - t0) / 1000);
      const left = rate > 0 ? Math.round((total - done) / rate) : 0;
      const eta = left >= 60 ? `${Math.floor(left / 60)} мин ${left % 60} с` : `${left} с`;
      setProgress(done, `${prefix || ''} · ${rate.toFixed(1)} док/с · осталось ~${eta}${cn ? ` · ${cn}` : ''}`);
    };
  },

  // Путь 1 (Chrome/Edge): один архив, запись сразу в выбранный файл. Документ
  // уходит на диск и в памяти не задерживается — размер пакета ограничен только
  // свободным местом. Формат архива — js/zip-stream.js.
  async _streamToFile(jobs, sink, opts, setProgress, pool) {
    const zip = new window.ZipStream(sink);
    const report = DaipPrint._progressReporter(jobs.length, setProgress, '');
    try {
      // Запись в архив строго по одному: ZipStream ведёт смещения записей, и
      // параллельные add() их перепутают.
      let writing = Promise.resolve();
      const add = (file, bytes) => {
        writing = writing.then(() => zip.add(file, bytes));
        return writing;
      };
      const { failed } = await DaipPrint._produce(jobs, opts, add, report, pool);
      await writing;
      setProgress(jobs.length, ' — завершение архива');
      const res = await zip.close();
      await sink.close();
      return { count: res.count, note: failed.length ? `не напечатано: ${failed.length}` : '' };
    } catch (e) {
      // Незакрытый файл остался бы битым огрызком — убираем его за собой.
      try { await sink.abort(); } catch (e2) { /* уже закрыт */ }
      throw e;
    }
  },

  // Путь 2 (Firefox/Safari): архив собирается в памяти, поэтому пакет режем на
  // части по CHUNK договоров — каждая скачивается отдельным ZIP.
  async _zipInChunks(jobs, opts, setProgress, stamp, pool) {
    await BatchAR._ensureZip();
    const N = jobs.length;
    const parts = Math.ceil(N / DaipPrint.CHUNK);
    const failed = [];
    let done = 0;
    for (let p = 0; p < parts; p++) {
      const slice = jobs.slice(p * DaipPrint.CHUNK, (p + 1) * DaipPrint.CHUNK);
      const zip = new window.JSZip();
      const base = done;
      const label = parts > 1 ? ` (часть ${p + 1} из ${parts})` : '';
      const report = DaipPrint._progressReporter(N, setProgress, label);
      const res = await DaipPrint._produce(slice, opts,
        (file, bytes) => { zip.file(file, bytes, { compression: 'STORE' }); },
        (n, cn) => report(base + n, cn), pool);
      failed.push(...res.failed);
      done = base + slice.length;
      setProgress(done, `${label} — упаковка ZIP`);
      const out = await zip.generateAsync({ type: 'blob' });
      const suffix = parts > 1 ? ` часть ${p + 1} из ${parts}` : '';
      saveAs(out, `Рекомендации ДАиП ${stamp} (${N})${suffix}.zip`);
      // Пауза между частями: браузер успевает отдать файл и освободить память
      // под следующий архив (иначе на больших пакетах вкладка снова распухает).
      await new Promise(r => setTimeout(r, 400));
    }
    const note = [parts > 1 ? `${parts} ZIP-файла` : '', failed.length ? `не напечатано: ${failed.length}` : ''];
    return { count: done - failed.length, note: note.filter(Boolean).join(', ') };
  },
};

if (typeof window !== 'undefined') window.DaipPrint = DaipPrint;
