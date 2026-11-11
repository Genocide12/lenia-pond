"""Генерация PWA-иконок пруда: тёмный скруглённый квадрат + изумрудный «головастик»."""
from PIL import Image, ImageDraw

S = 4  # суперсэмплинг


def rounded(d, box, r, fill):
    d.rounded_rectangle(box, radius=r, fill=fill)


def draw_icon(size, maskable=False):
    base = size * S
    img = Image.new('RGBA', (base, base), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # фон
    rounded(d, [0, 0, base, base], base * 0.22, '#08160f')
    # коэффициент безопасной зоны для maskable (контент в центральных 66%)
    k = 0.62 if maskable else 0.94
    cx, cy = base * 0.47, base * 0.53
    r1 = base * 0.25 * (k / 0.94)
    r2 = r1 * 0.75
    d.ellipse([cx - r1, cy - r1, cx + r1, cy + r1], fill='#1d7a55')
    d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill='#54e8a3')
    # «хвостик»-дуга
    w = base * 0.062
    d.arc([cx + r1 * 0.15, cy - r1 * 1.5, cx + r1 * 1.7, cy + r1 * 0.1], start=-80, end=30, fill='#d2ffe4', width=int(w))
    # глаз
    re_ = r2 * 0.36
    d.ellipse([cx - r2 * 0.45 - re_, cy - r2 * 0.35 - re_, cx - r2 * 0.45 + re_, cy - r2 * 0.35 + re_], fill='#08160f')
    rd = r2 * 0.2
    d.ellipse([cx + r2 * 0.35 - rd, cy + r2 * 0.5 - rd, cx + r2 * 0.35 + rd, cy + r2 * 0.5 + rd], fill='#0e8f60')
    return img.resize((size, size), Image.LANCZOS)


for name, size, mask in [
    ('icon-192.png', 192, False),
    ('icon-512.png', 512, False),
    ('icon-maskable-512.png', 512, True),
    ('apple-touch-icon.png', 180, False),
]:
    draw_icon(size, mask).save(f'public/{name}')
    print(name, 'ok')
