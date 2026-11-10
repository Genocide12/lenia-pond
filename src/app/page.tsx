'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, Fish, Sprout, HelpCircle } from 'lucide-react';
import { CREATURES, type Creature } from '@/lib/lenia/creatures';
import { LeniaEngine, PALETTES, type LeniaParams, type Palette } from '@/lib/lenia/engine';
import { BlobTracker, type EventKind } from '@/lib/lenia/tracker';

const N = 256;
const ORBIUM = CREATURES.find((c) => c.name === 'Orbium unicaudatus')!;
const LIMUS = CREATURES.find((c) => c.name === 'Hydrogeminium limus')!;

function creatureParams(c: Creature): LeniaParams {
  return { R: c.R, dt: 1 / c.T, m: c.m, s: c.s, b: c.b, kn: c.kn, gn: c.gn };
}

/** Поворот паттерна на 90°×k (Ления эквивариантна поворотам — существо остаётся живым). */
function rotateCells(cells: number[], w: number, h: number, quarterTurns: number) {
  let cur = cells.slice();
  let cw = w;
  let ch = h;
  for (let t = 0; t < ((quarterTurns % 4) + 4) % 4; t++) {
    const next = new Array<number>(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        next[x * ch + (ch - 1 - y)] = cur[y * cw + x];
      }
    }
    cur = next;
    const tmp = cw;
    cw = ch;
    ch = tmp;
  }
  return { cells: cur, w: cw, h: ch };
}

/* ---------- Миры ---------- */

interface WorldDef {
  id: 'pond' | 'colony';
  label: string;
  creature: Creature;
  params: LeniaParams;
  palette: Palette;
  speed: number; // индекс в SPEEDS
  trails: boolean;
  icon: typeof Fish;
}

const SPEEDS = [1, 2, 4, 8]; // шагов за кадр (×60 в секунду)

const WORLDS: WorldDef[] = [
  {
    id: 'pond',
    label: 'Головастики',
    creature: ORBIUM,
    params: creatureParams(ORBIUM),
    palette: PALETTES[0], // биолюминесценция
    speed: 1,
    trails: true,
    icon: Fish,
  },
  {
    id: 'colony',
    label: 'Грибы',
    creature: LIMUS,
    params: creatureParams(LIMUS),
    palette: PALETTES[3], // солнечная
    speed: 2,
    trails: false,
    icon: Sprout,
  },
];

/* ---------- Оверлей: следы и вспышки событий ---------- */

const TRAIL_COLORS = ['#34d399', '#fbbf24', '#f472b6', '#2dd4bf', '#a3e635', '#fb923c'];
const GLOW_COLORS: Record<EventKind, string> = {
  birth: '#34d399',
  split: '#a3e635',
  merge: '#fbbf24',
  death: '#fb7185',
};
const GLOW_MS = 1500;

interface Glow {
  kind: EventKind;
  x: number;
  y: number;
  born: number;
}

interface DiaryEntry {
  id: number;
  kind: EventKind | 'info';
  t: number;
  text: string;
}

export interface HudSnap {
  t: number;
  pop: number;
  fps: number;
  entries: DiaryEntry[];
  popDelta: number;
}

const plural = (n: number) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'существо';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'существа';
  return 'существ';
};

