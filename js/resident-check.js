// resident-check.js — признак резидентства по БИН через локальный индекс ГБД ЮЛ.
//
// Источник: https://data.egov.kz/datasets/view?index=gbd_ul (реестр юридических
// лиц, филиалов и представительств РК). Правило: БИН есть в реестре → резидент,
// нет → нерезидент.
//
// Почему локальный индекс, а не запрос на каждый БИН (как гос. участие через
// e-Qazyna): в выгрузке договоров сотни строк, и сетевой запрос на каждую строку
// делает проверку медленной и зависимой от доступности сервиса. Весь реестр
// (~753 тыс. БИН) сжат в ~0,8 МБ (см. tools/build_gbd_index.py), грузится один
// раз за страницу и дальше проверка любого БИН — бинарный поиск в памяти,
// мгновенно и офлайн.
//
// ИИН (ИП и физлица) в ГБД ЮЛ отсутствуют по определению — реестр только для
// юридических лиц. Поэтому для ИИН правило «нет в базе → нерезидент» НЕ
// применяется (иначе все ИП стали бы нерезидентами: в реальной выгрузке
// договоров это ~38% строк). Резидентство ИП автоматически НЕ определяется
// (egov P30.11 их тоже не проверяет, среди ИП есть и нерезиденты), поэтому такие
// строки помечаются статусом 'individual' и подписью «ИП (ХЗ)» — резидентство
// неизвестно, галочку не трогаем (nonResident:null), решает андеррайтер.
//
// Различаем БИН и ИИН по 5-й цифре (структура идентификатора РК):
//   БИН: ГГММ + [4|5|6] + признак + номер + к.ц.  (4 — резидент, 5 — нерезидент,
//        6 — совместная деятельность), 6-я цифра: 0 головное / 1 филиал /
//        2 представительство / 3 крестьянское хозяйство.
//   ИИН: ГГММДД + пол-век(1..6) + номер + к.ц. → 5-я цифра = десятки числа
//        рождения (0..3), в диапазон 4..6 не попадает.

