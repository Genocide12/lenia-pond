/**
 * Пруд Лении — движок «бесконечной биосферы» на WebGL2.
 *
 * Мир — бесконечная сетка блюдцев (каждое — тор DISH×DISH клеток).
 * Возле камеры блюдца материализуются в пул из S×S слотов атласа R32F
 * и считаются честной Lenia (Bert Wang-Chak Chan): A ← clip(A + dt·G(K∗A)).
 * Вся планета за пределами пула живёт статистически (lib/lenia/eco.ts)
 * и рисуется по мета-текстуре META×META: одно блюдце — один тексель.
 * Дальше мета-текстуры мир процедурный (хэш координат в шейдере),
 * поэтому полей бесконечно много на любом устройстве.
 *
 * Точность float32 обязательна: на float16 каскад деления гриба ломается
 * (scripts/verify_precision.py). Производительность не зависит от зума:
 * шагов за кадр не больше адаптивного бюджета, рендер — один проход.
 */

import { POND_LIST, rotateCells, type Creature } from './creatures';

export const DISH = 96; // клеток в блюдце (должно совпадать с шейдерами)
export const META = 256; // сторона мета-текстуры планеты (блюдц)
export const TEX_PX = 21; // минимальный размер блюдца в пикселях для текстурного рендера

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

/** Палитра вида по индексу в POND_LIST. */
const SPECIES_PALETTE = ['bio', 'magma', 'viridis', 'solar', 'viridis', 'bio', 'magma', 'solar', 'viridis', 'magma', 'solar'];

export function speciesPalette(i: number): Palette {
  return PALETTES.find((p) => p.id === SPECIES_PALETTE[i]) ?? PALETTES[0];
}

/* ---------- климат и мутации (зеркало шейдера шага) ---------- */

export const CLIMATE_DM = 0.035; // амплитуда сдвига m (проверено свипом verify_climate.py)
export const CLIMATE_DS = 0.22; // амплитуда растяжения s

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

const smooth = (t: number) => t * t * (3 - 2 * t);

/** JS-зеркало палитры шейдера (миниатюры видов). */
export function paletteColor(stops: [number, number, number][], t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * 5;
  const i = Math.min(Math.floor(x), 4);
  const k = smooth(x - i);
  const mix = (a: number, b2: number) => a + (b2 - a) * k;
  return [mix(stops[i][0], stops[i + 1][0]), mix(stops[i][1], stops[i + 1][1]), mix(stops[i][2], stops[i + 1][2])];
}

