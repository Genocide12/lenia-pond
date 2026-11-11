/**
 * Пруд Лении — движок планеты блюдцев на WebGL2.
 *
 * Планета — поле WORLD×WORLD блюдцев (2000×2000, как просил автор):
 * каждое блюдце — ограниченное поле DISH×DISH клеток СО СТЕНАМИ. Существа
 * чувствуют границы своего блюдца (свёртка видит пустоту за стеной) и не
 * пересекают их — пока блюдце не заполнится 200 организмами, тогда колония
 * переливается в соседние блюдца (уровень биосферы, eco.ts).
 *
 * Честная Lenia (Bert Wang-Chak Chan): A ← clip(A + dt·G(K∗A)) — течёт
 * в материализованных блюдцах: каждое видимое блюдце получает слот
 * в атласе R32F (SD×SD слотов, ping-pong). Остальная планета живёт
 * статистически (популяции биосферы) и рисуется мета-текстурой 2048×2048
 * (тексель = блюдце, mip-уровни для дальнего плана). При отдалении камера
 * видит цветную движущуюся мозаику всей планеты без мерцания, при
 * приближении блюдца обретают структуру и существ — состояние не теряется.
 *
 * Точность float32 обязательна: на float16 каскад деления гриба ломается
 * (scripts/verify_precision.py). Шейдеры совместимы со SwiftShader:
 * precision highp int, никаких операций vec2 − скаляр.
 */

import { POND_LIST, rotateCells, type Creature } from './creatures';

export const DISH = 100; // клеток в блюдце (должно совпадать с шейдерами)
export const WORLD = 2000; // блюдцев в стороне планеты → 2000×2000 блюдцев
export const META = 2048; // сторона мета-текстуры планеты (тексель = блюдце)
export const LOD_N = 10; // текселей LOD на блюдце по стороне
export const LOD_CELL = DISH / LOD_N; // клеток, усредняемых в один тексель LOD
export const LOD_LO = 32; // px на блюдце: ниже — чистый LOD-рендер
export const LOD_HI = 64; // px на блюдце: выше — честная выборка клеток

/** Палитры не нужны: цвет вида считается в шейдере из его id (hue),
 *  поэтому новых видов может быть много — до 62, и все различимы. */

/* ---------- ядро и рост (JS-зеркало для нормировки) ---------- */

function kernelCore(r: number, kn: number): number {
  switch (kn) {
    case 1: {
      const q = 4 * r * (1 - r);
      return q * q * q * q;
    }
    case 2:
      if (r <= 0 || r >= 1) return 0;
      return Math.exp(4 - 1 / (r * (1 - r)));
    case 3:
      return r >= 0.25 && r <= 0.75 ? 1 : 0;
    default:
      return (r >= 0.25 && r <= 0.75 ? 1 : 0) + (r < 0.25 ? 0.5 : 0);
  }
}

function kernelAt(r: number, b: number[], kn: number): number {
  if (r >= 1) return 0;
  const NB = b.length;
  const Br = NB * r;
  const idx = Math.min(Math.floor(Br), NB - 1);
  const f = Math.min(Br - idx, 1);
  return kernelCore(f, kn) * b[idx];
}

function kernelNorm(R: number, b: number[], kn: number): number {
  let sum = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) sum += kernelAt(Math.hypot(dx, dy) / R, b, kn);
  }
  return sum || 1;
}

/** Цвет вида — зеркало шейдера: hue из золотого сечения по id вида,
 *  t — яркость 0..1 (тело темнее воды → яркий цвет вида). */
export function speciesColorJS(sp: number, t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  const h = (0.61803399 * sp + 0.06) % 1;
  const s = 0.62 + 0.3 * x;
  const v = 0.05 + 0.95 * x;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const w = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, w, p];
    case 1: return [q, v, p];
    case 2: return [p, v, w];
    case 3: return [p, q, v];
    case 4: return [w, p, v];
    default: return [v, p, q];
  }
}

/* ---------- шейдеры ---------- */

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

/** Шаг Lenia внутри блюдца со стенами: за границей — пустота (нули),
 *  поэтому существа чувствуют стену и не пересекают её. */
const STEP_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uState;
uniform sampler2D uKernel; // (2R+1)² весов — вместо ALU-ядра в цикле
uniform ivec2 uOrigin;
uniform int uR, uGn;
uniform float uMu, uSigma, uDt, uNorm;
out vec4 frag;

