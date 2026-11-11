"""Гипотеза: ЗЕРКАЛЬНЫЙ гриб (вертикальный флип при заливке в текстуру)
не делится на торе 96×96, хотя прямой — делится. Проверяем."""
import numpy as np

from verify_pond import N, ZOO, blobs, place, simulate

c = ZOO["Hydrogeminium limus"]
cells = np.array(c["cells"], dtype=float).reshape(c["h"], c["w"]) / 255.0

print("прямой гриб (как в NumPy-эталоне):")
_, hist, _ = simulate(c, place(c), 2000, check_every=200)
for t, mass, pop in hist:
    print(f"  t={t:4d} mass={mass:7.1f} pop={pop}")

# зеркальный: паттерн перевернут по вертикали (как при заливке в WebGL-текстуру)
cm = c.copy()
cm["cells"] = np.flipud(cells).flatten().tolist()
print("зеркальный гриб (флип строк, как в WebGL place):")
_, hist, _ = simulate(cm, place(cm), 2000, check_every=200)
for t, mass, pop in hist:
    print(f"  t={t:4d} mass={mass:7.1f} pop={pop}")

# и шумовой тест: прямой гриб + крошечный шум (половина ulp float16)
print("прямой гриб + шум 0.0005:")
A = place(c)
A = np.clip(A + (np.random.rand(N, N) - 0.5) * 0.001, 0, 1)
_, hist, _ = simulate(c, A, 2000, check_every=200)
for t, mass, pop in hist:
    print(f"  t={t:4d} mass={mass:7.1f} pop={pop}")
