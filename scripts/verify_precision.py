"""ПЕРЕДЕЛАНО (прошлый тест дважды делил на 255 — выводы были неверны).
Тестируем по-честному: зеркало, повороты, шум уровня float16."""
import numpy as np

from verify_pond import N, ZOO, place, simulate

c = ZOO["Hydrogeminium limus"]
cells = np.array(c["cells"], dtype=float).reshape(c["h"], c["w"])  # 0..255


def mk(pat):
    cm = dict(c)
    cm["cells"] = pat.round().astype(int).flatten().tolist()
    cm["w"], cm["h"] = pat.shape[1], pat.shape[0]
    return cm


def run(tag, pat, noise=0.0, steps=2600):
    cm = mk(pat)
    A = place(cm)
    if noise:
        A = np.clip(A / 255.0 + (np.random.rand(N, N) - 0.5) * 2 * noise, 0, 1) * 255.0
    _, hist, _ = simulate(cm, A, steps, check_every=400)
    pops = " ".join(f"{p}" for _, _, p in hist)
    print(f"{tag:30s} pop(400..): {pops}  mass={hist[-1][1]:6.0f}")


print("=== эталон (прямой, rot 0) ===")
run("прямой", cells)

print("=== зеркало (флип строк — как в WebGL place) ===")
run("зеркальный", np.flipud(cells))

print("=== повороты ===")
p = cells.copy()
for r in range(4):
    run(f"rot {r}", p)
    p = np.rot90(p)

print("=== шум ±0.00012 (погрешность float16) ===")
for i in range(3):
    run(f"шум f16 #{i}", cells, noise=0.00012)

print("=== зеркало + шум f16 ===")
for i in range(2):
    run(f"зерк+шум #{i}", np.flipud(cells), noise=0.00012)
