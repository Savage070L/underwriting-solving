#!/usr/bin/env python3
"""Готовит факсимиле для «Рекомендации ДАиП» из сырых сканов.

Исходники (снимки подписи с удалённым фоном) дают на печати «пикселизацию»:
  * штрих полупрозрачный и светлый — на бумаге выглядит вымытым;
  * внутри штриха светлые прожилки (гелевая ручка + удаление фона съело часть
    пикселей самой линии);
  * вокруг линий висит серо-белая пыль от того же удаления фона;
  * прежний ассет был 300 px шириной (~270 dpi на печати) и ещё и квантован
    в 64 цвета — альфа схлопывалась в несколько уровней, давая ступеньки.

Здесь всё считается на ПОЛНОМ разрешении исходника и только в самом конце
уменьшается до печатного размера:
  1. покрытие (сколько чернил в пикселе) = насколько пиксель темнее бумаги
     после композита на белом — учитывает и альфу, и светлоту разом;
  2. despeckle — пиксели без «поддержки» соседей выбрасываются (серо-белая пыль);
  3. closing — заливает светлые прожилки внутри штриха;
  4. усиление (гамма) + лёгкое расширение — «обводка сильнее»;
  5. лёгкое размытие — сглаживает рваный край, полученный при удалении фона;
  6. LANCZOS-даунсемпл до печатного размера и сборка RGBA с ОДНИМ цветом чернил
     (никаких серых каёмок в принципе) и без квантования.

Формат — именно RGBA, а не палитра: pdfmake раскладывает картинку на цветовой
слой + SMask, и при постоянном цвете слой сжимается практически в ноль, платим
только за альфу. Палитровый PNG весит меньше на диске, но в PDF попадает ДВАЖДЫ
(индексы + SMask) и раздувает документ вдвое.

Запуск:  python3 tools/build_signatures.py
"""

import os
from PIL import Image, ImageFilter
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Цвет чернил в готовом факсимиле. Исходник — синяя гелевая ручка
# (RGB ≈ 60,77,180); берём тот же оттенок, но плотнее: на ч/б принтере светлая
# синева уходит в полутоновый растр и читается как «серые точки».
INK = (30, 46, 122)

# Высота на печати — 17,7 мм (ARForm.SIG_HEIGHT = 67 px @96 dpi). 480 px по
# высоте дают ≈690 dpi — с запасом выше офисных 600 dpi. Было 300 px по ШИРИНЕ
# (≈270 dpi), отсюда и «лесенка» на распечатке. Выше поднимать нет смысла:
# каждый документ пакета несёт факсимиле внутри себя.
TARGET_H = 480

JOBS = [
    {
        'src': os.path.expanduser('~/Downloads/подпись Талгат Джелкобаев.png'),
        'dst': os.path.join(ROOT, 'assets/signatures/dzhelkobaev.png'),
    },
    {
        'src': os.path.expanduser('~/Downloads/подпись Романа Осинцева.png'),
        'dst': os.path.join(ROOT, 'assets/signatures/osintsev.png'),
    },
]

FLOOR = 0.055        # ниже этого покрытия — не чернила, а фон
SUPPORT_MIN = 0.075  # despeckle: минимальное покрытие в окрестности
GAMMA = 0.62         # <1 — усиливает полупрозрачные пиксели штриха
GROW = 0.35          # доля расширения (утолщение обводки)
SMOOTH = 1.1         # радиус сглаживания, px исходника


def _u8(arr):
    return Image.fromarray(np.clip(arr * 255.0, 0, 255).astype(np.uint8), 'L')


def _f(img):
    return np.asarray(img).astype(np.float64) / 255.0


def coverage(path):
    """Доля чернил в пикселе: 0 — чистая бумага, 1 — плотный штрих."""
    a = np.asarray(Image.open(path).convert('RGBA')).astype(np.float64) / 255.0
    rgb, al = a[:, :, :3], a[:, :, 3:4]
    on_white = rgb * al + (1.0 - al)          # как это ляжет на бумагу
    lum = (0.299 * on_white[:, :, 0] + 0.587 * on_white[:, :, 1]
           + 0.114 * on_white[:, :, 2])
    return 1.0 - lum


def build(src, dst, target_h=TARGET_H):
    cov = coverage(src)
    raw_ink = (cov > FLOOR).sum()

    # 1. Долой серо-белую пыль: пиксель остаётся, только если рядом есть штрих.
    support = _f(_u8(cov).filter(ImageFilter.GaussianBlur(3)))
    cov = np.where(support < SUPPORT_MIN, 0.0, cov)
    despeckled = raw_ink - (cov > FLOOR).sum()

    # 2. Closing — заливает светлые прожилки внутри линии (выпавшие пиксели).
    img = _u8(cov)
    closed = _f(img.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5)))
    cov = np.maximum(cov, closed)

    # 3. Плотность + утолщение: «обводка сильнее».
    cov = np.clip(cov / max(1e-6, np.percentile(cov[cov > FLOOR], 98)), 0, 1)
    cov = cov ** GAMMA
    grown = _f(_u8(cov).filter(ImageFilter.MaxFilter(3)))
    cov = np.clip(cov + GROW * (grown - cov), 0, 1)

    # 4. Сглаживание рваного края и обрезка остаточного фона.
    cov = _f(_u8(cov).filter(ImageFilter.GaussianBlur(SMOOTH)))
    cov = np.where(cov < FLOOR, 0.0, cov)

    # 5. Кроп по чернилам и даунсемпл ТОЛЬКО на этом шаге.
    alpha = _u8(cov)
    box = alpha.getbbox()
    alpha = alpha.crop(box)
    w, h = alpha.size
    alpha = alpha.resize((max(1, round(w * target_h / h)), target_h), Image.LANCZOS)

    out = Image.new('RGBA', alpha.size, INK + (0,))
    out.putalpha(alpha)
    out.save(dst, 'PNG', optimize=True)

    a = np.asarray(alpha).astype(int)
    print(f'{os.path.basename(dst)}: {alpha.size[0]}x{alpha.size[1]}, '
          f'{os.path.getsize(dst) / 1024:.1f} КБ; '
          f'вычищено пыли {despeckled} px; '
          f'плотных (α≥230) {(a >= 230).sum()} px '
          f'({100 * (a >= 230).sum() / max(1, (a > 10).sum()):.0f}% от видимых)')


if __name__ == '__main__':
    for job in JOBS:
        build(job['src'], job['dst'])
