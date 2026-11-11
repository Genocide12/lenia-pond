'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, Plus, Minus, Maximize, Sprout, Trash2, Download } from 'lucide-react';
import { POND_LIST, type Creature } from '@/lib/lenia/creatures';
import { PondEngine, speciesPalette, paletteColor, DISH, WORLD, LOD_LO, LOD_HI, type PondStats } from '@/lib/lenia/engine';
import { Biosphere, dishParams, DISH_CAP, POP_PER_MASS, type EcoRec, type FeedKind } from '@/lib/lenia/eco';
import { BlobTracker, type EventKind } from '@/lib/lenia/tracker';

const SPEED_MIN = 0.25;
const SPEED_MAX = 8;
const SPEED_PRESETS = [0.5, 1, 2, 4, 8];
const BASE_SPS = 12; // честных шагов Lenia на блюдце в секунду при ×1
const PLACE_PX = 220; // блюдце крупнее этого — тап сажает существо, меньше — перелёт
const STATS_MS = 500;
const ECO_MS = 500;
const GLOW_MS = 1500;
const MAT_OPS = 24; // новых материализаций за кадр (плавно, без фризов)
const MAT_MS = 200; // как часто пересобирается список желаемых блюдцев
const BUBBLE_PX = 12; // px на блюдце: 12..32 — материализуется пузырь вокруг камеры
const BUBBLE_R = 12; // радиус пузыря (блюдцев)

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

const fmtSpeed = (v: number) => '×' + (Math.abs(v - Math.round(v)) < 0.001 ? String(Math.round(v)) : String(Math.round(v * 100) / 100));

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
  real: boolean;
  planet: number;
  events: { id: number; kind: FeedItemKind; t: number; text: string }[];
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Сколько организмов посадить при материализации блюдца:
 *  минимум 4 — у колонии должен быть шанс основаться. */
