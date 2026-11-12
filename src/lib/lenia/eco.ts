/**
 * Биосфера планеты блюдцев: 2000×2000 блюдцев, жизнь — разреженная карта.
 *
 * Жизнь зарождается ОДНИМ видом в ОДНОМ блюдце (за всю историю планеты
 * 1–2 искры). Дальше всё делает эволюция: колонии мутируют, дивергенция
 * линии накапливается — и в какой-то момент популяция превращается в
 * НОВЫЙ ВИД со своим именем, цветом и характером. Хищники охотятся на
 * соседей и завоевывают их блюдца, симбионты поддерживают друг друга и
 * рождают гибридов, репликаторы (грибы) — фабрика новых видов. Виды
 * вымирают — до последнего блюдца.
 *
 * Характер вида — четыре черты: агрессия (охота, завоевание), броня
 * (стойкость к болезням и хищникам), мутабельность (скорость эволюции),
 * симбиоз (дружба и гибриды). Черты наследуются с вариацией, так что
 * каждый вид реально уникален. Черты исконных видов подобраны по их
 * натуре из оригинального зоопарка Lenia.
 *
 * Честная Lenia течёт в материализованных блюдцах (слоты движка), их
 * популяции синхронизируются из LOD-текстуры (syncMasses). Болезни гасят
 * колонию постепенно — тик за тиком, а не стирают блюдце за один кадр.
 */

import { POND_LIST } from './creatures';
import { DISH, META, WORLD, LOD_N } from './engine';

export { WORLD };

/** Ёмкость блюдца: абсолютный потолок организмов. */
export const DISH_CAP = 200;
/** Популяция из покрытия: масса 0.5 ≈ 200 существ. */
export const POP_PER_MASS = (DISH * DISH) / 25;
/** Максимум видов на планете: 6 бит в мета-текстуре (spEnc 1..63). */
export const SPECIES_MAX = 62;

/** Характер вида — наследуемые черты. */
export interface Traits {
  aggression: number; // охота и завоевание чужих блюдц
  armor: number; // стойкость к болезням и хищникам
  mutability: number; // скорость накопления дивергенции
  symbiosis: number; // дружба с соседями, гибриды
}

export type SpeciesRole = 'хищник' | 'сеятель видов' | 'симбионт' | 'броненосец' | 'мирный';

/** Вид: исконный или рождённый эволюцией. */
export interface SpeciesRec {
  id: number; // 0..61 — кодируется в мета-текстуре
  base: number; // тело вида — индекс в POND_LIST
  parent: number; // вид-предок (-1 — исконный)
  gen: number; // глубина эволюции
  name: string;
  role: SpeciesRole;
  m: number;
  s: number;
  T: number; // параметры шага Lenia линии
  spill: number; // популяция «блюдце переполнено»
  traits: Traits;
  born: number; // мировое время рождения
  alive: number; // живых блюдц (пересчитывается каждый тик)
  hadAlive: boolean; // был ли вид жив на прошлом тике
  extinctAt: number; // время вымирания (0 — жив или не рождался)
}

/** Черты исконных видов — по натуре существ из зоопарка Lenia. */
const BASE_TRAITS: Traits[] = [
  /* Головастик */ { aggression: 0.7, armor: 0.3, mutability: 0.3, symbiosis: 0.1 },
  /* Жук         */ { aggression: 0.8, armor: 0.2, mutability: 0.35, symbiosis: 0.05 },
  /* Волчок      */ { aggression: 0.15, armor: 0.7, mutability: 0.25, symbiosis: 0.2 },
  /* Щит         */ { aggression: 0.25, armor: 0.85, mutability: 0.2, symbiosis: 0.15 },
  /* Крониум     */ { aggression: 0.3, armor: 0.8, mutability: 0.15, symbiosis: 0.2 },
  /* Призрак     */ { aggression: 0.75, armor: 0.15, mutability: 0.4, symbiosis: 0.05 },
  /* Спираль     */ { aggression: 0.2, armor: 0.6, mutability: 0.5, symbiosis: 0.35 },
  /* Пила        */ { aggression: 0.9, armor: 0.35, mutability: 0.3, symbiosis: 0.0 },
  /* Странник    */ { aggression: 0.35, armor: 0.4, mutability: 0.45, symbiosis: 0.5 },
  /* Цветок      */ { aggression: 0.05, armor: 0.45, mutability: 0.55, symbiosis: 0.8 },
  /* Гриб        */ { aggression: 0.1, armor: 0.5, mutability: 0.95, symbiosis: 0.3 },
];

