'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, Plus, Minus, Maximize, Sprout, Trash2, Download } from 'lucide-react';
import { POND_LIST, type Creature } from '@/lib/lenia/creatures';
import { PondEngine, speciesColorJS, DISH, WORLD, LOD_HI } from '@/lib/lenia/engine';
import { Biosphere, POP_PER_MASS, type EcoRec } from '@/lib/lenia/eco';

const SPEED_MIN = 1;
const SPEED_MAX = 100;
const SPEED_PRESETS = [1, 2, 5, 10, 50, 100];
const BASE_SPS = 12; // честных шагов Lenia на блюдце в секунду при ×1
const PLACE_PX = 220; // блюдце крупнее этого — тап сажает существо, меньше — перелёт
const ECO_MS = 500;
const MAT_OPS = 24; // новых материализаций за кадр (плавно, без фризов)
const MAT_MS = 200; // как часто пересобирается список желаемых блюдцев
const BUBBLE_PX = 12; // px на блюдце: 12..14 — материализуется пузырь вокруг камеры
const BUBBLE_R = 12; // минимальный радиус пузыря (блюдцев)
const MAT_VIS_PX = 14; // px на блюдце: выше — материализуются все видимые блюдца
const SPAWN_MS = 200; // период появления организмов при удержании нажатия

const SPECIES: Creature[] = POND_LIST;

const fmtSpeed = (v: number) => '×' + (Math.abs(v - Math.round(v)) < 0.001 ? String(Math.round(v)) : String(Math.round(v * 100) / 100));

interface VisRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  count: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Сколько организмов посадить при материализации блюдца: колония,
 *  соответствующая статистической популяции (≈0.012 массы на организм) —
 *  при приближении камеры пятно НЕ схлопывается в точку, а продолжается
 *  той же жизнью. Без «ста организмов сразу»: максимум 28, дальше —
 *  честный рост самой Lenia. */
