/**
 * Lenia engine — WebGL2 implementation of Bert Wang-Chak Chan's continuous CA.
 *
 * Update rule (matches Chakazul/Lenia Python/reference, verified with NumPy):
 *   U = K * A          — toroidal convolution with a ring kernel
 *   G = g(U; m, s)     — growth function
 *   A' = clip(A + dt * G, 0, 1)
 *
 * Kernel shells: K(r) = sum over shells, shell i has weight b[i] and contains
 * one "core" bump evaluated at (NB*r mod 1); kernel = 0 for r >= 1.
 */

export interface LeniaParams {
  R: number; // kernel radius, cells
  dt: number; // time step
  m: number; // growth center
  s: number; // growth width
  b: number[]; // shell weights
  kn: number; // kernel core 1..4
  gn: number; // growth function 1..3
}

export const KERNEL_NAMES: Record<number, string> = {
  1: 'quad4 — полином',
  2: 'bump4 — экспонента',
  3: 'stpz — ступень',
  4: 'life — лестница',
};
export const GROWTH_NAMES: Record<number, string> = {
  1: 'quad4 — полином',
  2: 'gaus — гауссиана',
  3: 'stpz — ступень',
};

/** Core bump function indexed exactly like the original (kn-1). */
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

/** Growth function indexed exactly like the original (gn-1). */
export function growthFunc(u: number, m: number, s: number, gn: number): number {
  const x = u - m;
  switch (gn) {
    case 1: {
      const t = Math.max(0, 1 - (x * x) / (9 * s * s));
      return t * t * t * t * 2 - 1;
    }
    case 3:
      return Math.abs(x) <= s ? 1 : -1;
    default:
      return Math.exp(-(x * x) / (2 * s * s)) * 2 - 1;
  }
}

/** Kernel value at normalized radius r (0..1). */
export function kernelAt(r: number, R: number, b: number[], kn: number): number {
  if (r >= 1) return 0;
  const NB = b.length;
  const Br = NB * r;
  const idx = Math.min(Math.floor(Br), NB - 1);
  const f = Math.min(Br - idx, 1);
  return kernelCore(f, kn) * b[idx];
}

/** Sum of kernel over its window = normalization constant (mirrors the shader). */
export function kernelNorm(R: number, b: number[], kn: number): number {
  let sum = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const r = Math.hypot(dx, dy) / R;
      sum += kernelAt(r, R, b, kn);
    }
  }
  return sum || 1;
}

export interface Palette {
  id: string;
  name: string;
  stops: [number, number, number][]; // 6 RGB stops, dark -> bright
}

const hex = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];

