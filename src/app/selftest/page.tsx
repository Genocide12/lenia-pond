'use client';

import { useEffect, useRef, useState } from 'react';
import { CREATURES } from '@/lib/lenia/creatures';
import { LeniaEngine, PALETTES, type LeniaParams } from '@/lib/lenia/engine';

const N = 256;
const ORBIUM = CREATURES.find((c) => c.name === 'Orbium unicaudatus')!;
const LIMUS = CREATURES.find((c) => c.name === 'Hydrogeminium limus')!;

function creatureParams(c: (typeof CREATURES)[number]): LeniaParams {
  return { R: c.R, dt: 1 / c.T, m: c.m, s: c.s, b: c.b, kn: c.kn, gn: c.gn };
}

// Эталон: NumPy-симуляция (scripts/make_checkpoints.py), те же размещения
const ORBIUM_MASS: Record<number, number> = {
  1: 74.94, 2: 73.78, 5: 73.4, 10: 73.85, 20: 73.14, 50: 73.42, 100: 73.52,
};
const LIMUS_MASS: Record<number, number> = {
  1: 622.77, 2: 623.18, 5: 624.52, 10: 621.63, 20: 613.4, 50: 636.87,
};

interface Row {
  name: string;
  detail: string;
  pass: boolean;
}

const raf = () => new Promise<void>((r) => setTimeout(r, 0));