float growth(float u) {
  float x = u - uMu;
  if (uGn == 1) { float t = max(0.0, 1.0 - (x * x) / (9.0 * uSigma * uSigma)); return t * t * t * t * 2.0 - 1.0; }
  if (uGn == 3) { return (abs(x) <= uSigma) ? 1.0 : -1.0; }
  return exp(-(x * x) / (2.0 * uSigma * uSigma)) * 2.0 - 1.0;
}
void main() {
  ivec2 lc = ivec2(gl_FragCoord.xy) - uOrigin;
  float u = 0.0;
  for (int dy = -uR; dy <= uR; dy++) {
    for (int dx = -uR; dx <= uR; dx++) {
      float k = texelFetch(uKernel, ivec2(dx + uR, dy + uR), 0).r;
      if (k != 0.0) {
        int qx = lc.x + dx;
        int qy = lc.y + dy;
        if (qx >= 0 && qx < ${DISH} && qy >= 0 && qy < ${DISH}) {
          u += k * texelFetch(uState, uOrigin + ivec2(qx, qy), 0).r;
        }
      }
    }
  }
  u /= uNorm;
  float a = texelFetch(uState, uOrigin + lc, 0).r;
  frag = vec4(clamp(a + uDt * growth(u), 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

/** Возмущения экосистемы: мор (0), вирус (1) и угасание (2 — умножение
 *  на uK: болезни гасят колонию постепенно, тик за тиком). */
const PERTURB_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uState;
uniform ivec2 uOrigin;
uniform int uMode;
uniform float uSeed;
uniform float uK;
out vec4 frag;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = h(i), b = h(i + vec2(1.0, 0.0)), c = h(i + vec2(0.0, 1.0)), d = h(i + vec2(1.0, 1.0));
  return a + (b - a) * f.x + (c - a) * f.y + (a - b - c + d) * f.x * f.y;
}
void main() {
  ivec2 gc = ivec2(gl_FragCoord.xy);
  float a = texelFetch(uState, gc, 0).r;
  vec2 lc = vec2(gc - uOrigin);
  if (uMode == 0) {
    float n = vnoise(lc * 0.10);
    frag = vec4(a * clamp((n - 0.30) / 0.36, 0.18, 1.0), 0.0, 0.0, 1.0);
  } else if (uMode == 1) {
    float n = vnoise(lc * 0.13);
    float blob = smoothstep(0.55, 0.85, vnoise(lc * 0.09 + vec2(37.0)));
    frag = vec4(clamp(a * clamp((n - 0.30) / 0.42, 0.18, 1.0) + 0.5 * blob, 0.0, 1.0), 0.0, 0.0, 1.0);
  } else {
    frag = vec4(a * uK, 0.0, 0.0, 1.0);
  }
}`;

/** LOD всех слотов за один проход: тексель — среднее блока LOD_CELL². */
const LOD_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uState;
out vec4 frag;
void main() {
  ivec2 lc = ivec2(gl_FragCoord.xy);
  ivec2 slot = ivec2(lc.x / ${LOD_N}, lc.y / ${LOD_N});
  ivec2 sub = ivec2(lc.x - slot.x * ${LOD_N}, lc.y - slot.y * ${LOD_N});
  ivec2 org = ivec2(slot.x * ${DISH} + sub.x * ${LOD_CELL}, slot.y * ${DISH} + sub.y * ${LOD_CELL});
  float s = 0.0;
  for (int y = 0; y < ${LOD_CELL}; y++) {
    for (int x = 0; x < ${LOD_CELL}; x++) {
      s += texelFetch(uState, org + ivec2(x, y), 0).r;
    }
  }
  frag = vec4(s / float(${LOD_CELL * LOD_CELL}), 0.0, 0.0, 1.0);
}`;

const COPY_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform ivec2 uOffset;
out vec4 frag;
void main() { frag = texelFetch(uSrc, ivec2(gl_FragCoord.xy) + uOffset, 0); }`;

/** Аддитивная посадка: существо вливается в жизнь блюдца (max),
 *  не пробивая дыру в чужой колонии. Штамп — блюдце целиком. */
const STAMP_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform sampler2D uStamp;
uniform ivec2 uOrigin;
out vec4 frag;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy) - uOrigin;
  frag = vec4(max(texelFetch(uSrc, uOrigin + c, 0).r, texelFetch(uStamp, c, 0).r), 0.0, 0.0, 1.0);
}`;

/**
 * Рендер планеты. Три этажа детализации, без мерцания при зуме:
 *  - далеко (блюдце < 1 px): мип-уровни мета-текстуры — цветная движущаяся
 *    мозаика всей планеты;
 *  - средне (1..32 px): тексель блюдца — цвет вида × уровень жизни,
 *    с тихим ползущим шумом; материализованные блюдца — LOD-структура;
 *  - близко (≥32 px): честные клетки из слота, у стен — пустота.
 * Упаковка мета-тексселя: R = слот(ст.4б) + вид(мл.4б),
 * G = жизнь(6б) + вид(ст.2б) — виды id 0..61, B = слот(мл.8б),
 * A = вспышка (тип 3б + амплитуда 5б).
 * Цвет вида — hue из золотого сечения: каждый вид (в том числе
 * рождённый эволюцией) имеет свой узнаваемый цвет.
 */
const RENDER_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uState;
uniform sampler2D uLod;
uniform sampler2D uMeta;
uniform vec2 uCam;
uniform float uScale;
uniform vec2 uRes;
uniform float uTime;
uniform float uGamma;
uniform vec2 uFocus;
out vec4 frag;

const int LOD_LO = ${LOD_LO};
const int LOD_HI = ${LOD_HI};

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float tri(float x) { return abs(fract(x) * 2.0 - 1.0); }
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = h21(i), b = h21(i + vec2(1.0, 0.0)), c = h21(i + vec2(0.0, 1.0)), d = h21(i + vec2(1.0, 1.0));
  return a + (b - a) * f.x + (c - a) * f.y + (a - b - c + d) * f.x * f.y;
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
// цвет вида: hue из золотого сечения по id — до 62 различимых видов
vec3 speciesColor(int sp, float t) {
  float x = clamp(t, 0.0, 1.0);
  float hue = fract(0.61803399 * float(sp) + 0.06);
  return hsv2rgb(vec3(hue, 0.62 + 0.30 * x, 0.05 + 0.95 * x));
}
// честная выборка клеток слота; за стеной блюдца — пустота
float field(ivec2 origin, vec2 f) {
  vec2 p = f * float(${DISH}) - vec2(0.5);
  ivec2 i0 = ivec2(floor(p));
  vec2 fr = p - vec2(i0);
  float v = 0.0;
  for (int j = 0; j < 4; j++) {
    ivec2 o = ivec2(j - (j / 2) * 2, j / 2);
    ivec2 c = i0 + o;
    if (c.x >= 0 && c.x < ${DISH} && c.y >= 0 && c.y < ${DISH}) {
      float wgt = (o.x == 0 ? 1.0 - fr.x : fr.x) * (o.y == 0 ? 1.0 - fr.y : fr.y);
      v += texelFetch(uState, origin + c, 0).r * wgt;
    }
  }
  return v;
}
// ручная билинейка LOD слота: R32F нельзя фильтровать LINEAR
float slotLod(int slot, vec2 f) {
  ivec2 lorg = ivec2((slot % __SD__) * ${LOD_N}, (slot / __SD__) * ${LOD_N});
  vec2 p = f * float(${LOD_N}) - vec2(0.5);
  ivec2 i0 = ivec2(floor(p));
  vec2 fr = p - vec2(i0);
  ivec2 mn = lorg;
  ivec2 mx = lorg + ivec2(${LOD_N} - 1);
  ivec2 c0 = clamp(i0, mn, mx);
  ivec2 c1 = clamp(i0 + ivec2(1), mn, mx);
  float a = texelFetch(uLod, c0, 0).r;
  float b = texelFetch(uLod, ivec2(c1.x, c0.y), 0).r;
  float c = texelFetch(uLod, ivec2(c0.x, c1.y), 0).r;
  float d = texelFetch(uLod, c1, 0).r;
  return mix(mix(a, b, fr.x), mix(c, d, fr.x), fr.y);
}
// мета-текстура с мипами: пиксель вдали накрывает много блюдцев
vec4 metaAt(vec2 wpos) {
  float lv = clamp(-log2(max(uScale, 0.0001)), 0.0, 6.0);
  int L = int(lv);
  float s = exp2(float(L));
  vec2 p = wpos / vec2(s) - vec2(0.5);
  ivec2 i0 = ivec2(floor(p));
  vec2 fr = p - vec2(i0);
  int mx = (${META} >> L) - 1;
  ivec2 mn = ivec2(0);
  ivec2 mxv = ivec2(mx);
  ivec2 c0 = clamp(i0, mn, mxv);
  ivec2 c1 = clamp(i0 + ivec2(1), mn, mxv);
  vec4 a = texelFetch(uMeta, c0, L);
  vec4 b = texelFetch(uMeta, ivec2(c1.x, c0.y), L);
  vec4 c = texelFetch(uMeta, ivec2(c0.x, c1.y), L);
  vec4 d = texelFetch(uMeta, c1, L);
  return mix(mix(a, b, fr.x), mix(c, d, fr.x), fr.y);
}
void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 w = uCam + (px - uRes * 0.5) / uScale;
  vec2 q = px / uRes - vec2(0.5);
  vec3 bg = vec3(0.005, 0.011, 0.010) * (1.0 - 0.4 * dot(q, q));

  // вне конечной планеты — тёмная бездна с мягким ореолом края мира
  vec2 dout = max(vec2(0.0) - w, w - vec2(float(${WORLD})));
  float od = max(dout.x, dout.y);
  if (od > 0.0) {
    vec3 halo = vec3(0.012, 0.055, 0.034) * exp(-od * 2.6);
    frag = vec4(bg * 0.55 + halo, 1.0);
    return;
  }

  vec2 dishf = floor(w);
  vec2 f = fract(w);
  float h1 = hash12(dishf);

  vec4 m = uScale >= 0.95 ? texelFetch(uMeta, ivec2(dishf), 0) : metaAt(w);
  int rb = int(m.r * 255.0 + 0.5);
  int gb = int(m.g * 255.0 + 0.5);
  int spEnc = ((gb & 3) << 4) + (rb & 15);
  int sp = spEnc - 1;
  int slotEnc = ((rb >> 4) << 8) + int(m.b * 255.0 + 0.5);
  int slot = slotEnc > 0 ? slotEnc - 1 : -1;
  float life = float(gb >> 2) / 63.0;
  int fa = int(m.a * 255.0 + 0.5);
  int fkind = fa >> 5;
  float flash = float(fa & 31) / 31.0;

  // вода блюдца: вблизи — своя у каждого, вдали — глубокая гладь
  vec3 water = mix(vec3(0.014, 0.040, 0.044), vec3(0.043, 0.031, 0.013), h1) * (0.72 + 0.56 * h1);
  water = mix(vec3(0.010, 0.028, 0.032), water, smoothstep(0.6, 2.5, uScale));

  vec3 col;
  if (slot >= 0 && sp >= 0) {
    // материализованное блюдце: честная жизнь (клетки/LOD)
    ivec2 so = ivec2((slot % __SD__) * ${DISH}, (slot / __SD__) * ${DISH});
    float v;
    if (uScale >= float(LOD_HI)) {
      v = field(so, f);
    } else if (uScale > float(LOD_LO)) {
      float vd = field(so, f);
      float vl = slotLod(slot, f);
      v = mix(vl, vd, smoothstep(float(LOD_LO), float(LOD_HI), uScale));
    } else {
      v = slotLod(slot, f);
    }
    float sh = v * v * (3.0 - 2.0 * v);
    float vis = smoothstep(0.015, 0.11, v);
    col = mix(water, speciesColor(sp, pow(sh, uGamma)), vis);
  } else if (sp >= 0) {
    // статистическое блюдце: цвет вида × уровень жизни, тихий ползущий шум
    vec3 sc = speciesColor(sp, 0.80);
    float n = vnoise(f * 3.0 + vec2(h1 * 17.0) + vec2(uTime * 0.05));
    n = mix(0.5, n, smoothstep(1.5, 4.0, uScale));
    float vis = smoothstep(0.02, 0.30, life) * (0.72 + 0.38 * n);
    col = mix(water, sc, clamp(vis, 0.0, 1.0));
  } else {
    col = water;
  }

  // вспышки событий: кольцо вблизи, пульс всего блюдца вдали
  // 1 рождение (зелёный), 2 болезнь (янтарный), 3 гибель (красный),
  // 4 новый вид (фиолетовый), 5 симбиоз (циановый)
  if (flash > 0.003 && fkind > 0) {
    vec3 fc = fkind == 1 ? vec3(0.20, 0.90, 0.55) : fkind == 2 ? vec3(0.95, 0.75, 0.20) : fkind == 3 ? vec3(0.95, 0.35, 0.45) : fkind == 4 ? vec3(0.80, 0.60, 1.00) : vec3(0.45, 0.90, 0.95);
    if (uScale > 14.0) {
      vec2 dpx = min(f, vec2(1.0) - f) * uScale;
      float edge = min(dpx.x, dpx.y);
      float ring = 1.0 - smoothstep(0.0, 10.0, edge);
      col = mix(col, fc, ring * flash * (0.55 + 0.45 * tri(uTime * 4.5)));
    } else {
      col = mix(col, fc, flash * 0.75);
    }
  }

  // сетка блюдцев вблизи
  if (uScale > 26.0) {
    vec2 dpx = min(f, vec2(1.0) - f) * uScale;
    float edge = min(dpx.x, dpx.y);
    float lineA = 1.0 - smoothstep(0.0, 1.5, edge);
    col = mix(col, vec3(0.10, 0.35, 0.26), lineA * 0.16);
  }

  // изумрудная кромка планеты
  vec2 din = min(w, vec2(float(${WORLD})) - w);
  float rimW = max(0.09, 1.6 / uScale);
  float rim = smoothstep(rimW, 0.0, min(din.x, din.y));
  col = mix(col, vec3(0.05, 0.22, 0.14), rim * 0.35);

  // блюдце в фокусе камеры
  if (uScale > 3.0 && abs(dishf.x - uFocus.x) < 0.5 && abs(dishf.y - uFocus.y) < 0.5) {
    vec2 dpx = min(f, vec2(1.0) - f) * uScale;
    float edge = min(dpx.x, dpx.y);
    float glow = 1.0 - smoothstep(0.0, 3.0, edge);
    float pulse = 0.5 + 0.3 * tri(uTime * 1.2);
    col = mix(col, vec3(0.16, 0.85, 0.55), glow * pulse);
  }
  frag = vec4(col, 1.0);
}`;

/* ---------- движок ---------- */

export interface StepParams {
  sp: number;
  m: number;
  s: number;
  T: number;
}

export interface PondStats {
  mass: number;
  pop: number;
  blobs: { x: number; y: number; mass: number; size: number }[];
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(sh));
  return sh;
}

function program(gl: WebGL2RenderingContext, fragSrc: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
  return p;
}

export class PondEngine {
  readonly speciesList: Creature[];
  readonly softGL: boolean; // программный рендер (SwiftShader/llvmpipe) — беречь
  readonly slotSide: number; // блюдцев-слотов в стороне атласа (SD)
  readonly slotCount: number; // всего слотов (SD×SD)
  readonly lodTexSide: number; // сторона LOD-текстуры (SD×LOD_N)

  private gl: WebGL2RenderingContext;
  private tex: WebGLTexture[] = [];
  private fbo: WebGLFramebuffer[] = [];
  private metaTex!: WebGLTexture;
  private metaDirty = false;
  private kernelTex: WebGLTexture[] = [];
  private lodTex!: WebGLTexture;
  private lodFbo!: WebGLFramebuffer;
  private lodBuf: Float32Array;
  private scratchTex!: WebGLTexture;
  private scratchFbo!: WebGLFramebuffer;
  private progStep: WebGLProgram;
  private progPerturb: WebGLProgram;
  private progLod: WebGLProgram;
  private progCopy: WebGLProgram;
  private progStamp: WebGLProgram;
  private progRender: WebGLProgram;
  private stampTex!: WebGLTexture;
  private stampBuf = new Float32Array(DISH * DISH);
  private norms: number[];
  private zeroTile = new Float32Array(DISH * DISH);
  private uniCache = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private pixelBuf = new Float32Array(DISH * DISH);
  private ccCap = 0;
  private labelBuf = new Int32Array(DISH * DISH);
  private parentBuf = new Int32Array(DISH * DISH);
  private ccArea!: Int32Array;
  private ccMass!: Float64Array;
  private ccSx!: Float64Array;
  private ccSy!: Float64Array;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 не поддерживается этим браузером');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('Расширение EXT_color_buffer_float недоступно');
    this.gl = gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    this.softGL = /swiftshader|llvmpipe|software|basic render/i.test(renderer);

    // атлас слотов: размер подбирается под предел текстур GPU
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (maxTex < DISH * 8) throw new Error('Слишком маленький предел текстур GPU для планеты 2000×2000 блюдцев');
    this.slotSide = Math.max(8, Math.min(36, Math.floor(maxTex / DISH)));
    this.slotCount = this.slotSide * this.slotSide;
    this.lodTexSide = this.slotSide * LOD_N;
    this.lodBuf = new Float32Array(this.lodTexSide * this.lodTexSide);

    this.speciesList = POND_LIST;
    this.norms = this.speciesList.map((c) => kernelNorm(c.R, c.b, c.kn));

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const SD = String(this.slotSide);
    this.progStep = program(gl, STEP_FRAG);
    this.progPerturb = program(gl, PERTURB_FRAG);
    this.progLod = program(gl, LOD_FRAG);
    this.progCopy = program(gl, COPY_FRAG);
    this.progStamp = program(gl, STAMP_FRAG);
    this.progRender = program(gl, RENDER_FRAG.replaceAll('__SD__', SD));

    const AW = this.slotSide * DISH;
    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, AW, AW, 0, gl.RED, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.viewport(0, 0, AW, AW);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.tex.push(t);
      this.fbo.push(f);
    }

    // текстуры ядер видов: вес ядра вместо ALU в самом горячем цикле
    this.speciesList.forEach((c) => {
      const D = 2 * c.R + 1;
      const k = new Float32Array(D * D);
      for (let dy = -c.R; dy <= c.R; dy++) {
        for (let dx = -c.R; dx <= c.R; dx++) k[(dy + c.R) * D + (dx + c.R)] = kernelAt(Math.hypot(dx, dy) / c.R, c.b, c.kn);
      }
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, D, D, 0, gl.RED, gl.FLOAT, k);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.kernelTex.push(t);
    });

    // мета-текстура планеты: тексель = блюдце, мипы для дальнего плана
    this.metaTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, META, META, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(META * META * 4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);

    // LOD-текстура слотов: NEAREST (float нельзя LINEAR), сглаживание — в шейдере
    this.lodTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lodTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.lodTexSide, this.lodTexSide, 0, gl.RED, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.lodFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lodFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.lodTex, 0);

    this.scratchTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.scratchTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, DISH, DISH, 0, gl.RED, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.scratchFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.scratchTex, 0);

    // штамп аддитивной посадки: блюдце целиком (текстура-источник, не рендер-таргет)
    this.stampTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.stampTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, DISH, DISH, 0, gl.RED, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private uni(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.uniCache.get(p);
    if (!m) this.uniCache.set(p, (m = new Map()));
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name));
    return m.get(name)!;
  }

  slotOrigin(slot: number): [number, number] {
    return [(slot % this.slotSide) * DISH, Math.floor(slot / this.slotSide) * DISH];
  }

  /** Загрузить строку мета-текстуры (META текселей, RGBA). */
  setMetaRow(y: number, rowBytes: Uint8Array) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, META, 1, gl.RGBA, gl.UNSIGNED_BYTE, rowBytes);
    this.metaDirty = true;
  }

  /** Загрузить мета-текстуру целиком. */
  setMetaFull(bytes: Uint8Array) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, META, META, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.metaDirty = false;
  }

  /** Перестроить мип-уровни мета-текстуры (после загрузок строк). */
  regenMetaMips() {
    if (!this.metaDirty) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.metaDirty = false;
  }

  /** Посадить существо в слот (центр — lx, ly в клетках, y вверх).
   *  Тело всегда целиком внутри блюдца: стены не пересекаются.
   *  Перезапись — для посева пустых блюдцев. */
  place(slot: number, spIdx: number, rot: number, lx: number, ly: number) {
    const c = this.speciesList[spIdx];
    if (!c) return;
    const rc = rotateCells(c.cells, c.w, c.h, rot);
    const gl = this.gl;
    const D = DISH;
    const src = new Float32Array(rc.w * rc.h);
    for (let j = 0; j < rc.h; j++) {
      for (let x = 0; x < rc.w; x++) src[(rc.h - 1 - j) * rc.w + x] = rc.cells[j * rc.w + x];
    }
    const maxX = Math.max(1, D - 1 - rc.w);
    const maxY = Math.max(1, D - 1 - rc.h);
    const px = Math.min(maxX, Math.max(1, Math.round(lx - rc.w / 2)));
    const py = Math.min(maxY, Math.max(1, Math.round(ly - rc.h / 2)));
    const [ox, oy] = this.slotOrigin(slot);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, ox + px, oy + py, rc.w, rc.h, gl.RED, gl.FLOAT, src);
  }

  /** Посадить существо аддитивно (max): вливается в живую колонию,
   *  не пробивая дыру. Для тапа пользователя и иммигрантов. */
  placeAdd(slot: number, spIdx: number, rot: number, lx: number, ly: number) {
    const c = this.speciesList[spIdx];
    if (!c) return;
    const rc = rotateCells(c.cells, c.w, c.h, rot);
    const gl = this.gl;
    const D = DISH;
    const stamp = this.stampBuf;
    stamp.fill(0);
    const maxX = Math.max(1, D - 1 - rc.w);
    const maxY = Math.max(1, D - 1 - rc.h);
    const px = Math.min(maxX, Math.max(1, Math.round(lx - rc.w / 2)));
    const py = Math.min(maxY, Math.max(1, Math.round(ly - rc.h / 2)));
    for (let j = 0; j < rc.h; j++) {
      const ty = py + rc.h - 1 - j; // y вверх: строка 0 существа — верхняя
      if (ty < 0 || ty >= D) continue;
      for (let x = 0; x < rc.w; x++) {
        const tx = px + x;
        if (tx < 0 || tx >= D) continue;
        stamp[ty * D + tx] = rc.cells[j * rc.w + x];
      }
    }
    const [ox, oy] = this.slotOrigin(slot);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.stampTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, D, D, gl.RED, gl.FLOAT, stamp);

    gl.useProgram(this.progStamp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.uniform1i(this.uni(this.progStamp, 'uSrc'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.stampTex);
    gl.uniform1i(this.uni(this.progStamp, 'uStamp'), 1);
    gl.uniform2i(this.uni(this.progStamp, 'uOrigin'), ox, oy);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[1]);
    gl.viewport(ox, oy, D, D);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.useProgram(this.progCopy);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[1]);
    gl.uniform1i(this.uni(this.progCopy, 'uSrc'), 0);
    gl.uniform2i(this.uni(this.progCopy, 'uOffset'), 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[0]);
    gl.viewport(ox, oy, D, D);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Очистить слот. */
  clearSlot(slot: number) {
    const gl = this.gl;
    const [ox, oy] = this.slotOrigin(slot);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, ox, oy, DISH, DISH, gl.RED, gl.FLOAT, this.zeroTile);
  }

  /** Очистить весь атлас разом (кнопка «Очистить» — вся планета). */
  clearAll() {
    const gl = this.gl;
    for (let i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[i]);
      gl.viewport(0, 0, this.slotSide * DISH, this.slotSide * DISH);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Материализовать блюдце: очистить и поселить count организмов.
   *  fromDir ≥ 0 — стена, через которую колония пришла (0:+x, 1:−x, 2:+y, 3:−y):
   *  поселенцы появляются у этой стены, как будто перебрались через неё. */
  seedSlot(slot: number, spIdx: number, count: number, fromDir = -1) {
    this.clearSlot(slot);
    const M = 22; // отступ от стен: ядра видов до R=20
    const span = DISH - 2 * M;
    for (let i = 0; i < count; i++) {
      let lx: number;
      let ly: number;
      if (fromDir === 0) {
        lx = DISH - 20 - Math.random() * 8;
        ly = M + Math.random() * span;
      } else if (fromDir === 1) {
        lx = 20 + Math.random() * 8;
        ly = M + Math.random() * span;
      } else if (fromDir === 2) {
        lx = M + Math.random() * span;
        ly = DISH - 20 - Math.random() * 8;
      } else if (fromDir === 3) {
        lx = M + Math.random() * span;
        ly = 20 + Math.random() * 8;
      } else {
        lx = M + Math.random() * span;
        ly = M + Math.random() * span;
      }
      this.place(slot, spIdx, Math.floor(Math.random() * 4), lx, ly);
    }
  }

  /** Один шаг Lenia для слота с явными параметрами (вид+мутации). */
  stepSlot(slot: number, p: StepParams) {
    const c = this.speciesList[p.sp];
    if (!c) return;
    const gl = this.gl;
    const [ox, oy] = this.slotOrigin(slot);

    gl.useProgram(this.progStep);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.uniform1i(this.uni(this.progStep, 'uState'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.kernelTex[p.sp]);
    gl.uniform1i(this.uni(this.progStep, 'uKernel'), 1);
    gl.uniform2i(this.uni(this.progStep, 'uOrigin'), ox, oy);
    gl.uniform1i(this.uni(this.progStep, 'uR'), c.R);
    gl.uniform1f(this.uni(this.progStep, 'uMu'), p.m);
    gl.uniform1f(this.uni(this.progStep, 'uSigma'), p.s);
    gl.uniform1f(this.uni(this.progStep, 'uDt'), 1 / p.T);
    gl.uniform1f(this.uni(this.progStep, 'uNorm'), this.norms[p.sp]);
    gl.uniform1i(this.uni(this.progStep, 'uGn'), c.gn);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[1]);
    gl.viewport(ox, oy, DISH, DISH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.useProgram(this.progCopy);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[1]);
    gl.uniform1i(this.uni(this.progCopy, 'uSrc'), 0);
    gl.uniform2i(this.uni(this.progCopy, 'uOffset'), 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[0]);
    gl.viewport(ox, oy, DISH, DISH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Возмущение слота: 0 — мор, 1 — вирус, 2 — угасание (умножение на k). */
  perturb(slot: number, mode: number, seed: number, k = 1) {
    const gl = this.gl;
    const [ox, oy] = this.slotOrigin(slot);
    gl.useProgram(this.progPerturb);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.uniform1i(this.uni(this.progPerturb, 'uState'), 0);
    gl.uniform2i(this.uni(this.progPerturb, 'uOrigin'), ox, oy);
    gl.uniform1i(this.uni(this.progPerturb, 'uMode'), mode);
    gl.uniform1f(this.uni(this.progPerturb, 'uSeed'), seed);
    gl.uniform1f(this.uni(this.progPerturb, 'uK'), k);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[1]);
    gl.viewport(ox, oy, DISH, DISH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.useProgram(this.progCopy);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[1]);
    gl.uniform1i(this.uni(this.progCopy, 'uSrc'), 0);
    gl.uniform2i(this.uni(this.progCopy, 'uOffset'), 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[0]);
    gl.viewport(ox, oy, DISH, DISH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Перестроить LOD-текстуру слотов из живого состояния (раз в кадр). */
  genLod() {
    const gl = this.gl;
    gl.useProgram(this.progLod);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.uniform1i(this.uni(this.progLod, 'uState'), 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lodFbo);
    gl.viewport(0, 0, this.lodTexSide, this.lodTexSide);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Прочитать LOD-текстуру — один readPixels. */
  readLod(): Float32Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lodFbo);
    gl.readPixels(0, 0, this.lodTexSide, this.lodTexSide, gl.RED, gl.FLOAT, this.lodBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.lodBuf;
  }

  /** Прочитать слот в скретч (для полного анализа). */
  private readSlot(slot: number, out: Float32Array) {
    const gl = this.gl;
    const [ox, oy] = this.slotOrigin(slot);
    gl.useProgram(this.progCopy);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.uniform1i(this.uni(this.progCopy, 'uSrc'), 0);
    gl.uniform2i(this.uni(this.progCopy, 'uOffset'), ox, oy);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.viewport(0, 0, DISH, DISH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, DISH, DISH, gl.RED, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Масса и организмы слота: связность без перехода стен (блюдце не тор). */
  stats(slot: number): PondStats {
    this.readSlot(slot, this.pixelBuf);
    const buf = this.pixelBuf;
    const N = DISH;
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] > 0.02 ? buf[i] : 0;
    const lab = this.labelBuf;
    const parent = this.parentBuf;
    const THR = 0.1;
    lab.fill(0);
    let nl = 0;
    const find = (a: number): number => {
      let r = a;
      while (parent[r] !== r) r = parent[r];
      while (parent[a] !== r) {
        const nx = parent[a];
        parent[a] = r;
        a = nx;
      }
      return r;
    };
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };
    for (let y = 0; y < N; y++) {
      const row = y * N;
      for (let x = 0; x < N; x++) {
        const i = row + x;
        if (buf[i] <= THR) continue;
        const l1 = x > 0 ? lab[i - 1] : 0;
        let l2 = 0;
        let l3 = 0;
        let l4 = 0;
        if (y > 0) {
          const up = i - N;
          l3 = lab[up];
          if (x > 0) l2 = lab[up - 1];
          if (x < N - 1) l4 = lab[up + 1];
        }
        let m = 0;
        if (l1 > 0) m = find(l1);
        if (l2 > 0) {
          const r = find(l2);
          if (m === 0 || r < m) {
            if (m > 0) parent[m] = r;
            m = r;
          } else if (r !== m) parent[r] = m;
        }
        if (l3 > 0) {
          const r = find(l3);
          if (m === 0 || r < m) {
            if (m > 0) parent[m] = r;
            m = r;
          } else if (r !== m) parent[r] = m;
        }
        if (l4 > 0) {
          const r = find(l4);
          if (m === 0 || r < m) {
            if (m > 0) parent[m] = r;
            m = r;
          } else if (r !== m) parent[r] = m;
        }
        if (m === 0) {
          nl++;
          parent[nl] = nl;
          lab[i] = nl;
        } else {
          lab[i] = m;
        }
      }
    }
    if (this.ccCap < nl + 1) {
      this.ccCap = Math.max(1024, (nl + 1) * 2);
      this.ccArea = new Int32Array(this.ccCap);
      this.ccMass = new Float64Array(this.ccCap);
      this.ccSx = new Float64Array(this.ccCap);
      this.ccSy = new Float64Array(this.ccCap);
    } else {
      this.ccArea.fill(0, 0, nl + 1);
      this.ccMass.fill(0, 0, nl + 1);
      this.ccSx.fill(0, 0, nl + 1);
      this.ccSy.fill(0, 0, nl + 1);
    }
    for (let y = 0; y < N; y++) {
      const row = y * N;
      for (let x = 0; x < N; x++) {
        const l = lab[row + x];
        if (l === 0) continue;
        const r = find(l);
        this.ccArea[r]++;
        this.ccMass[r] += buf[row + x];
        this.ccSx[r] += x * buf[row + x];
        this.ccSy[r] += y * buf[row + x];
      }
    }
    const blobs: { x: number; y: number; mass: number; size: number }[] = [];
    for (let r = 1; r <= nl; r++) {
      if (parent[r] !== r) continue;
      if (this.ccArea[r] >= 30 && this.ccMass[r] > 0) {
        blobs.push({ x: this.ccSx[r] / this.ccMass[r], y: this.ccSy[r] / this.ccMass[r], mass: this.ccMass[r], size: this.ccArea[r] });
      }
    }
    blobs.sort((p, q) => q.mass - p.mass);
    return { mass: sum, pop: blobs.length, blobs };
  }

  /** Нарисовать планету (один проход на весь экран). */
  render(
    cam: { x: number; y: number; scale: number },
    focus: { x: number; y: number },
    timeSec: number,
    dpr: number,
    gamma = 0.75,
  ) {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const p = this.progRender;
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.uniform1i(this.uni(p, 'uState'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lodTex);
    gl.uniform1i(this.uni(p, 'uLod'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
    gl.uniform1i(this.uni(p, 'uMeta'), 2);
    gl.uniform2f(this.uni(p, 'uCam'), cam.x, cam.y);
    gl.uniform1f(this.uni(p, 'uScale'), cam.scale * dpr);
    gl.uniform2f(this.uni(p, 'uRes'), canvas.width, canvas.height);
    gl.uniform1f(this.uni(p, 'uTime'), timeSec);
    gl.uniform1f(this.uni(p, 'uGamma'), gamma);
    gl.uniform2f(this.uni(p, 'uFocus'), focus.x, focus.y);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  destroy() {
    const gl = this.gl;
    for (const f of this.fbo) gl.deleteFramebuffer(f);
    for (const t of this.tex) gl.deleteTexture(t);
    for (const t of this.kernelTex) gl.deleteTexture(t);
    gl.deleteTexture(this.metaTex);
    gl.deleteTexture(this.lodTex);
    gl.deleteFramebuffer(this.lodFbo);
    gl.deleteTexture(this.scratchTex);
    gl.deleteTexture(this.stampTex);
    gl.deleteFramebuffer(this.scratchFbo);
    gl.deleteProgram(this.progStep);
    gl.deleteProgram(this.progPerturb);
    gl.deleteProgram(this.progLod);
    gl.deleteProgram(this.progCopy);
    gl.deleteProgram(this.progStamp);
    gl.deleteProgram(this.progRender);
  }
}
