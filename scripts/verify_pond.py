"""Проверка физики «пруда из блюдцев» (блюдце = маленький тор N×N).

1) какие виды выживают в блюдце 96×96 (нейтральный климат);
2) делится ли Гриб (Hydrogeminium limus) в блюдце;
3) свип климата: какие сдвиги (m, s) убивают вид и за сколько шагов
   → выбор карты «климат → условия» для реального приложения.

Эталонная арифметика как в scripts/verify_lenia.py (FFT-свёртка).
"""
import json
import os
import time

import numpy as np

N = 96  # размер блюдца

ZOO = {c["name"]: c for c in json.load(open(os.path.join(os.path.dirname(__file__), "pond_zoo.json")))}


def kernel_of(c):
    R = c["R"]
    b = np.array(c["b"], dtype=float)
    kn = c["kn"]

    def core(r):
        if kn == 1:
            q = 4 * r * (1 - r)
            return q * q * q * q
        if kn == 2:
            return np.exp(4 - 1 / (r * (1 - r)))
        if kn == 3:
            return ((r >= 0.25) & (r <= 0.75)).astype(float)
        return ((r >= 0.25) & (r <= 0.75)).astype(float) + (r < 0.25) * 0.5

    yy, xx = np.mgrid[0:N, 0:N]
    d = np.hypot(xx - N // 2, yy - N // 2) / R
    NB = len(b)
    idx = np.minimum((NB * d).astype(int), NB - 1)
    f = np.minimum(NB * d - idx, 1.0)
    k = core(f) * b[idx]
    k[d >= 1] = 0.0
    K = k / k.sum()
    return np.fft.rfft2(np.fft.ifftshift(K))


def growth_of(c):
    gn = c["gn"]

    def g(u, m, s):
        x = u - m
        if gn == 1:
            t = np.maximum(0, 1 - (x * x) / (9 * s * s))
            return t * t * t * t * 2 - 1
        if gn == 3:
            return np.where(np.abs(x) <= s, 1.0, -1.0)
        return np.exp(-(x * x) / (2 * s * s)) * 2 - 1

    return g


def cells_of(c):
    a = np.array(c["cells"], dtype=float).reshape(c["h"], c["w"]) / 255.0
    return a


def place(c, A=None, cx=None, cy=None):
    if A is None:
        A = np.zeros((N, N))
    a = cells_of(c)
    h, w = a.shape
    cx = N // 2 if cx is None else cx
    cy = N // 2 if cy is None else cy
    x0, y0 = cx - w // 2, cy - h // 2
    for dy in range(h):
        for dx in range(w):
            A[(y0 + dy) % N, (x0 + dx) % N] = a[dy, dx]
    return A


def blobs(A, thr=0.1, minsize=30):
    """Периодические связные компоненты (упрощённо: через размыкание швов)."""
    from scipy import ndimage

    mask = A > thr
    lab, n = ndimage.label(mask)
    if n == 0:
        return 0
    # объединяем метки через края тора
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
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    return int(sum(1 for i, sz in enumerate(sizes, 1) if sz >= minsize and find(i) in roots))


def simulate(c, A, steps, dm=0.0, ds=1.0, check_every=None, verbose=False):
    Kf = kernel_of(c)
    g = growth_of(c)
    m = c["m"] + dm
    s = c["s"] * ds
    dt = 1.0 / c["T"]
    hist = []
    t0 = time.time()
    for t in range(1, steps + 1):
        U = np.fft.irfft2(np.fft.rfft2(A) * Kf, s=(N, N))
        A = np.clip(A + dt * g(U, m, s), 0, 1)
        if check_every and t % check_every == 0:
            pop = blobs(A)
            hist.append((t, float(A.sum()), pop))
            if verbose:
                print(f"  t={t:5d} mass={A.sum():8.1f} pop={pop}")
    return A, hist, time.time() - t0


if __name__ == "__main__":
    print(f"=== Блюдце {N}×{N}: выживание видов (нейтральный климат, 1200 шагов) ===")
    fit = []
    for name, c in ZOO.items():
        need_w = c["w"] + 2 * c["R"]
        need_h = c["h"] + 2 * c["R"]
        fits = need_w <= N and need_h <= N
        A, hist, secs = simulate(c, place(c), 1200, check_every=400)
        final = hist[-1]
        ok = final[2] >= 1 and final[1] > 30
        print(
            f"{name:34s} fit={'да ' if fits else 'НЕТ'}({need_w}×{need_h})"
            f"  mass={final[1]:7.1f} pop={final[2]:3d}  {'ЖИВ' if ok else 'погиб'}  ({secs:.1f}s)"
        )
        if fits and ok:
            fit.append(name)
    print("подходят:", len(fit))