const cnt = (r: EcoRec) => clamp(Math.round(r.pop * 0.22), 4, 48);

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PondEngine | null>(null);
  const worldRef = useRef<Biosphere | null>(null);
  const camRef = useRef({ x: WORLD / 2, y: WORLD / 2, scale: 60 });
  const animRef = useRef<{ t0: number; dur: number; from: { x: number; y: number; scale: number }; to: { x: number; y: number; scale: number } } | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const budgetRef = useRef(40); // шагов Lenia за кадр (адаптируется под устройство)
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
  const [speed, setSpeed] = useState(1);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const [installReady, setInstallReady] = useState(false);
  const startedRef = useRef(false);
  const pauseParamRef = useRef(false);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
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

    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
    if (engine.softGL) budgetRef.current = 0.35; // программный рендер — беречь

    const rsRef = { current: engine.softGL ? 0.5 : 1 }; // адаптивное разрешение рендера

    /* ---- слоты атласа: видимые блюдца материализуются, дальние — нет ---- */

    const SLOTS = engine.slotCount;
    const slotDish = new Int32Array(SLOTS).fill(-1); // слот → блюдце (ключ)
    const freeSlots: number[] = [];
    for (let i = SLOTS - 1; i >= 0; i--) freeSlots.push(i);
    let matCount = 0;
    let matRadius = 0; // радиус зоны материализации (блюдцев от камеры)

    const flushMeta = () => {
      for (const y of world.takeDirtyRows()) engine.setMetaRow(y, world.metaRow(y));
    };

    const releaseSlot = (slot: number) => {
      const k = slotDish[slot];
      if (k < 0) return;
      slotDish[slot] = -1;
      matCount--;
      const r = world.byKey(k);
      if (r && r.mat === slot) {
        r.mat = -1;
        world.touch(r);
      }
    };

    const allocSlot = (key: number): number => {
      let slot = freeSlots.pop();
      if (slot === undefined) {
        // выселяем блюдце, дальнее от камеры (вне зоны материализации)
        const cam = camRef.current;
        const nearLim = (matRadius * 1.3 + 2) * (matRadius * 1.3 + 2);
        let best = -1;
        let bestD = -1;
        for (let s = 0; s < SLOTS; s++) {
          const k = slotDish[s];
          if (k < 0) continue;
          const r = world.byKey(k);
          if (!r) {
            slotDish[s] = -1;
            best = s;
            bestD = 1e12;
            break;
          }
          const dx = r.wx - cam.x;
          const dy = r.wy - cam.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < nearLim) continue;
          if (d2 > bestD) {
            bestD = d2;
            best = s;
          }
        }
        if (best < 0) return -1;
        releaseSlot(best);
        flushMeta();
        slot = best;
      }
      slotDish[slot] = key;
      matCount++;
      engine.clearSlot(slot);
      return slot;
    };

    const releaseAndFree = (slot: number) => {
      releaseSlot(slot);
      engine.clearSlot(slot);
      freeSlots.push(slot);
    };

    /* ---- камера ---- */

    const minScale = () => {
      const m = Math.min(sizeRef.current.w, sizeRef.current.h);
      return m > 0 ? m / WORLD : 0.2; // вся планета вписывается в экран
    };
    const maxScale = () => Math.min(sizeRef.current.w, sizeRef.current.h) * 2 || 800;

    const clampCam = () => {
      const cam = camRef.current;
      const { w, h } = sizeRef.current;
      cam.scale = clamp(cam.scale, minScale(), maxScale());
      const vw = cam.scale > 0 ? w / cam.scale : WORLD;
      const vh = cam.scale > 0 ? h / cam.scale : WORLD;
      cam.x = vw >= WORLD ? WORLD / 2 : clamp(cam.x, vw / 2, WORLD - vw / 2);
      cam.y = vh >= WORLD ? WORLD / 2 : clamp(cam.y, vh / 2, WORLD - vh / 2);
    };

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

    const seedSafe = (wx: number, wy: number, sp: number, pop: number) => world.seedDish(wx, wy, sp, pop);
    const killSafe = (wx: number, wy: number) => {
      const r = world.peek(wx, wy);
      if (!r) return;
      if (r.mat >= 0) releaseAndFree(r.mat);
      world.killDish(wx, wy);
      flushMeta();
    };

    const zoomAt = (px: number, py: number, factor: number) => {
      const cam = camRef.current;
      const { w, h } = sizeRef.current;
      animRef.current = null;
      const wx = cam.x + (px - w / 2) / cam.scale;
      const wy = cam.y + (h / 2 - py) / cam.scale;
      cam.scale = clamp(cam.scale * factor, minScale(), maxScale());
      cam.x = wx - (px - w / 2) / cam.scale;
      cam.y = wy - (h / 2 - py) / cam.scale;
      clampCam();
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

    const wallPos = (fromDir: number): [number, number] => {
      const M = 22;
      const span = DISH - 2 * M;
      if (fromDir === 0) return [DISH - 20 - Math.random() * 8, M + Math.random() * span];
      if (fromDir === 1) return [20 + Math.random() * 8, M + Math.random() * span];
      if (fromDir === 2) return [M + Math.random() * span, DISH - 20 - Math.random() * 8];
      if (fromDir === 3) return [M + Math.random() * span, 20 + Math.random() * 8];
      return [DISH / 2, DISH / 2];
    };

    const hooks = {
      perturb: (slot: number, mode: number, seed: number) => engine.perturb(slot, mode, seed),
      clearSlot: (slot: number) => {
        releaseAndFree(slot);
        flushMeta();
      },
      placeImmigrant: (slot: number, sp: number, fromDir: number) => {
        const [lx, ly] = wallPos(fromDir);
        engine.placeAdd(slot, sp, Math.floor(Math.random() * 4), lx, ly);
      },
      feed: (kind: FeedKind, _wx: number, _wy: number) => pushFeed(kind, world.time, FEED_WORDS[kind]),
    };

    /* ---- старт: обзор всей планеты, жизнь зародится сама ---- */

    const q = new URLSearchParams(window.location.search);
    pauseParamRef.current = q.has('pause');
    resize();
    const cam0 = camRef.current;
    cam0.x = WORLD / 2;
    cam0.y = WORLD / 2;
    cam0.scale = minScale();
    const sp0 = q.get('speed');
    if (sp0) {
      const v = parseFloat(sp0);
      if (Number.isFinite(v) && v >= SPEED_MIN && v <= SPEED_MAX) {
        speedRef.current = v;
        queueMicrotask(() => setSpeed(v));
      }
    }
    engine.setMetaFull(world.metaBytes());

    /* ---- действия кнопок ---- */

    const populate = () => {
      if (!runningRef.current) {
        pushFeed('info', 0, 'на паузе — возобнови эволюцию, чтобы заселять');
        return;
      }
      const cam = camRef.current;
      let n = 0;
      for (let attempt = 0; attempt < 500 && n < 40; attempt++) {
        const wx = Math.round(cam.x + (Math.random() - 0.5) * 26);
        const wy = Math.round(cam.y + (Math.random() - 0.5) * 26);
        if (!world.inWorld(wx, wy) || world.peek(wx, wy)) continue;
        seedSafe(wx, wy, Math.floor(Math.random() * SPECIES.length), 4 + Math.random() * 7);
        n++;
      }
      if (n > 0) {
        guardRef.current = performance.now();
        pushFeed('info', 0, `жизнь засеяна: ${n} блюдцев рядом`);
      }
    };

    // «Очистить» стирает ВСЮ планету: каждое блюдце, вся жизнь
    const clear = () => {
      engine.clearAll();
      slotDish.fill(-1);
      freeSlots.length = 0;
      for (let i = SLOTS - 1; i >= 0; i--) freeSlots.push(i);
      matCount = 0;
      matRadius = 0;
      matList.length = 0;
      world.reset(); // новая история зарождений
      engine.setMetaFull(world.metaBytes());
      glowsRef.current = [];
      feedRef.current = [];
      trackerRef.current.reset();
      pushFeed('info', 0, 'планета очищена — жизнь зарождается заново');
    };

    const overview = () => flyTo(WORLD / 2, WORLD / 2, minScale());

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
      if (camRef.current.scale >= PLACE_PX && world.inWorld(dx, dy)) {
        if (isDouble) return;
        if (!runningRef.current) {
          // на паузе новые организмы не добавляются
          pushFeed('info', 0, 'на паузе — возобнови эволюцию, чтобы заселять');
          return;
        }
        const sp = selRef.current;
        const had = world.peek(dx, dy);
        if (!had || had.sp !== sp) world.seedDish(dx, dy, sp, had && had.sp >= 0 ? Math.max(3, had.pop) : 1);
        const r = world.peek(dx, dy);
        if (!r) return;
        let slot = r.mat;
        if (slot < 0) {
          slot = allocSlot(world.key(dx, dy));
          if (slot < 0) return;
          r.mat = slot;
          r.matSerial = r.serial;
          r.matSteps = 0;
          r.mass = Math.max(0.004, r.pop / POP_PER_MASS);
          world.touch(r);
          flushMeta();
        }
        engine.placeAdd(slot, sp, Math.floor(Math.random() * 4), (wpt.x - dx) * DISH, (wpt.y - dy) * DISH);
        r.matSerial = r.serial; // существо уже посажено — пересев не нужен
        guardRef.current = now;
        pushFeed('info', 0, `посажен: ${SPECIES[sp].ru.toLowerCase()}`);
        return;
      }
      if (isDouble) zoomAt(px, py, 2.2);
      else flyTo(clamp(dx + 0.5, 0.5, WORLD - 0.5), clamp(dy + 0.5, 0.5, WORLD - 0.5), Math.min(sizeRef.current.w, sizeRef.current.h));
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
          clampCam();
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
          if (idx < SPEED_PRESETS.length) setSpeed(SPEED_PRESETS[idx]);
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
          if (!runningRef.current) break; // на паузе заселение отключено
          const fd = focusDish();
          if (!world.peek(fd.x, fd.y)) seedSafe(fd.x, fd.y, selRef.current, 3);
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
    let frameDt = 0; // секунд с прошлого кадра (для темпа симуляции)
    let frames = 0;
    let stepAcc = 0;
    let cursor = 0;
    let lastFocus = '';
    let lastDi = { x: 1 << 30, y: 1 << 30 };
    const aliveList: EcoRec[] = [];
    const matList: number[] = []; // блюдца, желающие материализоваться (ключи)
    let matStamp = 0;

    /** Пересобрать список желаемых блюдцев: видимая область при большом
     *  зуме, пузырь вокруг камеры — при среднем. Ближние — первыми. */
    const updateMaterialization = (now: number) => {
      const cam = camRef.current;
      const { w, h } = sizeRef.current;
      const scale = cam.scale;
      const want: number[] = [];
      let radius = 0;
      if (scale >= LOD_LO) {
        const vx0 = Math.floor(cam.x - w / (2 * scale)) - 1;
        const vx1 = Math.ceil(cam.x + w / (2 * scale)) + 1;
        const vy0 = Math.floor(cam.y - h / (2 * scale)) - 1;
        const vy1 = Math.ceil(cam.y + h / (2 * scale)) + 1;
        radius = Math.max(vx1 - vx0, vy1 - vy0) / 2 + 2;
        for (const [k, r] of world.recs) {
          if (r.wx >= vx0 && r.wx <= vx1 && r.wy >= vy0 && r.wy <= vy1) want.push(k);
        }
      } else if (scale >= BUBBLE_PX) {
        radius = BUBBLE_R;
        for (const [k, r] of world.recs) {
          if (Math.abs(r.wx - cam.x) <= BUBBLE_R && Math.abs(r.wy - cam.y) <= BUBBLE_R) want.push(k);
        }
      }
      want.sort((a, b) => {
        const ra = world.byKey(a)!;
        const rb = world.byKey(b)!;
        const da = (ra.wx - cam.x) * (ra.wx - cam.x) + (ra.wy - cam.y) * (ra.wy - cam.y);
        const db = (rb.wx - cam.x) * (rb.wx - cam.x) + (rb.wy - cam.y) * (rb.wy - cam.y);
        return da - db;
      });
      matList.length = 0;
      matList.push(...want);
      matRadius = radius;
      matStamp = now;
    };

    const scan = (now: number) => {
      const fd = focusDish();
      if (fd.x !== lastDi.x || fd.y !== lastDi.y) {
        lastDi = fd;
        trackerRef.current.reset();
        glowsRef.current = [];
        lastFocus = '';
      }
      const r = world.peek(fd.x, fd.y);
      let st: PondStats = { mass: 0, pop: 0, blobs: [] };
      let t = 0;
      let events: { kind: EventKind; t: number; x: number; y: number }[] = [];
      const real = !!r && r.mat >= 0;
      if (real) {
        st = engine.stats(r!.mat);
        t = r!.matSteps * (1 / SPECIES[r!.sp].T);
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

      const key = `${r ? r.sp : -1}|${r ? r.mat : -1}`;
      if (key !== lastFocus || now - lastStats >= STATS_MS) {
        lastFocus = key;
        hudCbRef.current({
          t,
          pop: real ? st.pop : r ? Math.round(r.pop) : 0,
          fps: Math.round(fpsRef.current),
          spName: r && r.sp >= 0 ? SPECIES[r.sp].ru : 'пусто',
          real,
          planet: world.aliveCount(),
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
            frameDt = Math.min(0.25, dt / 1000);
          }
        } else frameDt = 0;
        lastFrame = now;

        // адаптация под устройство: бюджет шагов и разрешение рендера (цель — не ниже ~50 fps).
        // падение — мгновенное (каждый кадр), рост — осторожный
        if (emaRef.current > 21) budgetRef.current = Math.max(engine.softGL ? 0.5 : 8, budgetRef.current * 0.92);
        if (++frames % 10 === 0) {
          if (emaRef.current < 14.5) budgetRef.current = Math.min(engine.softGL ? 3 : 700, budgetRef.current * 1.3 + 3);
          const rs = rsRef.current;
          if (emaRef.current > 22 && rs > 0.45) {
            rsRef.current = Math.max(0.45, rs * 0.85);
            resize();
          } else if (emaRef.current < 13 && rs < 1) {
            rsRef.current = Math.min(1, rs * 1.12);
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
        clampCam();

        const cam = camRef.current;
        const { w, h } = sizeRef.current;
        const cdx = Math.floor(cam.x);
        const cdy = Math.floor(cam.y);
        const vx0 = Math.floor(cam.x - w / (2 * cam.scale));
        const vx1 = Math.ceil(cam.x + w / (2 * cam.scale));
        const vy0 = Math.floor(cam.y - h / (2 * cam.scale));
        const vy1 = Math.ceil(cam.y + h / (2 * cam.scale));
        visRef.current = { x0: vx0, y0: vy0, x1: vx1, y1: vy1, count: (vx1 - vx0) * (vy1 - vy0) };

        // материализация: блюдце получает слот, когда попадает в зону
        // детализации у камеры; при отдалении слот освобождается, но жизнь
        // блюдца продолжает течь статистически — без обнулений и blanks
        if (now - matStamp > MAT_MS) updateMaterialization(now);
        let ops = 0;
        for (const key of matList) {
          const r = world.byKey(key);
          if (!r || r.mat >= 0) continue;
          if (ops >= MAT_OPS) break;
          const slot = allocSlot(key);
          if (slot < 0) break;
          r.mat = slot;
          r.matSerial = r.serial;
          r.matSteps = 0;
          r.mass = Math.max(0.004, r.pop / POP_PER_MASS);
          engine.seedSlot(slot, r.sp, cnt(r), r.fromDir);
          world.touch(r);
          ops++;
        }
        if (ops > 0) flushMeta();
        if (matRadius > 0) {
          // выселяем блюдца, ушедшие далеко от зоны детализации
          let freed = 0;
          const lim = (matRadius * 1.7 + 2) * (matRadius * 1.7 + 2);
          for (let s = 0; s < SLOTS && freed < 8; s++) {
            const k = slotDish[s];
            if (k < 0) continue;
            const r = world.byKey(k);
            if (!r) {
              slotDish[s] = -1;
              matCount--;
              freeSlots.push(s);
              continue;
            }
            const dx = r.wx - cam.x;
            const dy = r.wy - cam.y;
            if (dx * dx + dy * dy > lim) {
              releaseAndFree(s);
              freed++;
            }
          }
          if (freed > 0) flushMeta();
        }

        // живые материализованные блюдца
        aliveList.length = 0;
        for (let s = 0; s < SLOTS; s++) {
          const k = slotDish[s];
          if (k < 0) continue;
          const r = world.byKey(k);
          if (r && r.mat === s) aliveList.push(r);
          else if (r && r.mat !== s) {
            // слот уже не принадлежит блюдцу — почистим
            slotDish[s] = -1;
            matCount--;
            freeSlots.push(s);
          } else {
            slotDish[s] = -1;
            matCount--;
            freeSlots.push(s);
          }
        }

        // честные шаги Lenia: каждое блюдце хочет BASE_SPS×скорость шагов
        // в СЕКУНДУ (не на кадр — темп не зависит от fps устройства).
        // Блюдца у камеры получают полный темп первыми — скорость всегда видна
        if (runningRef.current && aliveList.length > 0) {
          stepAcc += BASE_SPS * speedRef.current * frameDt * aliveList.length;
          let n = Math.floor(stepAcc);
          const cap = Math.min(Math.round(budgetRef.current), engine.softGL ? 3 : 700);
          if (n > cap) {
            n = cap;
            stepAcc = 0;
          } else stepAcc -= n;
          // ближний круг (радиус 3 блюдца от камеры) всегда получает свой
          // полный темп — влияние скорости видно при любом бюджете устройства
          const share = Math.max(1, Math.round(BASE_SPS * speedRef.current * frameDt));
          const nearCap = engine.softGL ? 4 : 400;
          let done = 0;
          for (let i = 0; i < aliveList.length && done < nearCap; i++) {
            const r = aliveList[i];
            const dx = r.wx - cam.x;
            const dy = r.wy - cam.y;
            if (dx * dx + dy * dy > 9) continue; // только ближний круг
            for (let k2 = 0; k2 < share && done < nearCap; k2++) {
              engine.stepSlot(r.mat, dishParams(r));
              r.matSteps++;
              done++;
            }
          }
          let rest = n - done;
          if (rest < 0) rest = 0;
          while (rest > 0) {
            const r = aliveList[cursor++ % aliveList.length];
            engine.stepSlot(r.mat, dishParams(r));
            r.matSteps++;
            rest--;
          }
        }

        // LOD нужен для рендера только при отдалении; на программном рендере — реже
        if (matCount > 0 && cam.scale < LOD_HI && (!engine.softGL || frames % 3 === 0)) engine.genLod();
        engine.regenMetaMips();
        engine.render(cam, { x: cdx, y: cdy }, now / 1000, dpr * rsRef.current);
        drawGlows(now);

        const ecoEvery = engine.softGL ? 1000 : ECO_MS;
        if (now - lastEco >= ecoEvery) {
          lastEco = now;
          if (matCount > 0) {
            if (cam.scale >= LOD_HI) engine.genLod(); // свежий LOD для проб масс
            world.syncMasses(slotDish, engine.readLod(), engine.lodTexSide, engine.slotSide);
          }
          world.setCamera(cdx, cdy);
          if (runningRef.current) world.tick(0.5 * (ecoEvery / 500) * speedRef.current, hooks); // на паузе планета замерла
          world.buildMeta();
          flushMeta();
        }
        if (now - lastStats >= (engine.softGL ? 1000 : STATS_MS)) {
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
        clampCam();
      },
      speed: (v?: number) => {
        if (v !== undefined) {
          const c = clamp(v, SPEED_MIN, SPEED_MAX);
          speedRef.current = c;
          setSpeed(c);
        }
        return speedRef.current;
      },
      vis: () => visRef.current,
      world: () => ({ dishes: WORLD, cells: WORLD * DISH, slots: SLOTS, slotSide: engine.slotSide }),
      matCount: () => matCount,
      eco: (wx: number, wy: number) => {
        const r = world.peek(wx, wy);
        return r
          ? { sp: r.sp, spName: SPECIES[r.sp].ru, pop: r.pop, mass: r.mass, mat: r.mat, serial: r.serial, mut: [...r.mut], emitAt: r.emitAt, time: world.time }
          : null;
      },
      aliveCount: () => world.aliveCount(),
      aliveNear: (rad: number) => world.aliveNear(rad),
      tick: (n = 1) => {
        for (let i = 0; i < n; i++) world.tick(0.5, hooks);
        world.buildMeta();
        flushMeta();
      },
      stepDish: (wx: number, wy: number, n: number) => {
        const r = world.peek(wx, wy);
        if (r && r.mat >= 0) {
          for (let i = 0; i < n; i++) engine.stepSlot(r.mat, dishParams(r));
          r.matSteps += n;
        }
      },
      seedDish: (wx: number, wy: number, sp: number, pop = 6) => seedSafe(wx, wy, sp, pop),
      killDish: (wx: number, wy: number) => killSafe(wx, wy),
      perturb: (wx: number, wy: number, mode: number) => {
        const r = world.peek(wx, wy);
        if (r && r.mat >= 0) engine.perturb(r.mat, mode, Math.random() * 100);
      },
      stats: (wx?: number, wy?: number) => {
        let r: EcoRec | null = null;
        if (wx !== undefined && wy !== undefined) r = world.peek(wx, wy);
        else {
          const fd = focusDish();
          r = world.peek(fd.x, fd.y);
        }
        return r && r.mat >= 0 ? engine.stats(r.mat) : { mass: 0, pop: 0, blobs: [] };
      },
      focusInfo: () => {
        const fd = focusDish();
        const r = world.peek(fd.x, fd.y);
        return r
          ? { dish: fd, sp: r.sp, spName: SPECIES[r.sp].ru, pop: r.pop, mass: r.mass, mat: r.mat, serial: r.serial, mut: [...r.mut], time: world.time, steps: r.matSteps }
          : { dish: fd, sp: -1, spName: '-', pop: 0, mass: 0, mat: -1, serial: 0, mut: [0, 1, 0], time: world.time, steps: 0 };
      },
      budget: (v?: number) => {
        if (v !== undefined) budgetRef.current = v;
        return budgetRef.current;
      },
      dbg: () => ({
        running: runningRef.current,
        speed: speedRef.current,
        budget: budgetRef.current,
        alive: aliveList.length,
        matCount,
        matRadius,
        ema: +emaRef.current.toFixed(1),
        stepAcc: +stepAcc.toFixed(2),
      }),
      fps: () => fpsRef.current,
      speciesCount: SPECIES.length,
      place: (wx: number, wy: number, sp: number) => {
        const had = world.peek(wx, wy);
        if (!had) world.seedDish(wx, wy, sp, 1);
        const r = world.peek(wx, wy);
        if (!r) return;
        let slot = r.mat;
        if (slot < 0) {
          slot = allocSlot(world.key(wx, wy));
          if (slot < 0) return;
          r.mat = slot;
          r.matSerial = r.serial;
          r.matSteps = 0;
          r.mass = Math.max(0.004, r.pop / POP_PER_MASS);
          engine.clearSlot(slot);
          world.touch(r);
          flushMeta();
        }
        engine.placeAdd(slot, sp, 0, DISH / 2, DISH / 2);
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
              Планета из 2000×2000 блюдцев. Жизнь зарождается в разных уголках, в разное время и разных видов. Организмы чувствуют стены своего блюдца и
              заполняют его — все 200 существ — и лишь потом колония переливается в соседние, мутирует и борется за территорию.
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
              <p>Пробел — пауза · на паузе заселение отключено</p>
              <p>Выбери существо внизу и тапни по блюдцу — поселить</p>
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
          onClick={() => setSpeedOpen((v) => !v)}
          data-testid="speed"
          aria-label="Скорость времени"
          className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-black/55 font-mono text-[13px] font-bold text-emerald-200 backdrop-blur transition-colors active:bg-emerald-900/50"
        >
          {fmtSpeed(speed)}
        </button>

        <RailBtn onClick={() => actionsRef.current.populate()} testid="populate" label="Заселить блюдца рядом">
          <Sprout className="h-5 w-5" />
        </RailBtn>

        <RailBtn onClick={() => actionsRef.current.clear()} testid="clear" label="Очистить всю планету">
          <Trash2 className="h-5 w-5" />
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

      {speedOpen && <SpeedPanel value={speed} onChange={setSpeed} onClose={() => setSpeedOpen(false)} />}

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
            const cam = camRef.current;
            animRef.current = null;
            cam.scale = Math.max(cam.scale / 1.6, Math.min(sizeRef.current.w, sizeRef.current.h) / WORLD || 3);
            const { w, h } = sizeRef.current;
            const vw = w / cam.scale;
            const vh = h / cam.scale;
            cam.x = vw >= WORLD ? WORLD / 2 : clamp(cam.x, vw / 2, WORLD - vw / 2);
            cam.y = vh >= WORLD ? WORLD / 2 : clamp(cam.y, vh / 2, WORLD - vh / 2);
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

/* ---------- панель скорости ---------- */

function SpeedPanel({ value, onChange, onClose }: { value: number; onChange: (v: number) => void; onClose: () => void }) {
  return (
    <>
      <button className="fixed inset-0 z-10 cursor-default" onClick={onClose} aria-label="Закрыть" tabIndex={-1} />
      <div
        data-testid="speed-panel"
        className="absolute z-20 w-60 rounded-2xl border border-white/10 bg-[#0b1512]/95 p-3.5 shadow-xl backdrop-blur"
        style={{ right: 'max(4rem, calc(env(safe-area-inset-right) + 4rem))', top: 'max(3.4rem, calc(env(safe-area-inset-top) + 3.4rem))' }}
      >
        <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-300/80">Скорость времени</p>
        <p className="mt-0.5 font-mono text-lg font-bold text-emerald-200">{fmtSpeed(value)}</p>
        <input
          id="speed-slider"
          data-testid="speed-slider"
          type="range"
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={0.05}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="mt-2 w-full cursor-pointer accent-emerald-400"
        />
        <div className="mt-0.5 flex justify-between font-mono text-[9px] text-neutral-500">
          <span>×¼</span>
          <span>×2</span>
          <span>×8</span>
        </div>
        <div className="mt-2.5 grid grid-cols-5 gap-1">
          {SPEED_PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => onChange(p)}
              className={`rounded-lg border px-1 py-1.5 font-mono text-[11px] transition-colors ${
                Math.abs(value - p) < 0.001 ? 'border-emerald-400/60 bg-emerald-900/50 text-emerald-100' : 'border-white/10 bg-white/[0.03] text-neutral-300'
              }`}
            >
              {p === 0.5 ? '½' : p}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/* ---------- HUD: наблюдение за блюдцем под центром ---------- */

function Hud({ callbackRef }: { callbackRef: { current: (s: HudSnap) => void } }) {
  const [snap, setSnap] = useState<HudSnap>({ t: 0, pop: 0, fps: 0, spName: '', real: false, planet: 0, events: [] });

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
        <p className="mt-0.5 truncate text-[11px] text-neutral-400">{snap.spName}</p>
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
