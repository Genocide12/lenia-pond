"""Деление гриба в ЧИСТОМ float32 (scipy.fft complex64) — та же точность,
что в GPU-шейдере. Меряем распределение времени образования колонии."""
import numpy as np
import scipy.fft as sf

from verify_pond import N, ZOO, place

c = ZOO["Hydrogeminium limus"]
b = np.array(c["b"], dtype=np.float32)
R, kn = c["R"], c["kn"]


def core32(r):
    q = 4 * r * (1 - r)
    return (q * q * q * q).astype(np.float32)


yy, xx = np.mgrid[0:N, 0:N].astype(np.float32), None
I, J = np.meshgrid(np.arange(N), np.arange(N))
D = (np.hypot(I - N // 2, J - N // 2) / R).astype(np.float32)
Br = (len(b) * D).astype(np.float32)
idx = np.minimum(Br.astype(int), len(b) - 1)
frac = np.minimum(Br - idx, np.float32(1.0)).astype(np.float32)
K = (core32(frac) * b[idx]).astype(np.float32)
K[D >= 1] = 0
K /= K.sum()
Kf = sf.rfft2(np.fft.ifftshift(K).astype(np.float32))


def g32(u, m, s):
    x = (u - m).astype(np.float32)
    t = np.maximum(np.float32(0), np.float32(1) - (x * x) / np.float32(9 * s * s))
    return (t * t * t * t * np.float32(2) - np.float32(1)).astype(np.float32)


def run(seed, steps=2200):
    rng = np.random.default_rng(seed)
    A = place(c).astype(np.float32)  # образец
    if seed > 0:
        A = np.clip(A + (rng.random((N, N)).astype(np.float32) - 0.5) * np.float32(2e-6), 0, 1).astype(np.float32)
    m = np.float32(c["m"])
    s = np.float32(c["s"])
    dt = np.float32(1 / c["T"])
    first = None
    for t in range(1, steps + 1):
        U = sf.irfft2(sf.rfft2(A) * Kf, s=(N, N)).astype(np.float32)
        A = np.clip(A + dt * g32(U, m, s), 0, 1).astype(np.float32)
        if t % 100 == 0:
            mask = A > 0.1
            if mask.sum() > 2000 and first is None:
                first = t
    return first, float(A[A > 0.02].sum())


print('float32-конвейер (seed 0 = без шума):')
for seed in range(6):
    first, mass = run(seed)
    print(f'  seed {seed}: колония с t={first}  mass_end={mass:.0f}')
