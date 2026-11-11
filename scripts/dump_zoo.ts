// Дамп зоопарка в JSON для NumPy-проверок: bun scripts/dump_zoo.ts
import { CREATURES } from '../src/lib/lenia/creatures';

const out = CREATURES.map((c) => ({
  id: c.id, name: c.name, ru: c.ru, kind: c.kind,
  R: c.R, T: c.T, b: c.b, m: c.m, s: c.s, kn: c.kn, gn: c.gn,
  w: c.w, h: c.h, cells: c.cells.map((v) => Math.round(v * 255)),
}));

await Bun.write('scripts/pond_zoo.json', JSON.stringify(out));
console.log('ok', out.length, 'creatures');
