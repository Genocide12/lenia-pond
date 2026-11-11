"""Проверка экотипа (dm, ds) для Гриба: честный подсчёт организмов
(связные компоненты как в приложении) в чистом float32."""
import sys

import numpy as np
import scipy.fft as sf
from scipy import ndimage

sys.path.insert(0, '.')
from verify_pond import N, ZOO, place
from verify_f32 import Kf as Kf_limus, g32

c = ZOO['Hydrogeminium limus']
A0 = place(c).astype(np.float32)
dt = np.float32(0.1)


def popcount(A):
    mask = A > 0.1
    if not mask.any():
        return 0
    lab, n = ndimage.label(mask)
    if n == 0:
        return 0
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    merge = {}
    for y in range(N):
        a, b = lab[y, 0], lab[y, N - 1]
        if a and b and a != b:
            merge.setdefault(a, set()).add(b)
    for x in range(N):
        a, b = lab[0, x], lab[N - 1, x]
        if a and b and a != b:
            merge.setdefault(a, set()).add(b)
    parent = list(range(n + 1))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a, bs in merge.items():
        for b in bs:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra
    roots = set(find(i) for i in range(1, n + 1))
    return int(sum(1 for i, sz in enumerate(sizes, 1) if 30 <= sz <= 8000 and find(i) in roots))


def trial(dm, ds, seed, steps=4000):
    rng = np.random.default_rng(seed)
    A = A0.copy()
    if seed > 0:
        A = np.clip(A + (rng.random((N, N)).astype(np.float32) - np.float32(0.5)) * np.float32(2e-6), 0, 1).astype(np.float32)
    m = np.float32(c['m'] + dm)
    s = np.float32(c['s'] * ds)
    hist = []
    for t in range(1, steps + 1):
        U = sf.irfft2(sf.rfft2(A) * Kf_limus, s=(N, N)).astype(np.float32)
        A = np.clip(A + dt * g32(U, m, s), 0, 1).astype(np.float32)
        if t % 400 == 0:
            hist.append((t, popcount(A), int((A > 0.02).sum())))
    return hist


for dm, ds in [(0.0, 1.1), (-0.005, 1.1), (0.0, 1.2), (0.0, 1.0)]:
    print(f'=== экотип dm={dm:+.3f} ds={ds:.1f} (m={c["m"]+dm:.3f}, s={c["s"]*ds:.4f}) ===')
    for seed in [0, 1, 2]:
        hist = trial(dm, ds, seed)
        pops = ' '.join(f'{p:3d}' for _, p, _ in hist)
        print(f'  seed {seed}: pop(400..4000): {pops}')