const cnt = (r: EcoRec) => clamp(Math.round(r.pop * 0.22), 4, 28);

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PondEngine | null>(null);
  const worldRef = useRef<Biosphere | null>(null);
  const camRef = useRef({ x: WORLD / 2, y: WORLD / 2, scale: 60 });
  const animRef = useRef<{ t0: number; dur: number; from: { x: number; y: number; scale: number }; to: { x: number; y: number; scale: number } } | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const budgetRef = useRef(120); // шагов Lenia за кадр (адаптируется под устройство)
  const fpsRef = useRef(0);
  const emaRef = useRef(16.7);
  const runningRef = useRef(true);
  const speedRef = useRef(1);
  const selRef = useRef(0);
  const visRef = useRef<VisRect | null>(null);
  const guardRef = useRef(0);
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
    if (!canvas) return;
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

    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
    if (engine.softGL) budgetRef.current = 6; // программный рендер — беречь

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
      perturb: (slot: number, mode: number, seed: number, k?: number) => engine.perturb(slot, mode, seed, k ?? 1),
      clearSlot: (slot: number) => {
        releaseAndFree(slot);
        flushMeta();
      },
      placeImmigrant: (slot: number, sp: number, fromDir: number) => {
        const [lx, ly] = wallPos(fromDir);
        engine.placeAdd(slot, world.speciesBase(sp), Math.floor(Math.random() * 4), lx, ly);
      },
      feed: () => {
        /* ни текстового лога, ни вспышек событий: ничего лишнего не
         * рисуется и не анализируется — кадр максимально лёгкий */
      },
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
      if (!runningRef.current) return;
      // зарождение жизни: ОДНО блюдце, ОДИН вид — маленькая колония
      // выбранных существ рядом с центром обзора
      const cam = camRef.current;
      const sp = selRef.current;
      const cx = Math.round(cam.x);
      const cy = Math.round(cam.y);
      let best: { x: number; y: number; d: number } | null = null;
      for (let rad = 0; rad <= 12 && !best; rad++) {
        for (let dy = -rad; dy <= rad && !best; dy++) {
          for (let dx = -rad; dx <= rad; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
            const wx = cx + dx;
            const wy = cy + dy;
            if (!world.inWorld(wx, wy) || world.peek(wx, wy)) continue;
            const d = dx * dx + dy * dy;
            if (!best || d < best.d) best = { x: wx, y: wy, d };
          }
        }
      }
      if (!best) return;
      seedSafe(best.x, best.y, sp, 4);
      guardRef.current = performance.now();
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
    };

    const overview = () => flyTo(WORLD / 2, WORLD / 2, minScale());

    actionsRef.current = { populate, clear, overview };

    /* ---- ввод ---- */

    type P = { x: number; y: number; sx: number; sy: number; t: number; moved: boolean };
    const pointers = new Map<number, P>();
    let pinch: { dist0: number; scale0: number; wx: number; wy: number } | null = null;

    const focusDish = () => ({ x: Math.floor(camRef.current.x), y: Math.floor(camRef.current.y) });

    /* ---- поселение организмов ---- */

    /** Поселить ОДИН организм вида sp в блюдце (wx, wy), локально в (lx, ly).
     *  Никогда не трогает чужую жизнь: пустое блюдце — новая колония,
     *  свой вид — подселение в колонию, чужой вид — ближайшее свободное
     *  блюдце рядом. Никто никого не убивает и не заменяет. */
    const placeWorld = (wx: number, wy: number, sp: number, lx: number, ly: number): boolean => {
      if (!world.inWorld(wx, wy)) return false;
      const had = world.peek(wx, wy);
      let tx = wx;
      let ty = wy;
      if (had && world.speciesBase(had.sp) !== sp) {
        // в чужом блюдце новая жизнь не селится — ищем свободное рядом,
        // чтобы хозяин продолжал жить своей физикой
        let found: { x: number; y: number } | null = null;
        for (let rad = 1; rad <= 8 && !found; rad++) {
          for (let dy2 = -rad; dy2 <= rad && !found; dy2++) {
            for (let dx2 = -rad; dx2 <= rad && !found; dx2++) {
              if (Math.max(Math.abs(dx2), Math.abs(dy2)) !== rad) continue;
              const nx = wx + dx2;
              const ny = wy + dy2;
              if (world.inWorld(nx, ny) && !world.peek(nx, ny)) found = { x: nx, y: ny };
            }
          }
        }
        if (!found) return false; // места рядом нет — жизнь блюдца не трогаем
        tx = found.x;
        ty = found.y;
        lx = DISH / 2 + (Math.random() - 0.5) * 36;
        ly = DISH / 2 + (Math.random() - 0.5) * 36;
        world.seedDish(tx, ty, sp, 1);
      } else if (!had) {
        world.seedDish(wx, wy, sp, 1);
      }
      const r = world.peek(tx, ty);
      if (!r) return false;
      let slot = r.mat;
      if (slot < 0) {
        slot = allocSlot(world.key(tx, ty));
        if (slot < 0) return false;
        r.mat = slot;
        r.matSerial = r.serial;
        r.matSteps = 0;
        r.mass = Math.max(0.004, r.pop / POP_PER_MASS);
        r.seedMass = r.mass; // приживление без обвала пятна
      }
      engine.placeAdd(slot, sp, Math.floor(Math.random() * 4), lx, ly);
      r.matSerial = r.serial; // организм уже на GPU — пересев не нужен
      world.touch(r);
      flushMeta();
      guardRef.current = performance.now();
      return true;
    };

    /* ---- удержание нажатия: организмы появляются, пока держишь ---- */

    let spawnTimer = 0;
    let spawnPid = -1;
    const stopSpawn = () => {
      if (spawnTimer) window.clearInterval(spawnTimer);
      spawnTimer = 0;
      spawnPid = -1;
    };
    const spawnAt = (px: number, py: number): boolean => {
      if (!runningRef.current) return false;
      const wpt = screenToWorld(px, py);
      const dx = Math.floor(wpt.x);
      const dy = Math.floor(wpt.y);
      return placeWorld(dx, dy, selRef.current, (wpt.x - dx) * DISH, (wpt.y - dy) * DISH);
    };
    const startSpawn = (pid: number, px: number, py: number) => {
      stopSpawn();
      if (!spawnAt(px, py)) return; // мимо мира или нет места — не начинаем
      spawnPid = pid;
      spawnTimer = window.setInterval(() => {
        if (!spawnAt(px, py)) stopSpawn();
      }, SPAWN_MS);
    };

    const onDown = (e: PointerEvent) => {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* capture не критична */
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), moved: false });
      // одиночное нажатие крупным планом — начинается посев: организмы
      // появляются, пока палец/кнопка мыши удерживается
      if (pointers.size === 1 && runningRef.current && camRef.current.scale >= PLACE_PX) {
        const rect = canvas.getBoundingClientRect();
        startSpawn(e.pointerId, e.clientX - rect.left, e.clientY - rect.top);
      }
      if (pointers.size === 2) {
        stopSpawn();
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
      if (p.moved && spawnPid === e.pointerId) stopSpawn(); // повели палец — это панорама, не посев
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
      if (spawnPid === e.pointerId) stopSpawn();
      if (p && !p.moved && performance.now() - p.t < 400 && pointers.size === 0) {
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const wpt = screenToWorld(px, py);
        const dx = Math.floor(wpt.x);
        const dy = Math.floor(wpt.y);
        if (camRef.current.scale >= PLACE_PX) {
          // вблизи организмы уже посеяны при нажатии; клик по бездне вне
          // планеты — мягкий перелёт туда
          if (!world.inWorld(dx, dy)) flyTo(clamp(dx + 0.5, 0.5, WORLD - 0.5), clamp(dy + 0.5, 0.5, WORLD - 0.5), Math.min(sizeRef.current.w, sizeRef.current.h));
          return;
        }
        const now = performance.now();
        const lt = lastTapRef.current;
        const isDouble = now - lt.t < 320 && Math.hypot(px - lt.x, py - lt.y) < 36;
        lastTapRef.current = { t: now, x: px, y: py };
        if (isDouble) zoomAt(px, py, 2.2);
        else flyTo(clamp(dx + 0.5, 0.5, WORLD - 0.5), clamp(dy + 0.5, 0.5, WORLD - 0.5), Math.min(sizeRef.current.w, sizeRef.current.h));
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
        case 'Digit5':
        case 'Digit6': {
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

    let lastEco = 0;
    let lastFrame = 0;
    let frameDt = 0; // секунд с прошлого кадра (для темпа симуляции)
    let frames = 0;
    let stepAcc = 0;
    let cursor = 0;
    const aliveList: EcoRec[] = [];
    const matList: number[] = []; // блюдца, желающие материализоваться (ключи)
    let matStamp = 0;
    // переиспользуемые структуры — ноль аллокаций в кадре (без утечек и GC-фризов)
    const zoneAKeys = new Set<number>();
    const cacheFor = new Int16Array(SLOTS);
    const nearList: EcoRec[] = [];
    const farList: EcoRec[] = [];
    const farSteps: number[] = [];
    const stepPool: { slot: number; sp: number; m: number; s: number; T: number }[] = [];
    for (let i = 0; i < 2048; i++) stepPool.push({ slot: 0, sp: 0, m: 0.15, s: 0.015, T: 10 });
    let lodRenderRev = -1;
    let lodReadRev = -1;

    /** Пересобрать список желаемых блюдцев: видимая область при большом
     *  зуме, пузырь вокруг камеры — при среднем. Ближние — первыми. */
    const updateMaterialization = (now: number) => {
      const cam = camRef.current;
      const { w, h } = sizeRef.current;
      const scale = cam.scale;
      const want: number[] = [];
      zoneAKeys.clear();
      let radius = 0;
      if (scale >= MAT_VIS_PX) {
        const vx0 = Math.floor(cam.x - w / (2 * scale)) - 1;
        const vx1 = Math.ceil(cam.x + w / (2 * scale)) + 1;
        const vy0 = Math.floor(cam.y - h / (2 * scale)) - 1;
        const vy1 = Math.ceil(cam.y + h / (2 * scale)) + 1;
        radius = Math.max(vx1 - vx0, vy1 - vy0) / 2 + 2;
        for (const [k, r] of world.recs) {
          if (r.wx >= vx0 && r.wx <= vx1 && r.wy >= vy0 && r.wy <= vy1) {
            want.push(k);
            zoneAKeys.add(k);
          }
        }
      } else if (scale >= BUBBLE_PX) {
        // пузырь материализации вокруг камеры — покрывает экран (с запасом),
        // чтобы движущиеся существа в поле зрения сохраняли первозданный вид
        radius = clamp(Math.ceil(Math.min(w, h) / scale / 2) + 2, BUBBLE_R, 26);
        for (const [k, r] of world.recs) {
          if (Math.abs(r.wx - cam.x) <= radius && Math.abs(r.wy - cam.y) <= radius) {
            want.push(k);
            zoneAKeys.add(k);
          }
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
        // ema — реальное время КАДРА: в нём видно и опустошение очереди GPU,
        // поэтому падение бюджета происходит и при GPU-перегрузе, а не только
        // при тормозах JS. Падение — мгновенное, рост — осторожный.
        if (emaRef.current > 21) budgetRef.current = Math.max(engine.softGL ? 0.5 : 8, budgetRef.current * (emaRef.current > 26 ? 0.85 : 0.93));
        if (++frames % 10 === 0) {
          if (emaRef.current < 14.5) budgetRef.current = Math.min(engine.softGL ? 3 : 700, budgetRef.current * 1.12 + 1);
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
        // детализации у камеры. При выходе из зоны слот НЕ стирается —
        // жизнь блюдца кэшируется ещё несколько тиков, и при возврате
        // камеры колония продолжается с того же места (без всхлопываний)
        if (now - matStamp > MAT_MS) updateMaterialization(now);
        let ops = 0;
        for (const key of matList) {
          const r = world.byKey(key);
          if (!r || r.mat >= 0) continue; // закэшированное блюдце уже живо
          if (ops >= MAT_OPS) break;
          const slot = allocSlot(key);
          if (slot < 0) break;
          r.mat = slot;
          r.matSerial = r.serial;
          r.matSteps = 0;
          r.mass = Math.max(0.004, r.pop / POP_PER_MASS);
          r.seedMass = r.mass; // льготный пол: пятно не гаснет при приближении
          engine.seedSlot(slot, world.speciesBase(r.sp), cnt(r), r.fromDir);
          world.touch(r);
          ops++;
        }
        if (ops > 0) flushMeta();

        // живые материализованные блюдца зоны детализации
        aliveList.length = 0;
        for (const key of matList) {
          const r = world.byKey(key);
          if (r && r.mat >= 0) aliveList.push(r);
        }

        // честные шаги Lenia — ИНСТАНСИРОВАННЫМИ пакетами: один проход
        // на все блюдца вместо пары draw call на каждое. Ближний круг
        // всегда получает полный темп — скорость видна при любом бюджете.
        // pace масштабирует объём шагов по реальному времени кадра:
        // очередь GPU опустошается, кадры выравниваются — без «дёрганого
        // перегруза», который раньше превращался в многосекундные лаги.
        if (runningRef.current && aliveList.length > 0) {
          stepAcc += BASE_SPS * speedRef.current * frameDt;
          const share = Math.floor(stepAcc);
          stepAcc -= share;
          if (share > 0) {
            const pace = clamp(16.7 / Math.max(emaRef.current, 0.5), 0.12, 1);
            nearList.length = 0;
            farList.length = 0;
            for (const r of aliveList) {
              // остывшее блюдце (жизнь угасла на GPU) не шагаем — eco скоро
              // похоронит его честно, а пустые свёртки только жгли время GPU
              if (r.mass < 0.0006 && r.matSteps > 60) continue;
              const dx = r.wx - cam.x;
              const dy = r.wy - cam.y;
              if (dx * dx + dy * dy <= 9) nearList.push(r);
              else farList.push(r);
            }
            const nearTotalCap = engine.softGL ? 8 : 480;
            const kNear = nearList.length > 0 ? Math.min(Math.max(1, Math.round(share * pace)), 64, Math.max(1, Math.floor(nearTotalCap / nearList.length))) : 0;
            let budgetLeft = Math.max(0, Math.round(Math.min(Math.round(budgetRef.current), engine.softGL ? 12 : 4000) * pace) - kNear * nearList.length);
            farSteps.length = farList.length;
            for (let i = 0; i < farList.length; i++) farSteps[i] = 0;
            let maxK = kNear;
            let guard2 = 0;
            while (budgetLeft > 0 && farList.length > 0 && guard2++ < 100000) {
              const i = cursor++ % farList.length;
              farSteps[i]++;
              budgetLeft--;
              if (farSteps[i] > maxK) maxK = farSteps[i];
            }
            for (let p = 0; p < maxK; p++) {
              // при реальной просадке кадра — только обязательный проход:
              // минимум прогресса у всех блюдц, без наращивания очереди GPU
              if (p > 0 && emaRef.current > 19.5) break;
              let cnt2 = 0;
              if (p < kNear) {
                for (const r of nearList) {
                  const it = stepPool[cnt2++];
                  it.slot = r.mat;
                  world.dishParamsInto(r, it);
                  r.matSteps++;
                }
              }
              for (let i = 0; i < farList.length; i++) {
                if (farSteps[i] <= p) continue;
                const r = farList[i];
                const it = stepPool[cnt2++];
                it.slot = r.mat;
                world.dishParamsInto(r, it);
                r.matSteps++;
              }
              engine.stepBatch(stepPool, cnt2);
            }
          }
        }

        // LOD нужен для рендера только при отдалении и только когда
        // атлас менялся (шаги/посадки/болезни) — при паузе не пересобираем
        const rev = engine.stateRevision;
        if (matCount > 0 && cam.scale < LOD_HI && rev !== lodRenderRev && (!engine.softGL || frames % 3 === 0)) {
          engine.genLod();
          lodRenderRev = rev;
        }
        engine.regenMetaMips();
        engine.render(cam, now / 1000, dpr * rsRef.current);

        // тик биосферы: при высокой скорости — чаще, но с ограниченным dt
        const ecoEvery = engine.softGL ? 1000 : Math.max(140, Math.round(ECO_MS / Math.sqrt(speedRef.current)));
        if (now - lastEco >= ecoEvery) {
          lastEco = now;
          const lod = engine.pollLod();
          if (matCount > 0 && rev !== lodReadRev) {
            if (cam.scale >= LOD_HI) engine.genLod();
            engine.requestLod();
            lodReadRev = rev;
          }
          if (lod) world.syncMasses(slotDish, lod, engine.lodTexSide, engine.slotSide);
          // кэш слотов: блюдца вне зоны детализации держат свою жизнь
          // ~3.5 секунды (а не 6 тиков: на ×100 тик — 140 мс, жизнь
          // стиралась бы меньше чем за секунду) — при возврате камеры
          // колония продолжается с того же места, без всхлопываний
          const cacheTicks = Math.max(6, Math.round(3500 / ecoEvery));
          for (let s = 0; s < SLOTS; s++) {
            const k = slotDish[s];
            if (k < 0) continue;
            if (zoneAKeys.has(k)) {
              cacheFor[s] = 0;
              continue;
            }
            if (++cacheFor[s] > cacheTicks) releaseAndFree(s);
          }
          world.setCamera(cdx, cdy);
          if (runningRef.current) world.tick(Math.min(4, 0.5 * (ecoEvery / 500) * speedRef.current), hooks);
          world.buildMeta();
          flushMeta();
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
          ? { sp: r.sp, spName: world.speciesName(r.sp), pop: r.pop, mass: r.mass, div: r.div, mat: r.mat, serial: r.serial, emitAt: r.emitAt, time: world.time }
          : null;
      },
      aliveCount: () => world.aliveCount(),
      aliveNear: (rad: number) => world.aliveNear(rad),
      speciesCount: () => world.aliveSpeciesCount(),
      species: () =>
        world.species
          .filter((s): s is NonNullable<typeof s> => !!s)
          .map((s) => ({ id: s.id, name: s.name, role: s.role, base: s.base, gen: s.gen, parent: s.parent, alive: s.alive, m: +s.m.toFixed(3), s: +s.s.toFixed(4), T: s.T })),
      tick: (n = 1) => {
        for (let i = 0; i < n; i++) world.tick(0.5, hooks);
        world.buildMeta();
        flushMeta();
      },
      stepDish: (wx: number, wy: number, n: number) => {
        const r = world.peek(wx, wy);
        if (r && r.mat >= 0) {
          for (let i = 0; i < n; i++) engine.stepSlot(r.mat, world.dishParams(r));
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
          ? { dish: fd, sp: r.sp, spName: world.speciesName(r.sp), pop: r.pop, mass: r.mass, mat: r.mat, serial: r.serial, div: r.div, time: world.time, steps: r.matSteps }
          : { dish: fd, sp: -1, spName: '-', pop: 0, mass: 0, mat: -1, serial: 0, div: 0, time: world.time, steps: 0 };
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
      place: (wx: number, wy: number, sp: number) => placeWorld(wx, wy, sp, DISH / 2, DISH / 2),
      populate,
      clear,
    };

    let wasRunning = true;
    const onVis = () => {
      if (document.hidden) {
        wasRunning = runningRef.current;
        runningRef.current = false;
        stopSpawn();
      } else {
        runningRef.current = wasRunning;
      }
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      stopSpawn();
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
  }, []);

  /* ---------- рендер ---------- */

  const startEvolution = () => {
    startedRef.current = true;
    setStarted(true);
    if (!pauseParamRef.current) setRunning(true);
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#040806] text-neutral-100" style={{ touchAction: 'none' }}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none select-none" aria-label="Пруд Лении" />

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
              Планета из 2000×2000 блюдцев. Жизнь зарождается один раз — один вид в одном блюдце. Дальше всё делает эволюция: колонии мутируют и
              рождают новые виды, хищники охотятся и завоевывают чужие блюдца, симбионты дают гибридов, болезни гасят колонии постепенно, а не стирают
              в миг.
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
              <p>Выбери существо внизу, нажми на блюдце и держи — организмы появляются, пока держишь</p>
            </div>
          </div>
        </div>
      )}

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

        <RailBtn onClick={() => actionsRef.current.populate()} testid="populate" label="Зарождение жизни выбранным видом">
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
        <div className="mt-2.5 grid grid-cols-3 gap-1.5">
          {SPEED_PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => onChange(p)}
              data-testid={`speed-${p}`}
              className={`h-10 rounded-xl border font-mono text-sm transition-all active:scale-95 ${
                Math.abs(value - p) < 0.001
                  ? 'border-emerald-400/60 bg-emerald-900/60 text-emerald-100'
                  : 'border-white/10 bg-white/[0.03] text-neutral-300 hover:bg-white/[0.07]'
              }`}
            >
              ×{p}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-neutral-500">Клавиши 1–6 · большие скорости — максимум возможностей устройства</p>
      </div>
    </>
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
    const scale = Math.min((S - 6) / sp.w, (S - 6) / sp.h);
    const ox = (S - sp.w * scale) / 2;
    const oy = (S - sp.h * scale) / 2;
    for (let y = 0; y < sp.h; y++) {
      for (let x = 0; x < sp.w; x++) {
        const v = sp.cells[y * sp.w + x];
        if (v <= 0.03) continue;
        const [r, g2, b] = speciesColorJS(palId, v);
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
