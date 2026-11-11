"""Проверка эволюционных механик для бесконечной биосферы.

1) Мутации: случайные сдвиги (dm∈±0.03, ds∈0.86–1.18, dT∈±3) не должны убивать
   виды чаще, чем крайние значения климата (свип verify_climate уже покрыл
   dm±0.04, ds 0.7–1.3 — тут проверяем именно тройки из экосистемы).
2) Мор (пятнистое вымирание) и вирус: колония гриба должна переживать
   возмущение и в основном восстанавливаться — иначе циклы «разросся→умер»
   вымрут везде.

Эталонная арифметика — как в verify_pond.py (FFT-свёртка, блюдце 96×96).
"""
import os

import numpy as np

from verify_pond import N, ZOO, blobs, cells_of, kernel_of, growth_of, place

rng = np.random.default_rng(7)


def simulate(c, A, steps, dm=0.0, ds=1.0, dT=0):
    Kf = kernel_of(c)
    g = growth_of(c)
    m = c["m"] + dm
    s = c["s"] * ds
    dt = 1.0 / max(1, c["T"] + dT)
    for _ in range(steps):
        U = np.fft.irfft2(np.fft.rfft2(A) * Kf, s=(N, N))
        A = np.clip(A + dt * g(U, m, s), 0, 1)
    return A


def vnoise(seed, scale=0.13):
    """Зеркало шейдера PERTURB: value-noise на сетке блюдца."""
    h = np.full((N // 2 + 2, N // 2 + 2), 0.0)
    ys, xs = np.mgrid[0:N, 0:N]
    p = np.stack([ys, xs], -1) * scale
    pi = np.floor(p).astype(int)
    pf = p - pi
    sf = pf * pf * (3 - 2 * pf)

    def hh(i, j):
        n = (i * 127.1 + j * 311.7 + seed) % 6.2831853
        return (np.sin(n) * 43758.5453) % 1.0

    a = hh(pi[..., 0], pi[..., 1])
    b = hh(pi[..., 0] + 1, pi[..., 1])
    cc = hh(pi[..., 0], pi[..., 1] + 1)
    d = hh(pi[..., 0] + 1, pi[..., 1] + 1)
    return a + (b - a) * sf[..., 0] + (cc - a) * sf[..., 1] + (a - b - cc + d) * sf[..., 0] * sf[..., 1]


def dieoff(A, seed):
    n = vnoise(seed, 0.10)
    return A * np.clip((n - 0.30) / 0.36, 0.18, 1.0)


def virus(A, seed):
    n = vnoise(seed)
    blob = np.clip((vnoise(seed + 37, 0.09) - 0.55) / 0.30, 0, 1)
    return np.clip(A * np.clip((n - 0.30) / 0.42, 0.18, 1.0) + 0.5 * blob, 0, 1)


def colony(c, k=8):
    A = np.zeros((N, N))
    for _ in range(k):
        place(c, A, cx=int(rng.integers(16, N - 16)), cy=int(rng.integers(16, N - 16)))
    return A


print("=== 1. Мутации (8 случайных на вид, 1200 шагов) ===")
for name in ["Orbium unicaudatus", "Hydrogeminium limus", "Scutium valvatus", "Florakronium arcus"]:
    c = ZOO[name]
    alive = 0
    for trial in range(8):
        dm = rng.uniform(-0.03, 0.03)
        ds = rng.uniform(0.86, 1.18)
        dT = int(rng.integers(-3, 4))
        A = simulate(c, place(c), 1200, dm=dm, ds=ds, dT=dT)
        if blobs(A) >= 1 and A.sum() > 30:
            alive += 1
    print(f"{name:28s} живо {alive}/8")

print("\n=== 2. Гриб: колония → мор → восстановление (800 шагов) ===")
c = ZOO["Hydrogeminium limus"]
rec = 0
for trial in range(6):
    A = simulate(c, colony(c, 8), 500)
    m0 = A.sum()
    A = simulate(c, dieoff(A, trial * 13.7), 800)
    m1 = A.sum()
    ok = blobs(A) >= 3 and m1 > 0.35 * m0
    rec += ok
    print(f"  прогон {trial}: масса {m0:6.0f} → {m1:6.0f}  pop={blobs(A):3d}  {'восстановился' if ok else 'погиб'}")
print(f"восстановлений: {rec}/6")

print("\n=== 3. Гриб: колония → вирус → исход (800 шагов) ===")
surv = 0
for trial in range(6):
    A = simulate(c, colony(c, 8), 500)
    A = simulate(c, virus(A, trial * 7.3), 800)
    ok = blobs(A) >= 1 and A.sum() > 30
    surv += ok
    print(f"  прогон {trial}: масса {A.sum():6.0f}  pop={blobs(A):3d}  {'жив' if ok else 'погиб'}")
print(f"пережили вирус: {surv}/6")
