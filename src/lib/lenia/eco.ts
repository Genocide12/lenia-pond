/**
 * Биосфера планеты блюдцев: 2000×2000 блюдцев, жизнь — разреженная карта.
 *
 * Каждое блюдце — экосистема на 200 организмов (DISH_CAP). Организмы
 * чувствуют стены своего блюдца и не пересекают их, пока блюдце не
 * заполнится completely — заполненное блюдце с соблюдением паузы
 * («emitAt») переливается в соседние: колонисты появляются у стены
 * соседнего блюдца, как будто перебрались через неё. Пустое блюдце
 * колонизируется, своё получает подкрепление, чужое — войну за территорию.
 *
 * Честная Lenia течёт в материализованных блюдцах (слоты движка), их
 * популяции синхронизируются из LOD-текстуры (syncMasses). Остальная
 * планета живёт статистически — логистический рост, вирусы от скученности,
 * встречи видов на фронтире, вымирания. Климата нет: эволюция — только
 * через взаимодействие существ. Механики проверены NumPy
 * (scripts/verify_evolution.py).
 */

import { POND_LIST } from './creatures';
import { DISH, META, WORLD, LOD_N } from './engine';

export { WORLD };

/** Ёмкость блюдца: столько организмов живёт в одном блюдце. */
export const DISH_CAP = 200;
/** Популяция «блюдце заполнено» — пора переливаться в соседей. */
const FULL_POP = DISH_CAP - 6;
/** Популяция из покрытия: масса 0.5 ≈ 200 существ. */
export const POP_PER_MASS = (DISH * DISH) / 25;

export interface EcoRec {
  wx: number;
  wy: number;
  sp: number; // индекс вида в POND_LIST (мёртвых блюдцев нет в карте)
  pop: number; // популяция (организмов, до ~220)
  mass: number; // покрытие блюдца 0..1 (последняя проба GPU)
  mut: [number, number, number]; // dm, ds, dT — накопленные мутации линии
  mat: number; // слот движка или -1
  serial: number; // растёт при любом изменении экосистемы
  matSerial: number; // serial на момент материализации
  matSteps: number; // честные шаги Lenia в текущей материализации
  lean: number; // подряд голодных проб
  emitAt: number; // мировое время следующего переливания (блюдце полно)
  fromDir: number; // стена, через которую пришла колония (-1 — своя)
  flashKind: number; // 0 нет, 1 рождение, 2 вирус, 3 гибель
  flashUntil: number; // мировое время конца вспышки
}

export type FeedKind = 'virus' | 'mut' | 'spread' | 'origin' | 'extinct';

export interface EcoHooks {
  perturb(slot: number, mode: number, seed: number): void;
  clearSlot(slot: number): void;
  placeImmigrant(slot: number, sp: number, fromDir: number): void;
  feed(kind: FeedKind, wx: number, wy: number): void;
}

interface OriginPlan {
  wx: number;
  wy: number;
  sp: number;
  at: number; // мировое время зарождения
  mut: [number, number, number];
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Целочисленный хэш координат → [0,1). Стабилен между сессиями. */
export function hash01(x: number, y: number, s: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];
const OPP = [1, 0, 3, 2];

/** Параметры шага Lenia для блюдца: вид + мутации линии. Климата нет —
 *  эволюция идёт только через взаимодействие существ. */
export function dishParams(r: EcoRec): { sp: number; m: number; s: number; T: number } {
  const c = POND_LIST[r.sp];
  return {
    sp: r.sp,
    m: c.m + r.mut[0],
    s: c.s * r.mut[1],
    T: Math.max(1, Math.round(c.T + r.mut[2])),
  };
}

export class Biosphere {
  /** Живые блюдца планеты: ключ = wy*WORLD+wx. Мёртвых нет в карте. */
  readonly recs = new Map<number, EcoRec>();
  time = 0;
  private camX = WORLD / 2;
  private camY = WORLD / 2;
  private meta = new Uint8Array(META * META * 4);
  private shadow = new Uint8Array(META * META * 4);
  private dirtyRows = new Set<number>();
  private schedule: OriginPlan[] = [];

