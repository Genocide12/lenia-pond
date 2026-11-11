'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, Plus, Minus, Maximize, Sprout, Trash2, Thermometer, Download } from 'lucide-react';
import { POND_LIST, type Creature } from '@/lib/lenia/creatures';
import { PondEngine, speciesPalette, paletteColor, DISH, META, TEX_PX, type PondStats } from '@/lib/lenia/engine';
import { Biosphere, dishParams, type EcoRec, type FeedKind } from '@/lib/lenia/eco';
import { BlobTracker, type EventKind } from '@/lib/lenia/tracker';

const SPEEDS = [0.5, 1, 2, 4, 8];
const PLACE_PX = 220; // блюдце крупнее этого — тап сажает существо, меньше — перелёт
const STATS_MS = 500;
const ECO_MS = 500;
const GLOW_MS = 1500;
const MAT_OPS = 3; // материализаций за кадр (плавно, без фризов)
const MIN_SCALE = 3; // пикселей на блюдце в дальнем обзоре (полей видно тысячи)

const SPECIES: Creature[] = POND_LIST;

type FeedItemKind = EventKind | FeedKind | 'info';

const FEED_COLORS: Record<FeedItemKind, string> = {
  birth: 'text-emerald-300/90',
  split: 'text-lime-300/90',
  merge: 'text-amber-300/90',
  death: 'text-rose-300/80',
  virus: 'text-orange-300/90',
  mut: 'text-amber-200/90',
  spread: 'text-emerald-300/90',
  origin: 'text-lime-200/90',
  extinct: 'text-rose-300/80',
  info: 'text-neutral-400/80',
};
const FEED_WORDS: Record<FeedItemKind, string> = {
  birth: 'рождение',
  split: 'деление!',
  death: 'гибель',
  merge: 'слияние',
  virus: 'вирус!',
  mut: 'мутация',
  spread: 'расселение',
  origin: 'зарождение жизни',
  extinct: 'вымирание',
  info: '',
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

interface VisRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  count: number;
}

