import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { SplineInfo } from '../core/types';
import { curvatureCombs, sampleProfile, sampleSpline } from '../core/spline';
import { CombSettings } from './CombSettings';
import { Icon } from './Icon';

export type SplinePlane = 'XY' | 'XZ' | 'YZ';

export interface SplineEditorProps {
  splines: SplineInfo[];
  selected: string | null;
  onSelect: (id: string) => void;
  onChange: (id: string, points: number[][]) => void;
  onReset: (id: string) => void;
  /** curvature comb overlay (controlled so the big workspace can share it) */
  comb: boolean;
  onComb: (value: boolean) => void;
  combDensity: number;
  combScale: number;
  onCombDensity: (value: number) => void;
  onCombScale: (value: number) => void;
  /** plane used by the 2D projection of 3D splines */
  plane: SplinePlane;
  onPlane: (plane: SplinePlane) => void;
  /** hide the dock header when embedded in the workspace */
  hideHeader?: boolean;
}

const AXIS_LABEL = ['x', 'y', 'z'];

const axesFor = (s: SplineInfo, plane: SplinePlane): [number, number] =>
  s.dim === 2 ? [0, 1] : plane === 'XY' ? [0, 1] : plane === 'XZ' ? [0, 2] : [1, 2];

interface View {
  cx: number;
  cy: number;
  scale: number;
}

const PAD = 26;

function fitView(s: SplineInfo, axes: [number, number], w: number, h: number): View {
  let min0 = Infinity, max0 = -Infinity, min1 = Infinity, max1 = -Infinity;
  for (const p of s.points) {
    min0 = Math.min(min0, p[axes[0]]);
    max0 = Math.max(max0, p[axes[0]]);
    min1 = Math.min(min1, p[axes[1]]);
    max1 = Math.max(max1, p[axes[1]]);
  }
  if (!Number.isFinite(min0)) {
    min0 = -1; max0 = 1; min1 = -1; max1 = 1;
  }
  const bw = Math.max(0.2, max0 - min0);
  const bh = Math.max(0.2, max1 - min1);
  const iw = Math.max(60, w - PAD * 2);
  const ih = Math.max(40, h - PAD * 2);
  const scale = Math.max(4, Math.min(iw / bw, ih / bh));
  return { cx: (min0 + max0) / 2, cy: (min1 + max1) / 2, scale };
}

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, raw))));
  const n = raw / p;
  const m = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return m * p;
}

const AXIS_COLORS = ['#d98a7a', '#8fc79a', '#7fa6d9'];