const ResidentCheck = {
  DATA_URL: 'data/gbd_ul_bins.bin',
  META_URL: 'data/gbd_ul_meta.json',

  _bins: null,        // Float64Array, отсортирован по возрастанию
  _flagged: null,     // Float64Array: БИН, у которых свежая запись не «Зарегистрирован»
  _statuses: null,    // Uint8Array параллельно _flagged: 1 ликв., 2 реорг., 3 иное
  _meta: null,
  _promise: null,
  _error: null,
  _listeners: [],

  // ===== ЗАГРУЗКА =====

  // Идемпотентно: повторные вызовы возвращают тот же промис.
  load() {
    if (ResidentCheck._promise) return ResidentCheck._promise;
    ResidentCheck._promise = ResidentCheck._load().then((ok) => {
      const cbs = ResidentCheck._listeners.slice();
      ResidentCheck._listeners.length = 0;
      cbs.forEach((cb) => { try { cb(ok); } catch (e) { console.warn(e); } });
      return ok;
    });
    return ResidentCheck._promise;
  },

  async _load() {
    try {
      const [binResp, metaResp] = await Promise.all([
        fetch(ResidentCheck.DATA_URL, { cache: 'default' }),
        fetch(ResidentCheck.META_URL, { cache: 'default' }).catch(() => null),
      ]);
      if (!binResp.ok) throw new Error(`HTTP ${binResp.status}`);
      const buf = await binResp.arrayBuffer();
      const decoded = ResidentCheck._decode(buf);
      ResidentCheck._bins = decoded.bins;
      ResidentCheck._flagged = decoded.flagged;
      ResidentCheck._statuses = decoded.statuses;
      if (metaResp && metaResp.ok) {
        try { ResidentCheck._meta = await metaResp.json(); } catch (e) { /* meta опционален */ }
      }
      ResidentCheck._error = null;
      console.info(`ГБД ЮЛ: индекс загружен — ${ResidentCheck._bins.length} БИН`
        + (ResidentCheck._meta?.generated ? `, база от ${ResidentCheck._meta.generated}` : ''));
      return true;
    } catch (e) {
      ResidentCheck._bins = null;
      ResidentCheck._error = String(e && e.message ? e.message : e);
      console.warn('ГБД ЮЛ: индекс не загружен —', ResidentCheck._error,
        '→ признак резидентства придётся выставлять вручную. Собрать индекс: python3 tools/build_gbd_index.py');
      return false;
    }
  },

  // Формат GBDB: 'GBDB' + версия + резерв + count(uint32 LE) [+ flaggedCount(uint32)
  // в v2] + поток(-и) LEB128-разностей (первая разность — само значение).
  // v2 дополнительно несёт список БИН с нештатным статусом САМОЙ СВЕЖЕЙ записи
  // (ликвидирован / реорганизован) и байт статуса на каждый такой БИН.
  _decode(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer);
    if (u8.length < 12 || u8[0] !== 71 || u8[1] !== 66 || u8[2] !== 68 || u8[3] !== 66) {
      throw new Error('неизвестный формат индекса (нет магии GBDB)');
    }
    const ver = u8[4];
    if (ver !== 1 && ver !== 2) throw new Error(`версия индекса ${ver} не поддерживается`);
    const dv = new DataView(arrayBuffer);
    const count = dv.getUint32(8, true);
    const flaggedCount = ver >= 2 ? dv.getUint32(12, true) : 0;
    let p = ver >= 2 ? 16 : 12;

    // LEB128: 7 бит на байт; БИН < 10^12 → максимум 6 байт, множители точны в double.
    const readStream = (n) => {
      const out = new Float64Array(n);
      let prev = 0;
      for (let i = 0; i < n; i++) {
        let shift = 1;
        let delta = 0;
        for (;;) {
          const b = u8[p++];
          delta += (b & 0x7F) * shift;
          if (!(b & 0x80)) break;
          shift *= 128;
        }
        prev += delta;
        out[i] = prev;
      }
      return out;
    };

    const bins = readStream(count);
    const flagged = readStream(flaggedCount);
    const statuses = flaggedCount ? u8.slice(p, p + flaggedCount) : new Uint8Array(0);
    return { bins, flagged, statuses };
  },

  ready() { return !!ResidentCheck._bins; },
  failed() { return !!ResidentCheck._error; },
  meta() { return ResidentCheck._meta; },
  size() { return ResidentCheck._bins ? ResidentCheck._bins.length : 0; },

  // Дата актуальности базы «11.07.2026» (или '' если меты нет).
  updatedText() {
    const g = ResidentCheck._meta?.generated;
    if (!g) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(g));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : String(g);
  },

  // Колбэк после загрузки индекса (или сразу, если уже загружен/упал).
  onReady(cb) {
    if (typeof cb !== 'function') return;
    if (ResidentCheck._bins || ResidentCheck._error) { cb(!!ResidentCheck._bins); return; }
    ResidentCheck._listeners.push(cb);
  },

  // ===== ПРОВЕРКА =====

  _norm(id) { return String(id == null ? '' : id).replace(/\D/g, ''); },

  // 'bin' | 'iin' | 'invalid' — по 5-й цифре идентификатора.
  idKind(id) {
    const s = ResidentCheck._norm(id);
    if (s.length !== 12) return 'invalid';
    return '456'.includes(s[4]) ? 'bin' : 'iin';
  },

  // Тип юр. лица по 5-й цифре БИН: 4 — резидент, 5 — нерезидент, 6 — совместная
  // деятельность. Используется только как пояснение в подсказке.
  binTypeNote(id) {
    const s = ResidentCheck._norm(id);
    if (s.length !== 12) return '';
    if (s[4] === '4') return 'по структуре БИН — юр. лицо-резидент РК';
    if (s[4] === '5') return 'по структуре БИН — юр. лицо-нерезидент';
    if (s[4] === '6') return 'по структуре БИН — совместная деятельность';
    return '';
  },

  _indexOf(arr, target) {
    if (!arr) return -1;
    let lo = 0;
    let hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = arr[mid];
      if (v === target) return mid;
      if (v < target) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  },

  has(id) {
    const s = ResidentCheck._norm(id);
    if (s.length !== 12 || !ResidentCheck._bins) return false;
    return ResidentCheck._indexOf(ResidentCheck._bins, Number(s)) >= 0;
  },

  // Статус САМОЙ СВЕЖЕЙ записи по этому БИН: 0 — «Зарегистрирован» (норма),
  // 1 — ликвидирован, 2 — реорганизован, 3 — иной нештатный статус.
  // По одному БИН в реестре бывает несколько записей (перерегистрация) —
  // индекс уже собран по самой свежей из них (см. tools/build_gbd_index.py).
  registryStatus(id) {
    const s = ResidentCheck._norm(id);
    if (s.length !== 12 || !ResidentCheck._flagged || !ResidentCheck._flagged.length) return 0;
    const i = ResidentCheck._indexOf(ResidentCheck._flagged, Number(s));
    return i >= 0 ? ResidentCheck._statuses[i] : 0;
  },

  STATUS_LABELS: { 1: 'ликвидирован', 2: 'реорганизован', 3: 'нештатный статус в реестре' },

  // Главная точка входа. Возвращает:
  //   status      'resident' | 'nonresident' | 'individual' | 'invalid' | 'unavailable'
  //   nonResident true / false / null (null — не трогать галочку)
  //   label       короткая подпись для UI
  //   badge       ещё короче — для таблицы выгрузки
  //   title       расшифровка для tooltip
  check(id) {
    const s = ResidentCheck._norm(id);
    const kind = ResidentCheck.idKind(s);
    const upd = ResidentCheck.updatedText();
    const base = upd ? ` (база ГБД ЮЛ от ${upd})` : ' (ГБД ЮЛ)';

    if (kind === 'invalid') {
      return { status: 'invalid', nonResident: null, label: '—', badge: '—',
        title: 'Некорректный БИН/ИИН: нужно 12 цифр' };
    }
    if (kind === 'iin') {
      // ИП/физлицо. Резидентство ИП автоматически НЕ определяется: реестр юр. лиц
      // (ГБД ЮЛ) к ним неприменим, egov P30.11 их тоже не проверяет. Среди ИП есть
      // и нерезиденты, поэтому «резидент по умолчанию» — ложное утверждение.
      // Показываем «ИП (ХЗ)» = резидентство неизвестно, галочку НЕ трогаем
      // (nonResident:null) — решение за андеррайтером.
      return {
        status: 'individual', nonResident: null,
        label: 'ИП (ХЗ)', badge: 'ИП',
        title: 'Это ИИН (ИП или физлицо). Резидентство ИП автоматически не определяется '
          + '(реестр юр. лиц к нему неприменим, egov его не проверяет). Среди ИП есть и нерезиденты — '
          + 'уточните и выставьте вручную.',
      };
    }
    if (!ResidentCheck._bins) {
      // Индекс ещё в полёте — не «нет данных», а «подождите»: по onReady
      // проверка пересчитается сама.
      if (!ResidentCheck._error) {
        return { status: 'loading', nonResident: null, label: 'проверка по ГБД ЮЛ…', badge: '…',
          title: 'Локальный индекс ГБД ЮЛ ещё загружается' };
      }
      return { status: 'unavailable', nonResident: null, label: 'база не загружена', badge: '?',
        title: `Локальный индекс ГБД ЮЛ не загружен: ${ResidentCheck._error}. `
          + 'Соберите его: python3 tools/build_gbd_index.py' };
    }
    const found = ResidentCheck.has(s);
    const note = ResidentCheck.binTypeNote(s);
    if (found) {
      // Резидентство определяется наличием БИН в реестре. Статус самой свежей
      // записи (ликвидирован / реорганизован) резидентства не отменяет, но
      // показывается отдельной пометкой — это важно андеррайтеру.
      const st = ResidentCheck.registryStatus(s);
      const stLabel = ResidentCheck.STATUS_LABELS[st];
      return {
        status: 'resident', nonResident: false, registryStatus: st,
        label: stLabel ? `резидент · ${stLabel}` : 'резидент',
        badge: stLabel ? 'резидент!' : 'резидент',
        title: `БИН найден в реестре юр. лиц РК${base} → резидент`
          + (stLabel ? `. ВНИМАНИЕ: по самой свежей записи реестра компания «${stLabel}»` : ''),
      };
    }
    return {
      status: 'nonresident', nonResident: true, label: 'нерезидент', badge: 'нерезидент',
      title: `БИН отсутствует в реестре юр. лиц РК${base} → нерезидент`
        + (note ? `. Примечание: ${note}` : ''),
    };
  },

  // Проверка списка (индекс уже в памяти — это просто map, без сети).
  checkMany(ids) { return (ids || []).map((id) => ResidentCheck.check(id)); },

  // ===== АВТОРИТЕТНАЯ ПРОВЕРКА ЧЕРЕЗ egov (P30.11, мост-расширение) =====
  // Локальный индекс gbd_ul отстаёт (нет свежих регистраций) → даёт ложных
  // нерезидентов. egov P30.11 — источник резидентства (налоговый) и актуальнее.
  // Схема гибридная: локальный индекс = мгновенный ответ (оффлайн, без сети),
  // egov через мост = АВТОРИТЕТНОЕ уточнение (по одному запросу на БИН, только
  // когда мост доступен). Кэшируем по БИН, чтобы не дёргать повторно.
  _egovCache: new Map(),     // bin → Promise (дедуп запросов «в полёте»)
  _egovResolved: new Map(),  // bin → verdict (синхронно доступный результат)

  bridgeAvailable() {
    return typeof StatGovClient !== 'undefined'
      && typeof StatGovClient.isAvailable === 'function'
      && StatGovClient.isAvailable();
  },

  // Готовый (уже полученный) авторитетный вердикт egov по БИН — синхронно, без сети.
  egovResolved(id) {
    return ResidentCheck._egovResolved.get(ResidentCheck._norm(id)) || null;
  },

  // Авторитетная проверка. Возвращает verdict той же формы, что check(), но с
  // source:'egov'. null — мост недоступен или запрос не удался (тогда вызывающий
  // остаётся на локальном вердикте). Промис кэшируется (в т.ч. на время полёта).
  checkEgov(id) {
    const s = ResidentCheck._norm(id);
    if (s.length !== 12) return Promise.resolve(null);
    // Эндпоинт P30.11 /organizations/ — ТОЛЬКО для БИН юрлиц. Для ИИН (ИП/физлицо,
    // 5-я цифра 0–3) он отдаёт «не является БИН» / статус 031 «не зарегистрирован»
    // с resident:false — что для ИИН стало бы ложным «нерезидентом». Поэтому для
    // ИИН egov НЕ дёргаем — остаётся локальный вердикт 'individual' (ИП, резидент
    // по умолчанию). БИН типа 6 (5-я цифра 6) — это тоже ИП, но egov его принимает
    // и сам вернёт статус 033 «является ИП», поэтому для БИН всех типов запрос идёт.
    if (ResidentCheck.idKind(s) !== 'bin') return Promise.resolve(null);
    if (!ResidentCheck.bridgeAvailable()) return Promise.resolve(null);
    if (ResidentCheck._egovCache.has(s)) return ResidentCheck._egovCache.get(s);
    const p = StatGovClient.lookupEgovResidency(s)
      .then((d) => { const v = ResidentCheck._egovVerdict(d); if (v) ResidentCheck._egovResolved.set(s, v); return v; })
      .catch(() => { ResidentCheck._egovCache.delete(s); return null; }); // ошибку не кэшируем
    ResidentCheck._egovCache.set(s, p);
    return p;
  },

  // Ответ egov P30.11 → verdict. resident:true → резидент; status 033 → ИП;
  // 034/прочее при resident:false → нерезидент (с причиной из статуса).
  _egovVerdict(d) {
    if (!d || d.resident == null) return null;
    const note = d.statusText || '';
    const nm = d.shortName || d.fullName || '';
    if (d.resident === true) {
      return {
        status: 'resident', nonResident: false, source: 'egov', registryStatus: 0,
        label: 'резидент', badge: 'резидент', egovName: nm || null,
        title: `egov (P30.11): резидент${nm ? ' — ' + nm : ''}`,
      };
    }
    if (d.statusCode === '033') {
      // egov подтвердил, что БИН принадлежит ИП. Но резидентство ИП egov не
      // определяет → «ИП (ХЗ)», галочку не трогаем (nonResident:null).
      return {
        status: 'individual', nonResident: null, source: 'egov', registryStatus: 0,
        label: 'ИП (ХЗ)', badge: 'ИП',
        title: 'egov (P30.11): БИН принадлежит индивидуальному предпринимателю (не юрлицо). '
          + 'Резидентство ИП автоматически не определяется — уточните вручную.',
      };
    }
    return {
      status: 'nonresident', nonResident: true, source: 'egov', registryStatus: 0,
      label: 'нерезидент', badge: 'нерезидент',
      title: `egov (P30.11): нерезидент${note ? ' — ' + note : ''}`,
    };
  },
};

// Автозагрузка индекса сразу при подключении скрипта: ~0,8 МБ, не блокирует
// рендер, к моменту первой проверки обычно уже готов.
if (typeof window !== 'undefined') {
  window.ResidentCheck = ResidentCheck;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ResidentCheck.load());
  } else {
    ResidentCheck.load();
  }
}