  constructor() {
    this.reset();
  }

  /** Новая игра: мёртвая планета + расписание зарождений жизни. */
  reset() {
    this.time = 0;
    this.recs.clear();
    this.meta.fill(0);
    this.shadow.fill(0);
    this.dirtyRows.clear();
    this.makeSchedule();
  }

  /** Колонии зарождения: далеко друг от друга, в разное время, разные виды
   *  и разные мутации — у каждой линии своя эволюция. Первая — недалеко от
   *  центра планеты, чтобы её было видно с обзорного зума. */
  private makeSchedule() {
    const c = WORLD / 2;
    const pts: { wx: number; wy: number }[] = [
      { wx: Math.round(c + (Math.random() - 0.5) * 160), wy: Math.round(c + (Math.random() - 0.5) * 160) },
    ];
    for (let minDist = 600; minDist >= 300 && pts.length < 7; minDist -= 100) {
      let guard = 0;
      while (pts.length < 7 && guard++ < 4000) {
        const wx = 2 + Math.floor(Math.random() * (WORLD - 4));
        const wy = 2 + Math.floor(Math.random() * (WORLD - 4));
        if (pts.every((p) => Math.hypot(p.wx - wx, p.wy - wy) >= minDist)) pts.push({ wx, wy });
      }
    }
    const times: number[] = [2 + Math.random() * 4];
    for (let i = 1; i < pts.length; i++) times.push(15 + Math.random() * 225); // до ~4 минут
    times.sort((a, b) => a - b);
    const species = [...POND_LIST.keys()];
    for (let i = species.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [species[i], species[j]] = [species[j], species[i]];
    }
    this.schedule = pts.map((p, i) => ({
      wx: p.wx,
      wy: p.wy,
      sp: species[i % species.length],
      at: times[i],
      mut: [(Math.random() - 0.5) * 0.012, 0.96 + Math.random() * 0.08, Math.round((Math.random() - 0.5) * 2)],
    }));
  }

  key(wx: number, wy: number): number {
    return wy * WORLD + wx;
  }

  /** Запись блюдца (за пределами планеты — null). */
  peek(wx: number, wy: number): EcoRec | null {
    if (!this.inWorld(wx, wy)) return null;
    return this.recs.get(this.key(wx, wy)) ?? null;
  }

  byKey(key: number): EcoRec | null {
    return this.recs.get(key) ?? null;
  }

  inWorld(wx: number, wy: number): boolean {
    return wx >= 0 && wy >= 0 && wx < WORLD && wy < WORLD;
  }

  setCamera(x: number, y: number) {
    this.camX = x;
    this.camY = y;
  }

  aliveCount(): number {
    return this.recs.size;
  }

  aliveNear(rad: number): number {
    let n = 0;
    for (const r of this.recs.values()) {
      if (Math.abs(r.wx - this.camX) <= rad && Math.abs(r.wy - this.camY) <= rad) n++;
    }
    return n;
  }

  private fresh(wx: number, wy: number, sp: number, pop: number, mut: [number, number, number]): EcoRec {
    return {
      wx,
      wy,
      sp,
      pop,
      mass: clamp(pop / POP_PER_MASS, 0, 1),
      mut,
      mat: -1,
      serial: 1,
      matSerial: 0,
      matSteps: 0,
      lean: 0,
      emitAt: this.time + 25 + Math.random() * 20,
      fromDir: -1,
      flashKind: 1,
      flashUntil: this.time + 1.3,
    };
  }

