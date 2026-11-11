#!/usr/bin/env python3
"""Анализ скриншотов «Пруда Лении»: не пустой ли кадр, палитра, доля жизни."""
import sys
from PIL import Image

def analyze(path):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()
    n = 0
    dark = bright = green = teal = colorful = 0
    lum_sum = 0.0
    for y in range(0, h, 4):
        for x in range(0, w, 4):
            r, g, b = px[x, y]
            n += 1
            lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255
            lum_sum += lum
            mx, mn = max(r, g, b), min(r, g, b)
            sat = (mx - mn) / 255 if mx else 0
            if lum < 0.08:
                dark += 1
            if lum > 0.55:
                bright += 1
            if g > 70 and g > r * 1.3 and g > b * 1.05:
                green += 1
            if g > 60 and b > 60 and r < g * 0.8:
                teal += 1
            if sat > 0.25 and lum > 0.12:
                colorful += 1
    print(f"{path}  {w}x{h}")
    print(f"  средняя яркость: {lum_sum / n:.3f}")
    print(f"  тёмных (<0.08): {dark / n * 100:.1f}%  ярких (>0.55): {bright / n * 100:.1f}%")
    print(f"  зелёных: {green / n * 100:.1f}%  бирюзовых: {teal / n * 100:.1f}%  цветных: {colorful / n * 100:.1f}%")
    print(f"  вердикт: {'ПУСТО/ЧЁРНЫЙ КВАДРАТ' if lum_sum / n < 0.005 else 'ok, кадр живой'}")
    return lum_sum / n, colorful / n

if __name__ == '__main__':
    for p in sys.argv[1:]:
        analyze(p)
