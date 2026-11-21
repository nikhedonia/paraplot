import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { ProgramView } from '../core/compileProtocol';
import type { Aabb } from '../core/types';
import { type CameraState, defaultCamera, cameraPosition } from '../render/renderer';
import type { RenderSettings, ViewMode } from '../render/settings';
import {
  createBackend,
  type FrameInfo,
  type RenderBackend,
} from '../render/backend';
import { Icon } from './Icon';

export interface AnimateResult {
  program: ProgramView | null;
  error?: string;
}

export interface ViewportProps {
  program: ProgramView | null;
  settings: RenderSettings;
  onSettings: (s: RenderSettings) => void;
  onError: (msg: string | null) => void;
  /** re-evaluates the scene at a given time (only used by animated scenes) */
  animate?: (time: number) => Promise<AnimateResult>;
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
  /** show a pointer to the spline curvature combs in curvature mode */
  hasSplines?: boolean;
  /** stop drawing while another surface covers the viewport */
  paused?: boolean;
  /** stored project image shown while the first frame is prepared */
  preview?: string | null;
  /** status line under the boot spinner */
  bootLabel?: string;
  /** the scene failed to compile: stop the spinner, show the editor error */
  bootFailed?: boolean;
  /** notified once the first frame has been presented */
  onFirstFrame?: () => void;
}

interface Size {
  w: number;
  h: number;
}

/** first frames run at the floor quality so a heavy scene can never wedge the GPU */
const BOOT_QUALITY = 0.3;
const PROBE_STEPS = 32;
/** while dragging, render fewer pixels and skip shadows … */
const DRAFT_MS = 140;
const DRAFT_SCALE = 0.62;
/** … then draw one full quality frame once the interaction settles */
const IDLE_MS = 500;
/** hard cap on the drawing buffer so 4k/retina screens don't melt */
const PIXEL_BUDGET = 2_000_000;
/** per-frame budgets (ms) used to pick a sustainable render scale */
const IDLE_BUDGET = 90;
/** the curvature view takes seven extra map() calls per hit pixel */
const CURVATURE_MAX_SCALE = 0.55;
const MAX_RAMP = 6;

/** match the original draft / standard / fine presets (72 / 128 / 200 steps) */
const qualitySteps = (scale: number): number => {
  const s = Math.min(1, Math.max(0.3, scale));
  if (s <= 0.55) return Math.round(32 + ((s - 0.3) / 0.25) * 40);
  if (s <= 0.8) return Math.round(72 + ((s - 0.55) / 0.25) * 56);
  return Math.round(128 + ((s - 0.8) / 0.2) * 72);
};

interface QualityState {
  phase: 'probe1' | 'probe2' | 'ramp' | 'idle';
  scale: number;
  target: number;
  rampCount: number;
}

