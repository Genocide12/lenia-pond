/**
 * Биосфера конечного пруда: жизнь всего поля WORLD×WORLD блюдц.
 *
 * Мир — поле 20×20 блюдц (2000×2000 клеток), и каждое блюдце всегда
 * материализовано на GPU: честная Lenia течёт в любом блюдце при любом
 * зуме. Здесь живёт «медленная» часть экосистемы: популяции, вирусы,
 * мутации, вымирания, расселения и зарождения. Массы блюдц синхронизируются
 * из LOD-текстуры движка (syncMasses), поэтому решения принимаются по
 * реальному состоянию колоний на GPU.
 *
 * Зарождение новой игры: несколько колоний, далеко друг от друга, в разное
 * время, разных видов и с разными мутациями. Колонии растут, расселяются,
 * встречаются — и начинают влиять друг на друга: вирусы перескакивают на
 * чужой вид, эмигранты воюют за блюдце, побеждает сильнейший.
 * Механики возмущений проверены NumPy (scripts/verify_evolution.py).
 */

import { POND_LIST } from './creatures';
import { META, WORLD, LOD_N, LOD_TEX } from './engine';

export { WORLD };

/** Ёмкость блюдца: столько организмов комфортно живёт (дальше — эмиграция). */
export const DISH_CAP = 200;

export interface EcoRec {
  wx: number;
  wy: number;
  sp: number; // индекс вида в POND_LIST или -1 (пусто)
  pop: number; // популяция (организмов, до ~220)
  mass: number; // покрытие блюдца 0..1 (последняя проба GPU)
  mut: [number, number, number]; // dm, ds, dT — накопленные мутации линии
  mat: number; // слот движка или -1
  serial: number; // растёт при любом изменении экосистемы
  matSerial: number; // serial на момент материализации
  matSteps: number; // честные шаги Lenia в текущей материализации
  strikes: number; // подряд перенаселений
  lean: number; // подряд голодных проб
  flashKind: number; // 0 нет, 1 рождение, 2 вирус, 3 гибель
  flashUntil: number; // мировое время конца вспышки
}

export type FeedKind = 'virus' | 'mut' | 'spread' | 'origin' | 'extinct';

export interface EcoHooks {
  perturb(slot: number, mode: number, seed: number): void;
  clearSlot(slot: number): void;
  placeImmigrant(slot: number, sp: number): void;
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

function freshDead(wx: number, wy: number): EcoRec {
  return {
    wx,
    wy,
    sp: -1,
    pop: 0,
    mass: 0,
    mut: [0, 1, 0],
    mat: -1,
    serial: 1,
    matSerial: 0,
    matSteps: 0,
    strikes: 0,
    lean: 0,
    flashKind: 0,
    flashUntil: 0,
  };
}

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
  /** Все блюдца поля, индекс = слот движка (wy*WORLD+wx). */
  readonly recs: EcoRec[] = [];
  time = 0;
  private camX = 10;
  private camY = 10;
  private metaBytes = new Uint8Array(META * META * 4);
  private schedule: OriginPlan[] = [];
  private readonly dead: EcoRec = freshDead(-1, -1);

  constructor() {
    this.reset();
  }

  /** Новая игра: мёртвое поле + расписание зарождений жизни. */
  reset() {
    this.time = 0;
    this.recs.length = 0;
    for (let wy = 0; wy < WORLD; wy++) {
      for (let wx = 0; wx < WORLD; wx++) this.recs.push(freshDead(wx, wy));
    }
    this.makeSchedule();
  }

