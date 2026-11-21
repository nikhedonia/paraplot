import type {
  AnimateOutcome,
  AnimateSuccess,
  AnimateSuccessWire,
  CompileOutcome,
  CompileRequest,
  CompileSuccess,
  CompileSuccessWire,
  CompileWorkerMessage,
  ProgramView,
  ProgramWire,
} from './compileProtocol';
import type { ParamSchema } from './controls';
import type { TreeNode } from './sceneTree';
import type { SplineInfo } from './types';

interface Awaiting {
  kind: 'compile' | 'animate';
  resolve: (value: CompileOutcome | AnimateOutcome | null) => void;
}

const COMPILE_TIMEOUT_MS = 10_000;

/**
 * Owns the compiler worker. Full compiles are coalesced (only the newest
 * queued request is sent) and animation frames are one-at-a-time, so a busy
 * scene can never build a message backlog or freeze typing. A user scene with
 * an accidental infinite loop is bounded by a timeout + fresh worker.
 */
export class CompileClient {
  private worker: Worker;
  private readonly awaiting = new Map<number, Awaiting>();
  private nextId = 1;
  private queue: { request: CompileRequest; resolve: (v: CompileOutcome | null) => void } | null =
    null;
  private compileBusy = false;
  private compileTimer = 0;
  private workerAlive = true;
  private disposed = false;
  /** latest animation time requested; full compiles reuse it */
  private lastTime = 0;

  /* the worker omits unchanged payloads; keep the last full values here */
  private lastProgram: ProgramView | null = null;
  private lastTree: TreeNode | null = null;
  private lastSplines: SplineInfo[] | null = null;
  private lastBaseSplines: SplineInfo[] | null = null;
  private lastSchema: ParamSchema | null = null;

  constructor() {
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const worker = new Worker(new URL('./compileWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as CompileWorkerMessage;
      const pending = this.awaiting.get(msg.id);
      if (!pending) return;
      this.awaiting.delete(msg.id);
      if (pending.kind === 'compile') {
        this.clearTimer();
        this.compileBusy = false;
        const wire = msg as Extract<CompileWorkerMessage, { type: 'compiled' }>;
        pending.resolve(wire.ok ? this.mergeCompile(wire) : wire);
        this.pump();
      } else {
        const wire = msg as Extract<CompileWorkerMessage, { type: 'animated' }>;
        pending.resolve(wire.ok ? this.mergeAnimate(wire) : wire);
      }
    };
    worker.onerror = (event) => {
      this.failWorker(event.message || 'the scene compiler crashed');
    };
    return worker;
  }

  private clearTimer(): void {
    if (this.compileTimer) window.clearTimeout(this.compileTimer);
    this.compileTimer = 0;
  }

  private mergeProgram(wire: ProgramWire | null): ProgramView | null {
    if (!wire) return null;
    const glsl = wire.glsl ?? this.lastProgram?.glsl;
    // the first program always carries its shader; a missing one here means
    // the worker and client are out of sync, so drop the frame instead of
    // rendering a stale shader
    if (glsl === undefined) return null;
    const program: ProgramView = { ...wire, glsl };
    this.lastProgram = program;
    return program;
  }

  private mergeCompile(wire: CompileSuccessWire): CompileSuccess {
    this.lastTree = wire.tree ?? this.lastTree;
    this.lastSplines = wire.splines ?? this.lastSplines;
    this.lastBaseSplines = wire.baseSplines ?? this.lastBaseSplines;
    this.lastSchema = wire.schema ?? this.lastSchema;
    return {
      ok: true,
      program: this.mergeProgram(wire.program),
      splines: this.lastSplines ?? [],
      baseSplines: this.lastBaseSplines ?? [],
      tree: this.lastTree ?? { id: 'scene', kind: 'group', label: 'scene', depth: 0, children: [] },
      schema: this.lastSchema ?? {},
      values: wire.values,
      animated: wire.animated,
      ms: wire.ms,
    };
  }

  private mergeAnimate(wire: AnimateSuccessWire): AnimateOutcome {
    const glsl = wire.glsl ?? this.lastProgram?.glsl;
    if (glsl === undefined) {
      return { ok: false, error: 'the shader has not been compiled yet' };
    }
    const program: ProgramView = {
      glsl,
      values: wire.values,
      bounds: wire.bounds,
      materials: wire.materials,
      stats: wire.stats,
      usesTime: wire.usesTime,
    };
    this.lastProgram = program;
    return { ok: true, program, ms: wire.ms };
  }

  private failWorker(message: string): void {
    if (this.disposed) return;
    this.clearTimer();
    this.worker.terminate();
    this.workerAlive = false;
    for (const [id, pending] of this.awaiting) {
      pending.resolve(
        pending.kind === 'compile'
          ? { ok: false, error: message, schema: {}, ms: 0 }
          : { ok: false, error: message },
      );
      this.awaiting.delete(id);
    }
    this.compileBusy = false;
    // spawn lazily on the next request: a broken worker module must not enter a
    // tight create/error loop with no user action in between
    this.pump();
  }

  compile(request: CompileRequest): Promise<CompileOutcome | null> {
    if (this.disposed) return Promise.resolve(null);
    return new Promise((resolve) => {
      // only the newest queued compile matters; supersede the previous one
      this.queue?.resolve(null);
      this.queue = { request, resolve };
      this.pump();
    });
  }

  animate(time: number): Promise<AnimateOutcome | null> {
    if (this.disposed) return Promise.resolve(null);
    this.lastTime = time;
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.awaiting.set(id, {
        kind: 'animate',
        resolve: (value) => resolve(value as AnimateOutcome | null),
      });
      this.worker.postMessage({ type: 'animate', id, time });
    });
  }

  private pump(): void {
    if (this.disposed || this.compileBusy || !this.queue) return;
    if (!this.workerAlive) {
      this.worker = this.spawn();
      this.workerAlive = true;
    }
    const item = this.queue;
    this.queue = null;
    this.compileBusy = true;
    const id = this.nextId++;
    this.awaiting.set(id, {
      kind: 'compile',
      resolve: (value) => item.resolve(value as CompileOutcome | null),
    });
    // compile at the current animation time, not t=0: a live scene must not
    // visibly snap back to its start pose when a parameter changes
    this.worker.postMessage({ type: 'compile', id, ...item.request, time: this.lastTime });
    this.compileTimer = window.setTimeout(() => {
      this.failWorker('the scene took too long to compile (possible infinite loop)');
    }, COMPILE_TIMEOUT_MS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    for (const pending of this.awaiting.values()) pending.resolve(null);
    this.awaiting.clear();
    this.queue?.resolve(null);
    this.queue = null;
    this.worker.terminate();
  }
}
