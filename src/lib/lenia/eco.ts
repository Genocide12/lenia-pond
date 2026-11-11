/**
 * Биосфера бесконечного пруда: жизнь за пределами видимости.
 *
 * Мир — бесконечная сетка блюдцев. Возле камеры блюдца материализуются
 * в слоты движка и считаются честной Lenia на GPU, а вся остальная
 * планета живёт статистически: у каждого блюдца есть запись экосистемы
 * (вид, популяция, климат, мутации). Тик биосферы не зависит от того,
 * смотрит ли игрок: вирусы, мутации, вымирания, расселения и зарождения
 * жизни случаются и в глубине мира — отдалив камеру, видно, как планета
 * дышит. Механики возмущений проверены NumPy (scripts/verify_evolution.py).
 */

import { POND_LIST } from './creatures';
import { CLIMATE_DM, CLIMATE_DS, META } from './engine';

export { META };

/** Климатический оптимум видов (в порядке POND_LIST): у каждого свой пояс. */
const BIAS = [0.5, 0.66, 0.34, 0.58, 0.3, 0.72, 0.44, 0.52, 0.62, 0.4, 0.5];

export interface EcoRec {
  wx: number;
  wy: number;
  sp: number; // индекс вида в POND_LIST или -1 (пусто)
  clim: number; // 0..1
  pop: number; // статистическая популяция (организмов)
  mass: number; // покрытие блюдца 0..1 (последняя проба GPU)
  mut: [number, number, number]; // dm, ds, dT — накопленные мутации
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

/** Целочисленный хэш координат → [0,1). Стабилен между сессиями. */
export function hash01(x: number, y: number, s: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash01(xi, yi, s);
  const b = hash01(xi + 1, yi, s);
  const c = hash01(xi, yi + 1, s);
  const d = hash01(xi + 1, yi + 1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Климат блюдца — плавное поле по мировым координатам. */
export function climateAt(wx: number, wy: number): number {
  const v = vnoise(wx / 19, wy / 19, 11) * 0.72 + vnoise(wx / 6.5, wy / 6.5, 23) * 0.28;
  return Math.min(1, Math.max(0, 0.5 + (v - 0.5) * 1.35));
}

/** Ёмкость блюдца: сколько организмов вид может прокормить в этом климате. */
function carry(r: EcoRec): number {
  const base = 6.5 + 5 * hash01(r.wx, r.wy, 7);
  const d = (r.clim - BIAS[r.sp]) / 0.3;
  return base * Math.exp(-d * d) + 0.25;
}

/** Процедурное блюдце «из ниоткуда»: детерминировано координатами. */
function seedRec(wx: number, wy: number): EcoRec {
  const alive = hash01(wx, wy, 1) < 0.62;
  const sp = alive ? Math.floor(hash01(wx, wy, 2) * POND_LIST.length) : -1;
  return {
    wx,
    wy,
    sp,
    clim: climateAt(wx, wy),
    pop: sp >= 0 ? 1.5 + 7 * hash01(wx, wy, 3) : 0,
    mass: 0,
    mut: [
      (hash01(wx, wy, 4) - 0.5) * 0.016,
      1 + (hash01(wx, wy, 5) - 0.5) * 0.12,
      Math.round((hash01(wx, wy, 6) - 0.5) * 2),
    ],
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

/** Параметры шага Lenia для блюдца: вид + климат + мутации. */
export function dishParams(r: EcoRec): { sp: number; m: number; s: number; T: number } {
  const c = POND_LIST[r.sp];
  const d = (r.clim - 0.5) * 2;
  return {
    sp: r.sp,
    m: c.m + d * CLIMATE_DM + r.mut[0],
    s: c.s * (1 + d * CLIMATE_DS) * r.mut[1],
    T: Math.max(1, Math.round(c.T + r.mut[2])),
  };
}

export class Biosphere {
  readonly recs = new Map<number, EcoRec>();
  time = 0;
  private camX = 0;
  private camY = 0;
  private metaBytes = new Uint8Array(META * META * 4);
  private pureCache = new Map<string, Uint8Array>();

  static key(wx: number, wy: number): number {
    return (wx + 1048576) * 2097152 + (wy + 1048576);
  }

  /** Запись блюдца (создаётся процедурно при первом взгляде). */
  get(wx: number, wy: number): EcoRec {
    const k = Biosphere.key(wx, wy);
    let r = this.recs.get(k);
    if (!r) this.recs.set(k, (r = seedRec(wx, wy)));
    return r;
  }

  peek(wx: number, wy: number): EcoRec | null {
    return this.recs.get(Biosphere.key(wx, wy)) ?? null;
  }

  setCamera(x: number, y: number) {
    this.camX = x;
    this.camY = y;
  }

  aliveNear(rad: number): number {
    let n = 0;
    for (const r of this.recs.values()) {
      if (r.sp >= 0 && Math.abs(r.wx - this.camX) <= rad && Math.abs(r.wy - this.camY) <= rad) n++;
    }
    return n;
  }

  /** Заселить блюдцо видом (кнопка «Заселить», посадка, сброс). */
  seedDish(wx: number, wy: number, sp: number, pop: number) {
    const r = this.get(wx, wy);
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
    const r = this.peek(wx, wy);
    if (!r || (r.sp < 0 && r.pop <= 0)) return;
    r.sp = -1;
    r.pop = 0;
    r.serial++;
  }

  /** Климат блюдца (не сбрасывает материализацию — параметры читаются каждый шаг). */
  setClimate(wx: number, wy: number, k: number) {
    const r = this.get(wx, wy);
    r.clim = Math.min(1, Math.max(0, k));
  }

  /** Один тик планеты. dt — условные секунды (масштабируются скоростью). */
  tick(dt: number, hooks: EcoHooks) {
    this.time += dt;
    if (this.recs.size > 16000) {
      for (const [k, r] of this.recs) {
        if (r.mat < 0 && (Math.abs(r.wx - this.camX) > 320 || Math.abs(r.wy - this.camY) > 320)) this.recs.delete(k);
      }
    }
    let feeds = 0;
    const feed = (kind: FeedKind, wx: number, wy: number) => {
      if (feeds >= 3) return;
      if (Math.abs(wx - this.camX) > 10 || Math.abs(wy - this.camY) > 10) return;
      feeds++;
      hooks.feed(kind, wx, wy);
    };
    for (const r of this.recs.values()) {
      if (r.mat >= 0) {
        if (r.sp < 0) continue;
        if (r.mass > 0.42) {
          // перенаселение → мор (проверено NumPy: колония восстанавливается в 5/6)
          r.strikes++;
          hooks.perturb(r.mat, 0, hash01(r.wx, r.wy, Math.floor(this.time * 977)) * 100);
          r.mass *= 0.35;
          r.flashKind = 3;
          r.flashUntil = this.time + 1.3;
          r.serial++;
          feed('extinct', r.wx, r.wy);
          if (r.strikes >= 3) this.extinct(r, hooks);
        } else if (r.mass < 0.002) {
          if (++r.lean >= 2) this.extinct(r, hooks);
        } else {
          r.strikes = 0;
          r.lean = 0;
          if (Math.random() < 0.01 * dt * (0.5 + r.mass * 2.5)) {
            hooks.perturb(r.mat, 1, Math.random() * 100);
            r.mass *= 0.3;
            r.flashKind = 2;
            r.flashUntil = this.time + 1.3;
            r.serial++;
            feed('virus', r.wx, r.wy);
          } else if (Math.random() < 0.02 * dt) {
            this.mutate(r);
            feed('mut', r.wx, r.wy);
          } else if (r.mass > 0.02 && Math.random() < 0.045 * dt) {
            this.emigrate(r, hooks, feed);
          }
        }
      } else if (r.sp >= 0) {
        // невидимая жизнь: логистика популяции с шумом
        const K = carry(r);
        const grow = 0.5 * r.pop * (1 - r.pop / K);
        r.pop = Math.min(K * 1.15, Math.max(0, r.pop + (grow + (Math.random() - 0.5) * 0.9) * dt));
        if (r.pop < 0.18) {
          this.extinct(r, hooks);
        } else if (r.pop > 2.5 && Math.random() < 0.01 * dt * (r.pop / 6)) {
          r.pop *= 0.22;
          r.flashKind = 2;
          r.flashUntil = this.time + 1.3;
          feed('virus', r.wx, r.wy);
        } else if (r.pop > 5 && Math.random() < 0.018 * dt) {
          this.mutate(r);
          feed('mut', r.wx, r.wy);
        } else if (r.pop > 6.5 && Math.random() < 0.05 * dt) {
          this.emigrate(r, hooks, feed);
        }
      } else if (Math.random() < 0.0016 * dt * this.aliveFrac(r)) {
        // зарождение жизни: мёртвое блюдцо оживает рядом с живыми
        r.sp = Math.floor(Math.random() * POND_LIST.length);
        r.pop = 1.4;
        r.strikes = 0;
        r.lean = 0;
        r.flashKind = 1;
        r.flashUntil = this.time + 1.3;
        r.serial++;
        feed('origin', r.wx, r.wy);
      }
    }
  }

  /** Собрать мета-текстуру планеты (256×256 RGBA) для окна metaOrg. */
  buildMeta(org: { x: number; y: number }): Uint8Array {
    // «чистый мир» (неизвестные блюдца) кэшируется по позиции окна
    const ok = org.x + ',' + org.y;
    let pure = this.pureCache.get(ok);
    if (!pure) {
      pure = new Uint8Array(META * META * 4);
      for (let my = 0; my < META; my++) {
        const wy = org.y + my;
        for (let mx = 0; mx < META; mx++) {
          const wx = org.x + mx;
          const sp = hash01(wx, wy, 1) < 0.62 ? Math.floor(hash01(wx, wy, 2) * POND_LIST.length) : -1;
          const life = sp >= 0 ? Math.min(1, (1.5 + 7 * hash01(wx, wy, 3)) / 10) : 0;
          const clim = Math.min(3, Math.round(climateAt(wx, wy) * 3));
          const i = (my * META + mx) * 4;
          pure[i] = sp + 1;
          pure[i + 1] = Math.min(63, Math.round(life * 63)) | (clim << 6);
        }
      }
      this.pureCache.set(ok, pure);
      if (this.pureCache.size > 6) {
        const first = this.pureCache.keys().next().value as string;
        this.pureCache.delete(first);
      }
    }
    const out = this.metaBytes;
    out.set(pure);
    const t = this.time;
    // поверх — известные записи экосистемы в этом окне
    for (const r of this.recs.values()) {
      const mx = r.wx - org.x;
      const my = r.wy - org.y;
      if (mx < 0 || my < 0 || mx >= META || my >= META) continue;
      const life = r.mat >= 0 ? Math.min(1, r.mass * 2.4) : Math.min(1, r.pop / 10);
      let a = 0;
      if (r.flashKind > 0 && r.flashUntil > t) a = (r.flashKind << 6) | Math.round(63 * Math.min(1, (r.flashUntil - t) / 1.3));
      const i = (my * META + mx) * 4;
      out[i] = r.sp + 1;
      out[i + 1] = Math.min(63, Math.round(life * 63)) | (Math.min(3, Math.round(r.clim * 3)) << 6);
      out[i + 2] = r.mat >= 0 ? 255 : 0;
      out[i + 3] = a;
    }
    return out;
  }

  private aliveFrac(r: EcoRec): number {
    let n = 0;
    for (let d = 0; d < 4; d++) {
      const tx = r.wx + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const ty = r.wy + (d === 2 ? 1 : d === 3 ? -1 : 0);
      const t = this.peek(tx, ty);
      n += t ? (t.sp >= 0 ? 1 : 0) : hash01(tx, ty, 1) < 0.62 ? 1 : 0;
    }
    return n / 4;
  }

  private mutate(r: EcoRec) {
    const cl = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
    r.mut[0] = cl(r.mut[0] + (Math.random() - 0.5) * 0.014, -0.03, 0.03);
    r.mut[1] = cl(r.mut[1] * (1 + (Math.random() - 0.5) * 0.16), 0.86, 1.18);
    r.mut[2] = cl(r.mut[2] + Math.round((Math.random() - 0.5) * 2), -3, 3);
    r.serial++;
  }

  private emigrate(r: EcoRec, hooks: EcoHooks, feed: (k: FeedKind, x: number, y: number) => void) {
    const d = Math.floor(Math.random() * 4);
    const tx = r.wx + (d === 0 ? 1 : d === 1 ? -1 : 0);
    const ty = r.wy + (d === 2 ? 1 : d === 3 ? -1 : 0);
    const t = this.get(tx, ty);
    if (t.sp >= 0 && t.pop > 0.3) return;
    t.sp = r.sp;
    t.pop = 2.4;
    t.strikes = 0;
    t.lean = 0;
    t.serial++;
    t.flashKind = 1;
    t.flashUntil = this.time + 1.3;
    if (t.mat >= 0) {
      hooks.placeImmigrant(t.mat, r.sp);
      t.matSerial = t.serial; // переселенец живёт вместе с остатками старой жизни
    }
    feed('spread', tx, ty);
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
    if (Math.abs(r.wx - this.camX) <= 10 && Math.abs(r.wy - this.camY) <= 10) hooks.feed('extinct', r.wx, r.wy);
  }
}