  /** Колонии зарождения: далеко друг от друга, в разное время, разные виды
   *  и разные мутации — у каждой линии своя эволюция. */
  private makeSchedule() {
    const pts: { wx: number; wy: number }[] = [];
    for (let minDist = 7; minDist >= 5 && pts.length < 7; minDist--) {
      let guard = 0;
      while (pts.length < 7 && guard++ < 3000) {
        const wx = 2 + Math.floor(Math.random() * (WORLD - 4));
        const wy = 2 + Math.floor(Math.random() * (WORLD - 4));
        if (pts.every((p) => Math.hypot(p.wx - wx, p.wy - wy) >= minDist)) pts.push({ wx, wy });
      }
    }
    const times: number[] = [2 + Math.random() * 4];
    for (let i = 1; i < pts.length; i++) times.push(12 + Math.random() * 228); // до ~4 минут
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

  /** Запись блюдца (за пределами поля — безопасная мёртвая). */
  get(wx: number, wy: number): EcoRec {
    if (!this.inWorld(wx, wy)) return this.dead;
    return this.recs[wy * WORLD + wx];
  }

  peek(wx: number, wy: number): EcoRec | null {
    return this.inWorld(wx, wy) ? this.recs[wy * WORLD + wx] : null;
  }

  inWorld(wx: number, wy: number): boolean {
    return wx >= 0 && wy >= 0 && wx < WORLD && wy < WORLD;
  }

  setCamera(x: number, y: number) {
    this.camX = x;
    this.camY = y;
  }

  aliveCount(): number {
    let n = 0;
    for (const r of this.recs) if (r.sp >= 0) n++;
    return n;
  }

  aliveNear(rad: number): number {
    let n = 0;
    for (const r of this.recs) {
      if (r.sp >= 0 && Math.abs(r.wx - this.camX) <= rad && Math.abs(r.wy - this.camY) <= rad) n++;
    }
    return n;
  }

  /** Заселить блюдцо видом (кнопка «Заселить», посадка, сброс). */
  seedDish(wx: number, wy: number, sp: number, pop: number) {
    if (!this.inWorld(wx, wy)) return;
    const r = this.recs[wy * WORLD + wx];
    r.sp = sp;
    r.pop = pop;
    r.mass = 0.015;
    r.strikes = 0;
    r.lean = 0;
    r.flashKind = 1;
    r.flashUntil = this.time + 1.3;
    r.serial++;
  }

  killDish(wx: number, wy: number) {
    if (!this.inWorld(wx, wy)) return;
    const r = this.recs[wy * WORLD + wx];
    if (r.sp < 0 && r.pop <= 0) return;
    r.sp = -1;
    r.pop = 0;
    r.serial++;
  }

  /** Синхронизировать массы/популяции всех блюдц из LOD-текстуры движка. */
  syncMasses(lod: Float32Array) {
    const NN = LOD_N * LOD_N;
    for (let wy = 0; wy < WORLD; wy++) {
      for (let wx = 0; wx < WORLD; wx++) {
        const r = this.recs[wy * WORLD + wx];
        if (r.mat < 0 || r.sp < 0) continue;
        const ty = wy * LOD_N;
        const tx = wx * LOD_N;
        let s = 0;
        for (let y = 0; y < LOD_N; y++) {
          const row = (ty + y) * LOD_TEX + tx;
          for (let x = 0; x < LOD_N; x++) s += lod[row + x];
        }
        r.mass = s / NN;
        r.pop = clamp(r.mass * 400, 0.5, 220);
      }
    }
  }

  /** Один тик планеты. dt — условные секунды (масштабируются скоростью). */
  tick(dt: number, hooks: EcoHooks) {
    this.time += dt;

    // расписание зарождений: жизнь появляется в отдалённых блюдцах
    while (this.schedule.length > 0 && this.schedule[0].at <= this.time) {
      const o = this.schedule.shift()!;
      const r = this.recs[o.wy * WORLD + o.wx];
      if (r.sp < 0) {
        r.sp = o.sp;
        r.pop = 6;
        r.mut = [...o.mut];
        r.strikes = 0;
        r.lean = 0;
        r.flashKind = 1;
        r.flashUntil = this.time + 1.3;
        r.serial++;
        hooks.feed('origin', o.wx, o.wy);
      }
    }

    let feeds = 0;
    const feed = (kind: FeedKind, wx: number, wy: number) => {
      if (feeds >= 3) return;
      if (Math.abs(wx - this.camX) > 12 || Math.abs(wy - this.camY) > 12) return;
      feeds++;
      hooks.feed(kind, wx, wy);
    };

    for (const r of this.recs) {
      if (r.mat >= 0) {
        if (r.sp < 0) continue;
        if (r.mass > 0.55) {
          // перенаселение (близко к 200 существам) → мор, но не мгновенная смерть
          r.strikes++;
          hooks.perturb(r.mat, 0, hash01(r.wx, r.wy, Math.floor(this.time * 977)) * 100);
          r.mass *= 0.6;
          r.flashKind = 3;
          r.flashUntil = this.time + 1.3;
          r.serial++;
          r.matSerial = r.serial; // мор уже на GPU — жизнь не пересевается
          feed('extinct', r.wx, r.wy);
          if (r.strikes >= 4) this.extinct(r, hooks);
        } else if (r.mass < 0.0025) {
          if (++r.lean >= 3) this.extinct(r, hooks);
        } else {
          r.strikes = 0;
          r.lean = 0;
          if (Math.random() < 0.006 * dt * (0.3 + r.pop / DISH_CAP)) {
            hooks.perturb(r.mat, 1, Math.random() * 100);
            r.mass *= 0.5;
            r.flashKind = 2;
            r.flashUntil = this.time + 1.3;
            r.serial++;
            r.matSerial = r.serial; // вирус уже на GPU — колония продолжает жить
            feed('virus', r.wx, r.wy);
          } else if (Math.random() < 0.01 * dt * (r.pop / 40)) {
            this.mutate(r);
            feed('mut', r.wx, r.wy);
          } else if (Math.random() < 0.12 * dt * Math.max(0, r.pop / 120 - 0.5)) {
            this.emigrate(r, hooks, feed);
          }
        }
      } else if (r.sp >= 0) {
        // ещё не материализовано (считанные доли секунды): мягкая логистика
        r.pop = Math.min(DISH_CAP * 1.1, Math.max(0, r.pop + (0.16 * r.pop * (1 - r.pop / DISH_CAP) + (Math.random() - 0.5) * 0.9) * dt));
        if (r.pop < 0.3) this.extinct(r, hooks);
      } else if (Math.random() < 0.00012 * dt * this.aliveFrac(r)) {
        // зарождение жизни: мёртвое блюдцо оживает рядом с живыми
        r.sp = Math.floor(Math.random() * POND_LIST.length);
        r.pop = 1.6;
        r.strikes = 0;
        r.lean = 0;
        r.flashKind = 1;
        r.flashUntil = this.time + 1.3;
        r.serial++;
        feed('origin', r.wx, r.wy);
      }
    }

    // фронтир: встретившиеся виды влияют друг на друга
    for (let wy = 0; wy < WORLD; wy++) {
      for (let wx = 0; wx < WORLD; wx++) {
        const a = this.recs[wy * WORLD + wx];
        if (a.sp < 0) continue;
        for (let d = 0; d < 2; d++) {
          const tx = wx + (d === 0 ? 1 : 0);
          const ty = wy + (d === 0 ? 0 : 1);
          if (!this.inWorld(tx, ty)) continue;
          const b = this.recs[ty * WORLD + tx];
          if (b.sp < 0 || b.sp === a.sp) continue;
          if (Math.random() < 0.004 * dt) {
            const weak = a.pop <= b.pop ? a : b; // болезнь бьёт по плотнейшему
            if (weak.mat >= 0) {
              hooks.perturb(weak.mat, 1, Math.random() * 100);
              weak.mass *= 0.5;
              weak.flashKind = 2;
              weak.flashUntil = this.time + 1.3;
              weak.serial++;
              weak.matSerial = weak.serial;
            } else {
              weak.pop *= 0.5;
            }
            feed('virus', weak.wx, weak.wy);
          }
        }
      }
    }
  }

  /** Собрать мета-текстуру планеты (256×256 RGBA; мир 20×20 в углу 0,0). */
  buildMeta(): Uint8Array {
    const out = this.metaBytes;
    out.fill(0);
    const t = this.time;
    for (let wy = 0; wy < WORLD; wy++) {
      for (let wx = 0; wx < WORLD; wx++) {
        const r = this.recs[wy * WORLD + wx];
        const life = r.mat >= 0 ? Math.min(1, r.mass * 2.4) : Math.min(1, r.pop / 40);
        let a = 0;
        if (r.flashKind > 0 && r.flashUntil > t) a = (r.flashKind << 6) | Math.round(63 * Math.min(1, (r.flashUntil - t) / 1.3));
        const i = (wy * META + wx) * 4;
        out[i] = r.sp + 1;
        out[i + 1] = Math.min(63, Math.round(life * 63));
        out[i + 2] = r.mat >= 0 ? 255 : 0;
        out[i + 3] = a;
      }
    }
    return out;
  }

  private aliveFrac(r: EcoRec): number {
    let n = 0;
    for (let d = 0; d < 4; d++) {
      const tx = r.wx + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const ty = r.wy + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (this.inWorld(tx, ty) && this.recs[ty * WORLD + tx].sp >= 0) n++;
    }
    return n / 4;
  }

  private mutate(r: EcoRec) {
    const cl = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
    r.mut[0] = cl(r.mut[0] + (Math.random() - 0.5) * 0.014, -0.03, 0.03);
    r.mut[1] = cl(r.mut[1] * (1 + (Math.random() - 0.5) * 0.16), 0.86, 1.18);
    r.mut[2] = cl(r.mut[2] + Math.round((Math.random() - 0.5) * 2), -3, 3);
    r.serial++;
    if (r.mat >= 0) r.matSerial = r.serial; // мутация меняет только параметры шага — без пересева
  }

  private emigrate(r: EcoRec, hooks: EcoHooks, feed: (k: FeedKind, x: number, y: number) => void) {
    const d = Math.floor(Math.random() * 4);
    const tx = r.wx + (d === 0 ? 1 : d === 1 ? -1 : 0);
    const ty = r.wy + (d === 2 ? 1 : d === 3 ? -1 : 0);
    if (!this.inWorld(tx, ty)) return;
    const t = this.recs[ty * WORLD + tx];
    if (t.sp < 0) {
      // пустое блюдце — колония несёт свою эволюцию (мутации линии)
      t.sp = r.sp;
      t.pop = 3;
      t.mut = [...r.mut];
      t.strikes = 0;
      t.lean = 0;
      t.serial++;
      t.flashKind = 1;
      t.flashUntil = this.time + 1.3;
      if (t.mat >= 0) {
        hooks.placeImmigrant(t.mat, r.sp);
        t.matSerial = t.serial;
      }
      r.pop = Math.max(0, r.pop - 3);
      feed('spread', tx, ty);
    } else if (t.sp === r.sp) {
      t.pop = Math.min(DISH_CAP + 20, t.pop + 3); // подкрепление своих
      r.pop = Math.max(0, r.pop - 3);
    } else if (Math.random() < 0.5) {
      // чужой вид: война за блюдце — выживает сильнейший
      t.pop -= 7;
      if (t.pop < 3) {
        t.sp = r.sp;
        t.pop = 3;
        t.mut = [...r.mut];
        t.serial++;
        t.flashKind = 1;
        t.flashUntil = this.time + 1.3;
        if (t.mat >= 0) {
          hooks.perturb(t.mat, 0, Math.random() * 100); // старая колония подавлена
          hooks.placeImmigrant(t.mat, r.sp);
          t.matSerial = t.serial;
        }
        feed('spread', tx, ty);
      } else {
        t.serial++;
        if (t.mat >= 0) t.matSerial = t.serial;
        feed('virus', tx, ty);
      }
      r.pop = Math.max(0, r.pop - 4);
    }
  }

  private extinct(r: EcoRec, hooks: EcoHooks) {
    r.sp = -1;
    r.pop = 0;
    r.strikes = 0;
    r.lean = 0;
    r.serial++;
    r.flashKind = 3;
    r.flashUntil = this.time + 1.3;
    if (r.mat >= 0) {
      hooks.clearSlot(r.mat);
      r.mat = -1;
    }
    if (Math.abs(r.wx - this.camX) <= 12 && Math.abs(r.wy - this.camY) <= 12) hooks.feed('extinct', r.wx, r.wy);
  }
}
