import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { CompiledProgram } from '../core/codegen';
import type { Aabb } from '../core/types';
import { type CameraState, defaultCamera, cameraPosition } from '../render/renderer';
import type { RenderSettings } from '../render/settings';
import {
  createBackend,
  type FrameInfo,
  type RenderBackend,
} from '../render/backend';
import { Icon } from './Icon';

export interface AnimateResult {
  program: CompiledProgram | null;
  error?: string;
}

export interface ViewportProps {
  program: CompiledProgram | null;
  settings: RenderSettings;
  onSettings: (s: RenderSettings) => void;
  onError: (msg: string | null) => void;
  /** re-evaluates the scene at a given time (only used by animated scenes) */
  animate?: (time: number) => AnimateResult;
  /** the scene function takes a time argument */
  animated?: boolean;
  playing: boolean;
  onTogglePlay: () => void;
  /** filled with a function that captures the next drawn frame as a jpeg */
  snapshotRef?: MutableRefObject<(() => Promise<string | null>) | null>;
  /** bump to re-frame the current scene (e.g. after isolating a component) */
  frameSignal?: number;
  /** active visibility/solo filters, shown as a HUD chip */
  filterLabel?: string | null;
  onClearFilter?: () => void;
  /** message shown when there is nothing to render */
  emptyLabel?: string | null;
}

interface Size {
  w: number;
  h: number;
}

const QUALITY: Array<{ label: string; scale: number; steps: number }> = [
  { label: 'Draft', scale: 0.55, steps: 72 },
  { label: 'Standard', scale: 0.8, steps: 128 },
  { label: 'Fine', scale: 1.0, steps: 200 },
];

/** while dragging, render fewer pixels and skip shadows … */
const DRAFT_MS = 140;
const DRAFT_SCALE = 0.62;
/** … then draw one full quality frame once the interaction settles */
const IDLE_MS = 500;
/** hard cap on the drawing buffer so 4k/retina screens don't melt */
const PIXEL_BUDGET = 2_600_000;

