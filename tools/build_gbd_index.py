#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Сборка локального индекса БИН из ГБД ЮЛ (data.egov.kz, набор "gbd_ul")
======================================================================

Зачем:
  Приложение определяет признак резидентства по БИН: БИН есть в ГБД ЮЛ →
  резидент, нет → нерезидент. Дёргать API на каждый БИН (как это делает
  проверка гос. участия через e-Qazyna) слишком медленно: в выгрузке
  договоров сотни-тысячи строк, и каждая ждала бы сетевой запрос. Поэтому
  весь реестр БИН выгружается ОДИН раз в компактный бинарный индекс, который
  браузер грузит целиком (~0,8 МБ) и держит в памяти — проверка любого БИН
  становится мгновенной, работает офлайн и не зависит от лимитов egov.

ВАЖНО — как обходится реестр (постраничный курсор по БИН):
  Наивный обход через from/size ТЕРЯЕТ записи: Elasticsearch за data.egov.kz
  не гарантирует стабильный порядок при глубоких смещениях (from ~ 900 000).
  Замер на реальной выгрузке: пропало 655 БИН из 753 520 (0,09%) — живые
  действующие компании, которые стали бы «нерезидентами».
  Поэтому обход идёт КУРСОРОМ: query = range(bin > последний_БИН),
  sort = bin asc, from = 0 всегда. Каждый запрос «мелкий», порядок
  детерминированный, пропуск записи невозможен. search_after API не
  принимает (400), поэтому курсор реализован через range.
  В конце скрипт СВЕРЯЕТ число полученных записей с totalCount и ругается,
  если сошлось не всё.

Дубликаты и перерегистрация:
  По одному БИН в наборе бывает несколько записей (на замере — 179 508 БИН
  из 753 520, почти все по 2). Это две «эпохи» загрузки одной и той же
  компании: старая (адрес КАПСОМ, прежнее наименование) и актуальная
  (современный адрес, текущее наименование, у неё _id == id и дата
  регистрации с часовым поясом «2016-03-29+06:00»).
  Берём САМУЮ СВЕЖУЮ запись: сначала по дате регистрации, при равных датах —
  актуальную эпоху загрузки. Из неё берём статус: всё, что не
  «Зарегистрирован» (Ликвидирован / Реорганизован), попадает в отдельный
  список «флагов» индекса, и приложение показывает это отдельной пометкой.

Устойчивость к обрывам:
  data.egov.kz на длинной выгрузке периодически перестаёт отвечать (соединение
  установлено, данных нет). Поэтому: таймаут запроса короткий (45 с) с 8
  повторами, а прогресс обхода пишется построчно в data/.gbd_ul_scan.tmp.
  Если скрипт всё же оборвался — просто запустите его снова: он продолжит с
  места обрыва, а не с нуля. Начать заново — флаг --restart. Черновик
  удаляется автоматически, когда обход завершён и сверка сошлась.

Как использовать:
    # рекомендуется: скачать свежий реестр и собрать индекс (замер: 16 минут)
    python3 tools/build_gbd_index.py --refresh
    # оборвалось? запустите ту же команду ещё раз — продолжит с места обрыва

    # из уже скачанного CSV (быстро, но данные на дату выгрузки CSV)
    python3 tools/build_gbd_index.py --csv "~/Documents/ГБД ЮЛ .../gbd_ul_all_companies.csv"

Формат gbd_ul_bins.bin (little-endian), версия 2:
    0..3    магия 'GBDB'
    4       версия (2)
    5..7    резерв
    8..11   count        — сколько БИН всего (uint32)
    12..15  flaggedCount — сколько БИН с нештатным статусом (uint32)
    16..    поток varint (LEB128): первый БИН как число, далее РАЗНОСТИ
            с предыдущим (БИН < 10^12 < 2^53 — точен в double);
            затем такой же поток из flaggedCount БИН;
            затем flaggedCount байт со статусом: 1 — ликвидирован,
            2 — реорганизован, 3 — иной нештатный статус.