/* ============ Страница ============ */

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<LeniaEngine | null>(null);
  const trackerRef = useRef(new BlobTracker(N));
  const rafRef = useRef(0);
  const runningRef = useRef(true);
  const speedRef = useRef(2);
  const worldRef = useRef<WorldDef>(WORLDS[0]);
  const simTimeRef = useRef(0);
  const stepAccRef = useRef(0);
  const fpsRef = useRef(0);
  const lastFrameRef = useRef(0);
  const lastScanRef = useRef(0);
  const glowsRef = useRef<Glow[]>([]);
  const diaryRef = useRef<DiaryEntry[]>([]);
  const entryIdRef = useRef(1);
  const deadRef = useRef(0);
  const paintingGuardRef = useRef(0);
  const hudCbRef = useRef<(s: HudSnap) => void>(() => {});
  const lastPopRef = useRef<number | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const [speedIdx, setSpeedIdx] = useState(2);
  const [worldId, setWorldId] = useState<'pond' | 'colony'>('pond');
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    speedRef.current = SPEEDS[speedIdx];
    stepAccRef.current = 0;
  }, [speedIdx]);

  const pushDiary = useCallback((kind: EventKind | 'info', t: number, text: string) => {
    diaryRef.current = [{ id: entryIdRef.current++, kind, t, text }, ...diaryRef.current].slice(0, 6);
  }, []);

  /** Заселить мир. */
  const seedWorld = useCallback((w: WorldDef, eng: LeniaEngine) => {
    eng.clear();
    eng.setParams(w.params);
    eng.setPalette(w.palette);
    if (w.id === 'pond') {
      eng.randomize();
    } else {
      const c = w.creature;
      eng.placeCells(c.w, c.h, Float32Array.from(c.cells), N / 2, N / 2);
    }
    simTimeRef.current = 0;
    stepAccRef.current = 0;
    deadRef.current = 0;
    lastPopRef.current = null;
    trackerRef.current.reset();
    glowsRef.current = [];
    diaryRef.current = [];
    pushDiary('info', 0, w.id === 'pond' ? 'хаос — понаблюдайте, как из него соберётся жизнь' : 'одна клетка — сейчас начнёт делиться');
  }, [pushDiary]);

  // Переключение мира (кнопкой)
  const switchWorld = useCallback((id: 'pond' | 'colony') => {
    const w = WORLDS.find((x) => x.id === id)!;
    worldRef.current = w;
    setWorldId(id);
    setSpeedIdx(w.speed);
    speedRef.current = SPEEDS[w.speed];
    const eng = engineRef.current;
    if (eng) seedWorld(w, eng);
    setRunning(true);
    runningRef.current = true;
  }, [seedWorld]);

  const restart = useCallback(() => {
    const eng = engineRef.current;
    if (eng) seedWorld(worldRef.current, eng);
  }, []);

  /* ---------- Игровой цикл ---------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let engine: LeniaEngine;
    try {
      engine = new LeniaEngine(canvas, N, WORLDS[0].params, WORLDS[0].palette);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      queueMicrotask(() => setError(msg));
      return;
    }
    engineRef.current = engine;
    const octx = overlayRef.current?.getContext('2d') ?? null;

    // URL-параметры для тестов и глубоких ссылок: ?world=colony&speed=1&pause
    try {
      const q = new URLSearchParams(window.location.search);
      const w = q.get('world');
      if (w === 'colony' || w === 'pond') {
        const def = WORLDS.find((x) => x.id === w)!;
        worldRef.current = def;
        queueMicrotask(() => {
          setWorldId(w);
          setSpeedIdx(def.speed);
        });
        speedRef.current = SPEEDS[def.speed];
        seedWorld(def, engine);
        if (q.has('pause')) {
          runningRef.current = false;
          queueMicrotask(() => setRunning(false));
        }
      } else {
        seedWorld(WORLDS[0], engine);
      }
      const sp = q.get('speed');
      if (sp) {
        const idx = SPEEDS.indexOf(parseInt(sp, 10));
        if (idx >= 0) {
          speedRef.current = SPEEDS[idx];
          queueMicrotask(() => setSpeedIdx(idx));
        }
      }
    } catch {
      seedWorld(WORLDS[0], engine);
    }

    // Хук для авто-тестов (agent-browser)
    (window as unknown as { __lenia?: object }).__lenia = {
      stepN: (n: number) => {
        let done = 0;
        while (done < n) {
          const chunk = Math.min(30, n - done);
          for (let i = 0; i < chunk; i++) engine.step();
          done += chunk;
          simTimeRef.current += chunk * worldRef.current.params.dt;
          scan(performance.now(), chunk);
        }
      },
      stats: () => engine.getStats(),
      headings: () => trackerRef.current.headings(),
      world: () => worldRef.current.id,
      switchWorld,
    };

    const doGlows = (events: { kind: EventKind; x: number; y: number }[], now: number) => {
      for (const ev of events.slice(0, 3)) glowsRef.current.push({ kind: ev.kind, x: ev.x, y: ev.y, born: now });
    };

    /** Кадр наблюдения: счёт жителей, трекер, дневник, авто-возрождение. */
    const scan = (now: number, stepsSince: number) => {
      const st = engine.getStats();
      const events = trackerRef.current.update(st.blobs, simTimeRef.current, stepsSince);
      if (events.length > 0 && now - paintingGuardRef.current > 800) {
        const byKind = new Map<EventKind, number>();
        for (const ev of events) byKind.set(ev.kind, (byKind.get(ev.kind) ?? 0) + 1);
        const words: Record<EventKind, string> = {
          birth: 'родилось',
          split: 'деление!',
          death: 'погибло',
          merge: 'слияние',
        };
        for (const [kind, count] of byKind) {
          if (kind === 'merge') continue; // слияния слишком часты — видны вспышками
          pushDiary(kind, simTimeRef.current, count > 1 ? `${words[kind]} ${count}` : words[kind]);
        }
        doGlows(events, now);
      }

      const delta = lastPopRef.current === null ? 0 : st.population - lastPopRef.current;
      lastPopRef.current = st.population;
      hudCbRef.current({
        t: simTimeRef.current,
        pop: st.population,
        fps: fpsRef.current,
        entries: [...diaryRef.current],
        popDelta: delta,
      });

      // авто-возрождение мёртвого мира (тихая страховка)
      if (st.population === 0 && st.mass < 100) {
        deadRef.current++;
        if (deadRef.current >= 16) seedWorld(worldRef.current, engine);
      } else {
        deadRef.current = 0;
      }
    };

    const drawOverlay = (now: number) => {
      const cv = overlayRef.current;
      if (!cv || !octx) return;
      const S = 768;
      if (cv.width !== S || cv.height !== S) {
        cv.width = S;
        cv.height = S;
      }
      octx.clearRect(0, 0, S, S);

      const tracks = trackerRef.current.getTracks();
      // следы — только когда жителей немного (иначе каша)
      if (worldRef.current.trails && tracks.length <= 70) {
        for (const tr of tracks) {
          if (tr.trail.length < 3) continue;
          const color = TRAIL_COLORS[tr.id % TRAIL_COLORS.length];
          const pts = tr.trail;
          const chunks = 6;
          const per = Math.max(1, Math.floor((pts.length - 1) / chunks));
          octx.strokeStyle = color;
          octx.lineCap = 'round';
          for (let c = 0; c < chunks; c++) {
            const i0 = c * per;
            const i1 = Math.min(pts.length - 1, (c + 1) * per);
            if (i1 <= i0) continue;
            const a = (c + 1) / chunks;
            octx.globalAlpha = 0.06 + 0.34 * a * a;
            octx.lineWidth = 1 + 1.6 * a;
            octx.beginPath();
            let started = false;
            for (let i = i0; i <= i1; i++) {
              const px = ((pts[i].x + 0.5) * S) / N;
              const py = ((N - pts[i].y - 0.5) * S) / N;
              if (!started) {
                octx.moveTo(px, py);
                started = true;
              } else {
                const ddx = Math.abs(pts[i].x - pts[i - 1].x);
                const ddy = Math.abs(pts[i].y - pts[i - 1].y);
                if (ddx > N / 2 || ddy > N / 2) octx.moveTo(px, py);
                else octx.lineTo(px, py);
              }
            }
            octx.stroke();
          }
          const h = pts[pts.length - 1];
          octx.globalAlpha = 0.85;
          octx.fillStyle = color;
          octx.beginPath();
          octx.arc(((h.x + 0.5) * S) / N, ((N - h.y - 0.5) * S) / N, 2.2, 0, Math.PI * 2);
          octx.fill();
        }
        octx.globalAlpha = 1;
      }

      glowsRef.current = glowsRef.current.filter((g) => now - g.born < 2 * GLOW_MS && Math.abs(now - g.born) < 60000);
      for (const g of glowsRef.current) {
        const age = Math.min(1, Math.max(0, (now - g.born) / GLOW_MS));
        const r = (3 + age * 26) * 3;
        octx.globalAlpha = (1 - age) * 0.85;
        octx.strokeStyle = GLOW_COLORS[g.kind];
        octx.lineWidth = 2.5 * (1 - age) + 0.5;
        octx.beginPath();
        octx.arc(((g.x + 0.5) * S) / N, ((N - g.y - 0.5) * S) / N, r, 0, Math.PI * 2);
        octx.stroke();
      }
      octx.globalAlpha = 1;
    };

    const loop = (now: number) => {
      try {
        let dtms = 16.7;
        if (lastFrameRef.current) {
          dtms = now - lastFrameRef.current;
          if (dtms > 0 && dtms < 2000) {
            fpsRef.current = fpsRef.current === 0 ? 1000 / dtms : fpsRef.current * 0.9 + (1000 / dtms) * 0.1;
          }
        }
        lastFrameRef.current = now;

        const spd = speedRef.current;
        if (runningRef.current && dtms > 0) {
          // шаги набираются по времени: скорость не зависит от FPS и сама
          // снижается на слабых машинах (нет «лагов», есть плавное замедление)
          stepAccRef.current = Math.min(stepAccRef.current + (spd * dtms) / 16.7, spd * 2.5);
          let todo = Math.floor(stepAccRef.current);
          if (todo > 0) {
            if (todo > 20) todo = 20;
            for (let i = 0; i < todo; i++) engine.step();
            stepAccRef.current -= todo;
            simTimeRef.current += todo * worldRef.current.params.dt;
          }
        }
        engine.render();
        drawOverlay(now);

        if (now - lastScanRef.current >= 250) {
          const stepsSince = Math.max(1, Math.round(speedRef.current * ((now - lastScanRef.current) / 16.7)));
          lastScanRef.current = now;
          scan(now, stepsSince);
        }
      } catch (err) {
        runningRef.current = false;
        const msg = err instanceof Error ? err.message : String(err);
        queueMicrotask(() => {
          setError(msg);
          setRunning(false);
        });
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };

    // пауза, когда вкладка скрыта — не тратим батарею
    let wasRunningOnHide = true;
    const onVis = () => {
      if (document.hidden) {
        wasRunningOnHide = runningRef.current;
        runningRef.current = false;
      } else {
        runningRef.current = wasRunningOnHide;
        lastFrameRef.current = 0;
      }
    };
    document.addEventListener('visibilitychange', onVis);

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafRef.current);
      document.removeEventListener('visibilitychange', onVis);
      engine.destroy();
      engineRef.current = null;
    };
  }, [seedWorld, switchWorld, pushDiary]);

  /* ---------- Клавиатура ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setRunning((r) => !r);
      } else if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') {
        restart();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [restart]);

  /* ---------- Клик по пруду: поселить существо ---------- */
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const eng = engineRef.current;
    if (!eng) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const gx = ((e.clientX - rect.left) / rect.width) * N;
    const gy = (1 - (e.clientY - rect.top) / rect.height) * N;
    const w = worldRef.current;
    const c = w.creature;
    const rc = rotateCells(c.cells, c.w, c.h, Math.floor(Math.random() * 4));
    eng.placeCells(rc.w, rc.h, Float32Array.from(rc.cells), gx, gy);
    paintingGuardRef.current = performance.now();
    pushDiary('info', simTimeRef.current, `посажен ${w.id === 'pond' ? 'головастик' : 'гриб'}`);
  };

  return (
    <div
      className="flex min-h-screen flex-col text-neutral-100"
      style={{ background: 'radial-gradient(1200px 800px at 50% -10%, #0a1f18 0%, #05090b 55%, #040708 100%)' }}
    >
      {/* Шапка */}
      <header className="flex items-center justify-center gap-3 px-4 pt-5 pb-3 sm:justify-between sm:px-8">
        <h1 className="bg-gradient-to-r from-emerald-300 via-teal-200 to-amber-200 bg-clip-text text-2xl font-extrabold tracking-tight text-transparent sm:text-3xl">
          Пруд Лении
        </h1>
        <div className="relative">
          <button
            onClick={() => setHelpOpen((v) => !v)}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-emerald-300/90 transition-colors hover:bg-emerald-950/40"
            aria-label="Что это такое"
          >
            <HelpCircle className="h-4.5 w-4.5" />
          </button>
          {helpOpen && (
            <div className="absolute right-0 top-11 z-20 w-72 rounded-xl border border-white/10 bg-[#0b1512] p-4 text-sm leading-relaxed text-neutral-300 shadow-xl">
              <p>
                Это <b className="text-emerald-300">Ления</b> — непрерывная «игра в жизнь»: каждый житель —
                самоподдерживающаяся волна чисел.
              </p>
              <p className="mt-2">
                У пруда нет краёв: уплыв за край, существо появляется с противоположной стороны.
              </p>
              <p className="mt-2">
                Грибы делятся и заполняют пруд колонией. Кликните по воде, чтобы поселить жителя.
              </p>
              <p className="mt-2 text-xs text-neutral-500">
                Реконструкция Bert Wang-Chak Chan · github.com/Chakazul/Lenia
              </p>
            </div>
          )}
        </div>
      </header>

      {/* Сцена */}
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center px-3 pb-6">
        {error ? (
          <div className="mt-10 max-w-md rounded-xl border border-rose-500/40 bg-rose-950/20 p-5 text-center">
            <p className="font-medium text-rose-300">Симуляция остановлена</p>
            <p className="mt-1 text-sm text-neutral-400">{error}</p>
          </div>
        ) : (
          <>
            {/* Миры */}
            <div className="grid w-full max-w-md grid-cols-2 gap-2" role="tablist" aria-label="Мир">
              {WORLDS.map((w) => {
                const Icon = w.icon;
                const active = worldId === w.id;
                return (
                  <button
                    key={w.id}
                    role="tab"
                    aria-selected={active}
                    data-world={w.id}
                    onClick={() => switchWorld(w.id)}
                    className={`flex items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors ${
                      active
                        ? 'border-emerald-500/60 bg-emerald-950/50 text-emerald-100 shadow-[0_0_24px_rgba(16,185,129,0.12)]'
                        : 'border-white/10 bg-white/[0.02] text-neutral-300 hover:border-emerald-900/60 hover:bg-emerald-950/20'
                    }`}
                  >
                    <Icon className={`h-4.5 w-4.5 ${active ? 'text-emerald-300' : 'text-emerald-500/60'}`} aria-hidden />
                    {w.label}
                  </button>
                );
              })}
            </div>

            {/* Пруд */}
            <div className="relative mt-3 w-full">
              <div className="relative overflow-hidden rounded-2xl border border-white/10 shadow-[0_0_60px_rgba(0,0,0,0.5)]">
                <canvas
                  ref={canvasRef}
                  className="aspect-square w-full touch-none select-none cursor-crosshair"
                  onPointerDown={onPointerDown}
                  aria-label="Пруд Лении"
                />
                <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />
                <Hud callbackRef={hudCbRef} paused={!running} />
              </div>
            </div>

            {/* Управление */}
            <div className="mt-3 flex w-full flex-wrap items-center justify-center gap-2 sm:gap-3">
              <button
                onClick={() => setRunning((r) => !r)}
                data-testid="playpause"
                className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-950/40 px-5 py-2.5 text-sm font-semibold text-emerald-200 transition-colors hover:bg-emerald-900/40"
              >
                {running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                {running ? 'Пауза' : 'Пуск'}
              </button>

              <div className="flex overflow-hidden rounded-xl border border-white/10" data-testid="speed" role="group" aria-label="Скорость">
                {SPEEDS.map((s, i) => (
                  <button
                    key={s}
                    onClick={() => setSpeedIdx(i)}
                    aria-pressed={speedIdx === i}
                    className={`px-3.5 py-2.5 font-mono text-sm transition-colors ${
                      speedIdx === i
                        ? 'bg-emerald-500/20 text-emerald-200'
                        : 'bg-white/[0.02] text-neutral-400 hover:bg-white/[0.05]'
                    }`}
                  >
                    ×{s}
                  </button>
                ))}
              </div>

              <button
                onClick={restart}
                data-testid="restart"
                className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-5 py-2.5 text-sm font-semibold text-neutral-300 transition-colors hover:bg-white/[0.06]"
              >
                <RotateCcw className="h-4 w-4" />
                Заново
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/* ---------- HUD: счётчик, время, дневник (обновляется напрямую, без ре-рендера страницы) ---------- */

function Hud({
  callbackRef,
  paused,
}: {
  callbackRef: { current: (s: HudSnap) => void };
  paused: boolean;
}) {
  const [snap, setSnap] = useState<HudSnap>({ t: 0, pop: 0, fps: 0, entries: [], popDelta: 0 });

  useEffect(() => {
    callbackRef.current = setSnap;
    return () => {
      callbackRef.current = () => {};
    };
  }, [callbackRef]);

  return (
    <>
      <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-2">
        <div className="rounded-xl border border-emerald-500/30 bg-black/60 px-3.5 py-2 backdrop-blur">
          <p className="text-[10px] uppercase tracking-wider text-emerald-500/80">{plural(Math.abs(snap.pop))}</p>
          <p
            data-testid="pop-count"
            className={`text-2xl font-extrabold leading-none tabular-nums transition-colors ${
              snap.popDelta > 0 ? 'text-emerald-300' : snap.popDelta < 0 ? 'text-rose-300' : 'text-neutral-100'
            }`}
          >
            {snap.pop}
          </p>
        </div>
        {paused && (
          <div className="rounded-full border border-amber-500/40 bg-black/70 px-3 py-1 text-xs font-semibold text-amber-300 backdrop-blur">
            пауза · пробел
          </div>
        )}
      </div>

      <div
        className="pointer-events-none absolute right-3 top-3 rounded-lg border border-white/10 bg-black/60 px-3 py-1.5 font-mono text-[11px] tabular-nums text-emerald-200/70 backdrop-blur"
        data-testid="stats"
      >
        t = {snap.t.toFixed(0)}
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 max-w-[85%]" data-testid="diary">
        {snap.entries.slice(0, 5).map((e) => (
          <p
            key={e.id}
            className={`truncate font-mono text-[11px] leading-5 backdrop-blur-sm ${
              e.kind === 'birth'
                ? 'text-emerald-300/90'
                : e.kind === 'split'
                  ? 'text-lime-300/90'
                  : e.kind === 'death'
                    ? 'text-rose-300/80'
                    : 'text-neutral-400/80'
            }`}
          >
            <span className="text-neutral-500">t {e.t.toFixed(0)} · </span>
            {e.text}
          </p>
        ))}
      </div>
    </>
  );
}
