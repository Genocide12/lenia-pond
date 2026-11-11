#!/usr/bin/env python3
"""Пиксельный анализ скриншотов пруда: колонии, мерцание, плоские заливки."""
import sys
from PIL import Image

def analyze(path):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()
    n = w * h
    sum_r = sum_g = sum_b = 0
    bright = 0        # сумма RGB > 120 — «жизнь»
    flat_rows = {}
    max_flat = 0
    colors = {}
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            sum_r += r; sum_g += g; sum_b += b
            s = r + g + b
            if s > 120:
                bright += 1
                key = (r // 40, g // 40, b // 40)
                colors[key] = colors.get(key, 0) + 1
    # плоские заливки: строки одинаковых ярких пикселей
    for y in range(0, h, 8):
        row_sig = {}
        for x in range(0, w, 8):
            r, g, b = px[x, y]
            if r + g + b > 150:
                sig = (r // 25, g // 25, b // 25)
                row_sig[sig] = row_sig.get(sig, 0) + 1
        if row_sig:
            m = max(row_sig.values())
            max_flat = max(max_flat, m)
    top = sorted(colors.items(), key=lambda kv: -kv[1])[:6]
    print(f"{path}: {w}x{h} avg=({sum_r*2//n},{sum_g*2//n},{sum_b*2//n}) "
          f"bright%={100*bright*4//n} colorKinds={len(colors)} maxFlatRun={max_flat}")
    print("  top colors (r,g,b bucket: count):", top)

for p in sys.argv[1:]:
    analyze(p)

# сравнение двух кадров: мерцание = гигантская разница доли ярких пикселей
if len(sys.argv) >= 3:
    def brightfrac(path):
        im = Image.open(path).convert('RGB')
        w, h = im.size
        px = im.load()
        b = sum(1 for y in range(0, h, 2) for x in range(0, w, 2) if sum(px[x, y]) > 120)
        return b / (w * h / 4)
    a, b = brightfrac(sys.argv[1]), brightfrac(sys.argv[2])
    print(f"bright frac: {a:.4f} vs {b:.4f} |delta|={abs(a-b):.4f} -> {'МЕРЦАЕТ' if abs(a-b) > 0.03 else 'стабильно'}")
