import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Aabb, SplineInfo } from '../core/types';
import { buildSplinePreview } from '../core/splinePreview';
import type { CompiledProgram } from '../core/codegen';
import { createBackend, type RenderBackend } from '../render/backend';
import { type CameraState, defaultCamera } from '../render/renderer';
import { DEFAULT_SETTINGS, type RenderSettings } from '../render/settings';
import { Icon } from './Icon';

const PREVIEW_SETTINGS: RenderSettings = {
  ...DEFAULT_SETTINGS,
  scale: 0.95,
  maxSteps: 110,
  shadows: true,
  ao: true,
  grid: true,
  view: 'shaded',
};

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** keep the expensive preview rebuild off the pointer-move path */
function useDebouncedValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}
const PREVIEW_DEBOUNCE_MS = 90;

export interface SplineView3DProps {
  spline: SplineInfo | null;
  /** draw 3D curvature combs along the curve */
  comb?: boolean;
  density?: number;
  scale?: number;
}

/**
 * A small orbitable raymarched preview of one spline/profile: the swept shape,
 * its control cage and handles, rendered with the same SDF pipeline.
 */
function SplineView3DImpl({
  spline,
  comb = false,
  density = 40,
  scale = 1,
}: SplineView3DProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const backendRef = useRef<RenderBackend | null>(null);
  const programRef = useRef<CompiledProgram | null>(null);
  const cameraRef = useRef<CameraState>({ ...defaultCamera(), fov: (40 * Math.PI) / 180 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const invalidateRef = useRef<() => void>(() => {});
  const framedFor = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // dragging a control point changes the spline on every pointer event; the
  // 3D preview only needs to follow at a comfortable cadence
  const previewSpline = useDebouncedValue(spline, PREVIEW_DEBOUNCE_MS);
  // clears immediately when the selection disappears, lags only while editing
  const activePreview = spline ? previewSpline : null;
  const program = useMemo(() => {
    if (!activePreview) return null;
    try {
      return buildSplinePreview(activePreview, comb, { density, scale });
    } catch {
      return null;
    }
  }, [activePreview, comb, density, scale]);
  programRef.current = program;

  const frame = useCallback((bounds: Aabb) => {
    const c = cameraRef.current;
    const center: [number, number, number] = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
    const diag = Math.max(
      0.2,
      Math.hypot(
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      ),
    );
    c.target = center;
    c.dist = (diag / 2 / Math.tan(c.fov / 2)) * 1.3;
    c.yaw = 0.8;
    c.pitch = 0.38;
    invalidateRef.current();
  }, []);

  /* ---- backend + orbit ---- */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const canvas = document.createElement('canvas');
    canvas.className = 'spline-3d-canvas';
    canvasRef.current = canvas;
    host.prepend(canvas);

    let raf = 0;
    let inFlight = false;
    let dirty = true;

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(tick);
    };
    const invalidate = () => {
      dirty = true;
      schedule();
    };
    invalidateRef.current = invalidate;

    function tick() {
      raf = 0;
      if (inFlight) return;
      const p = programRef.current;
      const { w, h } = sizeRef.current;
      const backend = backendRef.current;
      if (!p || !backend || w < 2 || h < 2) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      let scale = PREVIEW_SETTINGS.scale;
      const pixels = w * h * dpr * dpr * scale * scale;
      if (pixels > 2_200_000) scale *= Math.sqrt(2_200_000 / pixels);

      inFlight = true;
      dirty = false;
      try {
        backend.setScene(p);
        backend.render({
          camera: cameraRef.current,
          settings: PREVIEW_SETTINGS,
          width: w,
          height: h,
          dpr,
          time: 0,
          floorY: p.bounds.min[1] - 0.004,
          scale,
        });
      } catch (err) {
        inFlight = false;
        setError((err as Error).message ?? String(err));
      }
    }

    let backend: RenderBackend | null = null;
    try {
      backend = createBackend(canvas, {
        onFrame: () => {
          inFlight = false;
          if (dirty) schedule();
        },
        onError: (message) => setError(message),
      });
    } catch (err) {
      setError((err as Error).message ?? String(err));
    }
    backendRef.current = backend;

    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height };
      invalidate();
    });
    ro.observe(host);
    const r0 = host.getBoundingClientRect();
    sizeRef.current = { w: r0.width, h: r0.height };

    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onDown = (e: PointerEvent) => {
      if (e.target !== canvas || e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      host.classList.add('grabbing');
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const c = cameraRef.current;
      c.yaw -= dx * 0.008;
      c.pitch = clamp(c.pitch + dy * 0.008, -1.45, 1.45);
      invalidate();
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      host.classList.remove('grabbing');
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = cameraRef.current;
      c.dist = clamp(c.dist * Math.exp(e.deltaY * 0.0014), 0.05, 200);
      invalidate();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    invalidate();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      ro.disconnect();
      backend?.dispose();
      backendRef.current = null;
      canvas.remove();
      canvasRef.current = null;
      invalidateRef.current = () => {};
    };
  }, []);

  /* ---- scene changes ---- */
  useEffect(() => {
    if (!program || !activePreview) return;
    if (framedFor.current !== activePreview.id) {
      framedFor.current = activePreview.id;
      frame(program.bounds);
    } else {
      invalidateRef.current();
    }
  }, [program, activePreview, frame]);

  return (
    <div className="spline-view3d" ref={hostRef}>
      <div className="hud hud-tr">
        <button
          className="iconbtn"
          title="Frame spline"
          onClick={() => programRef.current && frame(programRef.current.bounds)}
        >
          <Icon name="frame" />
        </button>
      </div>
      <div className="hud hud-bl">drag orbit · wheel zoom</div>
      {error && <div className="viewport-error">{error}</div>}
      {!spline && <div className="viewport-error">Select a spline or profile to preview it in 3D.</div>}
    </div>
  );
}

export const SplineView3D = memo(SplineView3DImpl);
