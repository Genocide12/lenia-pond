"""Гриб в половинном масштабе (паттерн/2, R=9) в блюдце 96×96:
простора больше — деление должно стать надёжным. Проверяем с шумом и без."""
import numpy as np

from verify_pond import N, ZOO, blobs, place, simulate

c = ZOO["Hydrogeminium limus"]
cells = np.array(c["cells"], dtype=float).reshape(c["h"], c["w"]) / 255.0
h2, w2 = c["h"] // 2, c["w"] // 2
small = cells.reshape(h2, 2, w2, 2).mean(axis=(1, 3))  # 25×20

cm = dict(c)
cm["cells"] = small.flatten().tolist()
cm["w"], cm["h"] = w2, h2
cm["R"] = 9

print(f"малый гриб: {w2}x{h2}, R=9, занимет {w2+18}x{h2+18} из 96")
print("без шума:")
_, hist, _ = simulate(cm, place(cm), 3000, check_every=300)
for t, mass, pop in hist:
    print(f"  t={t:4d} mass={mass:7.1f} pop={pop}")

print("с шумом 0.002 (грубее float16):")
A = np.clip(place(cm) + (np.random.rand(N, N) - 0.5) * 0.004, 0, 1)
_, hist, _ = simulate(cm, A, 3000, check_every=300)
for t, mass, pop in hist:
    print(f"  t={t:4d} mass={mass:7.1f} pop={pop}")

print("ещё один шум (другой seed):")
A = np.clip(place(cm) + (np.random.rand(N, N) - 0.5) * 0.004, 0, 1)
_, hist, _ = simulate(cm, A, 3000, check_every=300)
for t, mass, pop in hist:
    print(f"  t={t:4d} mass={mass:7.1f} pop={pop}")
