import { useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { SplineInfo } from '../core/types';
import { sampleProfile, sampleSpline } from '../core/spline';
import { Icon } from './Icon';

export interface SplineEditorProps {
  splines: SplineInfo[];
  selected: string | null;
  onSelect: (id: string) => void;
  onChange: (id: string, points: number[][]) => void;
  onReset: (id: string) => void;
}

type Plane = 'XY' | 'XZ' | 'YZ';

const AXIS_LABEL = ['x', 'y', 'z'];

const axesFor = (s: SplineInfo, plane: Plane): [number, number] =>
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

export function SplineEditor({ splines, selected, onSelect, onChange, onReset }: SplineEditorProps) {
  const [plane, setPlane] = useState<Plane>('XY');
  const [active, setActive] = useState(0);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [fitNonce, setFitNonce] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<number | null>(null);
  const viewRef = useRef<{ key: string; view: View } | null>(null);

  const spline = splines.find((s) => s.id === selected) ?? splines[0] ?? null;
  const axes = spline ? axesFor(spline, plane) : ([0, 1] as [number, number]);
  const key = spline
    ? `${spline.id}|${axes.join()}|${spline.points.length}|${Math.round(size.w)}x${Math.round(size.h)}|${fitNonce}`
    : '';

  if (spline && (!viewRef.current || viewRef.current.key !== key)) {
    viewRef.current = { key, view: fitView(spline, axes, size.w || 320, size.h || 140) };
  }
  const view = viewRef.current?.view ?? { cx: 0, cy: 0, scale: 60 };

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

    const sx = (x: number) => (x - view.cx) * view.scale + w / 2;
    const sy = (y: number) => h / 2 - (y - view.cy) * view.scale;

    ctx.clearRect(0, 0, w, h);

    // grid
    const step = niceStep(30 / view.scale);
    const x0 = view.cx - w / 2 / view.scale;
    const x1 = view.cx + w / 2 / view.scale;
    const y0 = view.cy - h / 2 / view.scale;
    const y1 = view.cy + h / 2 / view.scale;

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
    const sampled =
      spline.kind === 'spline'
        ? sampleSpline(spline.points, spline.closed, 12)
        : sampleProfile(spline.points, spline.closed, 12);
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
  }, [spline, view, size, axes, active, hover]);

  const toWorld = (e: ReactPointerEvent | ReactMouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    return {
      px,
      py,
      x: (px - size.w / 2) / view.scale + view.cx,
      y: (size.h / 2 - py) / view.scale + view.cy,
    };
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!spline) return;
    const { px, py } = toWorld(e);
    let best = -1;
    let bestD = 16;
    spline.points.forEach((p, i) => {
      const dx = (p[axes[0]] - view.cx) * view.scale + size.w / 2 - px;
      const dy = size.h / 2 - (p[axes[1]] - view.cy) * view.scale - py;
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) {
      setActive(best);
      dragRef.current = best;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  };

  const onPointerMove = (e: ReactPointerEvent) => {
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
      <header className="dock-head">
        <span className="dock-title">splines</span>
        <span className="dock-count">{splines.length}</span>
        {is3d && (
          <div className="segmented tiny" role="tablist" aria-label="edit plane">
            {(['XY', 'XZ', 'YZ'] as Plane[]).map((p) => (
              <button key={p} className={plane === p ? 'active' : ''} onClick={() => setPlane(p)}>
                {p}
              </button>
            ))}
          </div>
        )}
      </header>

      {!spline ? (
        <p className="dock-empty">
          No splines yet. Add <code>spline({'{ points, r }'})</code> or a lathe/extrude profile.
        </p>
      ) : (
        <>
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

          <div className="spline-canvas-wrap" ref={wrapRef}>
            <canvas
              data-spline={JSON.stringify({ view, axes, points: spline.points })}
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={() => setHover(null)}
              onDoubleClick={(e) => {
                const w = toWorld(e);
                const last = spline.points[spline.points.length - 1] ?? [0, 0, 0];
                const next = [...last];
                next[axes[0]] = w.x;
                next[axes[1]] = w.y;
                onChange(spline.id, [...spline.points.map((p) => [...p]), next]);
              }}
            />
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
