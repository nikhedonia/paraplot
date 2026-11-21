import { VERTEX_SRC } from './glsl';
import type { Aabb, Material, Vec3 } from '../core/types';
import type { RenderSettings, ViewMode } from './settings';
import type { CameraState, RenderScene } from './types';

export type { RenderSettings, ViewMode } from './settings';
export type { CameraState, RenderScene } from './types';

const ZERO_FLOAT = new Float32Array(1);

const VIEW_CODE: Record<ViewMode, number> = {
  shaded: 0,
  normals: 1,
  curvature: 2,
  zebra: 3,
  gradient: 4,
};

export const defaultCamera = (): CameraState => ({
  yaw: 0.72,
  pitch: 0.42,
  dist: 6,
  target: [0, 0.6, 0],
  fov: (38 * Math.PI) / 180,
});

export function cameraPosition(c: CameraState): Vec3 {
  const cp = Math.cos(c.pitch);
  return [
    c.target[0] + c.dist * Math.sin(c.yaw) * cp,
    c.target[1] + c.dist * Math.sin(c.pitch),
    c.target[2] + c.dist * Math.cos(c.yaw) * cp,
  ];
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('could not create shader');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? 'unknown shader error';
    gl.deleteShader(sh);
    throw new Error(humanizeShaderLog(log, src));
  }
  return sh;
}

