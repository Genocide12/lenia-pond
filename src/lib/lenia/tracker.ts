/**
 * Трекер организмов: следит за «пятнами жизни» между кадрами анализа поля,
 * различает рождения, гибели (растворения), слияния и деления.
 *
 * Координаты — в клетках поля (N×N, y вверх, как в текстуре состояния).
 * Все расстояния тороидальные.
 */

export interface BlobInfo {
  x: number;
  y: number;
  mass: number;
  size: number;
}

export type EventKind = 'birth' | 'death' | 'merge' | 'split';

export interface LifeEvent {
  kind: EventKind;
  t: number; // время симуляции
  x: number;
  y: number;
}

export interface TrackPoint {
  x: number;
  y: number;
}

export interface Track {
  id: number;
  x: number;
  y: number;
  mass: number;
  size: number;
  trail: TrackPoint[];
  heading: number | null; // радианы, направление последнего движения
  age: number; // сколько сканов жив
}

interface InternalTrack extends Track {
  missed: number;
  prevMass: number;
  pending: boolean;
}

const TRAIL_LEN = 46;
const MAX_MISSED = 2;
const MIN_TRACK_AGE = 2; // сканов до подтверждения события рождения

export class BlobTracker {
  private readonly N: number;
  private tracks = new Map<number, InternalTrack>();
  private nextId = 1;
  births = 0;
  deaths = 0;
  merges = 0;
  splits = 0;
  popHistory: { t: number; pop: number }[] = [];

  constructor(n = 256) {
    this.N = n;
  }

  private torusDist(ax: number, ay: number, bx: number, by: number): number {
    let dx = Math.abs(ax - bx);
    let dy = Math.abs(ay - by);
    if (dx > this.N / 2) dx = this.N - dx;
    if (dy > this.N / 2) dy = this.N - dy;
    return Math.hypot(dx, dy);
  }

  reset() {
    this.tracks.clear();
    this.births = 0;
    this.deaths = 0;
    this.merges = 0;
    this.splits = 0;
    this.popHistory = [];
  }

  getTracks(): Track[] {
    return [...this.tracks.values()];
  }

  /** Углы движения (градусы, 0 = вправо, против часовой) живых треков. */
  headings(): number[] {
    const out: number[] = [];
    for (const tr of this.tracks.values()) {
      if (tr.heading !== null && !tr.pending && tr.age >= 3) {
        out.push((tr.heading * 180) / Math.PI);
      }
    }
    return out;
  }