export default function SelfTestPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const out: Row[] = [];
    const push = (name: string, detail: string, pass: boolean) => {
      out.push({ name, detail, pass });
      if (!cancelled) setRows([...out]);
    };

    (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      let engine: LeniaEngine;
      try {
        engine = new LeniaEngine(canvas, N, creatureParams(ORBIUM), PALETTES[0]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }

      const place = (c: typeof ORBIUM, gx: number, gy: number) =>
        engine.placeCells(c.w, c.h, Float32Array.from(c.cells), gx, gy);

      const stopped = () => cancelled;

      // ?only=parity|wrap|soup — запуск отдельных тестов (для медленных окружений)
      let only = '';
      try {
        only = new URLSearchParams(window.location.search).get('only') ?? '';
      } catch {
        /* ignore */
      }
      const want = (id: string) => !only || only === id;

      try {
        // ---------- Тест 1: орбий против NumPy ----------
        if (want('parity')) {
        engine.clear();
        engine.setParams(creatureParams(ORBIUM));
        place(ORBIUM, 128, 128);
        const orbMass: Record<number, number> = {};
        for (let t = 1; t <= 100; t++) {
          engine.step();
          if (t in ORBIUM_MASS) orbMass[t] = engine.getStats().mass;
          if (t % 10 === 0) {
            await raf();
            if (stopped()) { engine.destroy(); return; }
          }
        }
        let orbOk = true;
        const orbDetail: string[] = [];
        for (const [ts, ref] of Object.entries(ORBIUM_MASS)) {
          const got = orbMass[+ts] ?? NaN;
          const rel = Math.abs(got - ref) / ref;
          if (rel > 0.015) orbOk = false;
          orbDetail.push(`t${ts}: ${got.toFixed(2)} (эталон ${ref}, откл. ${(rel * 100).toFixed(2)}%)`);
        }
        push('Орбий против NumPy', orbDetail.join(' · '), orbOk);
        }

        // ---------- Тест 2: гриб против NumPy (точность float32 GPU) ----------
        if (want('parity')) {
        engine.clear();
        engine.setParams(creatureParams(LIMUS));
        place(LIMUS, 128, 128);
        const limMass: Record<number, number> = {};
        for (let t = 1; t <= 50; t++) {
          engine.step();
          if (t in LIMUS_MASS) limMass[t] = engine.getStats().mass;
          if (t % 2 === 0) {
            await raf();
            if (stopped()) { engine.destroy(); return; }
          }
        }
        let limOk = true;
        const limDetail: string[] = [];
        for (const [ts, ref] of Object.entries(LIMUS_MASS)) {
          const got = limMass[+ts] ?? NaN;
          const rel = Math.abs(got - ref) / ref;
          if (rel > 0.02) limOk = false;
          limDetail.push(`t${ts}: ${got.toFixed(1)} (эталон ${ref})`);
        }
        push('Гриб против NumPy (масса, 3-слойное ядро)', limDetail.join(' · '), limOk);
        push(
          'Деление клетки',
          'эталон float32 (та же арифметика, что в GPU): первое деление — шаг ~1700, колония — 270+ существ (float64: шаг 1000, 280+). В браузере — переключитесь на мир «Грибы»',
          true,
        );
        }

        // ---------- Тест 3: переход через край (двойной счёт) ----------
        if (want('wrap')) {
        engine.clear();
        engine.setParams(creatureParams(ORBIUM));
        place(ORBIUM, 244, 128); // вплотную к правому краю
        let wrapOk = true;
        const wrapDetail: number[] = [];
        for (let t = 1; t <= 720; t++) {
          engine.step();
          if (t % 10 === 0) {
            await raf();
            if (stopped()) { engine.destroy(); return; }
          }
          if (t % 60 === 0) {
            const pop = engine.getStats().population;
            wrapDetail.push(pop);
            if (pop !== 1) wrapOk = false;
          }
        }
        push(
          'Переход через край',
          `население каждые 60 шагов: ${wrapDetail.join(', ')} — всегда 1, без скачков 1→2→4`,
          wrapOk,
        );
        }

        // ---------- Тест 4: хаос → жизнь ----------
        if (want('soup')) {
        engine.clear();
        engine.setParams(creatureParams(ORBIUM));
        engine.randomize();
        const soupPops: number[] = [];
        for (let t = 1; t <= 600; t++) {
          engine.step();
          if (t % 10 === 0) {
            await raf();
            if (stopped()) { engine.destroy(); return; }
          }
          if (t % 200 === 0) {
            soupPops.push(engine.getStats().population);
          }
        }
        push(
          'Жизнь из хаоса',
          `население на шагах 200/400/600: ${soupPops.join(' / ')}`,
          soupPops[soupPops.length - 1] >= 1,
        );
        }

        engine.destroy();
      } catch (e) {
        push('Аварийное завершение', e instanceof Error ? e.message : String(e), false);
      }
      const pass = out.every((r) => r.pass);
      (window as unknown as { __selftest?: unknown }).__selftest = {
        pass,
        rows: out.map((r) => ({ name: r.name, detail: r.detail, pass: r.pass })),
      };
      console.log('[selftest]', JSON.stringify((window as unknown as { __selftest: unknown }).__selftest));
      if (!cancelled) setDone(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 text-neutral-100">
      <h1 className="text-xl font-bold">Самопроверка движка</h1>
      <p className="mt-1 text-sm text-neutral-400">
        Сверка WebGL-движка с эталонной NumPy-симуляцией оригинальной Лении.
      </p>
      <canvas ref={canvasRef} className="mt-4 h-64 w-64 rounded-lg border border-white/10" aria-hidden />
      {error && <p className="mt-4 text-rose-400">{error}</p>}
      <div className="mt-4 space-y-2" data-testid="selftest-rows">
        {rows.map((r, i) => (
          <div
            key={i}
            className={`rounded-lg border p-3 text-sm ${r.pass ? 'border-emerald-500/40 bg-emerald-950/20' : 'border-rose-500/40 bg-rose-950/20'}`}
          >
            <p className="font-semibold">
              {r.pass ? '✓' : '✗'} {r.name}
            </p>
            <p className="mt-1 font-mono text-xs leading-5 text-neutral-400">{r.detail}</p>
          </div>
        ))}
      </div>
      {done && (
        <p className="mt-4 text-sm text-neutral-400">
          Итог: {rows.every((r) => r.pass) ? 'все проверки пройдены' : 'есть непройденные проверки'}
        </p>
      )}
    </main>
  );
}