/** Переполнение блюдца по видам: грибы заполняют всё, глайдеры — патрулируют. */
const BASE_SPILL = [34, 30, 48, 52, 50, 32, 46, 36, 34, 42, DISH_CAP - 6];

/** Видовые эпитеты для имён эволюционных линий. */
const SUFFIX = [
  'прибрежный', 'глубинный', 'стремительный', 'тихий', 'крепкий', 'малый', 'великий', 'пятнистый',
  'ночной', 'светлый', 'тёмный', 'южный', 'северный', 'древний', 'новый', 'стеклянный',
  'дымчатый', 'колючий', 'лунный', 'быстрый', 'медленный', 'резкий', 'мягкий', 'сонный',
];

function roleOf(t: Traits): SpeciesRole {
  if (t.mutability >= 0.7) return 'сеятель видов';
  if (t.aggression >= 0.6) return 'хищник';
  if (t.symbiosis >= 0.6) return 'симбионт';
  if (t.armor >= 0.65) return 'броненосец';
  return 'мирный';
}

export interface EcoRec {
  wx: number;
  wy: number;
  sp: number; // id вида в таблице species (мёртвых блюдцев нет в карте)
  pop: number; // популяция (организмов)
  mass: number; // покрытие блюдца 0..1 (последняя проба GPU)
  div: number; // дивергенция линии 0..1 — накопленная эволюция
  mat: number; // слот движка или -1
  serial: number; // растёт при любом изменении экосистемы
  matSerial: number; // serial на момент материализации
  matSteps: number; // честные шаги Lenia в текущей материализации
  seedMass: number; // масса на момент материализации: льготный пол приживления
  lean: number; // подряд голодных проб
  emitAt: number; // мировое время следующего переливания (блюдце полно)
  fromDir: number; // стена, через которую пришла колония (-1 — своя)
  sickUntil: number; // мировое время конца болезни (0 — здорова)
  sickK: number; // множитель угасания за тик болезни
  flashKind: number; // 0 нет, 1 рождение, 2 болезнь, 3 гибель, 4 новый вид, 5 симбиоз
  flashUntil: number; // мировое время конца вспышки
}

export type FeedKind =
  | 'virus'
  | 'mut'
  | 'spread'
  | 'origin'
  | 'extinct'
  | 'speciate'
  | 'hybrid'
  | 'conquest'
  | 'symbiosis'
  | 'hunt';

export interface EcoHooks {
  perturb(slot: number, mode: number, seed: number, k?: number): void;
  clearSlot(slot: number): void;
  placeImmigrant(slot: number, sp: number, fromDir: number): void;
  feed(kind: FeedKind, wx: number, wy: number, text?: string): void;
}

interface OriginPlan {
  wx: number;
  wy: number;
  sp: number;
  at: number; // мировое время зарождения
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];
const OPP = [1, 0, 3, 2];

export class Biosphere {
  /** Живые блюдца планеты: ключ = wy*WORLD+wx. Мёртвых нет в карте. */
  readonly recs = new Map<number, EcoRec>();
  /** Таблица видов: id → вид (null — слот свободен). */
  readonly species: (SpeciesRec | null)[] = [];
  time = 0;
  private camX = WORLD / 2;
  private camY = WORLD / 2;
  private meta = new Uint8Array(META * META * 4);
  private shadow = new Uint8Array(META * META * 4);
  private dirtyRows = new Set<number>();
  private schedule: OriginPlan[] = [];
  private suffixIdx = 0;
  private speciesFree: number[] = [];
  private nextSpeciateAt = 0; // кулдаун видообразования: новый вид успевает расплодиться
  private iter: EcoRec[] = []; // переиспользуемый снимок для тиков — без аллокаций

  constructor() {
    this.reset();
  }

