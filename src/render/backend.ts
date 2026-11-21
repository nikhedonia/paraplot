import { Renderer } from './renderer';
import { captureMainCanvas } from './capture';
import type {
  BackendHooks,
  FrameArgs,
  FrameInfo,
  RenderBackend,
  RenderScene,
} from './types';

export type { BackendHooks, FrameArgs, FrameInfo, RenderBackend, RenderScene } from './types';

/* ------------------------------------------------------------------ *
 * fallback: render on the main thread (used when OffscreenCanvas or
 * transferControlToOffscreen is unavailable, or with ?mainRender)
 * ------------------------------------------------------------------ */

class MainBackend implements RenderBackend {
  readonly offscreen = false;
  readonly busy = false;

  private readonly renderer: Renderer;
  private readonly hooks: BackendHooks;
  private pendingSnapshot: ((value: string | null) => void) | null = null;
  private readonly onLost: (event: Event) => void;

  constructor(canvas: HTMLCanvasElement, hooks: BackendHooks) {
    this.hooks = hooks;
    this.renderer = new Renderer(canvas);
    this.onLost = (event: Event) => {
      event.preventDefault();
      this.hooks.onContextLost?.();
    };
    canvas.addEventListener('webglcontextlost', this.onLost);
  }

  setScene(scene: RenderScene): void {
    try {
      this.renderer.setScene(scene);
      this.hooks.onError(null);
    } catch (err) {
      this.hooks.onError((err as Error).message ?? String(err));
    }
  }

  render(args: FrameArgs): void {
    const t0 = performance.now();
    this.renderer.render(
      args.camera,
      args.settings,
      args.width,
      args.height,
      args.dpr,
      args.time,
      args.floorY,
      args.scale,
    );
    if (this.pendingSnapshot) {
      const resolve = this.pendingSnapshot;
      this.pendingSnapshot = null;
      resolve(captureMainCanvas(this.renderer.canvas as HTMLCanvasElement));
    }
    this.hooks.onFrame({
      width: this.renderer.canvas.width,
      height: this.renderer.canvas.height,
      renderMs: performance.now() - t0,
      compiled: this.renderer.takeCompiled(),
    });
  }

  snapshot(): Promise<string | null> {
    return new Promise((resolve) => {
      this.pendingSnapshot = resolve;
    });
  }

  dispose(): void {
    this.renderer.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.renderer.dispose();
  }
}

/* ------------------------------------------------------------------ *
 * worker: every GL call (including shader compilation and the jpeg
 * encode for previews) happens off the main thread
 * ------------------------------------------------------------------ */

class WorkerBackend implements RenderBackend {
  readonly offscreen = true;
  busy = false;

  private readonly worker: Worker;
  private readonly hooks: BackendHooks;
  private readonly snapshots = new Map<number, (value: string | null) => void>();
  private scene: RenderScene | null = null;
  private glslKey = '';
  /** coalesce structural edits: only the newest shader is sent to the worker */
  private pendingGlsl: string | null = null;
  private lastArgs: FrameArgs | null = null;
  private nextSnapshot = 1;

  constructor(canvas: HTMLCanvasElement, hooks: BackendHooks) {
    this.hooks = hooks;
    this.worker = new Worker(new URL('./renderWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent) => this.onMessage(event.data);
    this.worker.onerror = (event) => {
      this.hooks.onError(event.message || 'the renderer worker crashed');
      this.hooks.onContextLost?.();
    };

    // transfer only after the worker exists; if this throws the canvas is
    // untouched and the caller can fall back to the main thread
    const offscreen = canvas.transferControlToOffscreen();
    this.worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
  }

  private onMessage(msg: any): void {
    switch (msg?.type) {
      case 'ready':
        break;
      case 'program-ok':
        this.hooks.onError(null);
        break;
      case 'view-ready':
        this.hooks.onProgramReady?.();
        break;
      case 'rendered':
        this.busy = false;
        this.hooks.onFrame({
          width: msg.width,
          height: msg.height,
          renderMs: typeof msg.renderMs === 'number' ? msg.renderMs : undefined,
          compiled: msg.compiled === true,
        });
        break;
      case 'snapshot': {
        const resolve = this.snapshots.get(msg.id);
        this.snapshots.delete(msg.id);
        resolve?.(typeof msg.dataUrl === 'string' ? msg.dataUrl : null);
        break;
      }
      case 'error':
        this.busy = false;
        this.hooks.onError(String(msg.message ?? 'renderer error'));
        break;
      case 'context-lost':
        this.busy = false;
        this.hooks.onContextLost?.();
        break;
      default:
        break;
    }
  }

  setScene(scene: RenderScene): void {
    this.scene = scene;
    if (scene.glsl !== this.glslKey) {
      this.glslKey = scene.glsl;
      this.pendingGlsl = scene.glsl;
    }
  }

  private flushProgram(): void {
    if (!this.pendingGlsl) return;
    this.worker.postMessage({ type: 'program', glsl: this.pendingGlsl });
    this.pendingGlsl = null;
  }

  render(args: FrameArgs): void {
    this.lastArgs = args;
    if (!this.scene || this.busy) return;
    this.busy = true;
    this.flushProgram();
    this.worker.postMessage({
      type: 'frame',
      args,
      values: this.scene.values,
      materials: this.scene.materials,
      bounds: this.scene.bounds,
    });
  }

  snapshot(): Promise<string | null> {
    const args = this.lastArgs;
    const scene = this.scene;
    if (!args || !scene) return Promise.resolve(null);
    const id = this.nextSnapshot++;
    return new Promise((resolve) => {
      this.snapshots.set(id, resolve);
      this.flushProgram();
      this.worker.postMessage({
        type: 'snapshot',
        id,
        args,
        values: scene.values,
        materials: scene.materials,
        bounds: scene.bounds,
      });
    });
  }

  dispose(): void {
    for (const resolve of this.snapshots.values()) resolve(null);
    this.snapshots.clear();
    this.worker.terminate();
  }
}

let supported: boolean | null = null;

export function supportsOffscreen(): boolean {
  if (supported !== null) return supported;
  try {
    if (new URLSearchParams(window.location.search).has('mainRender')) {
      supported = false;
      return false;
    }
    // Do NOT create and discard a probe WebGL context here: on several
    // drivers that costs hundreds of ms on the main thread and can evict the
    // real context. The render worker reports WebGL2 failures instead.
    supported =
      typeof OffscreenCanvas !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function';
  } catch {
    supported = false;
  }
  return supported;
}

export function createBackend(canvas: HTMLCanvasElement, hooks: BackendHooks): RenderBackend {
  if (supportsOffscreen()) {
    try {
      return new WorkerBackend(canvas, hooks);
    } catch (err) {
      // transfer failed before the canvas was handed over: main thread still works
      console.warn('[paraplot] offscreen rendering unavailable:', (err as Error).message);
    }
  }
  return new MainBackend(canvas, hooks);
}
