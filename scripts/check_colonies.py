#!/usr/bin/env python3
"""Проверка видимости колоний на скриншоте: ищем яркие кластеры в ожидаемых местах."""
from PIL import Image
import sys

im = Image.open(sys.argv[1] if len(sys.argv) > 1 else '/tmp/overview1.png').convert('RGB')
W, H = im.size
px = im.load()

# мировые координаты блюдц -> экранные (камера 10,10, scale 45, viewport 1440x900)
SCALE = 45
CAMX, CAMY = 10, 10

def dish_to_screen(wx, wy):
    sx = (wx + 0.5 - CAMX) * SCALE + W / 2
    sy = H / 2 - (wy + 0.5 - CAMY) * SCALE
    return int(sx), int(sy)

# все яркие пиксели (жизнь), кластеры по сетке
cells = {}
for y in range(0, H, 3):
    for x in range(0, W, 3):
        r, g, b = px[x, y]
        if r + g + b > 150:
            cells.setdefault((x // 30, y // 30), []).append((x, y, r, g, b))

print(f"Размер: {W}x{H}, ярких кластеров (>150 RGB): {len(cells)}")
for (cx, cy), pts in sorted(cells.items())[:15]:
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    r = sum(p[2] for p in pts) // len(pts); g = sum(p[3] for p in pts) // len(pts); b = sum(p[4] for p in pts) // len(pts)
    # какое блюдце под этим кластером
    wx = (min(xs) + max(xs)) / 2
    wy = (min(ys) + max(ys)) / 2
    dwx = (wx - W / 2) / SCALE + CAMX
    dwy = CAMY - (wy - H / 2) / SCALE
    print(f"  кластер@({(min(xs)+max(xs))//2},{(min(ys)+max(ys))//2}) size~{max(xs)-min(xs)}x{max(ys)-min(ys)} avgRGB=({r},{g},{b}) блюдцо~({dwx:.1f},{dwy:.1f})")

# максимум яркости в области конкретных колоний
for name, (dwx, dwy) in {'колония(11,6)': (11.5, 6.5), 'колония(2,7)': (2.5, 7.5), 'центр(10,10)': (10.5, 10.5)}.items():
    sx, sy = dish_to_screen(dwx, dwy)
    best = 0; col = None
    for dy in range(-30, 31):
        for dx in range(-30, 31):
            x, y = sx + dx, sy + dy
            if 0 <= x < W and 0 <= y < H:
                s = sum(px[x, y])
                if s > best:
                    best = s; col = px[x, y]
    print(f"{name}: maxRGBsum={best} color={col}")