/* ---------- шейдеры ---------- */

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

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
        ivec2 p = uOrigin + ((lc + ivec2(dx, dy) + 96) % 96);
        u += k * texelFetch(uState, p, 0).r;
      }
    }
  }
  u /= uNorm;
  float a = texelFetch(uState, uOrigin + lc, 0).r;
  frag = vec4(clamp(a + uDt * growth(u), 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

/** Возмущения экосистемы: мор (0) и вирус (1). Маски проверены NumPy. */
const PERTURB_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uState;
uniform ivec2 uOrigin;
uniform int uMode;
uniform float uSeed;
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
  } else {
    float n = vnoise(lc * 0.13);
    float blob = smoothstep(0.55, 0.85, vnoise(lc * 0.09 + 37.0));
    frag = vec4(clamp(a * clamp((n - 0.30) / 0.42, 0.18, 1.0) + 0.5 * blob, 0.0, 1.0), 0.0, 0.0, 1.0);
  }
}`;

/** Средняя масса блюдца — редукция 96×96 в один пиксель (дешёвая проба). */
const PROBE_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uState;
uniform ivec2 uOrigin;
out vec4 frag;
void main() {
  float s = 0.0;
  for (int y = 0; y < 96; y++) {
    for (int x = 0; x < 96; x++) s += texelFetch(uState, uOrigin + ivec2(x, y), 0).r;
  }
  frag = vec4(s / 9216.0, 0.0, 0.0, 1.0);
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
uniform ivec2 uWin;
uniform ivec2 uMetaOrg;
uniform int uSlots;
uniform float uTime;
uniform float uSpeed;
uniform float uGamma;
uniform vec2 uFocus;
out vec4 frag;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float tri(float x) { return abs(fract(x) * 2.0 - 1.0); }
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
  vec2 dishf = floor(w);
  vec2 f = fract(w);
  ivec2 di = ivec2(dishf);
  float h1 = hash12(dishf);

  int sp; float life; float clim; float flash; int fkind;
  bool mat = false;
  ivec2 mxy = di - uMetaOrg;
  if (mxy.x >= 0 && mxy.y >= 0 && mxy.x < 256 && mxy.y < 256) {
    vec4 m = texelFetch(uMeta, mxy, 0);
    sp = int(m.r * 255.0 + 0.5) - 1;
    int g = int(m.g * 255.0 + 0.5);
    life = float(g & 63) / 63.0;
    clim = float(g >> 6) / 3.0;
    mat = m.b > 0.5;
    int a = int(m.a * 255.0 + 0.5);
    fkind = a >> 6;
    flash = float(a & 63) / 63.0;
  } else {
    // бесконечный процедурный мир за пределами мета-текстуры
    sp = hash12(dishf + 7.3) < 0.55 ? int(hash12(dishf + 3.7) * 11.0) : -1;
    clim = hash12(dishf + 5.9);
    life = sp >= 0 ? 0.4 + 0.45 * tri(uTime * uSpeed * (0.05 + 0.09 * hash12(dishf + 9.1)) + h1) : 0.0;
    fkind = 0;
    flash = 0.0;
  }
  vec3 water = mix(vec3(0.014, 0.040, 0.044), vec3(0.052, 0.028, 0.010), clim) * (0.7 + 0.6 * h1);
  float tw = 0.88 + 0.12 * tri(uTime * uSpeed * (0.03 + 0.03 * h1) + h1 * 3.0);

  ivec2 sc = di - uWin;
  bool canTex = mat && sc.x >= 0 && sc.y >= 0 && sc.x < uSlots && sc.y < uSlots;
  bool textured = canTex && uScale > ${TEX_PX}.0;
  // статистический слой: круглый сгусток жизни вместо сплошной заливки
  vec3 colStat = water;
  if (sp >= 0) {
    float l = clamp(life * tw, 0.0, 1.0);
    if (l > 0.03) {
      float dl = length(f - vec2(0.5));
      float rad = max(0.20, l * 0.55);
      float colony = 1.0 - smoothstep(rad - 0.16, rad + 0.06, dl);
      colStat = max(colStat, palette(sp, 0.2 + 0.8 * l) * (0.30 + 0.70 * l) * (0.30 + 0.70 * colony));
    }
  }
  vec3 col = colStat;
  if (textured) {
    float v = field(sc * 96, f);
    float sh = v * v * (3.0 - 2.0 * v); // органичная пластика вместо пикселей
    float vis = smoothstep(0.02, 0.12, v); // пустая вода не заливается цветом палитры
    vec3 colTex = sp >= 0 ? mix(water, palette(sp, pow(sh, uGamma)), vis) : water;
    col = mix(colStat, colTex, smoothstep(${TEX_PX}.0, ${TEX_PX + 14}.0, uScale)); // мягкий LOD-переход
  }

  vec2 dpx = min(f, 1.0 - f) * uScale;
  float edge = min(dpx.x, dpx.y);
  if (uScale > 90.0) {
    float lineA = 1.0 - smoothstep(0.0, 1.5, edge);
    float zoomOut = clamp(1.0 - uScale / 220.0, 0.0, 1.0);
    col = mix(col, vec3(0.10, 0.35, 0.26), lineA * (0.10 + 0.22 * zoomOut));
  }
  if (flash > 0.003 && fkind > 0) {
    float ring = 1.0 - smoothstep(0.0, 10.0, edge);
    vec3 fc = fkind == 1 ? vec3(0.20, 0.90, 0.55) : fkind == 2 ? vec3(0.95, 0.75, 0.20) : vec3(0.95, 0.35, 0.45);
    col = mix(col, fc, ring * flash * (0.55 + 0.45 * tri(uTime * 4.5)));
  }
  if (abs(dishf.x - uFocus.x) < 0.5 && abs(dishf.y - uFocus.y) < 0.5) {
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
  readonly slots: number; // сторона пула (S×S блюдц)
  readonly atlasW: number; // ширина атласа (слоты)
  readonly atlasH: number; // высота атласа (слоты + строки парковки)
  readonly parkRows: number; // строк парковки состояний (зум без потерь)
  private parkFree: number[] = [];
  readonly speciesList: Creature[];
  readonly softGL: boolean; // программный рендер (SwiftShader/llvmpipe) — беречь

  private gl: WebGL2RenderingContext;
  private tex: WebGLTexture[] = [];
  private fbo: WebGLFramebuffer[] = [];
  private metaTex!: WebGLTexture;
  private kernelTex: WebGLTexture[] = [];
  private probeTex!: WebGLTexture;
  private probeFbo!: WebGLFramebuffer;
  private probeBuf = new Float32Array(1);
  private scratchTex!: WebGLTexture;
  private scratchFbo!: WebGLFramebuffer;
  private progStep: WebGLProgram;
  private progPerturb: WebGLProgram;
  private progProbe: WebGLProgram;
  private progCopy: WebGLProgram;
  private progRender: WebGLProgram;
  private norms: number[];
  private palUniform: Float32Array;
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

    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const dm = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    let slots = 20;
    if (maxTex < 2048 || (dm && dm <= 4)) slots = 12; // слабым устройствам — меньший атлас R32F
    this.slots = slots;
    this.parkRows = Math.max(0, Math.min(6, Math.floor(maxTex / DISH) - slots)); // запасные строки — парковка состояний
    this.atlasW = slots * DISH;
    this.atlasH = (slots + this.parkRows) * DISH;
    for (let p = 0; p < this.parkRows * slots; p++) this.parkFree.push(p);

    this.speciesList = POND_LIST;
    this.norms = this.speciesList.map((c) => kernelNorm(c.R, c.b, c.kn));
    this.palUniform = new Float32Array(this.speciesList.length * 6 * 3);
    this.speciesList.forEach((c, i) => {
      const pal = speciesPalette(i);
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
    this.progPerturb = program(gl, PERTURB_FRAG);
    this.progProbe = program(gl, PROBE_FRAG);
    this.progCopy = program(gl, COPY_FRAG);
    this.progRender = program(gl, RENDER_FRAG);

    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.atlasW, this.atlasH, 0, gl.RED, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.viewport(0, 0, this.atlasW, this.atlasH);
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

    this.metaTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, META, META, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.probeTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.probeTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.probeFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.probeTex, 0);

    this.scratchTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.scratchTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, DISH, DISH, 0, gl.RED, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.scratchFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.scratchTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private uni(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.uniCache.get(p);
    if (!m) this.uniCache.set(p, (m = new Map()));
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name));
    return m.get(name)!;
  }

  slotOrigin(slot: number): [number, number] {
    return [(slot % this.slots) * DISH, Math.floor(slot / this.slots) * DISH];
  }

  /** Загрузить мета-текстуру планеты (RGBA, META×META). */
  setMeta(bytes: Uint8Array) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, META, META, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  }

  /** Посадить существо в слот (центр — lx, ly в клетках, y вверх). Аддитивно. */
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
    const px = ((Math.round(lx - rc.w / 2)) % D + D) % D;
    const py = ((Math.round(ly - rc.h / 2)) % D + D) % D;
    const [ox, oy] = this.slotOrigin(slot);
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
  }

  /** Очистить слот. */
  clearSlot(slot: number) {
    const gl = this.gl;
    const [ox, oy] = this.slotOrigin(slot);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, ox, oy, DISH, DISH, gl.RED, gl.FLOAT, this.zeroTile);
  }

  get parkCapacity(): number {
    return this.parkRows * this.slots;
  }

  /** Спрятать живое состояние слота в парковку (GPU→GPU, без чтения в CPU). */
  park(slot: number, into = -1): number {
    const p = into >= 0 ? into : this.parkFree.length ? this.parkFree.pop()! : -1;
    if (p < 0) return -1;
    this.copyRegion(this.slots * this.slots + p, slot);
    return p;
  }

  /** Вернуть состояние из парковки в слот и освободить место. */
  unpark(parkIdx: number, slot: number) {
    this.copyRegion(slot, this.slots * this.slots + parkIdx);
    this.releasePark(parkIdx);
  }

  /** Освободить парковочное место, не возвращая состояние. */
  releasePark(parkIdx: number) {
    if (this.parkFree.indexOf(parkIdx) < 0) this.parkFree.push(parkIdx);
  }

  /** Копировать область 96×96 между слотами атласа (через скретч, GPU→GPU). */
  private copyRegion(dstSlot: number, srcSlot: number) {
    const gl = this.gl;
    const [sx, sy] = this.slotOrigin(srcSlot);
    const [dx, dy] = this.slotOrigin(dstSlot);
    gl.useProgram(this.progCopy);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.uniform1i(this.uni(this.progCopy, 'uSrc'), 0);
    gl.uniform2i(this.uni(this.progCopy, 'uOffset'), sx, sy);
    gl.viewport(0, 0, DISH, DISH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindTexture(gl.TEXTURE_2D, this.scratchTex);
    gl.uniform2i(this.uni(this.progCopy, 'uOffset'), -dx, -dy);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[0]);
    gl.viewport(dx, dy, DISH, DISH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Материализовать блюдце: очистить и поселить count организмов. */
  seedSlot(slot: number, spIdx: number, count: number) {
    this.clearSlot(slot);
    for (let i = 0; i < count; i++) {
      this.place(slot, spIdx, Math.floor(Math.random() * 4), 14 + Math.random() * 68, 14 + Math.random() * 68);
    }
  }

  /** Один шаг Lenia для слота с явными параметрами (вид+климат+мутации). */
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

  /** Возмущение слота: 0 — мор перенаселения, 1 — вирус. */
  perturb(slot: number, mode: number, seed: number) {
    const gl = this.gl;
    const [ox, oy] = this.slotOrigin(slot);
    gl.useProgram(this.progPerturb);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.uniform1i(this.uni(this.progPerturb, 'uState'), 0);
    gl.uniform2i(this.uni(this.progPerturb, 'uOrigin'), ox, oy);
    gl.uniform1i(this.uni(this.progPerturb, 'uMode'), mode);
    gl.uniform1f(this.uni(this.progPerturb, 'uSeed'), seed);
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

  /** Дешёвая проба: средняя масса блюдца (редукция на GPU, чтение 4 байт). */
  probeMass(slot: number): number {
    const gl = this.gl;
    const [ox, oy] = this.slotOrigin(slot);
    gl.useProgram(this.progProbe);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.uniform1i(this.uni(this.progProbe, 'uState'), 0);
    gl.uniform2i(this.uni(this.progProbe, 'uOrigin'), ox, oy);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeFbo);
    gl.viewport(0, 0, 1, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, 1, 1, gl.RED, gl.FLOAT, this.probeBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.probeBuf[0];
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

  /** Масса и организмы слота: периодическая связность (тор блюдца). */
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

  /** Нарисовать мир (один проход на весь экран). */
  render(
    cam: { x: number; y: number; scale: number },
    winOrg: { x: number; y: number },
    metaOrg: { x: number; y: number },
    focus: { x: number; y: number },
    timeSec: number,
    speed: number,
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
    gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
    gl.uniform1i(this.uni(p, 'uMeta'), 1);
    const nu = Math.min(this.speciesList.length, 11);
    gl.uniform3fv(this.uni(p, 'uPal'), this.palUniform.subarray(0, nu * 6 * 3));
    gl.uniform2f(this.uni(p, 'uCam'), cam.x, cam.y);
    gl.uniform1f(this.uni(p, 'uScale'), cam.scale * dpr);
    gl.uniform2f(this.uni(p, 'uRes'), canvas.width, canvas.height);
    gl.uniform2i(this.uni(p, 'uWin'), winOrg.x, winOrg.y);
    gl.uniform2i(this.uni(p, 'uMetaOrg'), metaOrg.x, metaOrg.y);
    gl.uniform1i(this.uni(p, 'uSlots'), this.slots);
    gl.uniform1f(this.uni(p, 'uTime'), timeSec);
    gl.uniform1f(this.uni(p, 'uSpeed'), speed);
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
    gl.deleteTexture(this.probeTex);
    gl.deleteFramebuffer(this.probeFbo);
    gl.deleteTexture(this.scratchTex);
    gl.deleteFramebuffer(this.scratchFbo);
    gl.deleteProgram(this.progStep);
    gl.deleteProgram(this.progPerturb);
    gl.deleteProgram(this.progProbe);
    gl.deleteProgram(this.progCopy);
    gl.deleteProgram(this.progRender);
  }
}
