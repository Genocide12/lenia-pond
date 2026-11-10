#!/usr/bin/env python3
"""Скан всех geminium-подобных существ: кто реально делится и как быстро.

Критерий наглядности для приложения: первое деление <= ~4000 шагов
(при dt=0.1 это t<=400, при 480 шагов/с в приложении — ~8 секунд).
"""
import json, sys, time
import numpy as np
from scipy import ndimage

sys.path.insert(0, '/home/z/my-project/scripts')
from verify_lenia import rle2cells, build_kernel, FIELD_FUNC

N = 256


def periodic_count(world, thr=0.1, min_size=30):
    n = world.shape[0]
    mask = world > thr
    if not mask.any():
        return 0
    lab, nl = ndimage.label(mask)
    parent = list(range(nl + 1))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for y in range(n):
        a, b = lab[y, 0], lab[y, n - 1]
        if a and b:
            union(a, b)
    for x in range(n):
        a, b = lab[0, x], lab[n - 1, x]
        if a and b:
            union(a, b)
    # площадь каждой метки (в пикселях), суммируем по корням union-find
    counts = np.bincount(lab.ravel(), minlength=nl + 1)
    sizes = {}
    for i in range(1, nl + 1):
        r = find(i)
        sizes[r] = sizes.get(r, 0) + counts[i]
    return sum(1 for r, sz in sizes.items() if sz >= min_size)


def parse_b(bs):
    from fractions import Fraction
    return [float(Fraction(x)) for x in str(bs).split(',')]


def run(name, steps=6000, every=100):
    data = json.load(open('/home/z/my-project/scripts/orig/animals.json'))
    a = [x for x in data if x.get('name') == name][0]
    cells = rle2cells(a['cells'])
    if cells.shape[0] > 130 or cells.shape[1] > 130:
        print(f"{name}: слишком велик {cells.shape}")
        return None
    p = a['params']
    b = parse_b(p['b'])
    K = build_kernel(N, p['R'], b, p.get('kn') or 1)
    KF = np.fft.rfft2(np.fft.ifftshift(K))
    g = FIELD_FUNC[(p.get('gn') or 1) - 1]
    dt = 1.0 / p['T']
    world = np.zeros((N, N))
    h, w = cells.shape
    ys = (np.arange(h) + N // 2 - h // 2) % N
    xs = (np.arange(w) + N // 2 - w // 2) % N
    world[np.ix_(ys, xs)] = cells

    t0 = time.time()
    first_div = None
    max_pop = 0
    for i in range(steps):
        U = np.fft.irfft2(KF * np.fft.rfft2(world), s=(N, N))
        world = np.clip(world + dt * g(U, p['m'], p['s']), 0, 1)
        if (i + 1) % every == 0:
            cnt = periodic_count(world)
            max_pop = max(max_pop, cnt)
            if first_div is None and cnt >= 2:
                first_div = i + 1
                print(f"  {name}: ДЕЛЕНИЕ на шаге {i+1} (t={(i+1)*dt:.0f}), популяция {cnt}")
                if cnt >= 2 and i + 1 >= steps:
                    pass
            if (i + 1) % 1200 == 0:
                print(f"  {name}: t={i+1} mass={world.sum():.0f} поп={cnt}", flush=True)
    final = periodic_count(world)
    print(f"{name}: итог поп={final} max={max_pop} первое деление={first_div} "
          f"({time.time()-t0:.0f}s)", flush=True)
    return first_div, final, max_pop


if __name__ == '__main__':
    names = [
        'Aerogeminium volitans',
        'Aerogeminium ambiguus',
        'Aerogeminium vagus',
        'Aerogeminium immotus',
        'Hydrogeminium natans',
        'Hydrogeminium limus',
        'Hydrogeminium labens',
        'Gyrogeminium gyrans',
        'Terrageminium saliens',
        'Aerogeminium repens',
        'Hydrogeminium saliens',
    ]
    steps = int(sys.argv[1]) if len(sys.argv) > 1 else 6000
    results = {}
    for nm in names:
        try:
            results[nm] = run(nm, steps=steps)
        except Exception as e:
            print(f"{nm}: FAIL {e}")
    print('\n=== ИТОГ (шаг до первого деления, финальная популяция) ===')
    for nm, r in sorted(results.items(), key=lambda kv: (kv[1] is None, kv[1][0] if kv[1] else 10**9)):
        if r:
            print(f"  {nm:32s} деление@{r[0]}  поп={r[1]}  max={r[2]}")
        else:
            print(f"  {nm:32s} —")