  /** Новая игра: мёртвая планета, исконные виды, расписание зарождения. */
  reset() {
    this.time = 0;
    this.recs.clear();
    this.species.length = 0;
    this.suffixIdx = 0;
    this.meta.fill(0);
    this.shadow.fill(0);
    this.dirtyRows.clear();
    // исконные виды 0..10 — тела и проверенные параметры из зоопарка
    POND_LIST.forEach((c, i) => {
      this.species[i] = {
        id: i,
        base: i,
        parent: -1,
        gen: 0,
        name: c.ru,
        role: roleOf(BASE_TRAITS[i]),
        m: c.m,
        s: c.s,
        T: c.T,
        spill: BASE_SPILL[i],
        traits: { ...BASE_TRAITS[i] },
        born: 0,
        alive: 0,
        hadAlive: false,
        extinctAt: 0,
      };
    });
    for (let i = POND_LIST.length; i < SPECIES_MAX; i++) this.species[i] = null;
    this.speciesFree = [];
    for (let i = SPECIES_MAX - 1; i >= POND_LIST.length; i--) this.speciesFree.push(i);
    this.makeSchedule();
  }

  /** История планеты: 1–2 зарождения жизни — одно сразу, вторая искра
   *  спустя долгое время, далеко от первой, с поиском свободного места.
   *  Эволюция остальных видов — только через мутации, войны и гибриды. */
  private makeSchedule() {
    const c = WORLD / 2;
    const o1 = {
      wx: Math.round(c + (Math.random() - 0.5) * 160),
      wy: Math.round(c + (Math.random() - 0.5) * 160),
    };
    const sp1 = Math.floor(Math.random() * POND_LIST.length);
    const plans: OriginPlan[] = [{ wx: o1.wx, wy: o1.wy, sp: sp1, at: 2 + Math.random() * 4 }];
    if (Math.random() < 0.75) {
      let wx = o1.wx;
      let wy = o1.wy;
      for (let guard = 0; guard < 4000 && Math.hypot(wx - o1.wx, wy - o1.wy) < 700; guard++) {
        wx = 2 + Math.floor(Math.random() * (WORLD - 4));
        wy = 2 + Math.floor(Math.random() * (WORLD - 4));
      }
      let sp2 = Math.floor(Math.random() * POND_LIST.length);
      if (sp2 === sp1) sp2 = (sp2 + 1 + Math.floor(Math.random() * (POND_LIST.length - 1))) % POND_LIST.length;
      plans.push({ wx, wy, sp: sp2, at: 120 + Math.random() * 120 });
    }
    this.schedule = plans;
  }

  key(wx: number, wy: number): number {
    return wy * WORLD + wx;
  }

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

  aliveSpeciesCount(): number {
    let n = 0;
    for (const s of this.species) if (s && s.alive > 0) n++;
    return n;
  }

  /** Таблица видов (для HUD и отладки). */
  speciesInfo(id: number): SpeciesRec | null {
    return this.species[id] ?? null;
  }

  speciesName(id: number): string {
    return this.species[id]?.name ?? '—';
  }

  speciesRole(id: number): string {
    return this.species[id]?.role ?? '';
  }

  speciesBase(id: number): number {
    return this.species[id]?.base ?? 0;
  }

  speciesT(id: number): number {
    return this.species[id]?.T ?? 10;
  }

  private sp(id: number): SpeciesRec {
    const s = this.species[id];
    if (!s) throw new Error(`вид ${id} не существует`);
    return s;
  }

  /** Параметры шага Lenia для блюдца: тело вида + параметры линии. */
  dishParams(r: EcoRec): { sp: number; m: number; s: number; T: number } {
    const s = this.sp(r.sp);
    return { sp: s.base, m: s.m, s: s.s, T: s.T };
  }

  /** То же без аллокации — в переиспользуемый объект (горячий путь кадра). */
  dishParamsInto(r: EcoRec, out: { sp: number; m: number; s: number; T: number }) {
    const s = this.species[r.sp];
    if (!s) return;
    out.sp = s.base;
    out.m = s.m;
    out.s = s.s;
    out.T = s.T;
  }