  /** Заселить блюдце видом (кнопка «Заселить», посадка, сброс). */
  seedDish(wx: number, wy: number, sp: number, pop: number) {
    if (!this.inWorld(wx, wy)) return;
    const k = this.key(wx, wy);
    const old = this.recs.get(k);
    const r: EcoRec = old
      ? { ...old, sp, pop, mass: clamp(pop / POP_PER_MASS, 0, 1), lean: 0, serial: old.serial + 1, flashKind: 1, flashUntil: this.time + 1.3 }
      : this.fresh(wx, wy, sp, pop, [0, 1, 0]);
    this.recs.set(k, r);
  }

  killDish(wx: number, wy: number) {
    if (!this.inWorld(wx, wy)) return;
    const k = this.key(wx, wy);
    const r = this.recs.get(k);
    if (!r) return;
    this.recs.delete(k);
    this.put0(wx, wy);
  }

  /** Синхронизировать массы/популяции материализованных блюдц из
   *  LOD-текстуры движка (слот → блюдце через slotDish). */
  syncMasses(slotDish: Int32Array, lod: Float32Array, lodSide: number, slotSide: number) {
    for (let slot = 0; slot < slotDish.length; slot++) {
      const k = slotDish[slot];
      if (k < 0) continue;
      const r = this.recs.get(k);
      if (!r) continue;
      const sx = slot % slotSide;
      const sy = (slot / slotSide) | 0;
      let s = 0;
      for (let y = 0; y < LOD_N; y++) {
        const row = (sy * LOD_N + y) * lodSide + sx * LOD_N;
        for (let x = 0; x < LOD_N; x++) s += lod[row + x];
      }
      r.mass = s / (LOD_N * LOD_N);
      r.pop = clamp(r.mass * POP_PER_MASS, 0.5, DISH_CAP * 1.1);
    }
  }

  /** Один тик планеты. dt — условные секунды (масштабируются скоростью). */
  tick(dt: number, hooks: EcoHooks) {
    this.time += dt;

    // расписание зарождений: жизнь появляется в отдалённых блюдцах
    while (this.schedule.length > 0 && this.schedule[0].at <= this.time) {
      const o = this.schedule.shift()!;
      const k = this.key(o.wx, o.wy);
      if (!this.recs.has(k)) {
        this.recs.set(k, this.fresh(o.wx, o.wy, o.sp, 6, [...o.mut]));
        hooks.feed('origin', o.wx, o.wy);
      }
    }

    let feeds = 0;
    const feed = (kind: FeedKind, wx: number, wy: number) => {
      if (feeds >= 3) return;
      if (Math.abs(wx - this.camX) > 60 || Math.abs(wy - this.camY) > 60) return;
      feeds++;
      hooks.feed(kind, wx, wy);
    };

    for (const r of [...this.recs.values()]) {
      if (r.mat >= 0) {
        // материализованное блюдце: жизнь течёт честной Lenia на GPU
        if (r.mass < 0.0018) {
          if (++r.lean >= 4) this.extinct(r, hooks, feed);
          continue;
        }
        r.lean = 0;
        if (r.pop >= FULL_POP && this.time >= r.emitAt) {
          // блюдце заполнено организмами — колония переливается в соседей
          r.emitAt = this.time + 3 + Math.random() * 4;
          this.emigrate(r, hooks, feed);
        } else if (Math.random() < 0.0035 * dt * Math.pow(r.pop / DISH_CAP, 2)) {
          // вирус от скученности — редкий и мягкий, без мгновенной смерти
          hooks.perturb(r.mat, 1, Math.random() * 100);
          r.mass *= 0.55;
          r.flashKind = 2;
          r.flashUntil = this.time + 1.3;
          r.serial++;
          r.matSerial = r.serial; // вирус уже на GPU — колония продолжает жить
          feed('virus', r.wx, r.wy);
        } else if (Math.random() < 0.004 * dt * (r.pop / 100)) {
          this.mutate(r);
          feed('mut', r.wx, r.wy);
        }
      } else {
        // статистическое блюдце: мягкая логистика до ёмкости
        r.pop += (0.16 * r.pop * (1 - r.pop / DISH_CAP) + (Math.random() - 0.5) * 0.6) * dt;
        if (r.pop < 0.3) {
          this.extinct(r, hooks, feed);
          continue;
        }
        if (r.pop >= FULL_POP && this.time >= r.emitAt) {
          r.emitAt = this.time + 3 + Math.random() * 4;
          this.emigrate(r, hooks, feed);
        } else if (Math.random() < 0.00012 * dt * (r.pop / DISH_CAP)) {
          this.spark(r, feed); // рядом оживает независимый вид
        }
      }
    }

    // фронтир: встретившиеся виды влияют друг на друга
    for (const a of this.recs.values()) {
      for (let d = 0; d < 2; d++) {
        const tx = a.wx + (d === 0 ? 1 : 0);
        const ty = a.wy + (d === 0 ? 0 : 1);
        if (!this.inWorld(tx, ty)) continue;
        const b = this.recs.get(this.key(tx, ty));
        if (!b || b.sp === a.sp) continue;
        if (Math.random() < 0.02 * dt) {
          const weak = a.pop <= b.pop ? a : b; // болезнь бьёт по плотнейшему
          if (weak.mat >= 0) {
            hooks.perturb(weak.mat, 1, Math.random() * 100);
            weak.mass *= 0.55;
            weak.serial++;
            weak.matSerial = weak.serial;
          } else {
            weak.pop *= 0.55;
          }
          weak.flashKind = 2;
          weak.flashUntil = this.time + 1.3;
          feed('virus', weak.wx, weak.wy);
        }
      }
    }
  }

