/**
 * Пруд Лении — движок «пруда из блюдцев» на WebGL2.
 *
 * Пруд — сетка до 64×64 изолированных блюдц (каждое — тор 96×96 клеток),
 * уложенных в один атлас-текстуру R32F. Физика каждого блюдца — как в
 * оригинальной Lenia. Точность float32 обязательна: на float16 каскад
 * деления гриба ломается (scripts/verify_precision.py).
 * оригинальной Lenia (Bert Wang-Chak Chan): A ← clip(A + dt·G(K∗A)).
 *
 * Производительность не зависит от зума: за кадр делается не больше
 * `budget` шагов (адаптивно), они раздаются видимым блюдцам по кругу —
 * на каждое блюдце за кадр не больше `speed` шагов.
 */

import { CREATURES, POND_SPECIES, POND_ECOTYPES, rotateCells, type Creature } from './creatures';

export const DISH = 96; // клеток в блюдце (должно совпадать с шейдерами)

export interface Palette {
  id: string;
  name: string;
  stops: [number, number, number][];
}

const hex = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];

export const PALETTES: Palette[] = [
  { id: 'bio', name: 'Биолюминесценция', stops: ['#02120c', '#06392c', '#0e8f60', '#54e8a3', '#d2ffe4', '#f6fff9'].map(hex) },
  { id: 'solar', name: 'Солнечная', stops: ['#0d0801', '#3d2502', '#7a4a03', '#b8770a', '#e8b930', '#fff3c4'].map(hex) },
  { id: 'viridis', name: 'Виридис', stops: ['#12261e', '#1e4a3a', '#2a788e', '#22a884', '#7ad151', '#fde725'].map(hex) },
  { id: 'magma', name: 'Магма', stops: ['#0f030a', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'].map(hex) },
] as unknown as Palette[];

/** Палитра вида по индексу в POND_SPECIES. */
const SPECIES_PALETTE = ['bio', 'magma', 'viridis', 'solar', 'viridis', 'bio', 'magma', 'solar', 'viridis', 'magma', 'solar'];

export function speciesPalette(i: number): Palette {
  return PALETTES.find((p) => p.id === SPECIES_PALETTE[i]) ?? PALETTES[0];
}

/* ---------- ядро и рост (зеркало шейдера, для нормировки) ---------- */

export function kernelCore(r: number, kn: number): number {
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

function kernelAt(r: number, R: number, b: number[], kn: number): number {
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
    for (let dx = -R; dx <= R; dx++) sum += kernelAt(Math.hypot(dx, dy) / R, R, b, kn);
  }
  return sum || 1;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** JS-зеркало палитры шейдера (миниатюры видов). */
export function paletteColor(stops: [number, number, number][], t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * 5;
  const i = Math.min(Math.floor(x), 4);
  const k = smooth(x - i);
  const mix = (a: number, b2: number) => a + (b2 - a) * k;
  return [mix(stops[i][0], stops[i + 1][0]), mix(stops[i][1], stops[i + 1][1]), mix(stops[i][2], stops[i + 1][2])];
}

/* ---------- Климат: k∈[0,1] → сдвиг условий (проверено NumPy-свипом) ---------- */

export const CLIMATE_DM = 0.035; // амплитуда сдвига m
export const CLIMATE_DS = 0.22; // амплитуда растяжения s

/** Эффективные (m, s) вида в климате k. */
export function climateParams(c: Creature, k: number): { m: number; s: number } {
  const d = (k - 0.5) * 2;
  return { m: c.m + d * CLIMATE_DM, s: c.s * (1 + d * CLIMATE_DS) };
}

/* ---------- Шейдеры ---------- */

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const STEP_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uState;
uniform ivec2 uOrigin;
uniform int uR, uNB, uKn, uGn;
uniform float uB0, uB1, uB2, uB3, uMu, uSigma, uDt, uNorm;
out vec4 frag;

float core(float r) {
  if (uKn == 1) { float q = 4.0 * r * (1.0 - r); return q * q * q * q; }
  if (uKn == 2) { if (r <= 0.0 || r >= 1.0) return 0.0; return exp(4.0 - 1.0 / (r * (1.0 - r))); }
  if (uKn == 3) { return (r >= 0.25 && r <= 0.75) ? 1.0 : 0.0; }
  return ((r >= 0.25 && r <= 0.75) ? 1.0 : 0.0) + (r < 0.25 ? 0.5 : 0.0);
}
float shell(float d) {
  float r = d / float(uR);
  if (r >= 1.0) return 0.0;
  float Br = float(uNB) * r;
  int idx = int(min(floor(Br), float(uNB - 1)));
  float w = uB3;
  if (idx == 0) w = uB0; else if (idx == 1) w = uB1; else if (idx == 2) w = uB2;
  float f = min(Br - float(idx), 1.0);
  return core(f) * w;
}
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
      float k = shell(length(vec2(float(dx), float(dy))));
      if (k != 0.0) {
        ivec2 p = uOrigin + ((lc + ivec2(dx, dy) + 96) % 96);
        u += k * texelFetch(uState, p, 0).r;
      }
    }
  }
  u /= uNorm;
  float a = texelFetch(uState, uOrigin + lc, 0).r;
  frag = vec4(clamp(a + uDt * growth(u), 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

const COPY_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform ivec2 uOffset;
out vec4 frag;
void main() { frag = texelFetch(uSrc, ivec2(gl_FragCoord.xy) + uOffset, 0); }`;

const RENDER_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uState;
uniform sampler2D uMeta;
uniform vec3 uPal[66];
uniform vec2 uCam;
uniform float uScale;
uniform vec2 uRes;
uniform float uGrid;
uniform vec2 uFocus;
uniform float uTime;
uniform float uGamma;
out vec4 frag;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 palette(int sp, float t) {
  float x = clamp(t, 0.0, 1.0) * 5.0;
  int i = int(min(floor(x), 4.0));
  float f = x - float(i);
  f = f * f * (3.0 - 2.0 * f);
  int base = sp * 6;
  return mix(uPal[base + i], uPal[base + i + 1], f);
}

float field(ivec2 origin, vec2 f) {
  vec2 p = f * 96.0 - 0.5;
  ivec2 i0 = ivec2(floor(p));
  vec2 fr = p - vec2(i0);
  ivec2 w0 = (i0 + 96) % 96;
  ivec2 w1 = ivec2((i0.x + 1 + 96) % 96, w0.y);
  ivec2 w2 = ivec2(w0.x, (i0.y + 1 + 96) % 96);
  float a = texelFetch(uState, origin + w0, 0).r;
  float b = texelFetch(uState, origin + w1, 0).r;
  float c = texelFetch(uState, origin + w2, 0).r;
  float d = texelFetch(uState, origin + ivec2(w1.x, w2.y), 0).r;
  return mix(mix(a, b, fr.x), mix(c, d, fr.x), fr.y);
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 w = uCam + (px - uRes * 0.5) / uScale;
  vec2 q = px / uRes - 0.5;
  vec3 bg = vec3(0.006, 0.013, 0.011) * (1.0 - 0.4 * dot(q, q));
  if (w.x < 0.0 || w.y < 0.0 || w.x >= uGrid || w.y >= uGrid) { frag = vec4(bg, 1.0); return; }
  vec2 dish = floor(w);
  vec2 f = fract(w);
  ivec2 di = ivec2(dish);
  ivec2 origin = di * 96;
  vec2 meta = texelFetch(uMeta, di, 0).rg;
  int sp = int(meta.r * 255.0) - 1;
  float k = meta.g;
  float v = field(origin, f);

  vec3 cold = vec3(0.014, 0.040, 0.044);
  vec3 warm = vec3(0.052, 0.028, 0.010);
  vec3 water = mix(cold, warm, k) * (0.7 + 0.6 * hash12(dish));
  vec3 life = sp < 0 ? vec3(0.0) : palette(sp, pow(v, uGamma));
  vec3 col = max(water, life);

  vec2 dpx = min(f, 1.0 - f) * uScale;
  float edge = min(dpx.x, dpx.y);
  float lineA = 1.0 - smoothstep(0.0, 1.5, edge);
  float zoomOut = clamp(1.0 - uScale / 220.0, 0.0, 1.0);
  col = mix(col, vec3(0.10, 0.35, 0.26), lineA * (0.10 + 0.22 * zoomOut));

  if (abs(dish.x - uFocus.x) < 0.5 && abs(dish.y - uFocus.y) < 0.5) {
    float glow = 1.0 - smoothstep(0.0, 3.0, edge);
    float pulse = 0.5 + 0.3 * sin(uTime * 2.4);
    col = mix(col, vec3(0.16, 0.85, 0.55), glow * pulse);
  }
  frag = vec4(col, 1.0);
}`;

/* ---------- Движок ---------- */

export interface PondRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w: number;
  h: number;
  count: number;
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

function hash1(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class PondEngine {
  readonly grid: number;
  readonly atlas: number;
  readonly speciesList: Creature[];
  species: Int16Array;
  climate: Float32Array;
  steps: Int32Array;
  cursor = 0;

  private gl: WebGL2RenderingContext;
  private tex: WebGLTexture[] = [];
  private fbo: WebGLFramebuffer[] = [];
  private metaTex!: WebGLTexture;
  private metaBytes!: Uint8Array;
  private scratchTex!: WebGLTexture;
  private scratchFbo!: WebGLFramebuffer;
  private progStep: WebGLProgram;
  private progCopy: WebGLProgram;
  private progRender: WebGLProgram;
  private norms: number[];
  private palUniform: Float32Array;
  private metaDirty = true;
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

    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    let grid = Math.min(64, Math.floor(maxTex / DISH));
    const dm = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    if (dm && dm <= 4) grid = Math.min(grid, 24); // слабым устройствам — меньший атлас R32F
    this.grid = Math.max(8, grid);
    this.atlas = this.grid * DISH;

    this.speciesList = POND_SPECIES.map((id) => {
      const c = CREATURES.find((x) => x.id === id)!;
      const eco = POND_ECOTYPES[id];
      return eco ? { ...c, ...eco } : c;
    }).filter(Boolean);
    this.norms = this.speciesList.map((c) => kernelNorm(c.R, c.b, c.kn));
    this.palUniform = new Float32Array(this.speciesList.length * 6 * 3);
    this.speciesList.forEach((c, i) => {
      const pal = PALETTES.find((p) => p.id === SPECIES_PALETTE[i]) ?? PALETTES[0];
      pal.stops.forEach((s, j) => this.palUniform.set(s, (i * 6 + j) * 3));
    });

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.progStep = program(gl, STEP_FRAG);
    this.progCopy = program(gl, COPY_FRAG);
    this.progRender = program(gl, RENDER_FRAG);

    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.atlas, this.atlas, 0, gl.RED, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.viewport(0, 0, this.atlas, this.atlas);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.tex.push(t);
      this.fbo.push(f);
    }

    this.metaTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, this.grid, this.grid, 0, gl.RG, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.scratchTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.scratchTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, DISH, DISH, 0, gl.RED, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.scratchFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.scratchTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const n = this.grid * this.grid;
    this.species = new Int16Array(n).fill(-1);
    this.climate = new Float32Array(n);
    this.steps = new Int32Array(n);
    for (let i = 0; i < n; i++) this.climate[i] = (hash1(i) + hash1(i * 1.618 + 7.3)) / 2;
    this.metaBytes = new Uint8Array(n * 2);
    this.syncMeta();
  }

  private uni(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.uniCache.get(p);
    if (!m) this.uniCache.set(p, (m = new Map()));
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name));
    return m.get(name)!;
  }

  private tileOrigin(di: number): [number, number] {
    return [(di % this.grid) * DISH, Math.floor(di / this.grid) * DISH];
  }

  /** Обновить байты мета-текстуры для блюдца (загрузка — одной пачкой в render). */
  private syncMeta(di?: number) {
    const put = (i: number) => {
      this.metaBytes[i * 2] = this.species[i] + 1;
      this.metaBytes[i * 2 + 1] = Math.round(this.climate[i] * 255);
    };
    if (di === undefined) {
      for (let i = 0; i < this.grid * this.grid; i++) put(i);
    } else {
      put(di);
    }
    this.metaDirty = true;
  }

  private flushMeta() {
    if (!this.metaDirty) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.grid, this.grid, gl.RG, gl.UNSIGNED_BYTE, this.metaBytes);
    this.metaDirty = false;
  }

  /** Посадить существо в блюдце (центр — lx, ly в клетках, y вверх). */
  place(di: number, spIdx: number, rot: number, lx: number, ly: number) {
    const c = this.speciesList[spIdx];
    if (!c) return;
    const rc = rotateCells(c.cells, c.w, c.h, rot);
    const gl = this.gl;
    const D = DISH;
    const src = new Float32Array(rc.w * rc.h);
    for (let j = 0; j < rc.h; j++) {
      for (let x = 0; x < rc.w; x++) src[(rc.h - 1 - j) * rc.w + x] = rc.cells[j * rc.w + x];
    }
    const px = ((Math.round(lx - rc.w / 2)) % D + D) % D;
    const py = ((Math.round(ly - rc.h / 2)) % D + D) % D;
    const [ox, oy] = this.tileOrigin(di);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    const ws = px + rc.w <= D ? [rc.w] : [D - px, rc.w - (D - px)];
    const hs = py + rc.h <= D ? [rc.h] : [D - py, rc.h - (D - py)];
    let sy = 0;
    for (const hh of hs) {
      let sx = 0;
      for (const ww of ws) {
        if (ww > 0 && hh > 0) {
          const part = new Float32Array(ww * hh);
          for (let r = 0; r < hh; r++) {
            for (let x = 0; x < ww; x++) part[r * ww + x] = src[(sy + r) * rc.w + sx + x];
          }
          gl.texSubImage2D(gl.TEXTURE_2D, 0, ox + ((px + sx) % D), oy + ((py + sy) % D), ww, hh, gl.RED, gl.FLOAT, part);
        }
        sx += ww;
      }
      sy += hh;
    }
    this.species[di] = spIdx;
    this.steps[di] = 0;
    this.syncMeta(di);
  }

  setClimate(di: number, k: number) {
    this.climate[di] = Math.min(1, Math.max(0, k));
    this.syncMeta(di);
  }

  clearDish(di: number) {
    const gl = this.gl;
    const [ox, oy] = this.tileOrigin(di);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, ox, oy, DISH, DISH, gl.RED, gl.FLOAT, this.zeroTile);
    this.species[di] = -1;
    this.syncMeta(di);
  }

  clearRect(rect: PondRect | null) {
    if (!rect || rect.count >= this.grid * this.grid) {
      const gl = this.gl;
      for (let i = 0; i < 2; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[i]);
        gl.viewport(0, 0, this.atlas, this.atlas);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.species.fill(-1);
      this.syncMeta();
      return;
    }
    for (let y = rect.y0; y <= rect.y1; y++) {
      for (let x = rect.x0; x <= rect.x1; x++) this.clearDish(y * this.grid + x);
    }
  }

  /** Один шаг блюдца (пустые и чужие индексы пропускаются). */
  stepDish(di: number) {
    if (di < 0 || di >= this.species.length) return;
    const sp = this.species[di];
    if (sp < 0 || sp >= this.speciesList.length) return;
    const gl = this.gl;
    const c = this.speciesList[sp];
    const [ox, oy] = this.tileOrigin(di);
    const { m, s } = climateParams(c, this.climate[di]);

    gl.useProgram(this.progStep);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.uniform1i(this.uni(this.progStep, 'uState'), 0);
    gl.uniform2i(this.uni(this.progStep, 'uOrigin'), ox, oy);
    gl.uniform1i(this.uni(this.progStep, 'uR'), c.R);
    gl.uniform1i(this.uni(this.progStep, 'uNB'), c.b.length);
    gl.uniform1f(this.uni(this.progStep, 'uB0'), c.b[0] ?? 0);
    gl.uniform1f(this.uni(this.progStep, 'uB1'), c.b[1] ?? 0);
    gl.uniform1f(this.uni(this.progStep, 'uB2'), c.b[2] ?? 0);
    gl.uniform1f(this.uni(this.progStep, 'uB3'), c.b[3] ?? 0);
    gl.uniform1f(this.uni(this.progStep, 'uMu'), m);
    gl.uniform1f(this.uni(this.progStep, 'uSigma'), s);
    gl.uniform1f(this.uni(this.progStep, 'uDt'), 1 / c.T);
    gl.uniform1f(this.uni(this.progStep, 'uNorm'), this.norms[sp]);
    gl.uniform1i(this.uni(this.progStep, 'uKn'), c.kn);
    gl.uniform1i(this.uni(this.progStep, 'uGn'), c.gn);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[1]);
    gl.viewport(ox, oy, DISH, DISH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // вернуть шаг в канонический атлас
    gl.useProgram(this.progCopy);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[1]);
    gl.uniform1i(this.uni(this.progCopy, 'uSrc'), 0);
    gl.uniform2i(this.uni(this.progCopy, 'uOffset'), 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[0]);
    gl.viewport(ox, oy, DISH, DISH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.steps[di]++;
  }

  /**
   * Раздать кадровые шаги видимым блюдцам по кругу.
   * На каждое блюдце — не более speed шагов; всего — не больше budget.
   */
  distribute(rect: PondRect, budget: number, speed: number) {
    if (rect.count <= 0) return;
    if (this.cursor >= rect.count) this.cursor = 0;
    let remaining = Math.min(budget, rect.count * speed);
    while (remaining > 0) {
      const take = Math.min(rect.count, remaining);
      for (let i = 0; i < take; i++) {
        const c = this.cursor;
        this.stepDish((rect.y0 + Math.floor(c / rect.w)) * this.grid + rect.x0 + (c % rect.w));
        this.cursor = (c + 1) % rect.count;
      }
      remaining -= take;
    }
  }

  /** Прочитать блюдце (в скретч R32F → readPixels). Координаты y вверх. */
  readDish(di: number, out: Float32Array) {
    const gl = this.gl;
    const [ox, oy] = this.tileOrigin(di);
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

  /** Масса и организмы блюдца: периодическая связность (тор блюдца). */
  stats(di: number): PondStats {
    this.readDish(di, this.pixelBuf);
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
        let l1 = 0;
        let l2 = 0;
        let l3 = 0;
        let l4 = 0;
        if (x > 0) l1 = lab[i - 1];
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
    for (let y = 0; y < N; y++) {
      const a = lab[y * N];
      if (a === 0) continue;
      const yu = (y + N - 1) % N;
      const yd = (y + 1) % N;
      const b = lab[y * N + N - 1];
      const c = lab[yu * N + N - 1];
      const d = lab[yd * N + N - 1];
      if (b > 0) union(a, b);
      if (c > 0) union(a, c);
      if (d > 0) union(a, d);
    }
    for (let x = 0; x < N; x++) {
      const a = lab[x];
      if (a === 0) continue;
      const xl = (x + N - 1) % N;
      const xr = (x + 1) % N;
      const b = lab[(N - 1) * N + x];
      const c = lab[(N - 1) * N + xl];
      const d = lab[(N - 1) * N + xr];
      if (b > 0) union(a, b);
      if (c > 0) union(a, c);
      if (d > 0) union(a, d);
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

  /** Нарисовать пруд (один проход на весь экран). */
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
    this.flushMeta();
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.uniform1i(this.uni(p, 'uState'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
    gl.uniform1i(this.uni(p, 'uMeta'), 1);
    const nu = Math.min(this.speciesList.length, 11);
    gl.uniform3fv(this.uni(p, 'uPal'), this.palUniform.subarray(0, nu * 6 * 3));
    gl.uniform2f(this.uni(p, 'uCam'), cam.x, cam.y);
    gl.uniform1f(this.uni(p, 'uScale'), cam.scale * dpr);
    gl.uniform2f(this.uni(p, 'uRes'), canvas.width, canvas.height);
    gl.uniform1f(this.uni(p, 'uGrid'), this.grid);
    gl.uniform2f(this.uni(p, 'uFocus'), focus.x, focus.y);
    gl.uniform1f(this.uni(p, 'uTime'), timeSec);
    gl.uniform1f(this.uni(p, 'uGamma'), gamma);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  destroy() {
    const gl = this.gl;
    for (const f of this.fbo) gl.deleteFramebuffer(f);
    for (const t of this.tex) gl.deleteTexture(t);
    gl.deleteTexture(this.metaTex);
    gl.deleteTexture(this.scratchTex);
    gl.deleteFramebuffer(this.scratchFbo);
    gl.deleteProgram(this.progStep);
    gl.deleteProgram(this.progCopy);
    gl.deleteProgram(this.progRender);
  }
}
