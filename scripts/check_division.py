#!/usr/bin/env python3
"""Проверка деления репликаторов (Aerogeminium/Hydrogeminium) на N=256.

Ключевое отличие от прошлых проверок: подсчёт пятен ПЕРИОДИЧЕСКИЙ
(с учётом перехода через край тора) — существо, пересёкшее границу,
остаётся ОДНИМ. Это эталон для починки дневника в приложении.
"""
import json, sys
import numpy as np
from scipy import ndimage

sys.path.insert(0, '/home/z/my-project/scripts')
from verify_lenia import build_kernel, FIELD_FUNC

N = 256


def load_creatures():
    src = open('/home/z/my-project/src/lib/lenia/creatures.ts').read()
    marker = 'export const CREATURES: Creature[] = '
    start = src.index('= [', src.index(marker)) + 2
    depth = 0
    for i in range(start, len(src)):
        if src[i] == '[':
            depth += 1
        elif src[i] == ']':
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    return {c['name']: c for c in json.loads(src[start:end])}


class PeriodicCounter:
    """Счётчик связных компонент на торе (8-связность с объединением краёв)."""

    def __init__(self, n):
        self.n = n

    def count(self, world, thr=0.1, min_size=30):
        n = self.n
        mask = world > thr
        if not mask.any():
            return 0, []
        lab, nl = ndimage.label(mask)  # 4-связность внутри, объединяем края сами
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

        # вертикальный край: (0,y) ~( N-1,y)
        for y in range(n):
            a, b = lab[y, 0], lab[y, n - 1]
            if a and b:
                union(a, b)
        # горизонтальный край: (x,0) ~( x,N-1)
        for x in range(n):
            a, b = lab[0, x], lab[n - 1, x]
            if a and b:
                union(a, b)
        sizes = ndimage.sum_labels(mask, lab, index=range(1, nl + 1))
        roots = {}
        blobs = []
        for i in range(1, nl + 1):
            r = find(i)
            roots[r] = roots.get(r, 0) + sizes[i - 1]
        for r, sz in roots.items():
            if sz >= min_size:
                blobs.append(sz)
        return len(blobs), blobs


def run(name, steps=12000, every=200):
    cr = load_creatures()[name]
    cells = np.array(cr['cells']).reshape(cr['h'], cr['w'])
    b = cr['b']
    K = build_kernel(N, cr['R'], b, cr['kn'])
    KF = np.fft.rfft2(np.fft.ifftshift(K))
    g = FIELD_FUNC[cr['gn'] - 1]
    dt = 1.0 / cr['T']
    world = np.zeros((N, N))
    ys = (np.arange(cr['h']) + N // 2 - cr['h'] // 2) % N
    xs = (np.arange(cr['w']) + N // 2 - cr['w'] // 2) % N
    world[np.ix_(ys, xs)] = cells

    counter = PeriodicCounter(N)
    print(f"=== {name} (R={cr['R']} b={b} m={cr['m']} s={cr['s']}) ===")
    t0 = __import__('time').time()
    first_div = None
    for i in range(steps):
        U = np.fft.irfft2(KF * np.fft.rfft2(world), s=(N, N))
        world = np.clip(world + dt * g(U, cr['m'], cr['s']), 0, 1)
        if (i + 1) % every == 0:
            cnt, blobs = counter.count(world)
            if first_div is None and cnt >= 2:
                first_div = i + 1
            print(f"  t={i+1:6d}  mass={world.sum():8.1f}  существ={cnt}  sizes={[int(s) for s in blobs]}",
                  flush=True)
    cnt, _ = counter.count(world)
    print(f"  итог: существ={cnt}, первое деление на шаге {first_div}, "
          f"{( __import__('time').time()-t0):.1f}s")
    return first_div, cnt


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'both'
    if which in ('both', 'aero'):
        run('Aerogeminium repens')
    if which in ('both', 'hydro'):
        run('Hydrogeminium saliens')