  /** Рядом с живым блюдцем оживает независимый вид — своя эволюция. */
  private spark(r: EcoRec, feed: (k: FeedKind, x: number, y: number) => void) {
    const d = Math.floor(Math.random() * 4);
    const tx = r.wx + DX[d];
    const ty = r.wy + DY[d];
    if (!this.inWorld(tx, ty) || this.recs.has(this.key(tx, ty))) return;
    this.recs.set(this.key(tx, ty), this.fresh(tx, ty, Math.floor(Math.random() * POND_LIST.length), 1.6, [0, 1, 0]));
    feed('origin', tx, ty);
  }

  private mutate(r: EcoRec) {
    const cl = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
    r.mut[0] = cl(r.mut[0] + (Math.random() - 0.5) * 0.014, -0.03, 0.03);
    r.mut[1] = cl(r.mut[1] * (1 + (Math.random() - 0.5) * 0.16), 0.86, 1.18);
    r.mut[2] = cl(r.mut[2] + Math.round((Math.random() - 0.5) * 2), -3, 3);
    r.serial++;
    if (r.mat >= 0) r.matSerial = r.serial; // мутация меняет только параметры шага
  }

  /** Заполненное блюдце переливается в соседа: колонисты идут через
   *  общую стену, несут свою эволюцию (мутации линии). */
  private emigrate(r: EcoRec, hooks: EcoHooks, feed: (k: FeedKind, x: number, y: number) => void) {
    const d = Math.floor(Math.random() * 4);
    const tx = r.wx + DX[d];
    const ty = r.wy + DY[d];
    if (!this.inWorld(tx, ty)) return;
    const k = this.key(tx, ty);
    const t = this.recs.get(k);
    if (!t) {
      // пустое блюдце — колония несёт свою эволюцию
      const rec = this.fresh(tx, ty, r.sp, 3, [...r.mut]);
      rec.fromDir = OPP[d]; // пришли через стену, обращённую к родителю
      this.recs.set(k, rec);
      r.pop = Math.max(0, r.pop - 2);
      feed('spread', tx, ty);
    } else if (t.sp === r.sp) {
      t.pop = Math.min(DISH_CAP + 20, t.pop + 3); // подкрепление своих
      if (t.mat >= 0) hooks.placeImmigrant(t.mat, r.sp, OPP[d]);
      r.pop = Math.max(0, r.pop - 2);
    } else {
      // чужой вид: война за блюдце — выживает сильнейший
      t.pop -= 7;
      if (t.pop < 3) {
        t.sp = r.sp;
        t.pop = 3;
        t.mut = [...r.mut];
        t.lean = 0;
        t.emitAt = this.time + 25 + Math.random() * 20;
        t.fromDir = OPP[d];
        t.serial++;
        t.flashKind = 1;
        t.flashUntil = this.time + 1.3;
        if (t.mat >= 0) {
          hooks.perturb(t.mat, 0, Math.random() * 100); // старая колония подавлена
          hooks.placeImmigrant(t.mat, r.sp, OPP[d]);
          t.matSerial = t.serial; // вторжение без пересева — старая жизнь гаснет сама
        }
        feed('spread', tx, ty);
      } else {
        t.serial++;
        if (t.mat >= 0) {
          hooks.perturb(t.mat, 1, Math.random() * 100);
          t.mass *= 0.55;
          t.matSerial = t.serial;
        }
        t.flashKind = 2;
        t.flashUntil = this.time + 1.3;
        feed('virus', tx, ty);
      }
      r.pop = Math.max(0, r.pop - 4);
    }
  }