export interface HudSnap {
  t: number;
  pop: number;
  fps: number;
  spName: string;
  climate: number;
  placeable: boolean;
  real: boolean;
  planet: number;
  events: { id: number; kind: FeedItemKind; t: number; text: string }[];
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PondEngine | null>(null);
  const worldRef = useRef<Biosphere | null>(null);
  const camRef = useRef({ x: 0.5, y: 0.5, scale: 400 });
  const animRef = useRef<{ t0: number; dur: number; from: { x: number; y: number; scale: number }; to: { x: number; y: number; scale: number } } | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const budgetRef = useRef(24); // шагов за кадр (дробный — медленным устройствам и часть кадра)
  const fpsRef = useRef(0);
  const emaRef = useRef(16.7);
  const runningRef = useRef(true);
  const speedRef = useRef(1);
  const selRef = useRef(0);
  const visRef = useRef<VisRect | null>(null);
  const guardRef = useRef(0);
  const glowsRef = useRef<Glow[]>([]);
  const feedRef = useRef<{ id: number; kind: FeedItemKind; t: number; text: string }[]>([]);
  const feedIdRef = useRef(1);
  const hudCbRef = useRef<(s: HudSnap) => void>(() => {});
  const trackerRef = useRef(new BlobTracker(DISH));
  const installEvtRef = useRef<Event | null>(null);
  const lastTapRef = useRef({ t: 0, x: 0, y: 0 });
  const actionsRef = useRef({ populate: () => {}, clear: () => {}, overview: () => {} });

  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false); // до нажатия «Начать эволюцию» мир ждёт
  const [started, setStarted] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(1);
  const [sel, setSel] = useState(0);
  const [climateOpen, setClimateOpen] = useState(false);
  const [installReady, setInstallReady] = useState(false);
  const startedRef = useRef(false);
  const pauseParamRef = useRef(false);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    speedRef.current = SPEEDS[speedIdx];
  }, [speedIdx]);
  useEffect(() => {
    selRef.current = sel;
  }, [sel]);

  const pushFeed = useCallback((kind: FeedItemKind, t: number, text: string) => {
    feedRef.current = [{ id: feedIdRef.current++, kind, t, text: text || FEED_WORDS[kind] }, ...feedRef.current].slice(0, 3);
  }, []);

  /* ---------- PWA ---------- */

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

  /* ---------- монтирование: движок, мир, ввод, цикл ---------- */

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
    const world = new Biosphere();
    worldRef.current = world;
    const octx = overlay.getContext('2d');

    const S = engine.slots;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
    if (engine.softGL) budgetRef.current = 0.35; // программный рендер — беречь

    const resize = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.max(2, Math.round(w * dpr * rsRef.current));
      canvas.height = Math.max(2, Math.round(h * dpr * rsRef.current));
      overlay.width = w;
      overlay.height = h;
      clampCam();
    };

    const minScale = () => MIN_SCALE;
    const maxScale = () => Math.min(sizeRef.current.w, sizeRef.current.h) * 2 || 800;
    const clampCam = () => {
      const cam = camRef.current;
      cam.scale = clamp(cam.scale, minScale(), maxScale());
    };

    const winOrgRef = { current: { x: -(S >> 1), y: -(S >> 1) } };
    const metaOrgRef = { current: { x: 0, y: 0 } };
    const rsRef = { current: engine.softGL ? 0.5 : 1 }; // адаптивное разрешение рендера (медленным устройствам — меньше пикселей)
    const slotTable = new Map<number, EcoRec>();
    const parkedRecs = new Map<number, EcoRec>();
    const freeSlots: number[] = [];
    for (let i = 0; i < S * S; i++) freeSlots.push(i);

    const releaseParked = (r: EcoRec | null) => {
      if (r && r.park >= 0) {
        engine.releasePark(r.park);
        parkedRecs.delete(r.park);
        r.park = -1;
      }
    };
    const seedSafe = (wx: number, wy: number, sp: number, pop: number) => {
      releaseParked(world.peek(wx, wy));
      world.seedDish(wx, wy, sp, pop);
    };
    const killSafe = (wx: number, wy: number) => {
      releaseParked(world.peek(wx, wy));
      world.killDish(wx, wy);
    };

    /* ---- слоты: материализация видимых блюдц ---- */

    const writeBack = (r: EcoRec) => {
      r.pop = r.mass > 0.01 ? clamp(r.mass * 30, 0.5, 14) : r.pop * 0.85;
      r.mat = -1;
    };
    const dropSlot = (slot: number, r: EcoRec) => {
      writeBack(r);
      // жизнь не стирается — точное состояние паркуется на GPU и переживёт отдаление
      if (r.sp >= 0 && r.mass > 0.002) {
        let p = engine.park(slot);
        if (p < 0 && parkedRecs.size > 0) {
          let vk = -1;
          let vd = -1;
          for (const [pk, rec] of parkedRecs) {
            const d = Math.abs(rec.wx - camRef.current.x) + Math.abs(rec.wy - camRef.current.y);
            if (d > vd) {
              vd = d;
              vk = pk;
            }
          }
          if (vk >= 0) {
            parkedRecs.get(vk)!.park = -1;
            parkedRecs.delete(vk);
            p = engine.park(slot, vk);
          }
        }
        if (p >= 0) {
          r.park = p;
          parkedRecs.set(p, r);
        }
      }
      slotTable.delete(slot);
      freeSlots.push(slot);
    };
    const takeSlot = (cdx: number, cdy: number): number => {
      if (freeSlots.length) return freeSlots.pop()!;
      let bestSlot = -1;
      let bestD = -1;
      for (const [slot, r] of slotTable) {
        const d = Math.abs(r.wx - cdx) + Math.abs(r.wy - cdy);
        if (d > bestD) {
          bestD = d;
          bestSlot = slot;
        }
      }
      if (bestSlot >= 0 && bestD > 4) {
        dropSlot(bestSlot, slotTable.get(bestSlot)!);
        return bestSlot;
      }
      return -1;
    };
    const cnt = (r: EcoRec) => clamp(Math.round(r.pop / 2.2), 1, 6);

    /* ---- камера ---- */

    const zoomAt = (px: number, py: number, factor: number) => {
      const cam = camRef.current;
      const { w, h } = sizeRef.current;
      animRef.current = null;
      const wx = cam.x + (px - w / 2) / cam.scale;
      const wy = cam.y + (h / 2 - py) / cam.scale;
      cam.scale = clamp(cam.scale * factor, minScale(), maxScale());
      cam.x = wx - (px - w / 2) / cam.scale;
      cam.y = wy - (h / 2 - py) / cam.scale;
    };

    const flyTo = (x: number, y: number, scale: number) => {
      const cam = camRef.current;
      animRef.current = { t0: performance.now(), dur: 450, from: { ...cam }, to: { x, y, scale: clamp(scale, minScale(), maxScale()) } };
    };

    const screenToWorld = (px: number, py: number) => {
      const cam = camRef.current;
      const { w, h } = sizeRef.current;
      return { x: cam.x + (px - w / 2) / cam.scale, y: cam.y + (h / 2 - py) / cam.scale };
    };

    /* ---- экосистемные события (GPU-хуки для тика биосферы) ---- */

    const hooks = {
      perturb: (slot: number, mode: number, seed: number) => engine.perturb(slot, mode, seed),
      clearSlot: (slot: number) => engine.clearSlot(slot),
      placeImmigrant: (slot: number, sp: number) => engine.place(slot, sp, Math.floor(Math.random() * 4), 16 + Math.random() * 64, 16 + Math.random() * 64),
      releasePark: (p: number) => {
        engine.releasePark(p);
        parkedRecs.delete(p);
      },
      feed: (kind: FeedKind, _wx: number, _wy: number) => pushFeed(kind, world.time, FEED_WORDS[kind]),
    };

    /* ---- старт: жизнь у начала координат ---- */

    const q = new URLSearchParams(window.location.search);
    pauseParamRef.current = q.has('pause');
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.random() < 0.75) world.seedDish(dx, dy, Math.floor(Math.random() * SPECIES.length), 3 + Math.random() * 6);
        else world.killDish(dx, dy);
      }
    }
    resize();
    const cam0 = camRef.current;
    cam0.x = 0.5;
    cam0.y = 0.5;
    cam0.scale = q.get('zoom') === 'fit' ? minScale() : (Math.min(sizeRef.current.w, sizeRef.current.h) || 900) / 3.6;
    const sp0 = q.get('speed');
    if (sp0 && SPEEDS.includes(parseFloat(sp0))) {
      const idx = SPEEDS.indexOf(parseFloat(sp0));
      speedRef.current = SPEEDS[idx];
      queueMicrotask(() => setSpeedIdx(idx));
    }
    const mox = Math.floor((0 - META / 2) / 16) * 16;
    const moy = Math.floor((0 - META / 2) / 16) * 16;
    metaOrgRef.current = { x: mox, y: moy };
    engine.setMeta(world.buildMeta(metaOrgRef.current));

    /* ---- действия кнопок ---- */

    const populate = () => {
      const cam = camRef.current;
      const { w, h } = sizeRef.current;
      const vx0 = Math.floor(cam.x - w / (2 * cam.scale));
      const vx1 = Math.ceil(cam.x + w / (2 * cam.scale));
      const vy0 = Math.floor(cam.y - h / (2 * cam.scale));
      const vy1 = Math.ceil(cam.y + h / (2 * cam.scale));
      const wo = winOrgRef.current;
      let real = 0;
      for (let wy = vy0; wy < vy1; wy++) {
        for (let wx = vx0; wx < vx1; wx++) {
          const sp = Math.floor(Math.random() * SPECIES.length);
          seedSafe(wx, wy, sp, 4 + Math.random() * 7);
          if (real < 150 && wx >= wo.x && wy >= wo.y && wx < wo.x + S && wy < wo.y + S && cam.scale >= TEX_PX - 2) {
            const r = world.peek(wx, wy)!;
            if (r.mat < 0) {
              const slot = takeSlot(wx, wy);
              if (slot >= 0) {
                engine.seedSlot(slot, sp, cnt(r));
                r.mat = slot;
                r.matSerial = r.serial;
                r.mass = 0.015;
                slotTable.set(slot, r);
                real++;
              }
            }
          }
        }
      }
      guardRef.current = performance.now();
      pushFeed('info', 0, 'жизнь засеяна');
      setRunning(true);
    };

    const clear = () => {
      const cam = camRef.current;
      const { w, h } = sizeRef.current;
      const vx0 = Math.floor(cam.x - w / (2 * cam.scale));
      const vx1 = Math.ceil(cam.x + w / (2 * cam.scale));
      const vy0 = Math.floor(cam.y - h / (2 * cam.scale));
      const vy1 = Math.ceil(cam.y + h / (2 * cam.scale));
      for (let wy = vy0; wy < vy1; wy++) {
        for (let wx = vx0; wx < vx1; wx++) {
          const r = world.peek(wx, wy);
          if (!r) continue;
          killSafe(wx, wy);
          if (r.mat >= 0) {
            const slot = r.mat;
            engine.clearSlot(slot);
            r.mat = -1;
            slotTable.delete(slot);
            freeSlots.push(slot);
          }
        }
      }
      glowsRef.current = [];
      pushFeed('info', 0, 'блюдца очищены');
    };

    const overview = () => flyTo(camRef.current.x, camRef.current.y, minScale());

    actionsRef.current = { populate, clear, overview };

    /* ---- ввод ---- */

    type P = { x: number; y: number; sx: number; sy: number; t: number; moved: boolean };
    const pointers = new Map<number, P>();
    let pinch: { dist0: number; scale0: number; wx: number; wy: number } | null = null;

    const focusDish = () => ({ x: Math.floor(camRef.current.x), y: Math.floor(camRef.current.y) });

    const tapAt = (px: number, py: number) => {
      const now = performance.now();
      const lt = lastTapRef.current;
      const isDouble = now - lt.t < 320 && Math.hypot(px - lt.x, py - lt.y) < 36;
      lastTapRef.current = { t: now, x: px, y: py };
      const wpt = screenToWorld(px, py);
      const dx = Math.floor(wpt.x);
      const dy = Math.floor(wpt.y);
      if (camRef.current.scale >= PLACE_PX) {
        const wo = winOrgRef.current;
        if (dx >= wo.x && dy >= wo.y && dx < wo.x + S && dy < wo.y + S) {
          if (isDouble) return;
          const r = world.get(dx, dy);
          let slot = r.mat;
          if (slot < 0) {
            slot = takeSlot(dx, dy);
            if (slot >= 0) {
              engine.clearSlot(slot);
              r.mat = slot;
              r.matSerial = r.serial;
              r.mass = Math.max(r.mass, 0.02);
              slotTable.set(slot, r);
            }
          }
          if (slot >= 0) {
            engine.place(slot, selRef.current, Math.floor(Math.random() * 4), (wpt.x - dx) * DISH, (wpt.y - dy) * DISH);
            if (r.sp !== selRef.current) {
              r.sp = selRef.current;
              r.pop = Math.max(r.pop, 1);
              r.serial++;
              r.matSerial = r.serial;
            }
            guardRef.current = now;
            pushFeed('info', 0, `посажен: ${SPECIES[selRef.current].ru.toLowerCase()}`);
          }
          return;
        }
      }
      if (isDouble) zoomAt(px, py, 2.2);
      else flyTo(dx + 0.5, dy + 0.5, Math.min(sizeRef.current.w, sizeRef.current.h));
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
        pinch = { dist0: Math.max(8, Math.hypot(a.x - b.x, a.y - b.y)), scale0: camRef.current.scale, wx: wm.x, wy: wm.y };
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
        }
      } else if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const dist = Math.max(8, Math.hypot(a.x - b.x, a.y - b.y));
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const cam2 = camRef.current;
        animRef.current = null;
        cam2.scale = clamp((pinch.scale0 * dist) / pinch.dist0, minScale(), maxScale());
        cam2.x = pinch.wx - (mid.x - sizeRef.current.w / 2) / cam2.scale;
        cam2.y = pinch.wy - (sizeRef.current.h / 2 - mid.y) / cam2.scale;
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
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (!startedRef.current) return; // стартовый экран — модальный
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
          overview();
          break;
        case 'Digit1':
        case 'Digit2':
        case 'Digit3':
        case 'Digit4':
        case 'Digit5': {
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
          const fd = focusDish();
          seedSafe(fd.x, fd.y, selRef.current, 3);
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
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    /* ---- HUD и вспышки ---- */

    const drawGlows = (now: number) => {
      if (!octx) return;
      const { w, h } = sizeRef.current;
      octx.clearRect(0, 0, w, h);
      const cam2 = camRef.current;
      if (cam2.scale < 40 || glowsRef.current.length === 0) {
        glowsRef.current = cam2.scale < 40 ? [] : glowsRef.current;
        return;
      }
      const fd = focusDish();
      glowsRef.current = glowsRef.current.filter((gl) => now - gl.born < GLOW_MS);
      for (const gl of glowsRef.current) {
        const age = Math.min(1, (now - gl.born) / GLOW_MS);
        const wx = fd.x + (gl.x + 0.5) / DISH;
        const wy = fd.y + (gl.y + 0.5) / DISH;
        const sx = (wx - cam2.x) * cam2.scale + w / 2;
        const sy = h / 2 - (wy - cam2.y) * cam2.scale;
        const r = (3 + age * 13) * (cam2.scale / DISH);
        octx.globalAlpha = (1 - age) * 0.85;
        octx.strokeStyle = gl.kind === 'birth' ? '#34d399' : gl.kind === 'split' ? '#a3e635' : gl.kind === 'merge' ? '#fbbf24' : '#fb7185';
        octx.lineWidth = 2.2 * (1 - age) + 0.5;
        octx.beginPath();
        octx.arc(sx, sy, r, 0, Math.PI * 2);
        octx.stroke();
      }
      octx.globalAlpha = 1;
    };

    let lastEco = 0;
    let lastStats = 0;
    let lastFrame = 0;
    let frames = 0;
    let stepAcc = 0;
    let gateAcc = 0;
    let cursor = 0;
    let probeIdx = 0;
    let matList: { slot: number; r: EcoRec }[] = [];
    let lastFocus = '';
    let lastDi = { x: 1 << 30, y: 1 << 30 };

    const scan = (now: number) => {
      const fd = focusDish();
      if (fd.x !== lastDi.x || fd.y !== lastDi.y) {
        lastDi = fd;
        trackerRef.current.reset();
        glowsRef.current = [];
        lastFocus = '';
      }
      const r = world.get(fd.x, fd.y);
      let st: PondStats = { mass: 0, pop: 0, blobs: [] };
      let t = 0;
      let events: { kind: EventKind; t: number; x: number; y: number }[] = [];
      const real = r.mat >= 0 && r.sp >= 0;
      if (real) {
        st = engine.stats(r.mat);
        t = r.matSteps * (1 / SPECIES[r.sp].T);
        const stepsSince = Math.max(1, Math.round(speedRef.current * ((now - lastStats) / 16.7)));
        events = trackerRef.current.update(st.blobs, t, stepsSince);
      } else {
        trackerRef.current.reset();
        t = Math.round(world.time);
      }
      if (events.length > 0 && now - guardRef.current > 900) {
        for (const ev of events.slice(0, 3)) {
          glowsRef.current.push({ kind: ev.kind, x: ev.x, y: ev.y, born: now });
          pushFeed(ev.kind, t, FEED_WORDS[ev.kind]);
        }
      }
      const slider = document.getElementById('climate-slider') as HTMLInputElement | null;
      if (slider && document.activeElement !== slider) slider.value = String(r.clim);
      const key = `${r.sp}|${r.mat}`;
      if (key !== lastFocus || now - lastStats >= STATS_MS) {
        lastFocus = key;
        hudCbRef.current({
          t,
          pop: real ? st.pop : Math.round(r.pop),
          fps: Math.round(fpsRef.current),
          spName: r.sp >= 0 ? SPECIES[r.sp].ru : 'пусто',
          climate: r.clim,
          placeable: camRef.current.scale >= PLACE_PX,
          real,
          planet: world.aliveNear(24),
          events: [...feedRef.current],
        });
      }
    };

    /* ---- главный цикл ---- */

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

        // адаптация под устройство: бюджет шагов и разрешение рендера (цель — не ниже ~50 fps)
        if (++frames % 20 === 0) {
          if (emaRef.current > 19) budgetRef.current = Math.max(0.05, budgetRef.current * (emaRef.current > 35 ? 0.6 : 0.78));
          else if (emaRef.current < 15) budgetRef.current = Math.min(engine.softGL ? 2 : 400, budgetRef.current * 1.3 + 2);
          const rs = rsRef.current;
          if (emaRef.current > 24 && rs > 0.4) {
            rsRef.current = Math.max(0.4, rs * 0.8);
            resize();
          } else if (emaRef.current < 13 && rs < 1) {
            rsRef.current = Math.min(1, rs * 1.15);
            resize();
          }
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

        const cam = camRef.current;
        const { w, h } = sizeRef.current;
        const cdx = Math.floor(cam.x);
        const cdy = Math.floor(cam.y);

        // видимая область в блюдцах (мир бесконечен — без клампа)
        const vx0 = Math.floor(cam.x - w / (2 * cam.scale));
        const vx1 = Math.ceil(cam.x + w / (2 * cam.scale));
        const vy0 = Math.floor(cam.y - h / (2 * cam.scale));
        const vy1 = Math.ceil(cam.y + h / (2 * cam.scale));
        visRef.current = { x0: vx0, y0: vy0, x1: vx1, y1: vy1, count: (vx1 - vx0) * (vy1 - vy0) };

        // окно слотов следует за камерой
        const wo = winOrgRef.current;
        if (Math.abs(cdx - (wo.x + S / 2)) > S / 4 || Math.abs(cdy - (wo.y + S / 2)) > S / 4) {
          const nx = cdx - (S >> 1);
          const ny = cdy - (S >> 1);
          for (const [slot, r] of slotTable) {
            if (r.wx < nx || r.wy < ny || r.wx >= nx + S || r.wy >= ny + S) dropSlot(slot, r);
          }
          winOrgRef.current = { x: nx, y: ny };
        }

        // мета-текстура планеты следует за камерой
        const mo = metaOrgRef.current;
        const mx = Math.floor((cdx - META / 2) / 16) * 16;
        const my = Math.floor((cdy - META / 2) / 16) * 16;
        if (mo.x !== mx || mo.y !== my) {
          metaOrgRef.current = { x: mx, y: my };
          engine.setMeta(world.buildMeta(metaOrgRef.current));
        }

        // скан видимых блюдц: материализация + список на шаги
        const wo2 = winOrgRef.current;
        const wx0 = Math.max(vx0, wo2.x);
        const wx1 = Math.min(vx1, wo2.x + S);
        const wy0 = Math.max(vy0, wo2.y);
        const wy1 = Math.min(vy1, wo2.y + S);
        matList = [];
        let ops = 0;
        if (wx1 > wx0 && wy1 > wy0) {
          const yOrder: number[] = [];
          for (let d = 0; yOrder.length < wy1 - wy0; d++) {
            if (cdy + d < wy1) yOrder.push(cdy + d);
            if (d > 0 && cdy - d >= wy0) yOrder.push(cdy - d);
          }
          const xOrder: number[] = [];
          for (let d = 0; xOrder.length < wx1 - wx0; d++) {
            if (cdx + d < wx1) xOrder.push(cdx + d);
            if (d > 0 && cdx - d >= wx0) xOrder.push(cdx - d);
          }
          for (const wy of yOrder) {
            for (const wx of xOrder) {
              const r = world.get(wx, wy);
              if (r.mat >= 0) {
                if (r.sp < 0) continue; // вымерло — тик уже очистил
                if (r.serial !== r.matSerial) {
                  if (ops < MAT_OPS) {
                    engine.seedSlot(r.mat, r.sp, cnt(r));
                    r.matSerial = r.serial;
                    r.mass = 0.015;
                    ops++;
                  }
                } else {
                  matList.push({ slot: r.mat, r });
                }
              } else if (r.sp >= 0 && (r.park >= 0 || r.pop > 0.5) && cam.scale >= TEX_PX - 2 && ops < MAT_OPS) {
                const slot = takeSlot(cdx, cdy);
                if (slot < 0) {
                  ops = MAT_OPS;
                } else if (r.park >= 0) {
                  engine.unpark(r.park, slot); // жизнь пережила отдаление — возвращаем ту же самую
                  parkedRecs.delete(r.park);
                  r.park = -1;
                  r.mat = slot;
                  r.matSerial = r.serial;
                  r.mass = Math.max(r.mass, 0.02);
                  r.lean = 0;
                  r.strikes = 0;
                  slotTable.set(slot, r);
                  ops++;
                  matList.push({ slot, r });
                } else {
                  engine.seedSlot(slot, r.sp, cnt(r));
                  r.mat = slot;
                  r.matSerial = r.serial;
                  r.mass = 0.015;
                  slotTable.set(slot, r);
                  ops++;
                  matList.push({ slot, r });
                }
              }
            }
          }
          // слоты, ушедшие с экрана, сворачиваются в статистику
          for (const [slot, r] of slotTable) {
            if (r.wx < vx0 || r.wx >= vx1 || r.wy < vy0 || r.wy >= vy1) dropSlot(slot, r);
          }
        }

        // честные шаги Lenia: каждое блюдце хочет speed шагов/кадр,
        // устройство даёт budget шагов/кадр всего (дробный — и часть кадра)
        if (runningRef.current && matList.length > 0) {
          stepAcc += speedRef.current;
          const perDish = Math.floor(stepAcc);
          stepAcc -= perDish;
          gateAcc += budgetRef.current;
          const gateCap = Math.max(8, budgetRef.current);
          if (gateAcc > gateCap) gateAcc = gateCap;
          const supply = Math.floor(gateAcc);
          gateAcc -= supply;
          const n = Math.min(perDish * matList.length, supply);
          for (let i = 0; i < n; i++) {
            const it = matList[cursor++ % matList.length];
            engine.stepSlot(it.slot, dishParams(it.r));
            it.r.matSteps++;
          }
        }

        // пробы массы (редукция на GPU, чтение 4 байт) — через кадр, чтобы не стопорить конвейер
        if (matList.length > 0 && (frames & 1) === 0) {
          const it = matList[probeIdx++ % matList.length];
          it.r.mass = engine.probeMass(it.slot);
        }

        engine.render(cam, winOrgRef.current, metaOrgRef.current, { x: cdx, y: cdy }, now / 1000, speedRef.current, dpr * rsRef.current);
        drawGlows(now);

        if (now - lastEco >= ECO_MS) {
          lastEco = now;
          world.setCamera(cdx, cdy);
          if (runningRef.current) world.tick(0.5 * speedRef.current, hooks); // на паузе планета замерла
          engine.setMeta(world.buildMeta(metaOrgRef.current));
        }
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
        camRef.current = { x, y, scale: clamp(scale, minScale(), maxScale()) };
      },
      speed: (v?: number) => {
        if (v !== undefined) speedRef.current = v;
        return speedRef.current;
      },
      vis: () => visRef.current,
      win: () => ({ ...winOrgRef.current }),
      meta: () => ({ ...metaOrgRef.current }),
      slots: S,
      matCount: () => slotTable.size,
      eco: (wx: number, wy: number) => {
        const r = world.get(wx, wy);
        return { sp: r.sp, spName: r.sp >= 0 ? SPECIES[r.sp].ru : '-', pop: r.pop, mass: r.mass, clim: r.clim, mat: r.mat, park: r.park, serial: r.serial, mut: [...r.mut], time: world.time };
      },
      aliveNear: (rad: number) => world.aliveNear(rad),
      tick: (n = 1) => {
        for (let i = 0; i < n; i++) world.tick(0.5, hooks);
        engine.setMeta(world.buildMeta(metaOrgRef.current));
      },
      probe: (wx: number, wy: number) => {
        const r = world.get(wx, wy);
        return r.mat >= 0 ? engine.probeMass(r.mat) : r.mass;
      },
      stepDish: (wx: number, wy: number, n: number) => {
        const r = world.get(wx, wy);
        if (r.mat >= 0 && r.sp >= 0) {
          for (let i = 0; i < n; i++) engine.stepSlot(r.mat, dishParams(r));
          r.matSteps += n;
        }
      },
      seedDish: (wx: number, wy: number, sp: number, pop = 6) => seedSafe(wx, wy, sp, pop),
      killDish: (wx: number, wy: number) => killSafe(wx, wy),
      parked: () => parkedRecs.size,
      parkCap: () => engine.parkCapacity,
      perturb: (wx: number, wy: number, mode: number) => {
        const r = world.get(wx, wy);
        if (r.mat >= 0) engine.perturb(r.mat, mode, Math.random() * 100);
      },
      stats: () => {
        const fd = focusDish();
        const r = world.get(fd.x, fd.y);
        return r.mat >= 0 ? engine.stats(r.mat) : { mass: 0, pop: 0, blobs: [] };
      },
      focusInfo: () => {
        const fd = focusDish();
        const r = world.get(fd.x, fd.y);
        return { dish: fd, sp: r.sp, spName: r.sp >= 0 ? SPECIES[r.sp].ru : '-', pop: r.pop, mass: r.mass, clim: r.clim, mat: r.mat, serial: r.serial, mut: [...r.mut], time: world.time, steps: r.matSteps };
      },
      budget: (v?: number) => {
        if (v !== undefined) budgetRef.current = v;
        return budgetRef.current;
      },
      dbg: () => ({
        running: runningRef.current,
        speed: speedRef.current,
        budget: budgetRef.current,
        matLen: matList.length,
        matSample: matList.slice(0, 4).map((it) => ({ slot: it.slot, wx: it.r.wx, wy: it.r.wy, sp: it.r.sp, steps: it.r.matSteps })),
        ema: +emaRef.current.toFixed(1),
        stepAcc: +stepAcc.toFixed(2),
        slotCount: slotTable.size,
      }),
      fps: () => fpsRef.current,
      speciesCount: SPECIES.length,
      place: (wx: number, wy: number, sp: number) => {
        const r = world.get(wx, wy);
        if (r.mat >= 0) engine.place(r.mat, sp, 0, DISH / 2, DISH / 2);
      },
      populate,
      clear,
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
      worldRef.current = null;
      delete (window as unknown as { __pond?: object }).__pond;
    };
  }, [pushFeed]);

  /* ---------- рендер ---------- */

  const speedLabel = SPEEDS[speedIdx] === 0.5 ? '×½' : `×${SPEEDS[speedIdx]}`;

  const startEvolution = () => {
    startedRef.current = true;
    setStarted(true);
    if (!pauseParamRef.current) setRunning(true);
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#040806] text-neutral-100" style={{ touchAction: 'none' }}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none select-none" aria-label="Пруд Лении" />
      <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />

      {error && (
        <div
          className="pointer-events-none absolute inset-x-0 z-50 flex justify-center px-3"
          style={{ top: 'max(5.5rem, calc(env(safe-area-inset-top) + 5.5rem))' }}
        >
          <div className="pointer-events-auto w-full max-w-sm rounded-2xl border border-rose-500/40 bg-rose-950/85 p-4 shadow-xl backdrop-blur">
            <p className="text-sm font-semibold text-rose-300">Симуляция остановилась</p>
            <p className="mt-1 break-words text-xs leading-relaxed text-neutral-400">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-3 h-10 w-full rounded-xl border border-rose-400/40 bg-rose-900/40 text-sm font-medium text-rose-100 transition-transform active:scale-95"
            >
              Перезапустить
            </button>
          </div>
        </div>
      )}

      {!started && !error && (
        <div
          data-testid="start-screen"
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
        >
          <div className="w-full max-w-sm rounded-3xl border border-emerald-500/25 bg-[#06110d]/92 p-6 shadow-2xl">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-emerald-400/80">клеточный автомат · Lenia</p>
            <h1 className="mt-1.5 text-3xl font-extrabold tracking-tight text-neutral-50">Пруд Лении</h1>
            <p className="mt-2 text-sm leading-relaxed text-neutral-400">
              Планета из бесконечных блюдцев. Существа ползут, делятся, мутируют, болеют вирусами и вымирают. Планета живёт своей жизнью — можно вмешаться.
            </p>
            <button
              onClick={startEvolution}
              data-testid="start"
              className="mt-5 flex h-14 w-full items-center justify-center gap-2.5 rounded-2xl bg-emerald-500 text-base font-bold text-emerald-950 shadow-lg shadow-emerald-500/25 transition-transform active:scale-95"
            >
              <Play className="h-5 w-5 fill-current" />
              Начать эволюцию
            </button>
            <div className="mt-4 space-y-1 text-[11px] leading-relaxed text-neutral-500">
              <p>Тап — к блюдцу · двойной тап — зум · щипок или колесо — масштаб</p>
              <p>Выбери существо внизу и тапни по блюдцу — поселить</p>
              <p>Вирусы, мутации и вымирания случаются сами — смотри ленту событий</p>
            </div>
          </div>
        </div>
      )}

      <Hud callbackRef={hudCbRef} />

      <div className="rail absolute right-[max(0.75rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))] z-20">
        <RailBtn onClick={() => setRunning((r) => !r)} testid="playpause" label={running ? 'Пауза' : 'Пуск'} active>
          {running ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
        </RailBtn>

        <button
          onClick={() => setSpeedIdx((i) => (i + 1) % SPEEDS.length)}
          data-testid="speed"
          aria-label="Скорость времени"
          className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-black/55 font-mono text-[13px] font-bold text-emerald-200 backdrop-blur transition-colors active:bg-emerald-900/50"
        >
          {speedLabel}
        </button>

        <RailBtn onClick={() => actionsRef.current.populate()} testid="populate" label="Заселить видимые блюдца">
          <Sprout className="h-5 w-5" />
        </RailBtn>

        <RailBtn onClick={() => actionsRef.current.clear()} testid="clear" label="Очистить видимые блюдца">
          <Trash2 className="h-5 w-5" />
        </RailBtn>

        <RailBtn onClick={() => setClimateOpen((v) => !v)} testid="climate" label="Климат блюдца" active={climateOpen}>
          <Thermometer className="h-5 w-5" />
        </RailBtn>

        <RailBtn onClick={() => actionsRef.current.overview()} testid="fit" label="Обзор планеты">
          <Maximize className="h-5 w-5" />
        </RailBtn>

        {installReady && (
          <RailBtn onClick={install} testid="install" label="Установить приложение" accent>
            <Download className="h-5 w-5" />
          </RailBtn>
        )}
      </div>

      {climateOpen && (
        <ClimatePanel
          onClose={() => setClimateOpen(false)}
          onSet={(k) => {
            const w = worldRef.current;
            const cam = camRef.current;
            if (!w) return;
            w.setClimate(Math.floor(cam.x), Math.floor(cam.y), k);
          }}
        />
      )}

      <div className="pointer-events-none absolute bottom-[max(5.5rem,calc(env(safe-area-inset-bottom)+5.5rem))] right-[max(0.75rem,env(safe-area-inset-right))] z-20 hidden flex-col gap-1.5 [@media(pointer:fine)]:flex">
        <button
          onClick={() => {
            const { w, h } = sizeRef.current;
            const cam = camRef.current;
            animRef.current = null;
            const px = w / 2;
            const py = h / 2;
            const wx = cam.x + (px - w / 2) / cam.scale;
            const wy = cam.y + (h / 2 - py) / cam.scale;
            cam.scale = Math.min(cam.scale * 1.6, Math.min(w, h) * 2 || 800);
            cam.x = wx;
            cam.y = wy;
          }}
          aria-label="Приблизить"
          className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-black/55 text-neutral-300 backdrop-blur transition-colors hover:bg-white/10"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          onClick={() => {
            const { w, h } = sizeRef.current;
            const cam = camRef.current;
            animRef.current = null;
            cam.scale = Math.max(cam.scale / 1.6, 3);
          }}
          aria-label="Отдалить"
          className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-black/55 text-neutral-300 backdrop-blur transition-colors hover:bg-white/10"
        >
          <Minus className="h-4 w-4" />
        </button>
      </div>

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
  const [snap, setSnap] = useState<HudSnap>({ t: 0, pop: 0, fps: 0, spName: '', climate: 0.5, placeable: false, real: false, planet: 0, events: [] });

  useEffect(() => {
    callbackRef.current = setSnap;
    return () => {
      callbackRef.current = () => {};
    };
  }, [callbackRef]);

  return (
    <div className="pointer-events-none absolute left-[max(0.75rem,env(safe-area-inset-left))] top-[max(0.75rem,env(safe-area-inset-top))] z-10 flex max-w-[54vw] flex-col gap-1.5">
      <div data-testid="hud-card" className="rounded-2xl border border-emerald-500/25 bg-black/55 px-3 py-1.5 backdrop-blur [@media(pointer:coarse)]:hidden [@media(max-width:767px)]:hidden">
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
          {snap.real ? `шаг ${snap.t.toFixed(0)}` : `эпоха ${snap.t}`} · {snap.fps} fps · планета {snap.planet}
        </p>
      </div>
      <div className="max-w-full" data-testid="feed">
        {snap.events.slice(0, 2).map((e) => (
          <p key={e.id} className={`truncate font-mono text-[10px] leading-4 backdrop-blur-sm ${FEED_COLORS[e.kind]}`}>
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