function ViewportImpl({
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
  hasSplines = false,
  paused = false,
  preview = null,
  bootLabel = 'preparing the viewport',
  bootFailed = false,
  onFirstFrame,
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
  const onFirstFrameRef = useRef(onFirstFrame);
  onFirstFrameRef.current = onFirstFrame;
  const clockRef = useRef(0);
  const autoScaleRef = useRef(1);
  const submittedRef = useRef<{
    kind: 'probe' | 'draft' | 'live' | 'idle';
    scale: number;
    steps: number;
  } | null>(null);
  const glslSeenRef = useRef('');
  const dirtyRef = useRef(true);
  const interactingRef = useRef(false);
  const lastTapRef = useRef(0);
  const wakeRef = useRef<() => void>(() => {});
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const hasFrameRef = useRef(false);
  const qualityRef = useRef<QualityState>({
    phase: 'probe1',
    scale: BOOT_QUALITY,
    target: settings.scale,
    rampCount: 0,
  });
  const renderStartRef = useRef(0);
  const submittedScaleRef = useRef(settings.scale);
  const shownQualityRef = useRef(settings.scale);
  const animInFlightRef = useRef(false);
  const animSeqRef = useRef(0);
  const lostRef = useRef(0);
  const [backendEpoch, setBackendEpoch] = useState(0);
  const [hasFrame, setHasFrame] = useState(false);
  const [bootVisible, setBootVisible] = useState(true);
  const [bootSlow, setBootSlow] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [effectiveQuality, setEffectiveQuality] = useState(settings.scale);
  const [stats, setStats] = useState({
    fps: 0,
    w: 0,
    h: 0,
    time: 0,
    live: false,
    renderer: 'main' as 'main' | 'worker',
  });
  const [webglError, setWebglError] = useState<string | null>(null);

  const restartBackend = useCallback(() => {
    setBackendEpoch((n) => n + 1);
  }, []);
  const onLostRef = useRef<() => void>(() => {});
  const handleContextLost = useCallback(() => {
    lostRef.current++;
    const n = lostRef.current;
    setBootError(
      n <= 2
        ? 'GPU context lost — restarting at the lowest quality…'
        : 'The GPU context was lost repeatedly. Retry, or simplify the scene.',
    );
    setBootVisible(true);
    setHasFrame(false);
    hasFrameRef.current = false;
    if (n <= 2) window.setTimeout(restartBackend, 700);
  }, [restartBackend]);
  onLostRef.current = handleContextLost;

  useEffect(() => {
    if (!hasFrame) {
      setBootVisible(true);
      return;
    }
    const t = window.setTimeout(() => setBootVisible(false), 300);
    return () => window.clearTimeout(t);
  }, [hasFrame]);

  useEffect(() => {
    if (!program || hasFrame) return;
    setBootSlow(false);
    const t = window.setTimeout(() => setBootSlow(true), 10000);
    return () => window.clearTimeout(t);
  }, [program, hasFrame, backendEpoch]);

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
    let disposed = false;
    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let fpsStart = last;
    let publishedW = 0;
    let publishedH = 0;
    let idleTimer = 0;
    let refineTimer = 0;
    let idle = true;
    let lastAnimError: string | null = null;

    hasFrameRef.current = false;
    setHasFrame(false);
    setBootVisible(true);
    setBootSlow(false);
    setBootError(null);
    setWebglError(null);
    qualityRef.current = {
      phase: 'probe1',
      scale: BOOT_QUALITY,
      target: settingsRef.current.scale,
      rampCount: 0,
    };
    setEffectiveQuality(BOOT_QUALITY);
    shownQualityRef.current = BOOT_QUALITY;
    autoScaleRef.current = 1;
    submittedRef.current = null;
    glslSeenRef.current = programRef.current?.glsl ?? '';
    animSeqRef.current++;
    animInFlightRef.current = false;

    const isLive = () =>
      playingRef.current && (animatedRef.current || !!programRef.current?.usesTime);

    /** the slider target, capped for the (much heavier) analysis shader */
    const viewTarget = () =>
      Math.min(
        settingsRef.current.scale,
        settingsRef.current.view === 'curvature' ? CURVATURE_MAX_SCALE : 1,
      );

    function ensure() {
      if (disposed || raf || document.hidden) return;
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

    /** ask the compile worker for the next animation sample */
    function requestAnimation() {
      const animateFn = animateRef.current;
      if (animInFlightRef.current || !animateFn) return;
      animInFlightRef.current = true;
      const seq = animSeqRef.current;
      void Promise.resolve(animateFn(clockRef.current))
        .then((res) => {
          animInFlightRef.current = false;
          if (disposed || seq !== animSeqRef.current || !backendRef.current) return;
          if (res.program) {
            lastAnimError = null;
            backendRef.current.setScene(res.program);
            dirtyRef.current = true;
            ensure();
          } else if (res.error && res.error !== lastAnimError) {
            lastAnimError = res.error;
            onErrorRef.current(`animation: ${res.error}`);
          }
        })
        .catch((err: unknown) => {
          animInFlightRef.current = false;
          onErrorRef.current(`animation: ${(err as Error)?.message ?? String(err)}`);
        });
    }

    /** one ack per presented frame, from either backend */
    const onFrame = (info: FrameInfo) => {
      frames++;
      if (info.width !== publishedW || info.height !== publishedH) {
        publishedW = info.width;
        publishedH = info.height;
        setStats((s) => ({ ...s, w: info.width, h: info.height }));
      }

      if (!hasFrameRef.current) {
        hasFrameRef.current = true;
        setHasFrame(true);
        setBootError(null);
        setBootSlow(false);
        onFirstFrameRef.current?.();
        if (lostRef.current > 0) {
          window.setTimeout(() => {
            lostRef.current = 0;
          }, 12000);
        }
      }

      // The first two frames are a probe at the floor quality. The second one
      // is timed (the first may include a lazy shader/driver compile) and
      // picks a starting scale; a short ramp then fine-tunes it against the
      // measured GPU time. Interactive and animated frames have their own
      // feedback loops so a heavy scene stays responsive instead of locking
      // the viewport at an unsustainable quality.
      const q = qualityRef.current;
      const sub = submittedRef.current;
      const now = performance.now();
      const measured =
        typeof info.renderMs === 'number' && info.renderMs > 0
          ? info.renderMs
          : Math.max(1, now - renderStartRef.current);

      const compiled = info.compiled === true;
      if (!sub) {
        // stale ack from a frame submitted before a view reset
      } else if (q.phase === 'probe1') {
        q.phase = 'probe2';
        dirtyRef.current = true;
      } else if (q.phase === 'probe2') {
        if (compiled) {
          // no clean timing yet (driver compile): probe once more
          dirtyRef.current = true;
        } else {
          const cap = viewTarget();
          q.scale = Math.max(
            BOOT_QUALITY,
            Math.min(cap, 0.9 * BOOT_QUALITY * Math.sqrt(IDLE_BUDGET / measured)),
          );
          q.phase = 'ramp';
          q.rampCount = 0;
          // animated scenes start from the same estimate, then tune the multiplier
          autoScaleRef.current = Math.min(1, Math.max(0.4, q.scale / Math.max(cap, 0.01)));
          dirtyRef.current = true;
        }
      } else if (!compiled && q.phase === 'ramp' && sub?.kind === 'idle') {
        const cap = viewTarget();
        q.rampCount++;
        q.scale = Math.min(q.scale, cap);
        if (measured > IDLE_BUDGET * 1.35 && q.scale > BOOT_QUALITY) {
          q.scale = Math.max(BOOT_QUALITY, q.scale * 0.85);
        } else if (measured < IDLE_BUDGET * 0.7 && q.scale < cap) {
          q.scale = Math.min(cap, q.scale * 1.18);
        }
        const within = measured > IDLE_BUDGET * 0.5 && measured < IDLE_BUDGET * 1.2;
        const atFloor = q.scale <= BOOT_QUALITY + 1e-6 && measured > IDLE_BUDGET * 1.35;
        const atTarget = q.scale >= cap - 0.01;
        if (
          within ||
          atFloor ||
          (atTarget && measured <= IDLE_BUDGET * 1.35) ||
          q.rampCount >= MAX_RAMP
        ) {
          q.phase = 'idle';
        } else {
          dirtyRef.current = true;
        }
      } else if (compiled) {
        // shader link time is not a rendering measurement: take one more frame
        dirtyRef.current = true;
      }

      const actualScale = submittedScaleRef.current;
      if (Math.abs(actualScale - shownQualityRef.current) > 0.01) {
        shownQualityRef.current = actualScale;
        setEffectiveQuality(actualScale);
      }

      if (now - fpsStart > 400) {
        const fps = Math.round((frames * 1000) / Math.max(1, now - fpsStart));
        if (isLive()) {
          // animated scenes can also be limited by the worker's scene rebuild,
          // so use the observed frame rate rather than the draw time alone
          const a = autoScaleRef.current;
          if (fps < 30 && a > 0.4) autoScaleRef.current = Math.max(0.4, a * 0.9);
          else if (fps > 52 && a < 1) autoScaleRef.current = Math.min(1, a * 1.05);
        }
        setStats({
          fps,
          w: info.width,
          h: info.height,
          time: clockRef.current,
          // a late ack from a frame whose idle timer already fired must not
          // leave the HUD stuck on "rendering" with no loop running
          live: isLive() || !idle,
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
        onError: (message) => {
          onErrorRef.current(message);
          if (message && !hasFrameRef.current) setBootError(message);
        },
        onContextLost: () => onLostRef.current(),
        onProgramReady: () => {
          // the first curvature frame was measured while the variant was
          // still linking (shaded fallback); probe again with the real program
          if (settingsRef.current.view === 'curvature') {
            const q = qualityRef.current;
            q.phase = 'probe1';
            q.scale = BOOT_QUALITY;
            q.rampCount = 0;
            submittedRef.current = null;
            submittedScaleRef.current = BOOT_QUALITY;
            shownQualityRef.current = BOOT_QUALITY;
            setEffectiveQuality(BOOT_QUALITY);
          }
          wake();
        },
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

    if (programRef.current) backend.setScene(programRef.current);
    if (snapshotRef) {
      snapshotRef.current = () => {
        dirtyRef.current = true;
        ensure();
        return backend?.snapshot() ?? Promise.resolve(null);
      };
    }

    function tick(now: number) {
      if (!backend || disposed) return;
      raf = 0;
      if (pausedRef.current) return;
      const live = isLive();
      const delta = Math.max(0, Math.min(0.25, (now - last) / 1000));
      last = now;
      if (live) clockRef.current += delta;

      const { w, h } = sizeRef.current;
      if (w < 2 || h < 2) return;
      // no scene yet: the boot preview stays up until a program is compiled
      if (!programRef.current) return;

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

      // one sample in flight at a time; the viewport renders the last sample
      if (live && animatedRef.current) requestAnimation();

      const q = qualityRef.current;
      const probing = q.phase === 'probe1' || q.phase === 'probe2';
      const target = viewTarget();
      let kind: 'probe' | 'draft' | 'live' | 'idle';
      let scale: number;
      if (probing) {
        kind = 'probe';
        scale = BOOT_QUALITY;
      } else if (drafting) {
        kind = 'draft';
        const base = live ? target * autoScaleRef.current : Math.min(q.scale, target);
        scale = base * DRAFT_SCALE;
      } else if (live) {
        kind = 'live';
        scale = target * autoScaleRef.current;
      } else {
        kind = 'idle';
        scale = Math.min(q.scale, target);
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pixels = w * h * dpr * dpr * scale * scale;
      if (pixels > PIXEL_BUDGET) scale *= Math.sqrt(PIXEL_BUDGET / pixels);
      scale = Math.max(0.12, scale);

      const base = settingsRef.current;
      const renderSettings: RenderSettings = {
        ...base,
        maxSteps: probing ? PROBE_STEPS : Math.min(qualitySteps(scale), drafting ? 88 : 200),
        shadows: probing || drafting ? false : base.shadows,
        ao: probing || drafting ? false : base.ao,
      };

      // the grid plane is a scene-level constant: use the static bounds
      // so it does not bob while an animated scene moves
      const b = programRef.current?.bounds;
      submittedScaleRef.current = scale;
      submittedRef.current = { kind, scale, steps: renderSettings.maxSteps };
      renderStartRef.current = performance.now();
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
          probe: kind === 'probe' || (kind === 'idle' && q.phase === 'ramp'),
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
      disposed = true;
      animSeqRef.current++;
      animInFlightRef.current = false;
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
  }, [snapshotRef, backendEpoch]);

  /* ---- upload scene ---- */
  useEffect(() => {
    if (!program) return;
    // a new scene invalidates any animation sample that was in flight
    animSeqRef.current++;
    animInFlightRef.current = false;
    // structural changes may have a different cost: let the ramp re-measure
    if (program.glsl !== glslSeenRef.current) {
      glslSeenRef.current = program.glsl;
      const q = qualityRef.current;
      if (q.phase !== 'probe1' && q.phase !== 'probe2') {
        q.phase = 'ramp';
        q.rampCount = 0;
        // a structural edit can change cost by a lot: re-measure from a
        // conservative scale instead of risking a multi-second frame
        q.scale = Math.max(BOOT_QUALITY, Math.min(q.scale, 0.55));
      }
    }
    frameRef.current = program.bounds;
    // While a scene is live, an input edit should not swap in the compile-time
    // pose: the worker has already stored the new inputs, and the next
    // animation sample will upload them at the current clock. This removes the
    // one-frame step back/forward on every parameter change.
    // Only graph-animated scenes get a follow-up animation sample. A scene
    // that animates purely through the shader clock (implicit `time`) must
    // upload the new program immediately, or filtered/cleared scenes never
    // reach the viewport.
    if (playingRef.current && animatedRef.current && hasFrameRef.current) {
      wakeRef.current();
      return;
    }
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
  const settingsSeen = useRef(false);
  const scaleSeen = useRef(settings.scale);
  const fxSeen = useRef({ shadows: settings.shadows, ao: settings.ao, view: settings.view });
  useEffect(() => {
    if (!settingsSeen.current) {
      settingsSeen.current = true;
      scaleSeen.current = settings.scale;
      return;
    }
    if (settings.scale !== scaleSeen.current) {
      // a manual quality change pins the scale (the boot ramp is done)
      scaleSeen.current = settings.scale;
      const q = qualityRef.current;
      q.phase = 'idle';
      q.scale = settings.scale;
      q.target = settings.scale;
      q.rampCount = 0;
      autoScaleRef.current = 1;
      submittedScaleRef.current = settings.scale;
      shownQualityRef.current = settings.scale;
      setEffectiveQuality(settings.scale);
    }
    const fx = fxSeen.current;
    if (fx.view !== settings.view) {
      const prevView = fx.view;
      fx.view = settings.view;
      fx.shadows = settings.shadows;
      fx.ao = settings.ao;
      const q = qualityRef.current;
      if (settings.view === 'curvature') {
        // the curvature pass takes seven extra map() calls per hit pixel:
        // restart from the floor so the first analysis draw cannot stall the GPU
        q.phase = 'probe1';
        q.scale = BOOT_QUALITY;
        q.rampCount = 0;
      } else if (prevView === 'curvature' || q.phase === 'idle') {
        // normals/gradient/zebra cost about the same as shaded: keep the
        // current scale, just re-measure it for the new program
        q.phase = 'ramp';
        q.rampCount = 0;
      }
      // the in-flight frame belongs to the previous view; do not feed its
      // timing into the new program's ramp
      submittedRef.current = null;
      submittedScaleRef.current = q.scale;
      shownQualityRef.current = q.scale;
      setEffectiveQuality(q.scale);
    } else if (fx.shadows !== settings.shadows || fx.ao !== settings.ao) {
      fx.shadows = settings.shadows;
      fx.ao = settings.ao;
      const q = qualityRef.current;
      if (q.phase === 'idle') {
        q.phase = 'ramp';
        q.rampCount = 0;
      }
    }
    wakeRef.current();
  }, [settings, playing, animated]);

  useEffect(() => {
    if (!paused) wakeRef.current();
  }, [paused]);

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

  const view: ViewMode = settings.view ?? 'shaded';

  return (
    <div className={`viewport ${view !== 'shaded' ? 'analysis-on' : ''}`} ref={hostRef} data-view={view}>
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
        <div
          className="chip dim qualitychip"
          title="current render scale — the slider below is the target; the viewport auto-caps it to keep frames responsive"
        >
          q {Math.round(effectiveQuality * 100)}%
          {Math.abs(effectiveQuality - settings.scale) > 0.01 ? ' auto' : ''}
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
        <div className="chip dim modechip">sdf · {stats.renderer}</div>
      </div>

      <div className="hud hud-tr">
        <select
          className="hud-select"
          value={view}
          onChange={(e) => onSettings({ ...settings, view: e.target.value as ViewMode })}
          title="Surface analysis"
          aria-label="Surface analysis mode"
        >
          <option value="shaded">shaded</option>
          <option value="normals">normals</option>
          <option value="curvature">curvature</option>
          <option value="gradient">gradient</option>
          <option value="zebra">zebra</option>
        </select>
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
          className={`iconbtn ${settings.grid && view === 'shaded' ? 'on' : ''}`}
          title={view === 'shaded' ? 'Ground grid' : 'Ground grid is hidden in analysis views'}
          disabled={view !== 'shaded'}
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
        <label className="hud-quality" title="Render quality target — the actual scale is auto-capped when frames would exceed the time budget">
          <span>quality</span>
          <input
            type="range"
            min={30}
            max={100}
            step={5}
            value={Math.round(settings.scale * 100)}
            onChange={(e) => {
              const scale = Number(e.target.value) / 100;
              onSettings({ ...settings, scale, maxSteps: qualitySteps(scale) });
            }}
            aria-label="Render quality target"
          />
          <span className="hud-quality-val">{Math.round(settings.scale * 100)}%</span>
        </label>
      </div>

      <div className="hud hud-bl">
        <span>drag</span> orbit · <span>shift+drag</span> pan · <span>wheel</span> zoom
      </div>

      {view !== 'shaded' && (
        <div className="hud hud-br analysis-panel">
          <div className="analysis-head">
            <span className="analysis-title">
              {view === 'normals'
                ? 'surface normals'
                : view === 'curvature'
                  ? 'mean curvature'
                  : view === 'gradient'
                    ? 'gradient |∇d|'
                    : 'zebra stripes'}
            </span>
            {view === 'curvature' && (
              <span className="analysis-value">±{settings.curvatureScale.toFixed(1)}</span>
            )}
          </div>

          {(view === 'curvature' || view === 'gradient') && (
            <>
              <div className={`analysis-bar ${view}`} />
              <div className="analysis-labels">
                {view === 'curvature' ? (
                  <>
                    <span>concave</span>
                    <span>flat</span>
                    <span>convex</span>
                  </>
                ) : (
                  <>
                    <span>0.5</span>
                    <span>1.0</span>
                    <span>1.5</span>
                  </>
                )}
              </div>
            </>
          )}

          {view === 'curvature' && (
            <label className="analysis-slider" title="Mean curvature mapped to full colour">
              <span>κ</span>
              <input
                type="range"
                min={0.5}
                max={20}
                step={0.1}
                value={settings.curvatureScale}
                onChange={(e) =>
                  onSettings({ ...settings, curvatureScale: Number.parseFloat(e.target.value) })
                }
              />
            </label>
          )}

          {view === 'curvature' && hasSplines && (
            <div className="analysis-note">combs: splines dock → comb</div>
          )}

          {view === 'normals' && (
            <div className="analysis-note">
              <span className="axis-x">R +x</span>
              <span className="axis-y">G +y</span>
              <span className="axis-z">B +z</span>
            </div>
          )}

          {view === 'zebra' && (
            <div className="analysis-note">
              reflected stripes — smooth surfaces keep the bands continuous
            </div>
          )}
        </div>
      )}

      {emptyLabel && hasFrame && <div className="viewport-error">{emptyLabel}</div>}

      {bootVisible && (
        <div className={`viewport-boot ${hasFrame ? 'leaving' : ''}`} aria-live="polite">
          {preview ? (
            <img className="boot-preview" src={preview} alt="" draggable={false} />
          ) : (
            <div className="boot-blank">
              <Icon name="logo" size={44} />
            </div>
          )}
          <div className="boot-shade" />
          <div className="boot-status">
            {bootError || webglError || bootFailed ? (
              <span className="boot-warn" aria-hidden="true">
                !
              </span>
            ) : (
              <span className="spinner" aria-hidden="true" />
            )}
            <div className="boot-copy">
              <strong>{bootError ?? webglError ?? bootLabel}</strong>
              <span>
                {bootError || webglError
                  ? 'the stored preview stays visible while the renderer recovers'
                  : bootFailed
                    ? 'fix the error in the editor; the last valid scene is kept'
                    : bootSlow
                      ? 'still working — the GPU is taking longer than usual'
                      : 'first frame runs at low quality; it sharpens as timing is measured'}
              </span>
            </div>
            {(bootError || webglError || bootSlow) && !bootFailed && (
              <button
                className="ghostbtn boot-retry"
                onClick={() => {
                  lostRef.current = 0;
                  restartBackend();
                }}
              >
                retry
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** the parent re-renders on every keystroke/slider tick; the HUD does not need to */
export const Viewport = memo(ViewportImpl);