  /** Родить новый вид от родителя: параметры — маленький шаг эволюции
   *  в пределах безопасной полосы вокруг исконных (жизнеспособность),
   *  черты — наследие с вариацией. null — таблица видов переполнена. */
  private newSpecies(parent: SpeciesRec): SpeciesRec | null {
    let id = this.speciesFree.pop();
    if (id === undefined) {
      // переиспользуем слот давно вымершего вида
      let best: SpeciesRec | null = null;
      for (const s of this.species) {
        if (s && s.alive === 0 && s.hadAlive && s.extinctAt > 0 && this.time - s.extinctAt > 180) {
          if (!best || s.extinctAt < best.extinctAt) best = s;
        }
      }
      if (!best) return null;
      id = best.id;
    }
    const base = POND_LIST[parent.base];
    const m = clamp(parent.m + (Math.random() - 0.5) * 0.03, base.m - Math.min(0.04, 0.12 * base.m), base.m + Math.min(0.04, 0.12 * base.m));
    const s = clamp(parent.s * (1 + (Math.random() - 0.5) * 0.1), base.s * 0.93, base.s * 1.13);
    const T = Math.max(1, Math.round(parent.T + (Math.random() - 0.5) * 2));
    const traits: Traits = {
      aggression: clamp(parent.traits.aggression + (Math.random() - 0.5) * 0.28, 0.03, 0.97),
      armor: clamp(parent.traits.armor + (Math.random() - 0.5) * 0.28, 0.03, 0.97),
      mutability: clamp(parent.traits.mutability + (Math.random() - 0.5) * 0.3, 0.03, 0.97),
      symbiosis: clamp(parent.traits.symbiosis + (Math.random() - 0.5) * 0.28, 0.02, 0.97),
    };
    let name = `${base.ru} ${SUFFIX[this.suffixIdx++ % SUFFIX.length]}`;
    if (this.species.some((x) => x && x.name === name)) name += `-${parent.gen + 1}`;
    const rec: SpeciesRec = {
      id,
      base: parent.base,
      parent: parent.id,
      gen: parent.gen + 1,
      name,
      role: roleOf(traits),
      m,
      s,
      T,
      spill: clamp(parent.spill + (Math.random() - 0.5) * 30, 24, DISH_CAP - 6),
      traits,
      born: this.time,
      alive: 0,
      hadAlive: false,
      extinctAt: 0,
    };
    this.species[id] = rec;
    return rec;
  }

