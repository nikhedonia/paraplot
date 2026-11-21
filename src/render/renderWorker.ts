/**
 * Render worker. Owns the GL context of a transferred OffscreenCanvas, so
 * shader compilation, draw submission and preview JPEG encoding never touch
 * the main thread.
 */
import { Renderer } from './renderer';
import { captureOffscreenCanvas } from './capture';
import type { FrameArgs } from './types';
import type { Aabb, Material } from '../core/types';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
};

let renderer: Renderer | null = null;
let glsl = '';
let values = new Float32Array(0);
let materials: Material[] = [];
let bounds: Aabb = { min: [-1, -1, -1], max: [1, 1, 1] };

const post = (message: unknown) => scope.postMessage(message);
const scene = () => ({ glsl, values, materials, bounds });

let polling = false;
/** poll an asynchronous analysis-program link without blocking frame messages */
function schedulePoll(): void {
  if (polling || !renderer) return;
  polling = true;
  setTimeout(() => {
    polling = false;
    if (!renderer) return;
    const state = renderer.pollViewProgram();
    if (state === 'pending') schedulePoll();
    else if (state === 'ready') post({ type: 'view-ready' });
    else if (state === 'error') {
      post({
        type: 'error',
        message: renderer.takePendingViewError() ?? 'analysis shader failed to compile',
      });
    }
  }, 25);
}

scope.onmessage = async (event: MessageEvent) => {
  const msg = event.data;
  switch (msg?.type) {
    case 'init': {
      const canvas = msg.canvas as OffscreenCanvas;
      try {
        renderer = new Renderer(canvas);
        canvas.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          post({ type: 'context-lost' });
        });
        post({ type: 'ready' });
      } catch (err) {
        post({
          type: 'error',
          message: `${(err as Error).message ?? String(err)} — reload with ?mainRender=1 to use the main thread`,
        });
      }
      break;
    }

    case 'program': {
      glsl = String(msg.glsl ?? '');
      if (!renderer) break;
      try {
        renderer.setScene(scene());
        post({ type: 'program-ok' });
      } catch (err) {
        post({ type: 'error', message: (err as Error).message ?? String(err) });
      }
      break;
    }

    case 'frame': {
      const args = msg.args as FrameArgs;
      values = msg.values;
      materials = msg.materials;
      bounds = msg.bounds;
      if (!renderer) {
        post({ type: 'error', message: 'renderer is not ready' });
        break;
      }
      try {
        renderer.setScene(scene());
        const t0 = performance.now();
        renderer.render(
          args.camera,
          args.settings,
          args.width,
          args.height,
          args.dpr,
          args.time,
          args.floorY,
          args.scale,
        );
        // Only probe/ramp frames pay for a GPU sync: syncing every frame
        // would stall the shared GPU process and make the whole UI hang.
        let renderMs: number | undefined;
        if (args.probe) {
          renderer.syncFrame();
          renderMs = performance.now() - t0;
        }
        post({
          type: 'rendered',
          width: renderer.canvas.width,
          height: renderer.canvas.height,
          renderMs,
          compiled: renderer.takeCompiled(),
        });
        if (renderer.hasPendingView()) schedulePoll();
      } catch (err) {
        post({ type: 'error', message: (err as Error).message ?? String(err) });
      }
      break;
    }

    case 'snapshot': {
      const args = msg.args as FrameArgs;
      values = msg.values;
      materials = msg.materials;
      bounds = msg.bounds;
      let dataUrl: string | null = null;
      if (renderer) {
        try {
          renderer.setScene(scene());
          renderer.render(
            args.camera,
            args.settings,
            args.width,
            args.height,
            args.dpr,
            args.time,
            args.floorY,
            args.scale,
          );
          // make sure the offscreen canvas is complete before copying it
          renderer.syncFrame();
          // copy synchronously, then encode off-thread
          dataUrl = await captureOffscreenCanvas(renderer.canvas as OffscreenCanvas);
        } catch (err) {
          post({ type: 'error', message: (err as Error).message ?? String(err) });
        }
      }
      post({ type: 'snapshot', id: msg.id, dataUrl });
      break;
    }

    case 'dispose': {
      renderer?.dispose();
      renderer = null;
      break;
    }

    default:
      break;
  }
};