export function Viewport({
  program,
  settings,
  onSettings,
  onError,
  animate,
  animated = false,
  playing,
  onTogglePlay,
  snapshotRef,
  frameSignal = 0,
  filterLabel = null,
  onClearFilter,
  emptyLabel = null,
}: ViewportProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const backendRef = useRef<RenderBackend | null>(null);
  const cameraRef = useRef<CameraState>(defaultCamera());
  const sizeRef = useRef<Size>({ w: 0, h: 0 });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const frameRef = useRef<Aabb | null>(null);
  const framedRef = useRef(false);
  const programRef = useRef(program);
  programRef.current = program;
  const animateRef = useRef(animate);
  animateRef.current = animate;
  const animatedRef = useRef(animated);
  animatedRef.current = animated;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const clockRef = useRef(0);
  const autoScaleRef = useRef(1);
  const dirtyRef = useRef(true);
  const interactingRef = useRef(false);
  const lastTapRef = useRef(0);
  const wakeRef = useRef<() => void>(() => {});
  const [stats, setStats] = useState({
    fps: 0,
    w: 0,
    h: 0,
    time: 0,
    live: false,
    renderer: 'main' as 'main' | 'worker',
  });
  const [webglError, setWebglError] = useState<string | null>(null);

  const frame = useCallback((bounds: Aabb) => {
    const c = cameraRef.current;
    const center: [number, number, number] = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
    // keep the current orientation, fit the eight corners into the frustum
    const cp = Math.cos(c.pitch);
    const orbit: [number, number, number] = [
      Math.sin(c.yaw) * cp,
      Math.sin(c.pitch),
      Math.cos(c.yaw) * cp,
    ];
    const fwd: [number, number, number] = [-orbit[0], -orbit[1], -orbit[2]];
    const right: [number, number, number] = [-fwd[2], 0, fwd[0]];
    const rl = Math.hypot(right[0], right[2]) || 1;
    right[0] /= rl;
    right[2] /= rl;
    const up: [number, number, number] = [
      right[1] * fwd[2] - right[2] * fwd[1],
      right[2] * fwd[0] - right[0] * fwd[2],
      right[0] * fwd[1] - right[1] * fwd[0],
    ];

    const aspect = sizeRef.current.h > 0 ? sizeRef.current.w / sizeRef.current.h : 1.5;
    const tanY = Math.tan(c.fov / 2);
    const tanX = tanY * Math.max(0.5, aspect);
    const margin = 1.12;

    let dist = 0.4;
    for (let i = 0; i < 8; i++) {
      const p: [number, number, number] = [
        i & 1 ? bounds.max[0] : bounds.min[0],
        i & 2 ? bounds.max[1] : bounds.min[1],
        i & 4 ? bounds.max[2] : bounds.min[2],
      ];
      const v: [number, number, number] = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
      const dx = Math.abs(v[0] * right[0] + v[1] * right[1] + v[2] * right[2]);
      const dy = Math.abs(v[0] * up[0] + v[1] * up[1] + v[2] * up[2]);
      const dz = v[0] * fwd[0] + v[1] * fwd[1] + v[2] * fwd[2];
      dist = Math.max(dist, (dx * margin) / tanX - dz, (dy * margin) / tanY - dz);
    }

    c.target = center;
    c.dist = Math.max(0.4, Math.min(400, dist));
    dirtyRef.current = true;
    wakeRef.current();
  }, []);

  /* ---- renderer + loop ---- */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // a fresh canvas per mount: once transferred to a worker the element can
    // never be handed back to the main thread
    const canvas = document.createElement('canvas');
    canvas.className = 'viewport-canvas';
    canvasRef.current = canvas;
    host.prepend(canvas);

    let backend: RenderBackend | null = null;
    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let fpsStart = last;
    let publishedW = 0;
    let publishedH = 0;
    let idleTimer = 0;
    let refineTimer = 0;
    let idle = true;
    let animatedFor: CompiledProgram | null = null;
    let lastAnimError: string | null = null;

    const isLive = () =>
      playingRef.current && (animatedRef.current || !!programRef.current?.usesTime);

    function ensure() {
      if (raf || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }

    function wake() {
      dirtyRef.current = true;
      ensure();
    }
    wakeRef.current = wake;

    function postIdle() {
      frames = 0;
      fpsStart = performance.now();
      if (idle) return;
      idle = true;
      setStats((s) => (s.live ? { ...s, live: false } : s));
    }

    /** one ack per presented frame, from either backend */
    const onFrame = (info: FrameInfo) => {
      frames++;
      if (info.width !== publishedW || info.height !== publishedH) {
        publishedW = info.width;
        publishedH = info.height;
        setStats((s) => ({ ...s, w: info.width, h: info.height }));
      }
      const now = performance.now();
      if (now - fpsStart > 400) {
        const fps = Math.round((frames * 1000) / (now - fpsStart));
        if (isLive()) {
          // dynamic resolution: keep each submitted frame inside the budget,
          // so a slow GPU degrades pixels instead of responsiveness
          const a = autoScaleRef.current;
          if (fps < 42 && a > 0.5) {
            autoScaleRef.current = Math.max(0.5, Math.round((a - 0.1) * 100) / 100);
          } else if (fps > 56 && a < 1) {
            autoScaleRef.current = Math.min(1, Math.round((a + 0.05) * 100) / 100);
          }
        }
        setStats({
          fps,
          w: info.width,
          h: info.height,
          time: clockRef.current,
          live: true,
          renderer: backend?.offscreen ? 'worker' : 'main',
        });
        frames = 0;
        fpsStart = now;
      }
      if (isLive() || dirtyRef.current) ensure();
    };

    try {
      backend = createBackend(canvas, {
        onFrame,
        onError: (message) => onErrorRef.current(message),
      });
    } catch (err) {
      setWebglError((err as Error).message ?? String(err));
      canvas.remove();
      canvasRef.current = null;
      wakeRef.current = () => {};
      return;
    }

    backendRef.current = backend;
    host.dataset.renderer = backend.offscreen ? 'worker' : 'main';
    setStats((s) => ({ ...s, renderer: backend?.offscreen ? 'worker' : 'main' }));

    if (snapshotRef) {
      snapshotRef.current = () => {
        dirtyRef.current = true;
        ensure();
        return backend?.snapshot() ?? Promise.resolve(null);
      };
    }

    function tick(now: number) {
      if (!backend) return;
      raf = 0;
      const live = isLive();
      const delta = Math.max(0, Math.min(0.25, (now - last) / 1000));
      last = now;
      if (live) clockRef.current += delta;

      const { w, h } = sizeRef.current;
      if (w < 2 || h < 2) return;

      const sinceTap = now - lastTapRef.current;
      const drafting = interactingRef.current || sinceTap < DRAFT_MS;

      // nothing changed, nothing moves: go to sleep (no rAF, no GPU work)
      if (!dirtyRef.current && !live && !drafting) {
        postIdle();
        return;
      }

      // at most one frame in flight: drop this vsync instead of queueing work
      if (backend.busy) return;

      dirtyRef.current = false;
      if (idle) {
        idle = false;
        setStats((s) => (s.live ? s : { ...s, live: true }));
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = 0;
      }

      // an animated scene is a pure function of (params, time): rebuild it each
      // frame. Parameter drags while paused still refresh at the paused time.
      if (animatedRef.current && animateRef.current) {
        if (live || animatedFor !== programRef.current) {
          const res = animateRef.current(clockRef.current);
          animatedFor = programRef.current;
          if (res.program) {
            lastAnimError = null;
            backend.setScene(res.program);
          } else if (res.error && res.error !== lastAnimError) {
            lastAnimError = res.error;
            onErrorRef.current(`animation: ${res.error}`);
          }
        }
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      let scale = settingsRef.current.scale * (drafting ? DRAFT_SCALE : 1);
      if (live) scale *= autoScaleRef.current;
      const pixels = w * h * dpr * dpr * scale * scale;
      if (pixels > PIXEL_BUDGET) scale *= Math.sqrt(PIXEL_BUDGET / pixels);

      const base = settingsRef.current;
      const renderSettings: RenderSettings = drafting
        ? { ...base, shadows: false, maxSteps: Math.min(base.maxSteps, 88) }
        : base;

      // the grid plane is a scene-level constant: use the static (t = 0) bounds
      // so it does not bob while an animated scene moves
      const b = programRef.current?.bounds;
      try {
        backend.render({
          camera: cameraRef.current,
          settings: renderSettings,
          width: w,
          height: h,
          dpr,
          time: clockRef.current,
          floorY: b ? b.min[1] - 0.004 : 0,
          scale,
        });
      } catch (err) {
        onErrorRef.current((err as Error).message ?? String(err));
      }

      if (live) {
        ensure();
        return;
      }

      if (drafting) {
        // once the interaction window is over, draw a full quality frame
        const wait = Math.max(30, DRAFT_MS - sinceTap + 30);
        if (refineTimer) clearTimeout(refineTimer);
        refineTimer = window.setTimeout(() => {
          refineTimer = 0;
          dirtyRef.current = true;
          ensure();
        }, wait);
      }
      idleTimer = window.setTimeout(postIdle, IDLE_MS);
    }

    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height };
      dirtyRef.current = true;
      ensure();
    });
    ro.observe(host);
    const r0 = host.getBoundingClientRect();
    sizeRef.current = { w: r0.width, h: r0.height };

    wake();

    const onVisibility = () => {
      if (!document.hidden) {
        dirtyRef.current = true;
        ensure();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (idleTimer) clearTimeout(idleTimer);
      if (refineTimer) clearTimeout(refineTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      ro.disconnect();
      backend?.dispose();
      backendRef.current = null;
      if (snapshotRef) snapshotRef.current = null;
      delete host.dataset.renderer;
      canvas.remove();
      canvasRef.current = null;
      wakeRef.current = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotRef]);

  /* ---- upload scene ---- */
  useEffect(() => {
    if (!program) return;
    frameRef.current = program.bounds;
    backendRef.current?.setScene(program);
    if (!framedRef.current) {
      framedRef.current = true;
      frame(program.bounds);
    }
    wakeRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [program]);

  /* ---- re-frame on demand (component solo) ---- */
  useEffect(() => {
    if (!frameSignal) return;
    const bounds = programRef.current?.bounds;
    if (bounds) frame(bounds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameSignal]);

  /* ---- any of these need a fresh frame ---- */
  useEffect(() => {
    autoScaleRef.current = 1;
    wakeRef.current();
  }, [settings, playing, animated]);

  /* ---- interaction ---- */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let mode: 'orbit' | 'pan' | null = null;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (e: PointerEvent) => {
      // only orbit from the canvas itself; the HUD overlays must keep their clicks
      if (e.target !== canvasRef.current) return;
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
      mode = e.button === 0 && !e.shiftKey ? 'orbit' : 'pan';
      lastX = e.clientX;
      lastY = e.clientY;
      interactingRef.current = true;
      lastTapRef.current = performance.now();
      host.setPointerCapture(e.pointerId);
      host.classList.add(mode === 'orbit' ? 'grabbing' : 'panning');
      e.preventDefault();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!mode) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      lastTapRef.current = performance.now();
      dirtyRef.current = true;
      wakeRef.current();
      const c = cameraRef.current;

      if (mode === 'orbit') {
        c.yaw -= dx * 0.0075;
        c.pitch = Math.max(-1.45, Math.min(1.45, c.pitch + dy * 0.0075));
        return;
      }

      const k = (2 * c.dist * Math.tan(c.fov / 2)) / Math.max(80, sizeRef.current.h);
      const pos = cameraPosition(c);
      const fw: [number, number, number] = [
        c.target[0] - pos[0],
        c.target[1] - pos[1],
        c.target[2] - pos[2],
      ];
      const fl = Math.hypot(fw[0], fw[1], fw[2]) || 1;
      const f: [number, number, number] = [fw[0] / fl, fw[1] / fl, fw[2] / fl];
      const right: [number, number, number] = [-f[2], 0, f[0]];
      const rl = Math.hypot(right[0], right[2]) || 1;
      right[0] /= rl;
      right[2] /= rl;
      const up: [number, number, number] = [
        right[1] * f[2] - right[2] * f[1],
        right[2] * f[0] - right[0] * f[2],
        right[0] * f[1] - right[1] * f[0],
      ];
      c.target = [
        c.target[0] - right[0] * dx * k + up[0] * dy * k,
        c.target[1] - right[1] * dx * k + up[1] * dy * k,
        c.target[2] - right[2] * dx * k + up[2] * dy * k,
      ];
    };

    const end = (e: PointerEvent) => {
      if (!mode) return;
      mode = null;
      interactingRef.current = false;
      lastTapRef.current = performance.now();
      dirtyRef.current = true;
      wakeRef.current();
      host.classList.remove('grabbing', 'panning');
      try {
        host.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = cameraRef.current;
      const factor = Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.04 : 0.0014));
      c.dist = Math.max(0.02, Math.min(400, c.dist * factor));
      lastTapRef.current = performance.now();
      dirtyRef.current = true;
      wakeRef.current();
    };

    const onDouble = (e: MouseEvent) => {
      if (e.target !== canvasRef.current) return;
      if (frameRef.current) frame(frameRef.current);
    };

    const onContext = (e: Event) => e.preventDefault();

    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('dblclick', onDouble);
    host.addEventListener('contextmenu', onContext);
    return () => {
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', end);
      host.removeEventListener('pointercancel', end);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('dblclick', onDouble);
      host.removeEventListener('contextmenu', onContext);
    };
  }, [frame]);

  const qualityIndex = Math.max(
    0,
    QUALITY.findIndex((q) => q.scale === settings.scale),
  );

  return (
    <div className="viewport" ref={hostRef}>
      <div className="hud hud-tl">
        <div
          className={`chip ${stats.live ? '' : 'dim'}`}
          title={stats.live ? 'frames are being drawn' : 'idle — the viewport renders on demand'}
        >
          {stats.live ? (stats.fps > 0 ? `${stats.fps} fps` : 'rendering') : 'idle'}
        </div>
        <div className="chip">
          {stats.w}×{stats.h}
        </div>
        {(animated || program?.usesTime) && (
          <div className={`chip time ${playing ? 'live' : ''}`} title="scene clock">
            t {stats.time.toFixed(2)}s
          </div>
        )}
        {filterLabel && (
          <button className="chip filterchip" onClick={onClearFilter} title="Clear visibility and solo filters">
            {filterLabel} <span aria-hidden="true">×</span>
          </button>
        )}
        <div className="chip dim">sdf · {stats.renderer}</div>
      </div>

      <div className="hud hud-tr">
        {(animated || program?.usesTime) && (
          <button
            className={`iconbtn ${playing ? 'on' : ''}`}
            title={playing ? 'Pause the scene clock' : 'Play the scene clock'}
            onClick={onTogglePlay}
          >
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
        )}
        <button
          className="iconbtn"
          title="Frame scene (double click)"
          onClick={() => frameRef.current && frame(frameRef.current)}
        >
          <Icon name="frame" />
        </button>
        <button
          className={`iconbtn ${settings.grid ? 'on' : ''}`}
          title="Ground grid"
          onClick={() => onSettings({ ...settings, grid: !settings.grid })}
        >
          <Icon name="grid" />
        </button>
        <button
          className={`iconbtn ${settings.shadows ? 'on' : ''}`}
          title="Soft shadows"
          onClick={() => onSettings({ ...settings, shadows: !settings.shadows })}
        >
          <Icon name="shadow" />
        </button>
        <button
          className={`iconbtn ${settings.ao ? 'on' : ''}`}
          title="Ambient occlusion"
          onClick={() => onSettings({ ...settings, ao: !settings.ao })}
        >
          <Icon name="ao" />
        </button>
        <div className="segmented small">
          {QUALITY.map((q, i) => (
            <button
              key={q.label}
              className={i === qualityIndex ? 'active' : ''}
              title={`${q.label} — ${q.steps} march steps`}
              onClick={() => onSettings({ ...settings, scale: q.scale, maxSteps: q.steps })}
            >
              {q.label[0]}
            </button>
          ))}
        </div>
      </div>

      <div className="hud hud-bl">
        <span>drag</span> orbit · <span>shift+drag</span> pan · <span>wheel</span> zoom
      </div>

      {(webglError || !program) && (
        <div className="viewport-error">{webglError ?? emptyLabel ?? 'Compiling scene…'}</div>
      )}
    </div>
  );
}
