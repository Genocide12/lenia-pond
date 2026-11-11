"""Отбор репликатора для блюдца 96×96 в ЧИСТОМ float32 (точность GPU):
кто надёжно образует колонию? Несколько seed'ов на вид."""
import json
import sys

import numpy as np
import scipy.fft as sf

sys.path.insert(0, '.')
from verify_lenia import rle2cells

N = 96
data = json.load(open('/tmp/animals.json'))

CANDIDATES = [
    'Aerogeminium volitans',
    'Aerogeminium ambiguus',
    'Aerogeminium immotus',
    'Aerogeminium vagus',
    'Hydrogeminium natans',
    'Hydrogeminium labens',
    'Hydrogeminium limus',
    'Gyrogeminium gyrans',
    'Heptageminium natans',
]


def build(c):
    p = c['params']
    R = p['R']
    b = np.array([float(eval(str(x))) if '/' in str(x) else float(x) for x in str(p['b']).split(',')], dtype=np.float32)
    kn = p.get('kn', 1)
    I, J = np.meshgrid(np.arange(N), np.arange(N))
    D = (np.hypot(I - N // 2, J - N // 2) / R).astype(np.float32)

    def core(r):
        if kn == 1:
            q = 4 * r * (1 - r)
            return (q * q * q * q).astype(np.float32)
        if kn == 2:
            with np.errstate(divide='ignore', invalid='ignore'):
                v = np.exp(4 - 1 / (r * (1 - r)))
            return np.nan_to_num(v).astype(np.float32)
        if kn == 3:
            return ((r >= 0.25) & (r <= 0.75)).astype(np.float32)
        return (((r >= 0.25) & (r <= 0.75)).astype(np.float32) + (r < 0.25) * 0.5).astype(np.float32)

    Br = (len(b) * D).astype(np.float32)
    idx = np.minimum(Br.astype(int), len(b) - 1)
    frac = np.minimum(Br - idx, np.float32(1.0)).astype(np.float32)
    K = (core(frac) * b[idx]).astype(np.float32)
    K[D >= 1] = 0
    K /= K.sum()
    return sf.rfft2(np.fft.ifftshift(K).astype(np.float32)), p


def growth(u, m, s, gn):
    x = (u - m).astype(np.float32)
    if gn == 1:
        t = np.maximum(np.float32(0), np.float32(1) - (x * x) / np.float32(9 * s * s))
        return (t * t * t * t * np.float32(2) - np.float32(1)).astype(np.float32)
    if gn == 3:
        return (np.abs(x) <= s).astype(np.float32) * np.float32(2) - np.float32(1)
    return (np.exp(-(x * x) / np.float32(2 * s * s)) * np.float32(2) - np.float32(1)).astype(np.float32)


def place_cells(cells):
    A = np.zeros((N, N), dtype=np.float32)
    h, w = cells.shape
    A[(N - h) // 2:(N - h) // 2 + h, (N - w) // 2:(N - w) // 2 + w] = cells.astype(np.float32)
    return A


seen = set()
for a in data:
    if not a.get('cells') or not isinstance(a.get('params'), dict) or isinstance(a['cells'], list):
        continue
    name = a['name']
    if name not in CANDIDATES or name in seen:
        continue
    seen.add(name)
    cells = rle2cells(a['cells'])
    Kf, p = build(a)
    m0 = np.float32(p['m'])
    s0 = np.float32(p['s'])
    gn = p.get('gn', 1)
    dt = np.float32(1 / p['T'])

    results = []
    for seed in range(4):
        rng = np.random.default_rng(seed)
        A = place_cells(cells)
        if seed > 0:
            A = np.clip(A + (rng.random((N, N)).astype(np.float32) - np.float32(0.5)) * np.float32(2e-6), 0, 1).astype(np.float32)
        first = None
        for t in range(1, 2501):
            U = sf.irfft2(sf.rfft2(A) * Kf, s=(N, N)).astype(np.float32)
            A = np.clip(A + dt * growth(U, m0, s0, gn), 0, 1).astype(np.float32)
            if t % 100 == 0 and (A > 0.1).sum() > 2500 and first is None:
                first = t
                break
        results.append(first if first else '-')
    hits = sum(1 for r in results if r != '-')
    print(f'{name:28s} R={p["R"]:2d} {cells.shape[1]}x{cells.shape[0]}  колония: {hits}/4  t={results}')