  /**
   * Один кадр наблюдения.
   * @param blobs найденные организмы
   * @param t время симуляции
   * @param stepsSinceScan сколько шагов прошло с прошлого скана (для порога скорости)
   */
  update(blobs: BlobInfo[], t: number, stepsSinceScan: number): LifeEvent[] {
    const events: LifeEvent[] = [];
    // порог сопоставления: быстрейшие существа ~0.8 кл/шаг + запас
    const dmax = Math.min(64, Math.max(16, stepsSinceScan * 0.9));

    for (const tr of this.tracks.values()) tr.prevMass = tr.mass;

    // жадное сопоставление: сначала крупные пятна
    const sorted = [...blobs].sort((a, b) => b.mass - a.mass);
    const takenBlob = new Set<number>();
    const matched = new Set<number>();
    for (const b of sorted) {
      let best = -1;
      let bestCost = Infinity;
      for (const [id, tr] of this.tracks) {
        if (matched.has(id)) continue;
        const d = this.torusDist(tr.x, tr.y, b.x, b.y);
        if (d > dmax) continue;
        const massRatio = Math.max(tr.mass, 1e-6) / Math.max(b.mass, 1e-6);
        const cost = d + 12 * Math.abs(Math.log(massRatio));
        if (cost < bestCost) {
          bestCost = cost;
          best = id;
        }
      }
      if (best >= 0) {
        const tr = this.tracks.get(best)!;
        const wasPending = tr.pending;
        // заголовок по последним двум точкам (с учётом тора)
        const p = tr.trail[tr.trail.length - 1];
        let dx = b.x - (p ? p.x : b.x);
        let dy = b.y - (p ? p.y : b.y);
        if (dx > this.N / 2) dx -= this.N;
        if (dx < -this.N / 2) dx += this.N;
        if (dy > this.N / 2) dy -= this.N;
        if (dy < -this.N / 2) dy += this.N;
        if (Math.hypot(dx, dy) > 0.7) tr.heading = Math.atan2(dy, dx);
        tr.x = b.x;
        tr.y = b.y;
        tr.mass = b.mass;
        tr.size = b.size;
        tr.missed = 0;
        tr.age++;
        tr.pending = false;
        tr.trail.push({ x: b.x, y: b.y });
        if (tr.trail.length > TRAIL_LEN) tr.trail.shift();
        if (wasPending && tr.trail.length >= 2) {
          // маленькое пятно пережило второй скан — подтверждаем рождение
          this.confirmEvent(tr, t, events, dmax);
        }
        matched.add(best);
        takenBlob.add(blobs.indexOf(b));
      }
    }

    // пропавшие без сопоставления
    for (const [id, tr] of [...this.tracks]) {
      if (matched.has(id)) continue;
      tr.missed++;
      if (tr.missed <= MAX_MISSED) continue;
      // гибель: рядом есть выживший, к которому оно могло прилиться?
      let mergedInto = false;
      for (const [, other] of this.tracks) {
        if (other === tr || other.pending) continue;
        if (this.torusDist(other.x, other.y, tr.x, tr.y) < dmax * 1.3) {
          mergedInto = true;
          break;
        }
      }
      if (tr.age >= MIN_TRACK_AGE) {
        if (mergedInto) {
          this.merges++;
          events.push({ kind: 'merge', t, x: tr.x, y: tr.y });
        } else {
          this.deaths++;
          events.push({ kind: 'death', t, x: tr.x, y: tr.y });
        }
      }
      this.tracks.delete(id);
    }

    // новые пятна
    for (let i = 0; i < blobs.length; i++) {
      if (takenBlob.has(i)) continue;
      const b = blobs[i];
      const id = this.nextId++;
      const tr: InternalTrack = {
        id,
        x: b.x,
        y: b.y,
        mass: b.mass,
        size: b.size,
        trail: [{ x: b.x, y: b.y }],
        heading: null,
        age: 1,
        missed: 0,
        prevMass: b.mass,
        pending: true,
      };
      this.tracks.set(id, tr);
      // рождение «сразу взрослым»: пятно крупное (не шум) — событие сразу
      if (b.mass > 14) {
        this.confirmEvent(tr, t, events, dmax);
      }
    }

    this.popHistory.push({ t, pop: blobs.length });
    if (this.popHistory.length > 260) this.popHistory.shift();
    return events;
  }

  /** Подтвердить рождение трека: событие birth или split (если рядом родитель, потерявший массу). */
  private confirmEvent(tr: InternalTrack, t: number, events: LifeEvent[], dmax: number) {
    if (!tr.pending) return;
    tr.pending = false;
    tr.age = Math.max(tr.age, MIN_TRACK_AGE);
    let parent: InternalTrack | null = null;
    for (const [, other] of this.tracks) {
      if (other === tr || other.pending) continue;
      const d = this.torusDist(other.x, other.y, tr.x, tr.y);
      if (d < Math.max(30, dmax * 1.2) && other.mass < other.prevMass * 0.62) {
        parent = other;
        break;
      }
    }
    this.births++;
    if (parent) {
      this.splits++;
      events.push({ kind: 'split', t, x: tr.x, y: tr.y });
    } else {
      events.push({ kind: 'birth', t, x: tr.x, y: tr.y });
    }
  }
}
