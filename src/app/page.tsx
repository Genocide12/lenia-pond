'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, Plus, Minus, Maximize, Sprout, Trash2, Thermometer, Download } from 'lucide-react';
import { CREATURES, POND_SPECIES, type Creature } from '@/lib/lenia/creatures';
import { PondEngine, speciesPalette, paletteColor, DISH, type PondRect } from '@/lib/lenia/engine';
import { BlobTracker, type EventKind } from '@/lib/lenia/tracker';

const SPEEDS = [1, 2, 4, 8];
const PLACE_PX = 220; // блюдце крупнее этого — тап сажает существо, меньше — перелёт
const STATS_MS = 500;
const GLOW_MS = 1500;

const SPECIES: Creature[] = POND_SPECIES.map((id) => CREATURES.find((c) => c.id === id)!).filter(Boolean);

const GLOW_COLORS: Record<EventKind, string> = {
  birth: '#34d399',
  split: '#a3e635',
  merge: '#fbbf24',
  death: '#fb7185',
};
const EVENT_WORDS: Record<EventKind, string> = {
  birth: 'рождение',
  split: 'деление!',
  death: 'гибель',
  merge: 'слияние',
};

const plural = (n: number) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'существо';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'существа';
  return 'существ';
};

const climateWord = (k: number) => (k < 0.33 ? 'холодно' : k < 0.67 ? 'умеренно' : 'жарко');

interface Glow {
  kind: EventKind;
  x: number;
  y: number;
  born: number;
}