/** Attach a numbered excerpt of the failing shader line to the driver log. */
function humanizeShaderLog(log: string, src: string): string {
  const m = /ERROR:\s*\d+:(\d+)/.exec(log) ?? /:(\d+):/.exec(log);
  if (!m) return log.trim();
  const line = parseInt(m[1], 10);
  const lines = src.split('\n');
  const from = Math.max(1, line - 2);
  const excerpt = lines
    .slice(from - 1, line + 1)
    .map((l, i) => `${String(from + i).padStart(4)} | ${l}`)
    .join('\n');
  return `${log.trim()}\n\n${excerpt}`;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  /** shaded-view program plus one lazily compiled program per analysis view */
  private baseProgram: WebGLProgram | null = null;
  private viewPrograms = new Map<number, WebGLProgram>();
  private activeProgram: WebGLProgram | null = null;
  /** compiled programs keyed by variant + shader source, so structural toggles are free */
  private cache = new Map<string, WebGLProgram>();
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private sources = new Map<string, WebGLUniformLocation | null>();

  private values: Float32Array = new Float32Array(0);
  private materials: Material[] = [{ color: [0.3, 0.3, 0.3], rough: 0.5 }];
  private bounds: Aabb = { min: [-1, -1, -1], max: [1, 1, 1] };
  private fragmentSrc = '';
  private compiledFrame = false;
  private glslKey = '';
  /** a source that failed to compile: keep the last good program, don't retry */
  private failedGlsl: string | null = null;
  /** reused across frames: only reallocated when the material count changes */
  private materialColors = new Float32Array(0);
  private materialRough = new Float32Array(0);
  /** one-pixel readback buffer used to force GPU completion in the worker */
  private readPixel = new Uint8Array(4);
  /** the value pool as a data texture: dynamic uniform-array indexing is slow to compile */
  private valueTexture: WebGLTexture | null = null;
  private valueTextureWidth = 0;
  private lastValueUpload: Float32Array | null = null;
  /** an analysis program that is still compiling/linking asynchronously */
  private pendingView: {
    viewCode: number;
    program: WebGLProgram;
    vs: WebGLShader;
    fs: WebGLShader;
    src: string;
    key: string;
  } | null = null;
  private pendingViewError: string | null = null;
  private parallelExt: { COMPLETION_STATUS_KHR: number } | null | undefined = undefined;

  disposed = false;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvas;
    const gl = (canvas as HTMLCanvasElement).getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /** Upload a new scene. Recompiles only when the shader source changed. */
  setScene(scene: RenderScene): void {
    if (scene.glsl === this.failedGlsl) return;
    if (scene.glsl !== this.glslKey) {
      this.discardPending();
      try {
        this.baseProgram = this.buildProgram(scene.glsl, 0);
        this.compiledFrame = true;
        this.fragmentSrc = scene.glsl;
        this.glslKey = scene.glsl;
        // analysis variants are compiled lazily, per mode
        this.viewPrograms.clear();
        this.failedGlsl = null;
      } catch (err) {
        this.failedGlsl = scene.glsl;
        throw err;
      }
    }
    this.values = scene.values;
    this.materials = scene.materials;
    this.bounds = scene.bounds;
  }

  private buildProgram(fragmentSrc: string, viewCode: number): WebGLProgram {
    const gl = this.gl;
    const key = `V${viewCode}|${fragmentSrc}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const src = fragmentSrc.replace(
      '#version 300 es',
      `#version 300 es\n#define PARAPLOT_VIEW ${viewCode}`,
    );
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, src);
    const prog = gl.createProgram();
    if (!prog) throw new Error('could not create program');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) ?? 'link failed';
      gl.deleteProgram(prog);
      throw new Error(log);
    }
    this.cache.set(key, prog);
    this.evictPrograms(prog);
    return prog;
  }

  private getParallelExt(): { COMPLETION_STATUS_KHR: number } | null {
    if (this.parallelExt !== undefined) return this.parallelExt;
    this.parallelExt = this.gl.getExtension('KHR_parallel_shader_compile') as {
      COMPLETION_STATUS_KHR: number;
    } | null;
    return this.parallelExt;
  }

  private viewSource(viewCode: number): string {
    return this.fragmentSrc.replace(
      '#version 300 es',
      `#version 300 es\n#define PARAPLOT_VIEW ${viewCode}`,
    );
  }

  private discardPending(): void {
    const p = this.pendingView;
    if (!p) return;
    this.gl.deleteShader(p.vs);
    this.gl.deleteShader(p.fs);
    this.gl.deleteProgram(p.program);
    this.pendingView = null;
  }

  /**
   * Return a compiled analysis program, or start compiling it in the background.
   * The renderer keeps drawing the shaded program until the variant is ready,
   * so a slow driver compile never freezes the canvas or blocks the worker.
   */
  private startViewProgram(viewCode: number): WebGLProgram | null {
    const cachedVariant = this.viewPrograms.get(viewCode);
    if (cachedVariant) return cachedVariant;

    const key = `V${viewCode}|${this.fragmentSrc}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.viewPrograms.set(viewCode, cached);
      return cached;
    }
    if (this.pendingView?.viewCode === viewCode) return null;
    if (this.pendingView) this.discardPending();

    const gl = this.gl;
    if (!this.getParallelExt()) {
      const program = this.buildProgram(this.fragmentSrc, viewCode);
      this.viewPrograms.set(viewCode, program);
      return program;
    }

    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vs || !fs) throw new Error('could not create shader');
    const src = this.viewSource(viewCode);
    gl.shaderSource(vs, VERTEX_SRC);
    gl.compileShader(vs);
    gl.shaderSource(fs, src);
    gl.compileShader(fs);
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error('could not create program');
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'a_pos');
    gl.linkProgram(program);
    this.pendingView = { viewCode, program, vs, fs, src, key };
    return null;
  }

  hasPendingView(): boolean {
    return this.pendingView !== null;
  }

  /**
   * Advance a background program compile. Callers poll this while
   * `hasPendingView()` is true; it never blocks.
   */
  pollViewProgram(): 'pending' | 'ready' | 'error' | 'none' {
    const p = this.pendingView;
    if (!p) return 'none';
    const gl = this.gl;
    const ext = this.getParallelExt();
    if (ext && !gl.getProgramParameter(p.program, ext.COMPLETION_STATUS_KHR)) {
      return 'pending';
    }
    const vsOk = gl.getShaderParameter(p.vs, gl.COMPILE_STATUS);
    const fsOk = gl.getShaderParameter(p.fs, gl.COMPILE_STATUS);
    if (!vsOk || !fsOk) {
      const log = (fsOk ? gl.getShaderInfoLog(p.vs) : gl.getShaderInfoLog(p.fs)) ?? '';
      this.pendingViewError = humanizeShaderLog(log, p.src);
      this.discardPending();
      return 'error';
    }
    if (!gl.getProgramParameter(p.program, gl.LINK_STATUS)) {
      this.pendingViewError = gl.getProgramInfoLog(p.program) ?? 'link failed';
      this.discardPending();
      return 'error';
    }
    gl.deleteShader(p.vs);
    gl.deleteShader(p.fs);
    this.cache.set(p.key, p.program);
    this.evictPrograms(p.program);
    this.viewPrograms.set(p.viewCode, p.program);
    this.compiledFrame = true;
    this.pendingView = null;
    return 'ready';
  }

  takePendingViewError(): string | null {
    const err = this.pendingViewError;
    this.pendingViewError = null;
    return err;
  }

  /** keep the variants that are in use; drop the oldest leftover program */
  private evictPrograms(keep: WebGLProgram): void {
    if (this.cache.size <= 12) return;
    const protectedPrograms = new Set<WebGLProgram>();
    for (const p of [this.baseProgram, this.activeProgram, keep, ...this.viewPrograms.values()]) {
      if (p) protectedPrograms.add(p);
    }
    for (const [key, old] of this.cache) {
      if (!protectedPrograms.has(old)) {
        this.cache.delete(key);
        this.gl.deleteProgram(old);
        return;
      }
    }
  }

  /**
   * Block until the current frame has actually completed. `gl.finish()` is not
   * reliable across drivers; a tiny readback forces a real sync, which makes
   * the frame time trustworthy (and bounds the GPU queue to one frame).
   */
  private bindValueTexture(): void {
    const gl = this.gl;
    if (!this.valueTexture) {
      this.valueTexture = gl.createTexture();
      this.valueTextureWidth = 0;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.valueTexture);
    const width = Math.max(1, this.values.length);
    const upload = width !== this.valueTextureWidth || this.values !== this.lastValueUpload;
    if (upload) {
      const data = this.values.length > 0 ? this.values : ZERO_FLOAT;
      if (width !== this.valueTextureWidth) {
        this.valueTextureWidth = width;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, 1, 0, gl.RED, gl.FLOAT, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, 1, gl.RED, gl.FLOAT, data);
      }
      this.lastValueUpload = this.values;
    }
    gl.uniform1i(this.u('u_points'), 0);
  }

  syncFrame(): void {
    const gl = this.gl;
    gl.finish();
    try {
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.readPixel);
    } catch {
      // a lost/incomplete framebuffer is reported by the render loop
    }
  }

  /** true when the last render had to build a program (timing is not usable) */
  takeCompiled(): boolean {
    const compiled = this.compiledFrame;
    this.compiledFrame = false;
    return compiled;
  }

  private u(name: string): WebGLUniformLocation | null {
    if (!this.activeProgram) return null;
    if (!this.sources.has(name)) {
      this.sources.set(name, this.gl.getUniformLocation(this.activeProgram, name));
    }
    return this.sources.get(name)!;
  }

  render(
    camera: CameraState,
    settings: RenderSettings,
    cssWidth: number,
    cssHeight: number,
    dpr: number,
    time = 0,
    floorY = 0,
    scale = settings.scale,
  ) {
    if (this.disposed) return;
    const gl = this.gl;
    let program = this.baseProgram;
    if (!program) return;

    const viewCode = VIEW_CODE[settings.view] ?? 0;
    if (viewCode !== 0) {
      let variant: WebGLProgram | null = this.viewPrograms.get(viewCode) ?? null;
      if (!variant) variant = this.startViewProgram(viewCode);
      // while a variant links asynchronously, keep showing the shaded program
      if (variant) program = variant;
    }
    if (program !== this.activeProgram) {
      this.activeProgram = program;
      this.sources.clear();
    }

    const w = Math.max(1, Math.round(cssWidth * dpr * scale));
    const h = Math.max(1, Math.round(cssHeight * dpr * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(program);
    gl.bindVertexArray(this.vao);
    this.bindValueTexture();

    const pos = cameraPosition(camera);

    gl.uniform2f(this.u('u_res'), w, h);
    gl.uniform3f(this.u('u_camPos'), pos[0], pos[1], pos[2]);
    gl.uniform3f(this.u('u_camTarget'), camera.target[0], camera.target[1], camera.target[2]);
    gl.uniform1f(this.u('u_fov'), camera.fov);
    gl.uniform1f(this.u('u_time'), time);
    gl.uniform1i(this.u('u_maxSteps'), settings.maxSteps);
    gl.uniform1f(this.u('u_eps'), 0.00045);
    gl.uniform3f(this.u('u_boxMin'), this.bounds.min[0], this.bounds.min[1], this.bounds.min[2]);
    gl.uniform3f(this.u('u_boxMax'), this.bounds.max[0], this.bounds.max[1], this.bounds.max[2]);
    gl.uniform1f(this.u('u_shadows'), settings.shadows ? 1 : 0);
    gl.uniform1f(this.u('u_ao'), settings.ao ? 1 : 0);
    // fewer shadow steps at low resolution: the soft shadow is blurred anyway
    gl.uniform1i(this.u('u_shadowSteps'), Math.max(8, Math.min(30, Math.round(8 + scale * 24))));
    gl.uniform1f(this.u('u_grid'), settings.grid ? 1 : 0);
    gl.uniform1f(this.u('u_floorY'), floorY);
    gl.uniform3f(this.u('u_bgA'), 0.020, 0.028, 0.038);
    gl.uniform3f(this.u('u_bgB'), 0.004, 0.006, 0.009);

    // smoothness analysis
    const size = Math.hypot(
      this.bounds.max[0] - this.bounds.min[0],
      this.bounds.max[1] - this.bounds.min[1],
      this.bounds.max[2] - this.bounds.min[2],
    );
    const eps = Math.min(0.04, Math.max(0.0012, size * 0.003));
    gl.uniform1f(this.u('u_curvEps'), eps);
    gl.uniform1f(this.u('u_curvScale'), Math.max(0.05, settings.curvatureScale ?? 4));

    if (this.values.length > 0) gl.uniform1fv(this.u('u_values[0]'), this.values);

    if (this.materialColors.length !== this.materials.length * 3) {
      this.materialColors = new Float32Array(this.materials.length * 3);
    }
    if (this.materialRough.length !== this.materials.length) {
      this.materialRough = new Float32Array(this.materials.length);
    }
    const cols = this.materialColors;
    const rough = this.materialRough;
    this.materials.forEach((m, i) => {
      cols[i * 3] = m.color[0];
      cols[i * 3 + 1] = m.color[1];
      cols[i * 3 + 2] = m.color[2];
      rough[i] = m.rough;
    });
    gl.uniform3fv(this.u('u_matColor[0]'), cols);
    gl.uniform1fv(this.u('u_matRough[0]'), rough);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    this.discardPending();
    for (const p of this.cache.values()) gl.deleteProgram(p);
    this.cache.clear();
    this.baseProgram = null;
    this.viewPrograms.clear();
    this.activeProgram = null;
    if (this.valueTexture) gl.deleteTexture(this.valueTexture);
    this.valueTexture = null;
    this.lastValueUpload = null;
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
  }
}