  /** Заселить блюдце видом (зарождение жизни, посадка, сброс). */
  seedDish(wx: number, wy: number, sp: number, pop: number) {
    if (!this.inWorld(wx, wy) || !this.species[sp]) return;
    const k = this.key(wx, wy);
    const old = this.recs.get(k);
    const r: EcoRec = old
      ? { ...old, sp, pop, mass: clamp(pop / POP_PER_MASS, 0, 1), div: 0, sickUntil: 0, lean: 0, serial: old.serial + 1, flashKind: 1, flashUntil: this.time + 1.3 }
      : this.fresh(wx, wy, sp, pop);
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
   *  LOD-текстуры движка (слот → блюдце через slotDish).
   *
   *  Льготный период приживления: только что материализованное блюдце
   *  (matSteps < 48) не роняет массу ниже посева — честная колония на GPU
   *  разрастается до статистической за пару секунд, а чтение LOD могло
   *  произойти ещё до посева (асинхронный PBO) — раньше это обнуляло
   *  пятно в момент приближения камеры. */
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
      let m = s / (LOD_N * LOD_N);
      if (r.matSteps < 48 && r.seedMass > m) {
        m = Math.max(m, r.seedMass * (1 - r.matSteps / 48));
      }
      r.mass = m;
      r.pop = clamp(r.mass * POP_PER_MASS, 0.5, DISH_CAP * 1.1);
    }
  }

  /** Один тик планеты. dt — условные секунды (масштабируются скоростью). */
  tick(dt: number, hooks: EcoHooks) {
    this.time += dt;

    // расписание зарождений: редкие искры жизни в пустом мире.
    // Занято намеченное блюдце — ищем ближайшее свободное, искра не пропадает
    while (this.schedule.length > 0 && this.schedule[0].at <= this.time) {
      const o = this.schedule.shift()!;
      let wx = o.wx;
      let wy = o.wy;
      if (this.recs.has(this.key(wx, wy))) {
        let found = false;
        for (let rad = 1; rad <= 30 && !found; rad++) {
          for (let dy = -rad; dy <= rad && !found; dy++) {
            for (let dx = -rad; dx <= rad; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
              if (!this.inWorld(wx + dx, wy + dy) || this.recs.has(this.key(wx + dx, wy + dy))) continue;
              wx += dx;
              wy += dy;
              found = true;
            }
          }
        }
        if (!found) continue;
      }
      this.recs.set(this.key(wx, wy), this.fresh(wx, wy, o.sp, 6));
      hooks.feed('origin', wx, wy, `жизнь зародилась: ${this.sp(o.sp).name.toLowerCase()}`);
    }

    let feeds = 0;
    const feed = (kind: FeedKind, wx: number, wy: number, text?: string) => {
      // видообразование, гибриды и завоевания — всегда в ленту
      if (kind !== 'speciate' && kind !== 'hybrid' && kind !== 'conquest') {
        if (feeds >= 3) return;
        if (Math.abs(wx - this.camX) > 60 || Math.abs(wy - this.camY) > 60) return;
        feeds++;
      }
      hooks.feed(kind, wx, wy, text);
    };

    // снимок живых блюдцев — один на весь тик, без копирования массива
    this.iter.length = 0;
    for (const r of this.recs.values()) this.iter.push(r);
    for (let ii = 0; ii < this.iter.length; ii++) {
      const r = this.iter[ii];
      const s = this.sp(r.sp);

      // болезнь: колония гаснет постепенно, тик за тиком — без обнулений
      if (r.sickUntil > this.time) {
        const kEff = Math.pow(r.sickK, dt / 0.5);
        if (r.mat >= 0) hooks.perturb(r.mat, 2, Math.random() * 100, kEff);
        r.pop *= kEff;
        r.mass *= kEff;
      }

      // скученность вида: монокультура соседних блюдц — рассадник болезней
      let sameN = 0;
      for (let d = 0; d < 4; d++) {
        const n = this.recs.get(this.key(r.wx + DX[d], r.wy + DY[d]));
        if (n && n.sp === r.sp) sameN++;
      }
      const plague = 0.0004 + 0.0007 * sameN;

      if (r.mat >= 0) {
        // материализованное блюдце: жизнь течёт честной Lenia на GPU
        if (r.mass < 0.0018) {
          if (++r.lean >= 4) {
            this.extinct(r, hooks, feed);
            continue;
          }
        } else {
          r.lean = 0;
          if (r.pop >= s.spill - 6 && this.time >= r.emitAt) {
            // блюдце заполнено организмами — колония переливается в соседей
            r.emitAt = this.time + 3 + Math.random() * 4;
            this.emigrate(r, hooks, feed);
          } else if (Math.random() < (plague * dt * Math.pow(Math.min(1, r.pop / s.spill), 2)) / (0.4 + s.traits.armor)) {
            // болезнь от скученности: заражение + постепенное угасание
            hooks.perturb(r.mat, 1, Math.random() * 100);
            this.sicken(r, 2.0 + Math.random() * 1.2, 0.8);
            r.flashKind = 2;
            r.flashUntil = this.time + 1.3;
            r.serial++;
            r.matSerial = r.serial; // заражение уже на GPU — колония продолжает жить
            feed('virus', r.wx, r.wy);
          } else if (Math.random() < 0.01 * dt * (0.25 + Math.min(1.5, r.pop / 100)) * (0.5 + s.traits.mutability)) {
            this.evolve(r, feed);
          }
        }
      } else {
        // статистическое блюдце: мягкая логистика до ёмкости вида
        const cap = s.spill;
        r.pop += (0.16 * r.pop * (1 - r.pop / cap) + (Math.random() - 0.5) * 0.6) * dt;
        if (r.pop < 0.3) {
          this.extinct(r, hooks, feed);
          continue;
        }
        if (r.pop >= cap - 6 && this.time >= r.emitAt) {
          r.emitAt = this.time + 3 + Math.random() * 4;
          this.emigrate(r, hooks, feed);
        } else if (Math.random() < (plague * dt * (r.pop / cap)) / (0.4 + s.traits.armor)) {
          this.sicken(r, 2.4, 0.72);
          r.flashKind = 2;
          r.flashUntil = this.time + 1.3;
          feed('virus', r.wx, r.wy);
        } else if (Math.random() < 0.01 * dt * (0.25 + Math.min(1.5, r.pop / 100)) * (0.5 + s.traits.mutability)) {
          this.evolve(r, feed);
        }
      }
    }

    // фронтир: встретившиеся виды вступают в отношения — война или симбиоз
    this.iter.length = 0;
    for (const r of this.recs.values()) this.iter.push(r);
    for (let ii = 0; ii < this.iter.length; ii++) {
      const a = this.iter[ii];
      for (let d = 0; d < 2; d++) {
        const tx = a.wx + (d === 0 ? 1 : 0);
        const ty = a.wy + (d === 0 ? 0 : 1);
        if (!this.inWorld(tx, ty)) continue;
        const b = this.recs.get(this.key(tx, ty));
        if (!b || b.sp === a.sp) continue;
        if (Math.random() < 0.02 * dt) this.conflict(a, b, hooks, feed);
      }
    }

    // учёт видов: вид вымирает, когда погибло его последнее блюдце
    for (const s of this.species) if (s) s.alive = 0;
    for (const r of this.recs.values()) this.sp(r.sp).alive++;
    for (const s of this.species) {
      if (!s) continue;
      if (s.hadAlive && s.alive === 0) {
        s.extinctAt = this.time;
        hooks.feed('extinct', this.camX, this.camY, `вид погиб: ${s.name.toLowerCase()}`);
      }
      s.hadAlive = s.alive > 0;
    }
  }

  private sicken(r: EcoRec, dur: number, k: number) {
    r.sickUntil = Math.max(r.sickUntil, this.time + dur);
    r.sickK = Math.min(r.sickK < 1 ? r.sickK : 1, k);
  }

  /** Мутация линии: дивергенция растёт тем быстрее, чем мутабельнее вид.
   *  Когда она достигает единицы — популяция стала новым видом. Кулдаун
   *  на всю планету: новый вид успевает расплодиться, а не тонет в череде
   *  переименований. */
  private evolve(r: EcoRec, feed: (k: FeedKind, x: number, y: number, t?: string) => void) {
    const s = this.sp(r.sp);
    r.div += (0.16 + 0.3 * s.traits.mutability) * (0.6 + Math.random() * 0.8);
    r.serial++;
    if (r.div >= 1) {
      if (this.time < this.nextSpeciateAt) {
        r.div = 0.92; // планета ещё не готова к новому виду — дивергенция зреет
        return;
      }
      const child = this.newSpecies(s);
      if (child) {
        r.sp = child.id;
        r.div = 0;
        this.nextSpeciateAt = this.time + 45 + Math.random() * 45;
        if (r.mat >= 0) r.matSerial = r.serial; // параметры шага меняются мягко, пересев не нужен
        r.flashKind = 4;
        r.flashUntil = this.time + 1.6;
        feed('speciate', r.wx, r.wy, `новый вид: ${child.name.toLowerCase()}`);
      } else {
        r.div = 0.45; // таблица видов полна — эволюция продолжится позже
      }
    } else {
      feed('mut', r.wx, r.wy);
    }
  }

  /** Встреча видов на фронтире: симбионты дружат и рождают гибридов,
   *  хищники охотятся и завоевывают блюдца. */
  private conflict(a: EcoRec, b: EcoRec, hooks: EcoHooks, feed: (k: FeedKind, x: number, y: number, t?: string) => void) {
    const sa = this.sp(a.sp);
    const sb = this.sp(b.sp);

    // симбиоз: два дружелюбных вида поддерживают друг друга
    const sym = sa.traits.symbiosis + sb.traits.symbiosis;
    if (Math.random() < 0.06 * sym) {
      a.pop = Math.min(sa.spill * 1.2, a.pop + 2.5);
      b.pop = Math.min(sb.spill * 1.2, b.pop + 2.5);
      a.flashKind = 5;
      a.flashUntil = this.time + 1.2;
      b.flashKind = 5;
      b.flashUntil = this.time + 1.2;
      feed('symbiosis', a.wx, a.wy, `симбиоз: ${sa.name.toLowerCase()} + ${sb.name.toLowerCase()}`);
      if (Math.random() < 0.06) this.hybridize(a, b, feed);
      return;
    }

    // война: агрессор бьёт жертву — сила зависит от численности и брони
    const att = sa.traits.aggression + Math.random() * 0.35 >= sb.traits.aggression + Math.random() * 0.35 ? a : b;
    const def = att === a ? b : a;
    const satt = att === a ? sa : sb;
    const sdef = def === a ? sa : sb;
    const power = satt.traits.aggression * Math.min(1.6, att.pop / 40);
    const resist = 0.35 + 0.65 * sdef.traits.armor;
    const dmg = (power * 11 * 0.5) / resist;
    def.pop -= dmg;
    att.pop = Math.min(satt.spill * 1.3, att.pop + dmg * 0.45); // хищник кормится
    if (def.pop < Math.max(4, sdef.spill * 0.12)) {
      this.conquer(att, def, hooks, feed);
    } else {
      def.flashKind = 2;
      def.flashUntil = this.time + 1.0;
      if (def.mat >= 0) this.sicken(def, 1.2, 0.88); // раны
      feed('hunt', def.wx, def.wy, `${satt.name.toLowerCase()} охотится на ${sdef.name.toLowerCase()}`);
    }
  }

  /** Завоевание: блюдце переходит победителю. Старая жизнь угасает под
   *  новыми параметрами сама (честная Lenia), завоеватели входят через
   *  стену, обращённую к родной колонии. */
  private conquer(att: EcoRec, def: EcoRec, hooks: EcoHooks, feed: (k: FeedKind, x: number, y: number, t?: string) => void) {
    const satt = this.sp(att.sp);
    const oldName = this.sp(def.sp).name.toLowerCase();
    def.sp = att.sp;
    def.pop = 3;
    def.div = 0;
    def.lean = 0;
    def.sickUntil = 0;
    def.emitAt = this.time + 20 + Math.random() * 15;
    def.serial++;
    def.flashKind = 3;
    def.flashUntil = this.time + 1.5;
    if (def.mat >= 0) {
      const dx = Math.sign(def.wx - att.wx);
      const dy = Math.sign(def.wy - att.wy);
      const d = dx !== 0 ? (dx > 0 ? 0 : 1) : dy > 0 ? 2 : 3;
      for (let i = 0; i < 3; i++) hooks.placeImmigrant(def.mat, att.sp, OPP[d]);
      def.matSerial = def.serial; // завоеватели уже на GPU — пересев не нужен
    }
    att.pop = Math.max(1, att.pop - 3);
    feed('conquest', def.wx, def.wy, `${satt.name.toLowerCase()} завоевал блюдце ${oldName}`);
  }

  /** Гибрид: два вида-симбионта рождают нового — смесь черт родителей. */
  private hybridize(a: EcoRec, b: EcoRec, feed: (k: FeedKind, x: number, y: number, t?: string) => void) {
    const src = Math.random() < 0.5 ? a : b;
    const d = Math.floor(Math.random() * 4);
    const tx = src.wx + DX[d];
    const ty = src.wy + DY[d];
    if (!this.inWorld(tx, ty) || this.recs.has(this.key(tx, ty))) return;
    const parentId = Math.random() < 0.5 ? a.sp : b.sp;
    const child = this.newSpecies(this.sp(parentId));
    if (!child) return;
    const other = this.sp(child.parent === a.sp ? b.sp : a.sp);
    child.traits.aggression = clamp((child.traits.aggression + other.traits.aggression) / 2 + (Math.random() - 0.5) * 0.1, 0.03, 0.97);
    child.traits.armor = clamp((child.traits.armor + other.traits.armor) / 2 + (Math.random() - 0.5) * 0.1, 0.03, 0.97);
    child.traits.mutability = clamp((child.traits.mutability + other.traits.mutability) / 2 + (Math.random() - 0.5) * 0.12, 0.03, 0.97);
    child.traits.symbiosis = clamp((child.traits.symbiosis + other.traits.symbiosis) / 2 + (Math.random() - 0.5) * 0.1, 0.02, 0.97);
    child.role = roleOf(child.traits);
    this.recs.set(this.key(tx, ty), this.fresh(tx, ty, child.id, 3));
    feed('hybrid', tx, ty, `гибрид: ${child.name.toLowerCase()}`);
  }

  /** Заполненное блюдце переливается в соседа: колонисты идут через
   *  общую стену. Пустое блюдце — колония, чужое — война. */
  private emigrate(r: EcoRec, hooks: EcoHooks, feed: (k: FeedKind, x: number, y: number, t?: string) => void) {
    const d = Math.floor(Math.random() * 4);
    const tx = r.wx + DX[d];
    const ty = r.wy + DY[d];
    if (!this.inWorld(tx, ty)) return;
    const k = this.key(tx, ty);
    const t = this.recs.get(k);
    if (!t) {
      // пустое блюдце — колония несёт свой вид
      const rec = this.fresh(tx, ty, r.sp, 2);
      rec.fromDir = OPP[d]; // пришли через стену, обращённую к родителю
      this.recs.set(k, rec);
      r.pop = Math.max(0.5, r.pop - 2);
      feed('spread', tx, ty);
    } else if (t.sp === r.sp) {
      const s = this.sp(t.sp);
      t.pop = Math.min(s.spill + 16, t.pop + 3); // подкрепление своих
      if (t.mat >= 0) hooks.placeImmigrant(t.mat, r.sp, OPP[d]);
      r.pop = Math.max(0.5, r.pop - 2);
    } else {
      this.conflict(r, t, hooks, feed); // вторжение в чужое блюдце — война
    }
  }

  private extinct(r: EcoRec, hooks: EcoHooks, feed: (k: FeedKind, x: number, y: number, t?: string) => void) {
    const hadSlot = r.mat >= 0;
    const name = this.sp(r.sp).name.toLowerCase();
    this.recs.delete(this.key(r.wx, r.wy));
    this.put0(r.wx, r.wy);
    if (hadSlot) {
      hooks.clearSlot(r.mat);
      r.mat = -1;
    }
    if (Math.abs(r.wx - this.camX) <= 60 && Math.abs(r.wy - this.camY) <= 60) {
      feed('extinct', r.wx, r.wy, `колония погибла: ${name}`);
    }
  }

  private fresh(wx: number, wy: number, sp: number, pop: number): EcoRec {
    return {
      wx,
      wy,
      sp,
      pop,
      mass: clamp(pop / POP_PER_MASS, 0, 1),
      div: 0,
      mat: -1,
      serial: 1,
      matSerial: 0,
      matSteps: 0,
      seedMass: clamp(pop / POP_PER_MASS, 0, 1),
      lean: 0,
      emitAt: this.time + 20 + Math.random() * 15,
      fromDir: -1,
      sickUntil: 0,
      sickK: 1,
      flashKind: 1,
      flashUntil: this.time + 1.3,
    };
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

  /** Ячейка блюдца: R = слот(ст.4б) + вид(мл.4б), G = жизнь(6б) + вид(ст.2б),
   *  B = слот(мл.8б), A = вспышка(тип 3б + амплитуда 5б). */
  private cell(r: EcoRec) {
    const life = r.mat >= 0 ? Math.min(1, r.mass * 2) : Math.sqrt(Math.min(1, r.pop / this.sp(r.sp).spill));
    let kind = 0;
    let amp = 0;
    if (r.flashKind > 0 && r.flashUntil > this.time) {
      kind = r.flashKind;
      amp = Math.min(1, (r.flashUntil - this.time) / 1.3);
    }
    const life6 = Math.round(Math.min(1, life * (1 + 0.9 * amp)) * 63);
    const spEnc = r.sp + 1; // 1..62, 0 — мёртвое блюдце
    const slotEnc = r.mat >= 0 ? r.mat + 1 : 0;
    const rb = ((slotEnc >> 8) << 4) | (spEnc & 15);
    const g = (life6 << 2) | (spEnc >> 4);
    const a = kind > 0 ? (kind << 5) | Math.round(31 * amp) : 0;
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
