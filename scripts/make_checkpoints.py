#!/usr/bin/env python3
"""Контрольные точки для /selftest страницы: точное зеркало engine.placeCells
(row flip + центрирование) и шагов движка. GPU обязан повторить NumPy на малых t.
"""
import json, sys
import numpy as np

sys.path.insert(0, '/home/z/my-project/scripts')
from verify_lenia import build_kernel, FIELD_FUNC

N = 256


def load_ts():
    import base64
    src = open('/home/z/my-project/src/lib/lenia/creatures.ts').read()
    marker = 'const DATA: CreatureData[] = '
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
    arr = json.loads(src[start:end])
    out = {}
    for c in arr:
        ks = np.frombuffer(base64.b64decode(c['data']), dtype=np.uint8)
        c['cells'] = [int(k) / 255.0 for k in ks]
        out[c['name']] = c
    return out


def place_engine(world, cells, gx, gy):
    """Точное зеркало engine.placeCells: row flip, x0 = round(gx - w/2), y0 = round(gy - h/2)."""
    n = world.shape[0]
    h, w = cells.shape
    src = cells[::-1, :]  # row 0 = низ паттерна
    x0 = int(round(gx - w / 2)) % n
    y0 = int(round(gy - h / 2)) % n
    ys = (np.arange(y0, y0 + h)) % n
    xs = (np.arange(x0, x0 + w)) % n
    world[np.ix_(ys, xs)] = np.maximum(world[np.ix_(ys, xs)], src)


def make_stepper(R, T, b, m, s, kn, gn):
    K = build_kernel(N, R, b, kn)
    KF = np.fft.rfft2(np.fft.ifftshift(K))
    g = FIELD_FUNC[gn - 1]
    dt = 1.0 / T

    def step(world):
        U = np.fft.irfft2(KF * np.fft.rfft2(world), s=(N, N))
        world += dt * g(U, m, s)
        np.clip(world, 0, 1, out=world)

    return step


def main():
    zoo = load_ts()

    # --- Орбий в центре, его физика ---
    orb = zoo['Orbium unicaudatus']
    cells = np.array(orb['cells']).reshape(orb['h'], orb['w'])
    step = make_stepper(orb['R'], orb['T'], orb['b'], orb['m'], orb['s'], orb['kn'], orb['gn'])
    w = np.zeros((N, N))
    place_engine(w, cells, 128, 128)
    checkpoints = {}
    for t in range(1, 101):
        step(w)
        if t in (1, 2, 5, 10, 20, 50, 100):
            checkpoints[t] = round(float(w.sum()), 2)
    print('ORBIUM_CHECKPOINTS =', json.dumps(checkpoints))

    # --- Hydrogeminium limus в центре, его физика ---
    lim = zoo['Hydrogeminium limus']
    if lim is None:
        raise SystemExit('limus not in creatures.ts — надо добавить')
    cells = np.array(lim['cells']).reshape(lim['h'], lim['w'])
    step = make_stepper(lim['R'], lim['T'], lim['b'], lim['m'], lim['s'], lim['kn'], lim['gn'])
    w = np.zeros((N, N))
    place_engine(w, cells, 128, 128)
    checkpoints = {}
    from check_division import PeriodicCounter
    counter = PeriodicCounter(N)
    pops = {}
    for t in range(1, 2001):
        step(w)
        if t in (1, 2, 5, 10, 20, 50, 100, 200):
            checkpoints[t] = round(float(w.sum()), 2)
        if t in (500, 1000, 1500, 2000):
            pops[t] = counter.count(w)[0]
    print('LIMUS_CHECKPOINTS =', json.dumps(checkpoints))
    print('LIMUS_POPULATIONS =', json.dumps(pops))

    # --- Тест перехода через край: орбий у правого края, физика орбия ---
    orb = zoo['Orbium unicaudatus']
    cells = np.array(orb['cells']).reshape(orb['h'], orb['w'])
    step = make_stepper(orb['R'], orb['T'], orb['b'], orb['m'], orb['s'], orb['kn'], orb['gn'])
    w = np.zeros((N, N))
    place_engine(w, cells, 244, 128)  # у правой границы
    pops = []
    for t in range(1, 721):
        step(w)
        if t % 60 == 0:
            pops.append(counter.count(w)[0])
    print('WRAP_POPULATIONS (шаг 60..720, должно быть всё 1) =', pops)


if __name__ == '__main__':
    main()
