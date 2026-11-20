import { VERTEX_SRC } from './glsl';
import type { Aabb, Material, Vec3 } from '../core/types';
import type { RenderSettings, ViewMode } from './settings';
import type { CameraState, RenderScene } from './types';

export type { RenderSettings, ViewMode } from './settings';
export type { CameraState, RenderScene } from './types';

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
  private program: WebGLProgram | null = null;
  /** compiled programs keyed by shader source, so structural toggles are free */
  private cache = new Map<string, WebGLProgram>();
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private sources = new Map<string, WebGLUniformLocation | null>();

  private values: Float32Array = new Float32Array(0);
  private materials: Material[] = [{ color: [0.3, 0.3, 0.3], rough: 0.5 }];
  private bounds: Aabb = { min: [-1, -1, -1], max: [1, 1, 1] };
  private glslKey = '';
  /** a source that failed to compile: keep the last good program, don't retry */
  private failedGlsl: string | null = null;

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
      try {
        this.buildProgram(scene.glsl);
        this.glslKey = scene.glsl;
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

  private buildProgram(fragmentSrc: string) {
    const gl = this.gl;
    const cached = this.cache.get(fragmentSrc);
    if (cached) {
      this.program = cached;
      this.sources.clear();
      return;
    }

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSrc);
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
    this.program = prog;
    this.sources.clear();
    this.cache.set(fragmentSrc, prog);
    if (this.cache.size > 6) {
      for (const [key, old] of this.cache) {
        if (key !== fragmentSrc) {
          this.cache.delete(key);
          gl.deleteProgram(old);
          break;
        }
      }
    }
  }

  private u(name: string): WebGLUniformLocation | null {
    if (!this.sources.has(name)) {
      this.sources.set(name, this.gl.getUniformLocation(this.program!, name));
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
    if (!this.program) return;

    const w = Math.max(1, Math.round(cssWidth * dpr * scale));
    const h = Math.max(1, Math.round(cssHeight * dpr * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

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
    gl.uniform1i(this.u('u_view'), VIEW_CODE[settings.view] ?? 0);
    gl.uniform1f(this.u('u_curvEps'), eps);
    gl.uniform1f(this.u('u_curvScale'), Math.max(0.05, settings.curvatureScale ?? 4));

    if (this.values.length > 0) gl.uniform1fv(this.u('u_values[0]'), this.values);

    const cols = new Float32Array(this.materials.length * 3);
    const rough = new Float32Array(this.materials.length);
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
    for (const p of this.cache.values()) gl.deleteProgram(p);
    this.cache.clear();
    this.program = null;
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
  }
}