export interface HudSnap {
  t: number;
  pop: number;
  fps: number;
  spName: string;
  climate: number;
  placeable: boolean;
  events: { id: number; kind: EventKind | 'info'; t: number; text: string }[];
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PondEngine | null>(null);
  const camRef = useRef({ x: 0, y: 0, scale: 600 });
  const animRef = useRef<{ t0: number; dur: number; from: { x: number; y: number; scale: number }; to: { x: number; y: number; scale: number } } | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const budgetRef = useRef(12);
  const fpsRef = useRef(0);
  const emaRef = useRef(16.7);
  const runningRef = useRef(true);
  const speedRef = useRef(2);
  const selRef = useRef(0);
  const focusRef = useRef(0);
  const visRef = useRef<PondRect | null>(null);
  const guardRef = useRef(0);
  const glowsRef = useRef<Glow[]>([]);
  const feedRef = useRef<{ id: number; kind: EventKind | 'info'; t: number; text: string }[]>([]);
  const feedIdRef = useRef(1);
  const hudCbRef = useRef<(s: HudSnap) => void>(() => {});
  const trackerRef = useRef(new BlobTracker(DISH));
  const installEvtRef = useRef<Event | null>(null);
  const lastTapRef = useRef({ t: 0, x: 0, y: 0 });

  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const [speedIdx, setSpeedIdx] = useState(1);
  const [sel, setSel] = useState(0);
  const [climateOpen, setClimateOpen] = useState(false);
  const [installReady, setInstallReady] = useState(false);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    speedRef.current = SPEEDS[speedIdx];
  }, [speedIdx]);
  useEffect(() => {
    selRef.current = sel;
  }, [sel]);

  const pushFeed = useCallback((kind: EventKind | 'info', t: number, text: string) => {
    feedRef.current = [{ id: feedIdRef.current++, kind, t, text }, ...feedRef.current].slice(0, 3);
  }, []);

  /* ---------- PWA: service worker + установка ---------- */

  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
      navigator.serviceWorker.register(new URL('sw.js', document.baseURI).pathname).catch(() => {});
    }
    const onPrompt = (e: Event) => {
      e.preventDefault();
      installEvtRef.current = e;
      setInstallReady(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    const onInstalled = () => setInstallReady(false);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    const e = installEvtRef.current as (Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }) | null;
    if (!e) return;
    await e.prompt();
    await e.userChoice;
    installEvtRef.current = null;
    setInstallReady(false);
  }, []);

  /* ---------- камера ---------- */

  const minScale = useCallback(() => {
    const { w, h } = sizeRef.current;
    return (Math.min(w, h) / (engineRef.current?.grid ?? 64)) * 0.9;
  }, []);

  const maxScale = useCallback(() => {
    const { w, h } = sizeRef.current;
    return Math.min(w, h) * 2;
  }, []);

  const clampCam = useCallback(() => {
    const cam = camRef.current;
    const g = engineRef.current?.grid ?? 64;
    cam.scale = clamp(cam.scale, minScale(), maxScale());
    cam.x = clamp(cam.x, -1.5, g + 1.5);
    cam.y = clamp(cam.y, -1.5, g + 1.5);
  }, [minScale, maxScale]);

  const zoomAt = useCallback(
    (px: number, py: number, factor: number) => {
      const cam = camRef.current;
      const { w, h } = sizeRef.current;
      animRef.current = null;
      const wx = cam.x + (px - w / 2) / cam.scale;
      const wy = cam.y + (h / 2 - py) / cam.scale;
      cam.scale = clamp(cam.scale * factor, minScale(), maxScale());
      cam.x = wx - (px - w / 2) / cam.scale;
      cam.y = wy - (h / 2 - py) / cam.scale;
      clampCam();
    },
    [minScale, maxScale, clampCam],
  );

  const flyTo = useCallback((x: number, y: number, scale: number) => {
    const cam = camRef.current;
    animRef.current = { t0: performance.now(), dur: 450, from: { ...cam }, to: { x, y, scale } };
  }, []);

  const screenToWorld = useCallback((px: number, py: number) => {
    const cam = camRef.current;
    const { w, h } = sizeRef.current;
    return { x: cam.x + (px - w / 2) / cam.scale, y: cam.y + (h / 2 - py) / cam.scale };
  }, []);

  const visRect = useCallback((): PondRect | null => {
    const eng = engineRef.current;
    if (!eng) return null;
    const cam = camRef.current;
    const { w, h } = sizeRef.current;
    const g = eng.grid;
    const x0 = clamp(Math.floor(cam.x - w / (2 * cam.scale)), 0, g - 1);
    const x1 = clamp(Math.ceil(cam.x + w / (2 * cam.scale)) - 1, 0, g - 1);
    const y0 = clamp(Math.floor(cam.y - h / (2 * cam.scale)), 0, g - 1);
    const y1 = clamp(Math.ceil(cam.y + h / (2 * cam.scale)) - 1, 0, g - 1);
    const rw = x1 - x0 + 1;
    const rh = y1 - y0 + 1;
    return { x0, y0, x1, y1, w: rw, h: rh, count: rw * rh };
  }, []);

  const focusDi = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return 0;
    const cam = camRef.current;
    const g = eng.grid;
    return clamp(Math.floor(cam.y), 0, g - 1) * g + clamp(Math.floor(cam.x), 0, g - 1);
  }, []);

  /* ---------- заселение ---------- */

  const populateVisible = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    const rect = visRect();
    if (!rect) return;
    for (let y = rect.y0; y <= rect.y1; y++) {
      for (let x = rect.x0; x <= rect.x1; x++) {
        eng.place(y * eng.grid + x, Math.floor(Math.random() * SPECIES.length), Math.floor(Math.random() * 4), 26 + Math.random() * 44, 26 + Math.random() * 44);
      }
    }
    guardRef.current = performance.now();
    pushFeed('info', 0, 'пруд заселён');
    setRunning(true);
  }, [visRect, pushFeed]);

  const clearVisible = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.clearRect(visRect());
    glowsRef.current = [];
    pushFeed('info', 0, 'блюдца очищены');
  }, [visRect, pushFeed]);

  /* ---------- монтирование ---------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    let engine: PondEngine;
    try {
      engine = new PondEngine(canvas);
    } catch (e) {
      queueMicrotask(() => setError(e instanceof Error ? e.message : String(e)));
      return;
    }
    engineRef.current = engine;
    const octx = overlay.getContext('2d');

    const g = engine.grid;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);

    const resize = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      overlay.width = w; // оверлей в CSS-пикселях — дешёвые вспышки
      overlay.height = h;
      clampCam();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const cam = camRef.current;
    cam.x = g / 2;
    cam.y = g / 2;
    const q = new URLSearchParams(window.location.search);
    cam.scale = q.get('zoom') === 'fit' ? minScale() : Math.min(sizeRef.current.w, sizeRef.current.h) || 600;
    if (q.has('pause')) {
      runningRef.current = false;
      queueMicrotask(() => setRunning(false));
    }
    const sp0 = q.get('speed');
    if (sp0 && SPEEDS.includes(parseInt(sp0, 10))) {
      const idx = SPEEDS.indexOf(parseInt(sp0, 10));
      speedRef.current = SPEEDS[idx];
      queueMicrotask(() => setSpeedIdx(idx));
    }

    const center = Math.floor(g / 2) * g + Math.floor(g / 2);
    engine.place(center, 0, 0, DISH / 2, DISH / 2);
    for (let i = 0; i < 10; i++) {
      const dx = Math.floor(Math.random() * 9) - 4;
      const dy = Math.floor(Math.random() * 9) - 4;
      engine.place(
        (Math.floor(g / 2) + dy) * g + Math.floor(g / 2) + dx,
        Math.floor(Math.random() * SPECIES.length),
        Math.floor(Math.random() * 4),
        26 + Math.random() * 44,
        26 + Math.random() * 44,
      );
    }

    /* ---------- ввод ---------- */

    type P = { x: number; y: number; sx: number; sy: number; t: number; moved: boolean };
    const pointers = new Map<number, P>();
    let pinch: { dist0: number; scale0: number; wx: number; wy: number } | null = null;

    const tapAt = (px: number, py: number) => {
      const now = performance.now();
      const lt = lastTapRef.current;
      const isDouble = now - lt.t < 320 && Math.hypot(px - lt.x, py - lt.y) < 36;
      lastTapRef.current = { t: now, x: px, y: py };
      const wpt = screenToWorld(px, py);
      if (wpt.x < 0 || wpt.y < 0 || wpt.x >= g || wpt.y >= g) return;
      const dx = Math.floor(wpt.x);
      const dy = Math.floor(wpt.y);
      const di = dy * g + dx;
      if (camRef.current.scale >= PLACE_PX) {
        if (isDouble) return; // случайный второй тап — не сажаем вдвое
        engine.place(di, selRef.current, Math.floor(Math.random() * 4), (wpt.x - dx) * DISH, (wpt.y - dy) * DISH);
        guardRef.current = now;
        pushFeed('info', 0, `посажен: ${SPECIES[selRef.current].ru.toLowerCase()}`);
      } else if (isDouble) {
        zoomAt(px, py, 2.2);
      } else {
        flyTo(dx + 0.5, dy + 0.5, Math.min(sizeRef.current.w, sizeRef.current.h));
      }
    };

    const onDown = (e: PointerEvent) => {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* capture не критична */
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), moved: false });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const wm = screenToWorld(mid.x, mid.y);
        pinch = { dist0: Math.hypot(a.x - b.x, a.y - b.y), scale0: camRef.current.scale, wx: wm.x, wy: wm.y };
      }
    };

    const onMove = (e: PointerEvent) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 7) p.moved = true;
      if (pointers.size === 1) {
        if (p.moved) {
          const cam2 = camRef.current;
          animRef.current = null;
          cam2.x -= dx / cam2.scale;
          cam2.y += dy / cam2.scale;
          clampCam();
        }
      } else if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist < 8) return;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const cam2 = camRef.current;
        animRef.current = null;
        cam2.scale = clamp((pinch.scale0 * dist) / pinch.dist0, minScale(), maxScale());
        cam2.x = pinch.wx - (mid.x - sizeRef.current.w / 2) / cam2.scale;
        cam2.y = pinch.wy - (sizeRef.current.h / 2 - mid.y) / cam2.scale;
        clampCam();
      }
    };

    const onUp = (e: PointerEvent) => {
      const p = pointers.get(e.pointerId);
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (p && !p.moved && performance.now() - p.t < 400 && pointers.size === 0) {
        const rect = canvas.getBoundingClientRect();
        tapAt(e.clientX - rect.left, e.clientY - rect.top);
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.008 : 0.0016));
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, f);
    };

    const panBy = (dx: number, dy: number) => {
      const cam2 = camRef.current;
      animRef.current = null;
      cam2.x += dx / cam2.scale;
      cam2.y += dy / cam2.scale;
      clampCam();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          setRunning((r) => !r);
          break;
        case 'Equal':
        case 'NumpadAdd':
          zoomAt(sizeRef.current.w / 2, sizeRef.current.h / 2, 1.4);
          break;
        case 'Minus':
        case 'NumpadSubtract':
          zoomAt(sizeRef.current.w / 2, sizeRef.current.h / 2, 1 / 1.4);
          break;
        case 'Digit0':
          flyTo(g / 2, g / 2, minScale());
          break;
        case 'Digit1':
        case 'Digit2':
        case 'Digit3':
        case 'Digit4': {
          const idx = parseInt(e.code.slice(-1), 10) - 1;
          if (idx < SPEEDS.length) setSpeedIdx(idx);
          break;
        }
        case 'ArrowLeft':
        case 'KeyA':
          panBy(-90, 0);
          break;
        case 'ArrowRight':
        case 'KeyD':
          panBy(90, 0);
          break;
        case 'ArrowUp':
        case 'KeyW':
          panBy(0, 90);
          break;
        case 'ArrowDown':
        case 'KeyS':
          panBy(0, -90);
          break;
        case 'KeyR':
        case 'KeyК': {
          const di = focusDi();
          engine.clearDish(di);
          engine.place(di, selRef.current, Math.floor(Math.random() * 4), DISH / 2, DISH / 2);
          guardRef.current = performance.now();
          break;
        }
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', onKey);

    /* ---------- HUD и вспышки ---------- */

    const drawGlows = (now: number) => {
      if (!octx) return;
      const { w, h } = sizeRef.current;
      octx.clearRect(0, 0, w, h);
      const cam2 = camRef.current;
      if (cam2.scale < 40 || glowsRef.current.length === 0) {
        glowsRef.current = cam2.scale < 40 ? [] : glowsRef.current;
        return;
      }
      const fd = focusDi();
      const fx = fd % g;
      const fy = Math.floor(fd / g);
      glowsRef.current = glowsRef.current.filter((gl) => now - gl.born < GLOW_MS);
      for (const gl of glowsRef.current) {
        const age = Math.min(1, (now - gl.born) / GLOW_MS);
        const wx = fx + (gl.x + 0.5) / DISH;
        const wy = fy + (gl.y + 0.5) / DISH;
        const sx = (wx - cam2.x) * cam2.scale + w / 2;
        const sy = h / 2 - (wy - cam2.y) * cam2.scale;
        const r = (3 + age * 13) * (cam2.scale / DISH);
        octx.globalAlpha = (1 - age) * 0.85;
        octx.strokeStyle = GLOW_COLORS[gl.kind];
        octx.lineWidth = 2.2 * (1 - age) + 0.5;
        octx.beginPath();
        octx.arc(sx, sy, r, 0, Math.PI * 2);
        octx.stroke();
      }
      octx.globalAlpha = 1;
    };

    let lastStats = 0;
    let lastDi = -1;
    let lastFrame = 0;
    let frames = 0;
    const scan = (now: number) => {
      const di = focusDi();
      if (di !== lastDi) {
        lastDi = di;
        trackerRef.current.reset();
        glowsRef.current = [];
      }
      const sp = engine.species[di];
      let st = { mass: 0, pop: 0, blobs: [] as { x: number; y: number; mass: number; size: number }[] };
      let t = 0;
      let events: { kind: EventKind; t: number; x: number; y: number }[] = [];
      if (sp >= 0) {
        st = engine.stats(di);
        t = engine.steps[di] * (1 / engine.speciesList[sp].T);
        const stepsSince = Math.max(1, Math.round(speedRef.current * ((now - lastStats) / 16.7)));
        events = trackerRef.current.update(st.blobs, t, stepsSince);
      } else {
        trackerRef.current.reset();
      }
      if (events.length > 0 && now - guardRef.current > 900) {
        for (const ev of events.slice(0, 3)) {
          glowsRef.current.push({ kind: ev.kind, x: ev.x, y: ev.y, born: now });
          pushFeed(ev.kind, t, EVENT_WORDS[ev.kind]);
        }
      }
      const slider = document.getElementById('climate-slider') as HTMLInputElement | null;
      if (slider && document.activeElement !== slider) slider.value = String(engine.climate[di]);
      hudCbRef.current({
        t,
        pop: st.pop,
        fps: Math.round(fpsRef.current),
        spName: sp >= 0 ? engine.speciesList[sp].ru : 'пусто',
        climate: engine.climate[di],
        placeable: camRef.current.scale >= PLACE_PX,
        events: [...feedRef.current],
      });
    };

    /* ---------- цикл ---------- */

    const loop = (now: number) => {
      try {
        if (lastFrame) {
          const dt = now - lastFrame;
          if (dt > 0 && dt < 2000) {
            emaRef.current = emaRef.current * 0.9 + dt * 0.1;
            fpsRef.current = 1000 / emaRef.current;
          }
        }
        lastFrame = now;

        // адаптивный бюджет: кадр дорог — режем, дешёв — наращиваем
        if (++frames % 30 === 0) {
          if (emaRef.current > 22) budgetRef.current = Math.max(3, Math.floor(budgetRef.current * 0.75));
          else if (emaRef.current < 15) budgetRef.current = Math.min(96, budgetRef.current + 4);
        }

        const anim = animRef.current;
        if (anim) {
          const k = Math.min(1, (now - anim.t0) / anim.dur);
          const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
          const cam2 = camRef.current;
          cam2.x = anim.from.x + (anim.to.x - anim.from.x) * e;
          cam2.y = anim.from.y + (anim.to.y - anim.from.y) * e;
          cam2.scale = anim.from.scale * Math.pow(anim.to.scale / anim.from.scale, e);
          if (k >= 1) animRef.current = null;
          clampCam();
        }

        const rect = visRect();
        visRef.current = rect;
        if (rect && runningRef.current) engine.distribute(rect, budgetRef.current, speedRef.current);

        focusRef.current = focusDi();
        engine.render(camRef.current, { x: focusRef.current % g, y: Math.floor(focusRef.current / g) }, now / 1000, dpr);
        drawGlows(now);

        if (now - lastStats >= STATS_MS) {
          scan(now);
          lastStats = now;
        }
      } catch (err) {
        runningRef.current = false;
        queueMicrotask(() => {
          setError(err instanceof Error ? err.message : String(err));
          setRunning(false);
        });
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    const rafRef = { current: requestAnimationFrame(loop) };

    // хук для авто-тестов
    (window as unknown as { __pond?: object }).__pond = {
      cam: () => ({ ...camRef.current }),
      setCam: (x: number, y: number, scale: number) => {
        animRef.current = null;
        camRef.current = { x, y, scale };
        clampCam();
      },
      grid: g,
      dishes: g * g,
      vis: () => visRef.current,
      focus: () => focusRef.current,
      stats: (di?: number) => engine.stats(di ?? focusDi()),
      info: (di: number) => ({ sp: engine.species[di], climate: engine.climate[di], steps: engine.steps[di] }),
      budget: () => budgetRef.current,
      fps: () => fpsRef.current,
      populate: populateVisible,
      clear: clearVisible,
      place: (di: number, sp: number, rot = 0) => engine.place(di, sp, rot, DISH / 2, DISH / 2),
      step: (di: number, n: number) => {
        for (let i = 0; i < n; i++) engine.stepDish(di);
      },
      setClimate: (di: number, k: number) => engine.setClimate(di, k),
      speciesCount: SPECIES.length,
    };

    let wasRunning = true;
    const onVis = () => {
      if (document.hidden) {
        wasRunning = runningRef.current;
        runningRef.current = false;
      } else {
        runningRef.current = wasRunning;
      }
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      cancelAnimationFrame(rafRef.current);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      ro.disconnect();
      engine.destroy();
      engineRef.current = null;
      delete (window as unknown as { __pond?: object }).__pond;
    };
  }, [clampCam, minScale, maxScale, zoomAt, flyTo, screenToWorld, visRect, focusDi, populateVisible, clearVisible, pushFeed]);

  /* ---------- рендер ---------- */

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#040806] text-neutral-100" style={{ touchAction: 'none' }}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none select-none" aria-label="Пруд Лении" />
      <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />

      {error && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-6">
          <div className="max-w-md rounded-xl border border-rose-500/40 bg-rose-950/20 p-5 text-center">
            <p className="font-medium text-rose-300">Симуляция остановлена</p>
            <p className="mt-1 text-sm text-neutral-400">{error}</p>
          </div>
        </div>
      )}

      {/* статистика наблюдаемого блюдца */}
      <Hud callbackRef={hudCbRef} />

      {/* рейка управления справа */}
      <div className="rail absolute right-[max(0.75rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))] z-20">
        <RailBtn onClick={() => setRunning((r) => !r)} testid="playpause" label={running ? 'Пауза' : 'Пуск'} active>
          {running ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
        </RailBtn>

        <button
          onClick={() => setSpeedIdx((i) => (i + 1) % SPEEDS.length)}
          data-testid="speed"
          aria-label="Скорость"
          className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-black/55 font-mono text-[13px] font-bold text-emerald-200 backdrop-blur transition-colors active:bg-emerald-900/50"
        >
          ×{SPEEDS[speedIdx]}
        </button>

        <RailBtn onClick={populateVisible} testid="populate" label="Заселить видимые блюдца">
          <Sprout className="h-5 w-5" />
        </RailBtn>

        <RailBtn onClick={clearVisible} testid="clear" label="Очистить видимые блюдца">
          <Trash2 className="h-5 w-5" />
        </RailBtn>

        <RailBtn onClick={() => setClimateOpen((v) => !v)} testid="climate" label="Климат блюдца" active={climateOpen}>
          <Thermometer className="h-5 w-5" />
        </RailBtn>

        <RailBtn
          onClick={() => flyTo(engineRef.current ? engineRef.current.grid / 2 : 32, engineRef.current ? engineRef.current.grid / 2 : 32, minScale())}
          testid="fit"
          label="Весь пруд"
        >
          <Maximize className="h-5 w-5" />
        </RailBtn>

        {installReady && (
          <RailBtn onClick={install} testid="install" label="Установить приложение" accent>
            <Download className="h-5 w-5" />
          </RailBtn>
        )}
      </div>

      {/* климат наблюдаемого блюдца */}
      {climateOpen && <ClimatePanel onClose={() => setClimateOpen(false)} onSet={(k) => engineRef.current?.setClimate(focusDi(), k)} />}

      {/* зум-кнопки: только на десктопе (на телефоне — щипок) */}
      <div className="pointer-events-none absolute bottom-[max(5.5rem,calc(env(safe-area-inset-bottom)+5.5rem))] right-[max(0.75rem,env(safe-area-inset-right))] z-20 hidden flex-col gap-1.5 [@media(pointer:fine)]:flex">
        <button
          onClick={() => zoomAt(sizeRef.current.w / 2, sizeRef.current.h / 2, 1.6)}
          aria-label="Приблизить"
          className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-black/55 text-neutral-300 backdrop-blur transition-colors hover:bg-white/10"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          onClick={() => zoomAt(sizeRef.current.w / 2, sizeRef.current.h / 2, 1 / 1.6)}
          aria-label="Отдалить"
          className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-black/55 text-neutral-300 backdrop-blur transition-colors hover:bg-white/10"
        >
          <Minus className="h-4 w-4" />
        </button>
      </div>

      {/* виды */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-2"
        style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
      >
        <div className="species-strip pointer-events-auto flex max-w-full gap-1.5 overflow-x-auto rounded-2xl border border-white/10 bg-black/55 p-1.5 backdrop-blur">
          {SPECIES.map((c, i) => (
            <SpeciesChip key={c.name} sp={c} palId={i} selected={sel === i} onSelect={() => setSel(i)} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- кнопка рейки ---------- */

function RailBtn({
  children,
  onClick,
  label,
  testid,
  active,
  accent,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  testid?: string;
  active?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      aria-label={label}
      title={label}
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border backdrop-blur transition-colors active:scale-95 ${
        accent
          ? 'border-emerald-400/60 bg-emerald-600/40 text-emerald-100'
          : active
            ? 'border-emerald-500/40 bg-emerald-950/60 text-emerald-200'
            : 'border-white/10 bg-black/55 text-neutral-300 hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  );
}

/* ---------- панель климата ---------- */

function ClimatePanel({ onClose, onSet }: { onClose: () => void; onSet: (k: number) => void }) {
  const [k, setK] = useState(0.5);
  return (
    <>
      <button className="fixed inset-0 z-10 cursor-default" onClick={onClose} aria-label="Закрыть" tabIndex={-1} />
      <div
        className="absolute z-20 w-56 rounded-2xl border border-white/10 bg-[#0b1512]/95 p-3.5 shadow-xl backdrop-blur"
        style={{ right: 'max(4rem, calc(env(safe-area-inset-right) + 4rem))', top: 'max(0.75rem, env(safe-area-inset-top))' }}
        data-testid="climate-panel"
      >
        <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-300/80">Климат блюдца</p>
        <p className="mt-0.5 text-xs text-neutral-400">{climateWord(k)} — края губительны</p>
        <input
          id="climate-slider"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={k}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            setK(v);
            onSet(v);
          }}
          className="mt-2 w-full cursor-pointer"
        />
        <div className="mt-0.5 flex justify-between font-mono text-[9px] text-neutral-500">
          <span>лёд</span>
          <span>умеренно</span>
          <span>жарко</span>
        </div>
      </div>
    </>
  );
}

/* ---------- HUD: наблюдение за блюдцем под центром ---------- */

function Hud({ callbackRef }: { callbackRef: { current: (s: HudSnap) => void } }) {
  const [snap, setSnap] = useState<HudSnap>({ t: 0, pop: 0, fps: 0, spName: '', climate: 0.5, placeable: false, events: [] });

  useEffect(() => {
    callbackRef.current = setSnap;
    return () => {
      callbackRef.current = () => {};
    };
  }, [callbackRef]);

  return (
    <div className="pointer-events-none absolute left-[max(0.75rem,env(safe-area-inset-left))] top-[max(0.75rem,env(safe-area-inset-top))] z-10 flex max-w-[54vw] flex-col gap-1.5">
      <div className="rounded-2xl border border-emerald-500/25 bg-black/55 px-3 py-1.5 backdrop-blur">
        <div className="flex items-baseline gap-2">
          <p data-testid="pop-count" className="text-xl font-extrabold leading-none tabular-nums text-neutral-100">
            {snap.pop}
          </p>
          <p className="text-[9px] uppercase tracking-wider text-emerald-500/80">{plural(Math.abs(snap.pop))}</p>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-neutral-400">
          {snap.spName}
          {snap.spName !== 'пусто' && <> · {climateWord(snap.climate)}</>}
        </p>
        <p className="font-mono text-[9px] tabular-nums text-neutral-600">
          шаг {snap.t.toFixed(0)} · {snap.fps} fps
        </p>
      </div>
      <div className="max-w-full" data-testid="feed">
        {snap.events.slice(0, 2).map((e) => (
          <p
            key={e.id}
            className={`truncate font-mono text-[10px] leading-4 backdrop-blur-sm ${
              e.kind === 'birth'
                ? 'text-emerald-300/90'
                : e.kind === 'split'
                  ? 'text-lime-300/90'
                  : e.kind === 'death'
                    ? 'text-rose-300/80'
                    : 'text-neutral-400/80'
            }`}
          >
            {e.text}
          </p>
        ))}
      </div>
    </div>
  );
}

/* ---------- миниатюра вида ---------- */

function SpeciesChip({ sp, palId, selected, onSelect }: { sp: Creature; palId: number; selected: boolean; onSelect: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const S = 40;
    cv.width = S;
    cv.height = S;
    ctx.clearRect(0, 0, S, S);
    const stops = speciesPalette(palId).stops;
    const scale = Math.min((S - 6) / sp.w, (S - 6) / sp.h);
    const ox = (S - sp.w * scale) / 2;
    const oy = (S - sp.h * scale) / 2;
    for (let y = 0; y < sp.h; y++) {
      for (let x = 0; x < sp.w; x++) {
        const v = sp.cells[y * sp.w + x];
        if (v <= 0.03) continue;
        const [r, g2, b] = paletteColor(stops, v);
        ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g2 * 255)},${Math.round(b * 255)})`;
        ctx.fillRect(ox + x * scale, oy + y * scale, Math.max(1, scale), Math.max(1, scale));
      }
    }
  }, [sp, palId]);

  return (
    <button
      onClick={onSelect}
      data-sp={sp.id}
      aria-pressed={selected}
      title={sp.ru}
      className={`flex w-12 shrink-0 flex-col items-center gap-0.5 rounded-xl border p-1 transition-colors active:scale-95 ${
        selected ? 'border-emerald-400/70 bg-emerald-950/70' : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.06]'
      }`}
    >
      <canvas ref={ref} className="h-8 w-8" />
      <span className={`w-full truncate text-center text-[8px] leading-tight ${selected ? 'text-emerald-200' : 'text-neutral-400'}`}>{sp.ru}</span>
    </button>
  );
}
