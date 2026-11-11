"""Свип климата: как сдвиги (dm, ds) влияют на выживание видов в блюдце 96×96.

Цель — подобрать карту «климат k∈[0,1] → (dm, ds)», чтобы:
  k≈0.5 — комфортно (вид живёт неограниченно),
  края  — гибель за сотни шагов («смерть от условий»).
"""
import json

import numpy as np

from verify_pond import N, ZOO, blobs, place, simulate

DMS = np.round(np.arange(-0.04, 0.0401, 0.005), 4)
DSS = np.round(np.arange(0.7, 1.301, 0.05), 3)
STEPS = 800

for name in ["Orbium unicaudatus", "Hydrogeminium limus", "Bug (smaller)"]:
    c = ZOO[name]
    print(f"\n=== {name}  (m={c['m']}, s={c['s']}) — жив/мёртв после {STEPS} шагов ===")
    print("dm\\ds  " + " ".join(f"{ds:5.2f}" for ds in DSS))
    for dm in DMS:
        row = []
        for ds in DSS:
            A, hist, _ = simulate(c, place(c), STEPS, dm=float(dm), ds=float(ds), check_every=STEPS)
            mass, pop = hist[-1][1], hist[-1][2]
            row.append(f"{mass:5.0f}" if (pop >= 1 and mass > 30) else "    .")
        print(f"{dm:+.3f}  " + " ".join(row))
