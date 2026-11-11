"""Подбор экотипа Гриба для блюдца 96×96 в float32: свип (dm, ds),
ищем точку, где колония образуется во ВСЕХ seed'ах."""
import sys

import numpy as np
import scipy.fft as sf

sys.path.insert(0, '.')
from verify_pond import N, ZOO, place
from verify_f32 import Kf as Kf_limus, g32  # ядро и рост уже f32

c = ZOO['Hydrogeminium limus']
A0 = place(c).astype(np.float32)
dt = np.float32(0.1)


def trial(dm, ds, seed, steps=2600):
    rng = np.random.default_rng(seed)
    A = A0.copy()
    if seed > 0:
        A = np.clip(A + (rng.random((N, N)).astype(np.float32) - np.float32(0.5)) * np.float32(2e-6), 0, 1).astype(np.float32)
    m = np.float32(c['m'] + dm)
    s = np.float32(c['s'] * ds)
    first2 = None
    colony = None
    for t in range(1, steps + 1):
        U = sf.irfft2(sf.rfft2(A) * Kf_limus, s=(N, N)).astype(np.float32)
        A = np.clip(A + dt * g32(U, m, s), 0, 1).astype(np.float32)
        if t % 50 == 0:
            mask = A > 0.1
            # грубая оценка числа организмов: площадь/70
            est = mask.sum() / 70
            if first2 is None and est >= 1.8:
                first2 = t
            if colony is None and mask.sum() > 2200:
                colony = t
                break
    return first2, colony


print('dm      ds     | деление t (4 seed)      | колония t (4 seed)')
for dm in [-0.01, -0.005, 0.0, 0.005, 0.01]:
    for ds in [0.9, 1.0, 1.1, 1.2]:
        f2 = []
        col = []
        for seed in range(4):
            a, b = trial(dm, ds, seed)
            f2.append(a)
            col.append(b)
        n2 = sum(1 for x in f2 if x)
        nc = sum(1 for x in col if x)
        print(f'{dm:+.3f}  {ds:.1f}   | {n2}/4 {f2} | {nc}/4 {col}')