export function SplineEditor({
  splines,
  selected,
  onSelect,
  onChange,
  onReset,
  comb,
  onComb,
  combDensity,
  combScale,
  onCombDensity,
  onCombScale,
  plane,
  onPlane,
  hideHeader = false,
}: SplineEditorProps) {
  const [active, setActive] = useState(0);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [fitNonce, setFitNonce] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<number | null>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const viewRef = useRef<View>({ cx: 0, cy: 0, scale: 60 });

  const spline = splines.find((s) => s.id === selected) ?? splines[0] ?? null;
  const axes = spline ? axesFor(spline, plane) : ([0, 1] as [number, number]);
  const fitKey = spline
    ? `${spline.id}|${axes.join()}|${spline.points.length}|${Math.round(size.w)}x${Math.round(size.h)}|${fitNonce}`
    : '';

  // refit when the curve/size/plane changes; pan & zoom persist otherwise
  useEffect(() => {
    if (!spline) return;
    setView(fitView(spline, axes, size.w || 320, size.h || 140));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  const actualView =
    view ??
    (spline ? fitView(spline, axes, size.w || 320, size.h || 140) : { cx: 0, cy: 0, scale: 60 });
  viewRef.current = actualView;

  const sampled = useMemo(() => {
    if (!spline) return [];
    return spline.kind === 'spline'
      ? sampleSpline(spline.points, spline.closed, 12)
      : sampleProfile(spline.points, spline.closed, 12);
  }, [spline]);

  // the comb uses its own sampling so the density slider can exceed the
  // drawing resolution of the curve
  const combSampled = useMemo(() => {
    if (!comb || !spline) return [];
    const spans = spline.closed
      ? Math.max(1, spline.points.length)
      : Math.max(1, spline.points.length - 1);
    const per = Math.max(2, Math.min(64, Math.ceil(combDensity / spans)));
    return spline.kind === 'spline'
      ? sampleSpline(spline.points, spline.closed, per)
      : sampleProfile(spline.points, spline.closed, per);
  }, [comb, spline, combDensity]);

  const combData = useMemo(() => {
    if (!comb || !spline || combSampled.length < 5) return null;
    const planar = combSampled.map((p) => [p[axes[0]], p[axes[1]]]);
    return curvatureCombs(planar, spline.closed, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comb, spline, combSampled, axes[0], axes[1]]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const v = viewRef.current;
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      const scale = Math.min(8000, Math.max(4, v.scale * factor));
      const wx = (px - size.w / 2) / v.scale + v.cx;
      const wy = (size.h / 2 - py) / v.scale + v.cy;
      const next = {
        scale,
        cx: wx - (px - size.w / 2) / scale,
        cy: wy - (size.h / 2 - py) / scale,
      };
      viewRef.current = next;
      setView(next);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [size.w, size.h]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      setSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    });
    ro.observe(wrap);
    const r = wrap.getBoundingClientRect();
    setSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    return () => ro.disconnect();
  }, []);

  /* ---- draw ---- */
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !spline || size.w < 4 || size.h < 4) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { w, h } = size;

    const sx = (x: number) => (x - actualView.cx) * actualView.scale + w / 2;
    const sy = (y: number) => h / 2 - (y - actualView.cy) * actualView.scale;

    ctx.clearRect(0, 0, w, h);

    // grid
    const step = niceStep(30 / actualView.scale);
    const x0 = actualView.cx - w / 2 / actualView.scale;
    const x1 = actualView.cx + w / 2 / actualView.scale;
    const y0 = actualView.cy - h / 2 / actualView.scale;
    const y1 = actualView.cy + h / 2 / actualView.scale;

    ctx.lineWidth = 1;
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
      ctx.strokeStyle = Math.abs(x) < step * 0.01 ? '#2c3944' : '#161d24';
      ctx.beginPath();
      ctx.moveTo(Math.round(sx(x)) + 0.5, 0);
      ctx.lineTo(Math.round(sx(x)) + 0.5, h);
      ctx.stroke();
    }
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
      ctx.strokeStyle = Math.abs(y) < step * 0.01 ? '#2c3944' : '#161d24';
      ctx.beginPath();
      ctx.moveTo(0, Math.round(sy(y)) + 0.5);
      ctx.lineTo(w, Math.round(sy(y)) + 0.5);
      ctx.stroke();
    }

    // scale hint
    ctx.fillStyle = '#4d5a66';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(`${step}`, 8, h - 8);

    // sampled curve
    ctx.strokeStyle = '#67b3a8';
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    sampled.forEach((p, i) => {
      const px = sx(p[axes[0]]);
      const py = sy(p[axes[1]]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();

    // control polygon
    ctx.strokeStyle = '#394856';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    spline.points.forEach((p, i) => {
      const px = sx(p[axes[0]]);
      const py = sy(p[axes[1]]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    if (spline.closed && spline.points.length > 2) {
      ctx.lineTo(sx(spline.points[0][axes[0]]), sy(spline.points[0][axes[1]]));
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // curvature comb
    if (combData && combData.spikes.length > 1) {
      const maxK = combData.maxK || 1;
      const tips: Array<[number, number]> = [];
      ctx.lineWidth = 1;
      for (const spike of combData.spikes) {
        const bx = sx(spike.point[0]);
        const by = sy(spike.point[1]);
        const len = Math.min(220, Math.max(2, (spike.k / maxK) * 42 * combScale));
        const tx = bx + spike.dir[0] * len;
        const ty = by - spike.dir[1] * len;
        tips.push([tx, ty]);
        ctx.strokeStyle = 'rgba(224, 162, 103, 0.5)';
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(tx, ty, 1.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(240, 184, 120, 0.8)';
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(224, 162, 103, 0.25)';
      ctx.beginPath();
      tips.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      if (spline.closed) ctx.closePath();
      ctx.stroke();
    }

    // points
    spline.points.forEach((p, i) => {
      const px = sx(p[axes[0]]);
      const py = sy(p[axes[1]]);
      const isActive = i === Math.min(active, spline.points.length - 1);
      ctx.beginPath();
      ctx.arc(px, py, isActive ? 5 : 3.8, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? '#f0b878' : '#e0a267';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#0b0e12';
      ctx.stroke();
    });

    // hover crosshair
    if (hover && !dragRef.current) {
      const px = sx(hover.x);
      const py = sy(hover.y);
      ctx.strokeStyle = '#ffffff18';
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.moveTo(0, py);
      ctx.lineTo(w, py);
      ctx.stroke();
    }
  }, [spline, actualView, size, axes, active, hover, sampled, combData, combScale]);

  const toWorld = (e: ReactPointerEvent | ReactMouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const v = viewRef.current;
    return {
      px,
      py,
      x: (px - size.w / 2) / v.scale + v.cx,
      y: (size.h / 2 - py) / v.scale + v.cy,
    };
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!spline) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    const v = viewRef.current;

    // middle/right button pans, even when starting on a control point
    if (e.button !== 0) {
      panRef.current = { x: e.clientX, y: e.clientY };
      canvas.classList.add('panning');
      e.preventDefault();
      return;
    }

    const { px, py } = toWorld(e);
    let best = -1;
    let bestD = 16;
    spline.points.forEach((p, i) => {
      const dx = (p[axes[0]] - v.cx) * v.scale + size.w / 2 - px;
      const dy = size.h / 2 - (p[axes[1]] - v.cy) * v.scale - py;
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) {
      setActive(best);
      dragRef.current = best;
      e.preventDefault();
      return;
    }

    // empty space: pan
    panRef.current = { x: e.clientX, y: e.clientY };
    canvas.classList.add('panning');
    e.preventDefault();
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (panRef.current) {
      const dx = e.clientX - panRef.current.x;
      const dy = e.clientY - panRef.current.y;
      panRef.current = { x: e.clientX, y: e.clientY };
      const v = viewRef.current;
      const next = { ...v, cx: v.cx - dx / v.scale, cy: v.cy + dy / v.scale };
      viewRef.current = next;
      setView(next);
      return;
    }
    if (!spline) return;
    const w = toWorld(e);
    setHover({ x: w.x, y: w.y });
    const idx = dragRef.current;
    if (idx === null || idx >= spline.points.length) return;
    const pts = spline.points.map((p, i) => {
      if (i !== idx) return [...p];
      const next = [...p];
      next[axes[0]] = w.x;
      next[axes[1]] = w.y;
      return next;
    });
    onChange(spline.id, pts);
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    dragRef.current = null;
    panRef.current = null;
    canvasRef.current?.classList.remove('panning');
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };

  const addPoint = () => {
    if (!spline) return;
    const last = spline.points[spline.points.length - 1] ?? [0, 0, 0];
    const next = [...last];
    next[axes[0]] += 0.35;
    next[axes[1]] += 0.15;
    const pts = [...spline.points.map((p) => [...p]), next];
    onChange(spline.id, pts);
    setActive(pts.length - 1);
  };

  const removePoint = () => {
    if (!spline) return;
    const min = spline.kind === 'spline' ? 2 : 3;
    if (spline.points.length <= min) return;
    const idx = Math.min(active, spline.points.length - 1);
    const pts = spline.points.filter((_, i) => i !== idx).map((p) => [...p]);
    onChange(spline.id, pts);
    setActive(Math.max(0, idx - 1));
  };

  const is3d = spline?.dim === 3;
  const axisLabels = spline?.kind === 'lathe' ? ['r', 'y', 'z'] : AXIS_LABEL;

  return (
    <section className="dock-panel splines">
      {!hideHeader && (
      <header className="dock-head">
        <span className="dock-title">splines</span>
        <span className="dock-count">{splines.length}</span>
        <div className="spline-head-actions">
          {is3d && (
            <div className="segmented tiny" role="tablist" aria-label="edit plane">
              {(['XY', 'XZ', 'YZ'] as SplinePlane[]).map((p) => (
                <button key={p} className={plane === p ? 'active' : ''} onClick={() => onPlane(p)}>
                  {p}
                </button>
              ))}
            </div>
          )}
          <button
            className={`ghostbtn combbtn ${comb ? 'on' : ''}`}
            onClick={() => onComb(!comb)}
            disabled={!spline}
            aria-pressed={comb}
            title={
              spline
                ? 'Curvature comb — spikes of length κ = 1/R along the selected curve'
                : 'Add a spline or profile to use curvature combs'
            }
          >
            <Icon name="comb" size={13} /> <span className="comb-label">comb</span>
          </button>
        </div>
      </header>
      )}

      {!hideHeader && comb && (
        <div className="comb-row">
          <CombSettings
            density={combDensity}
            scale={combScale}
            onDensity={onCombDensity}
            onScale={onCombScale}
          />
        </div>
      )}

      {!spline ? (
        <p className="dock-empty">
          No splines yet. Add <code>spline({'{ points, r }'})</code> or a lathe/extrude profile.
        </p>
      ) : (
        <>
          {!hideHeader && (
          <div className="spline-tabs">
            {splines.map((s) => (
              <button
                key={s.id}
                className={`spline-tab ${s.id === spline.id ? 'active' : ''}`}
                onClick={() => onSelect(s.id)}
                title={`${s.kind} · ${s.points.length} points`}
              >
                {s.name}
                <span className="kind">{s.kind}</span>
              </button>
            ))}
          </div>
          )}

          <div className="spline-canvas-wrap" ref={wrapRef}>
            <canvas
              data-spline={JSON.stringify({ view: actualView, axes, points: spline.points })}
              ref={canvasRef}
              title="Drag a point to edit · drag empty space to pan · wheel to zoom"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={() => setHover(null)}
              onContextMenu={(e) => e.preventDefault()}
              onDoubleClick={(e) => {
                const w = toWorld(e);
                const last = spline.points[spline.points.length - 1] ?? [0, 0, 0];
                const next = [...last];
                next[axes[0]] = w.x;
                next[axes[1]] = w.y;
                onChange(spline.id, [...spline.points.map((p) => [...p]), next]);
              }}
            />
            <button
              className="canvas-fit"
              title="Fit the curve (pan and zoom are reset)"
              onClick={() => setFitNonce((n) => n + 1)}
            >
              <Icon name="frame" size={12} />
            </button>
            {hover && (
              <div className="spline-readout">
                {axisLabels[axes[0]]} {hover.x.toFixed(2)} · {axisLabels[axes[1]]} {hover.y.toFixed(2)}
              </div>
            )}
          </div>

          <div className="spline-tools">
            <button className="ghostbtn" onClick={addPoint} title="Append a control point">
              <Icon name="plus" size={12} /> point
            </button>
            <button
              className="ghostbtn"
              onClick={removePoint}
              title="Delete the selected point"
              disabled={spline.points.length <= (spline.kind === 'spline' ? 2 : 3)}
            >
              <Icon name="minus" size={12} /> point
            </button>
            <span className="grow" />
            <span className="spline-meta">
              {spline.points.length} pts · {spline.closed ? 'closed' : 'open'}
              {combData ? ` · κmax ${combData.maxK.toFixed(2)}` : ''}
            </span>
            <button
              className="ghostbtn"
              onClick={() => {
                onReset(spline.id);
                setFitNonce((n) => n + 1);
              }}
              title="Restore the points defined in code"
            >
              <Icon name="reset" size={12} /> reset
            </button>
          </div>
        </>
      )}
    </section>
  );
}
