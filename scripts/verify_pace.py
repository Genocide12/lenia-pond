"""Темп гибели и темп деления в блюдце 96×96 — для настройки климата."""
from verify_pond import N, ZOO, place, simulate

print("=== Головастик: гибель в жарком климате (dm=+0.025, ds=1.0) — темп ===")
c = ZOO["Orbium unicaudatus"]
_, hist, _ = simulate(c, place(c), 900, dm=0.025, ds=1.0, check_every=100)
for t, mass, pop in hist:
    print(f"  t={t:4d} mass={mass:6.1f} pop={pop}")

print("=== Головастик: нейтральный климат — контроль (не погибает) ===")
_, hist, _ = simulate(c, place(c), 900, dm=0.0, ds=1.0, check_every=300)
for t, mass, pop in hist:
    print(f"  t={t:4d} mass={mass:6.1f} pop={pop}")

print("=== Гриб: деление в нейтральном климате — население по шагам ===")
c = ZOO["Hydrogeminium limus"]
_, hist, _ = simulate(c, place(c), 4000, check_every=400)
for t, mass, pop in hist:
    print(f"  t={t:4d} mass={mass:7.1f} pop={pop}")

print("=== Жук (T=1, быстрый): нейтральный климат ===")
c = ZOO["Bug (smaller)"]
_, hist, _ = simulate(c, place(c), 600, check_every=100)
for t, mass, pop in hist:
    print(f"  t={t:4d} mass={mass:7.1f} pop={pop}")