export const PALETTES: Palette[] = [
  {
    id: 'bio',
    name: 'Биолюминесценция',
    stops: ['#02120c', '#06392c', '#0e8f60', '#54e8a3', '#d2ffe4', '#f6fff9'].map(hex) as [number, number, number][],
  },
  {
    id: 'magma',
    name: 'Магма',
    stops: ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'].map(hex) as [number, number, number][],
  },
  {
    id: 'viridis',
    name: 'Виридис',
    stops: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'].map(hex) as [number, number, number][],
  },
  {
    id: 'solar',
    name: 'Солнечная',
    stops: ['#0d0801', '#3d2502', '#7a4a03', '#b8770a', '#e8b930', '#fff3c4'].map(hex) as [number, number, number][],
  },
];

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const STEP_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uState;
uniform float uCell;
uniform int uR;
uniform int uNB;
uniform float uB0, uB1, uB2, uB3;
uniform float uMu, uSigma, uDt, uNorm;
uniform int uKn, uGn;
in vec2 vUv;
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
  float u = 0.0;
  for (int dy = -uR; dy <= uR; dy++) {
    for (int dx = -uR; dx <= uR; dx++) {
      float k = shell(length(vec2(float(dx), float(dy))));
      if (k != 0.0) {
        u += k * texture(uState, vUv + vec2(float(dx), float(dy)) * uCell).r;
      }
    }
  }
  u /= uNorm;
  float a = texture(uState, vUv).r;
  frag = vec4(clamp(a + uDt * growth(u), 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

const PAINT_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uState;
uniform int uN;
uniform vec2 uBrush;
uniform float uRadius;
uniform float uValue;
uniform int uErase;
in vec2 vUv;
out vec4 frag;

void main() {
  vec2 p = vUv * vec2(float(uN));
  vec2 d = abs(p - uBrush);
  vec2 n2 = vec2(float(uN));
  d = min(d, n2 - d);
  float dist2 = dot(d, d);
  float mask = exp(-dist2 / (2.0 * uRadius * uRadius));
  float a = texture(uState, vUv).r;
  float na = uErase == 1 ? a * (1.0 - mask) : clamp(a + mask * uValue, 0.0, 1.0);
  frag = vec4(na, 0.0, 0.0, 1.0);
}`;

const RENDER_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uState;
uniform int uN;
uniform vec3 uPal[6];
uniform float uGamma;
in vec2 vUv;
out vec4 frag;

float bilerp(vec2 uv) {
  vec2 p = uv * vec2(float(uN)) - vec2(0.5);
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 c = (i + vec2(0.5)) / vec2(float(uN));
  vec2 px = vec2(1.0) / vec2(float(uN));
  float a = texture(uState, c).r;
  float b = texture(uState, c + vec2(px.x, 0.0)).r;
  float d = texture(uState, c + vec2(0.0, px.y)).r;
  float e = texture(uState, c + px).r;
  return mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
}

void main() {
  float a = bilerp(vUv);
  float t = pow(a, uGamma);
  float x = clamp(t, 0.0, 1.0) * 5.0;
  int i = int(min(floor(x), 4.0));
  float f = x - float(i);
  vec3 c0, c1;
  if (i == 0) { c0 = uPal[0]; c1 = uPal[1]; }
  else if (i == 1) { c0 = uPal[1]; c1 = uPal[2]; }
  else if (i == 2) { c0 = uPal[2]; c1 = uPal[3]; }
  else if (i == 3) { c0 = uPal[3]; c1 = uPal[4]; }
  else { c0 = uPal[4]; c1 = uPal[5]; }
  vec3 col = mix(c0, c1, smoothstep(0.0, 1.0, f));
  frag = vec4(col, 1.0);
}`;

const smooth = (a: number, b: number, t: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

/** JS mirror of the render shader palette (for thumbnails). */
export function paletteColor(stops: [number, number, number][], t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * 5;
  const i = Math.min(Math.floor(x), 4);
  const f = x - i;
  const k = smooth(0, 1, f);
  const mix = (a: number, b2: number) => a + (b2 - a) * k;
  return [mix(stops[i][0], stops[i + 1][0]), mix(stops[i][1], stops[i + 1][1]), mix(stops[i][2], stops[i + 1][2])];
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('Shader compile error: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, fragSrc: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Program link error: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

const RENDER_SCALE = 3; // canvas pixels per simulation cell

export class LeniaEngine {
  readonly N: number;
  private gl: WebGL2RenderingContext;
  private tex: WebGLTexture[] = [];
  private fbo: WebGLFramebuffer[] = [];
  private read = 0;
  private progStep: WebGLProgram;
  private progPaint: WebGLProgram;
  private progRender: WebGLProgram;
  private params: LeniaParams;
  private norm = 1;
  private pal: Palette;
  private gamma = 0.75;
  private pixelBuf: Float32Array;
  /** Scratch buffers for organism counting (periodic connected components). */
  private visBuf!: Uint8Array;
  private stkBuf!: Int32Array;
  private labelBuf!: Int32Array;
  private parentBuf!: Int32Array;
  private ccArea!: Int32Array;
  private ccMass!: Float64Array;
  private ccSx!: Float64Array;
  private ccSy!: Float64Array;
  private ccCap = 0;
  private uniformCache = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

  constructor(canvas: HTMLCanvasElement, N: number, params: LeniaParams, pal: Palette) {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 не поддерживается этим браузером');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('Расширение EXT_color_buffer_float недоступно (float-рендеринг)');
    }
    this.gl = gl;
    this.N = N;
    this.params = { ...params };
    this.pal = pal;
    canvas.width = N * RENDER_SCALE;
    canvas.height = N * RENDER_SCALE;

    // quad
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.progStep = program(gl, STEP_FRAG);
    this.progPaint = program(gl, PAINT_FRAG);
    this.progRender = program(gl, RENDER_FRAG);

    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, N, N, 0, gl.RED, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      const f = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      this.tex.push(t);
      this.fbo.push(f);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.pixelBuf = new Float32Array(N * N);
    this.visBuf = new Uint8Array(N * N);
    this.stkBuf = new Int32Array(N * N);
    this.labelBuf = new Int32Array(N * N);
    this.parentBuf = new Int32Array(N * N);
    this.recalcNorm();
  }

  private uni(prog: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.uniformCache.get(prog);
    if (!m) {
      m = new Map();
      this.uniformCache.set(prog, m);
    }
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(prog, name));
    return m.get(name)!;
  }

  private recalcNorm() {
    this.norm = kernelNorm(this.params.R, this.params.b, this.params.kn);
  }

  setParams(p: Partial<LeniaParams>) {
    const needNorm =
      (p.R !== undefined && p.R !== this.params.R) ||
      (p.b !== undefined && p.b !== this.params.b) ||
      (p.kn !== undefined && p.kn !== this.params.kn);
    this.params = { ...this.params, ...p };
    if (needNorm) this.recalcNorm();
  }

  getParams(): LeniaParams {
    return { ...this.params };
  }

  setPalette(pal: Palette) {
    this.pal = pal;
  }

  setGamma(g: number) {
    this.gamma = g;
  }

  private drawTo(fbo: WebGLFramebuffer | null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, this.N, this.N);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** One simulation step. */
  step() {
    const gl = this.gl;
    const p = this.progStep;
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[this.read]);
    gl.uniform1i(this.uni(p, 'uState'), 0);
    gl.uniform1f(this.uni(p, 'uCell'), 1 / this.N);
    gl.uniform1i(this.uni(p, 'uR'), this.params.R);
    gl.uniform1i(this.uni(p, 'uNB'), this.params.b.length);
    gl.uniform1f(this.uni(p, 'uB0'), this.params.b[0] ?? 0);
    gl.uniform1f(this.uni(p, 'uB1'), this.params.b[1] ?? 0);
    gl.uniform1f(this.uni(p, 'uB2'), this.params.b[2] ?? 0);
    gl.uniform1f(this.uni(p, 'uB3'), this.params.b[3] ?? 0);
    gl.uniform1f(this.uni(p, 'uMu'), this.params.m);
    gl.uniform1f(this.uni(p, 'uSigma'), this.params.s);
    gl.uniform1f(this.uni(p, 'uDt'), this.params.dt);
    gl.uniform1f(this.uni(p, 'uNorm'), this.norm);
    gl.uniform1i(this.uni(p, 'uKn'), this.params.kn);
    gl.uniform1i(this.uni(p, 'uGn'), this.params.gn);
    this.drawTo(this.fbo[1 - this.read]);
    this.read = 1 - this.read;
  }

  /** Gaussian brush stroke at grid coords (gx, gy). */
  paint(gx: number, gy: number, radius: number, value: number, erase: boolean) {
    const gl = this.gl;
    const p = this.progPaint;
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[this.read]);
    gl.uniform1i(this.uni(p, 'uState'), 0);
    gl.uniform1i(this.uni(p, 'uN'), this.N);
    gl.uniform2f(this.uni(p, 'uBrush'), gx, gy);
    gl.uniform1f(this.uni(p, 'uRadius'), radius);
    gl.uniform1f(this.uni(p, 'uValue'), value);
    gl.uniform1i(this.uni(p, 'uErase'), erase ? 1 : 0);
    this.drawTo(this.fbo[1 - this.read]);
    this.read = 1 - this.read;
  }

  /** Draw the current state to the visible canvas. */
  render() {
    const gl = this.gl;
    const p = this.progRender;
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[this.read]);
    gl.uniform1i(this.uni(p, 'uState'), 0);
    gl.uniform1i(this.uni(p, 'uN'), this.N);
    for (let i = 0; i < 6; i++) {
      gl.uniform3fv(this.uni(p, `uPal[${i}]`), this.pal.stops[i]);
    }
    gl.uniform1f(this.uni(p, 'uGamma'), this.gamma);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.N * RENDER_SCALE, this.N * RENDER_SCALE);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Write a creature pattern into the state, centered at (gx, gy) grid coords
   * (gy measured from the BOTTOM of the screen, matching pointer coords),
   * with toroidal wrap. Pattern row 0 stays at the top of its bounding box.
   * Uploaded as up to 4 wrapped rectangles.
   */
  placeCells(w: number, h: number, cells: Float32Array, gx: number, gy: number) {
    const N = this.N;
    const gl = this.gl;
    // src: row 0 = bottom of the pattern (texture row 0 = bottom of the screen)
    const src = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      src.set(cells.subarray(j * w, (j + 1) * w), (h - 1 - j) * w);
    }
    const x0 = ((Math.round(gx - w / 2)) % N + N) % N;
    const y0 = ((Math.round(gy - h / 2)) % N + N) % N; // texture row = screen y-up
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[this.read]);
    const ws = x0 + w <= N ? [w] : [N - x0, w - (N - x0)];
    const hs = y0 + h <= N ? [h] : [N - y0, h - (N - y0)];
    let sy = 0;
    for (const hh of hs) {
      let sx = 0;
      for (const ww of ws) {
        if (ww > 0 && hh > 0) {
          const part = new Float32Array(ww * hh);
          for (let r = 0; r < hh; r++) {
            part.set(src.subarray((sy + r) * w + sx, (sy + r) * w + sx + ww), r * ww);
          }
          gl.texSubImage2D(gl.TEXTURE_2D, 0, (x0 + sx) % N, (y0 + sy) % N, ww, hh, gl.RED, gl.FLOAT, part);
        }
        sx += ww;
      }
      sy += hh;
    }
  }

  clear() {
    const gl = this.gl;
    for (let i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[i]);
      gl.viewport(0, 0, this.N, this.N);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Primordial-soup seed, verified against the NumPy reference:
   * smooth bilinear (smoothstep) upsample of a 16×16 random grid, full [0,1]
   * amplitude. Under orbium physics this self-organizes into ~180 organisms
   * with headings spread over all directions (mass ≈ 12.6k, stable for 6000+ steps).
   */
  randomize(rng: () => number = Math.random) {
    const N = this.N;
    const L = 16; // feature size ≈ N/16 px — best scale in reference runs
    const data = new Float32Array(N * N);
    const low = new Float32Array(L * L);
    for (let i = 0; i < low.length; i++) low[i] = rng();
    const sm = (t: number) => t * t * (3 - 2 * t);
    for (let y = 0; y < N; y++) {
      const fy = (y / N) * L;
      const iy = Math.floor(fy) % L;
      const ty = sm(fy - Math.floor(fy));
      const ya = iy * L;
      const yb = ((iy + 1) % L) * L;
      for (let x = 0; x < N; x++) {
        const fx = (x / N) * L;
        const ix = Math.floor(fx) % L;
        const tx = sm(fx - Math.floor(fx));
        const v0 = low[ya + ix] + (low[ya + ((ix + 1) % L)] - low[ya + ix]) * tx;
        const v1 = low[yb + ix] + (low[yb + ((ix + 1) % L)] - low[yb + ix]) * tx;
        data[y * N + x] = v0 + (v1 - v0) * ty;
      }
    }
    this.uploadField(data);
  }

  /** Upload a full N*N field (row 0 = top on screen). */
  uploadField(data: Float32Array) {
    const N = this.N;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[this.read]);
    const flipped = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      flipped.set(data.subarray((N - 1 - y) * N, (N - y) * N), y * N);
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RED, gl.FLOAT, flipped);
  }

  /**
   * Масса, центроид, дисперсия и список организмов поля
   * (текстурные координаты, y вверх). Полный readback (формат RED/FLOAT).
   *
   * «Организм» — связная компонента A > 0.1 площадью 30–8000 клеток.
   * СВЯЗНОСТЬ ПЕРИОДИЧЕСКАЯ: существо, пересёкшее край тора, остаётся одним
   * целым (края швов объединяются через union-find) — дневник не считает
   * его дважды и не выдаёт ложных «рождений» на границе.
   */
  getStats(): {
    mass: number;
    cx: number;
    cy: number;
    mom2: number;
    population: number;
    blobs: { x: number; y: number; mass: number; size: number }[];
  } {
    const gl = this.gl;
    const N = this.N;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.read]);
    gl.readPixels(0, 0, N, N, gl.RED, gl.FLOAT, this.pixelBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let sum = 0;
    let sx = 0;
    let sy = 0;
    let s2 = 0;
    const buf = this.pixelBuf;
    for (let y = 0; y < N; y++) {
      const row = y * N;
      for (let x = 0; x < N; x++) {
        const a = buf[row + x];
        if (a > 0.02) {
          sum += a;
          sx += x * a;
          sy += y * a;
          s2 += (x * x + y * y) * a;
        }
      }
    }

    // ---- проход 1: локальная разметка (запад, сз, север, св) ----
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

    // ---- швы тора: объединяем метки, соприкасающиеся через край ----
    // вертикальный шов: пиксель (0,y) соседствует с (N-1,y-1..y+1)
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
    // горизонтальный шов: пиксель (x,0) соседствует с (x-1..x+1,N-1)
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

    // ---- проход 2: накапливаем площадь/массу/центроид по корням ----
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
    const area = this.ccArea;
    const massArr = this.ccMass;
    const sxA = this.ccSx;
    const syA = this.ccSy;
    for (let y = 0; y < N; y++) {
      const row = y * N;
      for (let x = 0; x < N; x++) {
        const l = lab[row + x];
        if (l === 0) continue;
        const r = find(l);
        const a = buf[row + x];
        area[r]++;
        massArr[r] += a;
        sxA[r] += x * a;
        syA[r] += y * a;
      }
    }
    const blobs: { x: number; y: number; mass: number; size: number }[] = [];
    for (let r = 1; r <= nl; r++) {
      if (parent[r] !== r) continue;
      const size = area[r];
      const bm = massArr[r];
      if (size >= 30 && size <= 8000 && bm > 0) {
        blobs.push({ x: sxA[r] / bm, y: syA[r] / bm, mass: bm, size });
      }
    }
    blobs.sort((p, q) => q.mass - p.mass);
    if (sum <= 0) return { mass: 0, cx: 0, cy: 0, mom2: 0, population: blobs.length, blobs };
    const cx = sx / sum;
    const cy = sy / sum;
    const mom2 = s2 / sum - (cx * cx + cy * cy); // второй момент (разброс массы)
    return { mass: sum, cx, cy, mom2, population: blobs.length, blobs };
  }

  /** Прочитать текущее состояние (RED FLOAT, текстурные координаты) в буфер. */
  readStateInto(buf: Float32Array) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.read]);
    gl.readPixels(0, 0, this.N, this.N, gl.RED, gl.FLOAT, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  destroy() {
    const gl = this.gl;
    for (const f of this.fbo) gl.deleteFramebuffer(f);
    for (const t of this.tex) gl.deleteTexture(t);
    gl.deleteProgram(this.progStep);
    gl.deleteProgram(this.progPaint);
    gl.deleteProgram(this.progRender);
  }
}