Индекс пересобирать раз в 1-3 месяца: компании, зарегистрированные после
сборки, иначе будут определяться как нерезиденты.
"""

import argparse
import csv
import datetime as _dt
import json
import os
import struct
import sys
import time
import urllib.parse
import urllib.request

# ----------------------- Настройки -----------------------

DATASET = "gbd_ul"
VERSION = "v1"
BASE_URL = f"https://data.egov.kz/api/detailed/{DATASET}/{VERSION}"

PAGE_SIZE = 5000          # строк за один HTTP-запрос (~800 КБ, ~1 с)
RETRIES = 8               # egov периодически «подвисает» — переживаем это повторами
TIMEOUT = 45              # сек: лучше быстро оборвать зависший запрос и повторить

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)
DEFAULT_OUT = os.path.join(APP_DIR, "data")
DEFAULT_CSV = os.path.expanduser(
    "~/Documents/ГБД ЮЛ все компании КЗ/gbd_ul_all_companies.csv"
)

BIN_FILE = "gbd_ul_bins.bin"
META_FILE = "gbd_ul_meta.json"
STATE_FILE = ".gbd_ul_scan.tmp"   # прогресс обхода, чтобы дожать после обрыва

# Статусы записи → код в индексе. «Зарегистрирован» = 0 и в индекс не пишется.
STATUS_OK = "зарегистрирован"
STATUS_CODES = {"ликвидирован": 1, "реорганизован": 2}


def status_code(status: str) -> int:
    s = (status or "").strip().lower()
    if not s or s.startswith(STATUS_OK):
        return 0
    for key, code in STATUS_CODES.items():
        if s.startswith(key):
            return code
    return 3


# ----------------------- Выбор самой свежей записи -----------------------

def record_rank(rec: dict):
    """Ключ сортировки «свежести» записи о компании.

    1) дата регистрации (YYYY-MM-DD) — чем позже, тем свежее;
    2) при равных датах — актуальная эпоха загрузки: у неё _id == id
       и дата с часовым поясом («2016-03-29+06:00»).
    """
    dt = str(rec.get("datereg") or "")
    day = dt[:10]
    modern = 0
    if rec.get("_id") and rec.get("_id") == rec.get("id"):
        modern += 1
    if "+" in dt or dt.endswith("Z"):
        modern += 1
    return (day, modern)


def merge(best: dict, bin_str: str, rec: dict):
    """Положить запись в накопитель, оставив по БИН самую свежую."""
    rank = record_rank(rec)
    prev = best.get(bin_str)
    if prev is None or rank >= prev[0]:
        best[bin_str] = (rank, status_code(rec.get("statusru")))


# ----------------------- Загрузка из API -----------------------

def log(msg):
    """Печать с немедленным сбросом буфера — иначе прогресс не виден в файле."""
    print(msg, flush=True)


def _fetch(source: dict, timeout: int = TIMEOUT):
    """Один запрос с повторами.

    data.egov.kz периодически «подвисает»: TCP-соединение установлено, но ответ
    не приходит. Поэтому таймаут короткий (лучше оборвать и повторить), а число
    попыток большое. Если не удалось и после них — исключение, но прогресс
    обхода уже сохранён в STATE_FILE, и повторный запуск продолжит с места
    обрыва, а не с нуля.
    """
    url = BASE_URL + "?source=" + urllib.parse.quote(json.dumps(source, ensure_ascii=False))
    last = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last = e
            wait = min(60, 2 ** attempt)
            log(f"  ! ошибка запроса ({e}) — повтор {attempt + 1}/{RETRIES} через {wait} с")
            time.sleep(wait)
    raise RuntimeError(f"Запрос не удался после {RETRIES} попыток: {last}")


def _load_state(state_path):
    """Прочитать прогресс прошлого запуска: bin;day;modern;status по строке."""
    best = {}
    cursor = ""
    if not os.path.exists(state_path):
        return best, cursor, 0
    rows = 0
    with open(state_path, encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split(";")
            if len(parts) != 4:
                continue
            b, day, modern, st = parts
            try:
                rank = (day, int(modern))
                st = int(st)
            except ValueError:
                continue
            prev = best.get(b)
            if prev is None or rank >= prev[0]:
                best[b] = (rank, st)
            if b > cursor:
                cursor = b
            rows += 1
    return best, cursor, rows


def bins_from_api(out_dir, resume=True):
    """Полный обход реестра курсором по БИН. Возвращает (best, статистика)."""
    fields = ["bin", "datereg", "statusru", "id"]
    os.makedirs(out_dir, exist_ok=True)
    state_path = os.path.join(out_dir, STATE_FILE)

    def page(cursor):
        return _fetch({
            "query": {"range": {"bin": {"gt": cursor}}},
            "sort": [{"bin": "asc"}],
            "from": 0,                 # всегда 0 — глубоких смещений нет
            "size": PAGE_SIZE,
            "_source": fields,
        })

    best, cursor, seen = ({}, "", 0)
    if resume:
        best, cursor, seen = _load_state(state_path)
        if seen:
            log(f"Продолжаю прошлый обход: {seen} записей, курсор на БИН {cursor}")
    if not resume and os.path.exists(state_path):
        os.remove(state_path)

    head = page(cursor)
    expected = (head.get("totalCount") or 0) + seen
    total_all = _fetch({"from": 0, "size": 1}).get("totalCount") or 0
    log(f"Записей в наборе {DATASET}: {total_all} (из них с непустым БИН: {expected})")

    state = open(state_path, "a", encoding="utf-8")
    dup_records = 0
    data = head.get("data") or []
    t0 = time.time()

    while data:
        last_bin = str(data[-1].get("bin") or "")
        # Хвостовую группу с тем же БИН отбрасываем — её дубликаты придут
        # следующей страницей (курсор ставим на предыдущий БИН).
        keep = [r for r in data if str(r.get("bin") or "") != last_bin]
        if not keep:                 # вся страница — один БИН (теоретически)
            keep = data
            next_cursor = last_bin
        else:
            next_cursor = str(keep[-1].get("bin") or "")

        for rec in keep:
            b = str(rec.get("bin") or "").strip()
            if len(b) == 12 and b.isdigit():
                if b in best:
                    dup_records += 1
                rank = record_rank(rec)
                merge(best, b, rec)
                seen += 1
                # Пишем прогресс сразу: обрыв связи не обесценит уже скачанное.
                state.write(f"{b};{rank[0]};{rank[1]};{status_code(rec.get('statusru'))}\n")

        if next_cursor == cursor:    # защита от зацикливания
            log("  ! курсор не сдвинулся — останавливаюсь")
            break
        cursor = next_cursor
        state.flush()
        log(f"  {seen}/{expected} ({100 * seen / max(expected, 1):.1f}%) — уникальных БИН: {len(best)}")
        time.sleep(0.05)             # вежливая пауза
        data = page(cursor).get("data") or []

    state.close()
    elapsed = time.time() - t0
    log(f"Скачано за {elapsed:.0f} с")

    # Сверка полноты: сколько записей осталось «за курсором».
    tail = _fetch({"query": {"range": {"bin": {"gt": cursor}}}, "from": 0, "size": 1})
    tail_left = tail.get("totalCount") or 0
    stats = {
        "records_expected": expected,
        "records_read": seen,
        "records_total_dataset": total_all,
        "duplicate_records": dup_records,
        "tail_left": tail_left,
    }
    if tail_left:
        log(f"  ! ВНИМАНИЕ: за курсором осталось {tail_left} записей — запустите скрипт ещё раз, он продолжит с места обрыва")
    # Допуск: реестр живой, за время обхода могли добавиться/исчезнуть записи.
    delta = expected - seen
    ok = not tail_left and abs(delta) <= max(50, expected * 0.001)
    if ok:
        log(f"Сверка: прочитано {seen} из {expected} записей с БИН (разница {delta}) — полнота подтверждена")
        if os.path.exists(state_path):
            os.remove(state_path)     # обход завершён — черновик больше не нужен
    else:
        log(f"  ! ВНИМАНИЕ: прочитано {seen}, ожидалось {expected} (разница {delta}). "
            f"Черновик обхода сохранён: {state_path}")
    stats["complete"] = ok
    return best, stats


# ----------------------- Загрузка из CSV -----------------------

def bins_from_csv(path: str):
    """Резервный путь: из готовой выгрузки CSV.

    В CSV нет _id, поэтому актуальная эпоха записи определяется только по
    часовому поясу в дате регистрации.
    """
    csv.field_size_limit(1 << 30)
    best = {}
    rows = 0
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        header = [(h or "").strip().lower() for h in (next(reader, None) or [])]

        def col(*names, default=None):
            for n in names:
                if n in header:
                    return header.index(n)
            return default

        c_bin = col("бин", "bin", default=0)
        c_date = col("дата регистрации", "datereg", default=3)
        c_status = col("статус (рус)", "statusru", default=5)
        for row in reader:
            rows += 1
            if c_bin >= len(row):
                continue
            b = (row[c_bin] or "").strip()
            if len(b) == 12 and b.isdigit():
                merge(best, b, {
                    "datereg": row[c_date] if c_date is not None and c_date < len(row) else "",
                    "statusru": row[c_status] if c_status is not None and c_status < len(row) else "",
                })
    return best, {"records_expected": rows, "records_read": rows}


# ----------------------- Запись индекса -----------------------

def _varint(n: int, buf: bytearray):
    """LEB128: 7 бит на байт, старший бит — признак продолжения."""
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            buf.append(b | 0x80)
        else:
            buf.append(b)
            return


def _stream(values, buf: bytearray):
    prev = 0
    for v in values:
        _varint(v - prev, buf)       # первый элемент — само значение (prev = 0)
        prev = v


def write_index(best: dict, out_dir: str, meta_extra: dict):
    os.makedirs(out_dir, exist_ok=True)
    values = sorted(int(b) for b in best)
    flagged = sorted((int(b), st) for b, (_, st) in best.items() if st)

    buf = bytearray()
    buf += b"GBDB"
    buf += bytes([2, 0, 0, 0])
    buf += struct.pack("<I", len(values))
    buf += struct.pack("<I", len(flagged))
    _stream(values, buf)
    _stream([v for v, _ in flagged], buf)
    buf += bytes(st for _, st in flagged)

    bin_path = os.path.join(out_dir, BIN_FILE)
    with open(bin_path, "wb") as f:
        f.write(buf)

    meta = {
        "dataset": DATASET,
        "source": "https://data.egov.kz/datasets/view?index=gbd_ul",
        "generated": _dt.date.today().isoformat(),
        "bins": len(values),
        "flagged": len(flagged),
        "file": BIN_FILE,
        "bytes": len(buf),
        "format": "GBDB v2: uint32 count + uint32 flaggedCount + LEB128 delta streams + status bytes",
    }
    meta.update(meta_extra)
    with open(os.path.join(out_dir, META_FILE), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    log("\nГотово:")
    log(f"  {bin_path} — {len(values)} БИН ({len(flagged)} с нештатным статусом), {len(buf) / 1048576:.2f} МБ")
    log(f"  {os.path.join(out_dir, META_FILE)}")
    return meta


def main():
    ap = argparse.ArgumentParser(description="Собрать локальный индекс БИН из ГБД ЮЛ")
    ap.add_argument("--refresh", action="store_true",
                    help="скачать свежий реестр из data.egov.kz (иначе — из CSV)")
    ap.add_argument("--csv", default=DEFAULT_CSV, help="путь к выгрузке CSV")
    ap.add_argument("--out", default=DEFAULT_OUT, help="куда положить индекс")
    ap.add_argument("--restart", action="store_true",
                    help="начать обход заново, игнорируя черновик прошлого запуска")
    args = ap.parse_args()

    if args.refresh:
        best, stats = bins_from_api(args.out, resume=not args.restart)
        # НЕ перезаписываем индекс частичной выгрузкой: неполный обход = потерянные
        # БИН = ложные «нерезиденты». Старый индекс остаётся на месте, черновик
        # сохранён (см. .gbd_ul_scan.tmp) — повторный запуск продолжит и дожмёт.
        # Это критично для авто-обновления по расписанию: лучше отдать ошибку и
        # оставить прошлый индекс, чем опубликовать дырявый.
        if not stats.get("complete"):
            print("Обход НЕ завершён полностью — индекс не перезаписан. "
                  "Запустите ещё раз (продолжит с места обрыва).", file=sys.stderr)
            return 1
        extra = dict(stats)
        extra["origin"] = "api"
    else:
        if not os.path.exists(args.csv):
            print(f"CSV не найден: {args.csv}\n"
                  f"Запустите с --refresh, чтобы скачать реестр из API.", file=sys.stderr)
            return 1
        best, stats = bins_from_csv(args.csv)
        extra = dict(stats)
        extra["origin"] = os.path.basename(args.csv)
        log(f"CSV: {stats['records_read']} строк, уникальных БИН: {len(best)}")

    if not best:
        print("Не найдено ни одного БИН — индекс не записан.", file=sys.stderr)
        return 1
    write_index(best, args.out, extra)
    return 0


if __name__ == "__main__":
    sys.exit(main())
