import type {
  AnimateOutcome,
  CompileOutcome,
  CompileRequest,
  CompileWorkerMessage,
} from './compileProtocol';

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
        pending.resolve(msg as CompileOutcome);
        this.pump();
      } else {
        pending.resolve(msg as AnimateOutcome);
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
    this.worker.postMessage({ type: 'compile', id, ...item.request });
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