  private extinct(r: EcoRec, hooks: EcoHooks, feed: (k: FeedKind, x: number, y: number) => void) {
    const hadSlot = r.mat >= 0;
    this.recs.delete(this.key(r.wx, r.wy));
    this.put0(r.wx, r.wy);
    if (hadSlot) {
      hooks.clearSlot(r.mat);
      r.mat = -1;
    }
    if (Math.abs(r.wx - this.camX) <= 60 && Math.abs(r.wy - this.camY) <= 60) feed('extinct', r.wx, r.wy);
  }

  /* ---------- мета-текстура планеты ---------- */

  /** Пересобрать ячейки живых блюдцев (раз в тик экосистемы). */
  buildMeta() {
    for (const r of this.recs.values()) this.cell(r);
  }

  /** Мгновенно обновить ячейку одного блюдца (смена слота и т.п.). */
  touch(r: EcoRec) {
    this.cell(r);
  }

  /** Готовые к загрузке строки мета-текстуры. */
  takeDirtyRows(): number[] {
    if (this.dirtyRows.size === 0) return [];
    const rows = [...this.dirtyRows];
    this.dirtyRows.clear();
    return rows;
  }

  metaRow(y: number): Uint8Array {
    return this.meta.subarray(y * META * 4, (y + 1) * META * 4);
  }

  metaBytes(): Uint8Array {
    this.shadow.set(this.meta);
    this.dirtyRows.clear();
    return this.meta;
  }

  private cell(r: EcoRec) {
    const life = r.mat >= 0 ? Math.min(1, r.mass * 2) : Math.sqrt(Math.min(1, r.pop / DISH_CAP));
    let kind = 0;
    let amp = 0;
    if (r.flashKind > 0 && r.flashUntil > this.time) {
      kind = r.flashKind;
      amp = Math.min(1, (r.flashUntil - this.time) / 1.3);
    }
    const g = Math.round(Math.min(1, life * (1 + 0.9 * amp)) * 255);
    const slotEnc = r.mat >= 0 ? r.mat + 1 : 0;
    const rb = ((slotEnc >> 8) << 4) | (r.sp + 1);
    const a = kind > 0 ? (kind << 6) | Math.round(63 * amp) : 0;
    this.put(r.wx, r.wy, rb, g, slotEnc & 255, a);
  }

  private put(wx: number, wy: number, r: number, g: number, b: number, a: number) {
    const i = (wy * META + wx) * 4;
    const m = this.meta;
    if (m[i] === r && m[i + 1] === g && m[i + 2] === b && m[i + 3] === a) return;
    m[i] = r;
    m[i + 1] = g;
    m[i + 2] = b;
    m[i + 3] = a;
    this.dirtyRows.add(wy);
  }

  private put0(wx: number, wy: number) {
    this.put(wx, wy, 0, 0, 0, 0);
  }
}
