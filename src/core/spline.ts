import { clamp } from './math';

type P = number[];

const dist = (a: P, b: P) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
};

const mixp = (a: P, b: P, t: number): P => a.map((v, i) => v + (b[i] - v) * t);

/**
 * Centripetal Catmull-Rom through the control points.
 * Returns `perSegment` samples per span; closed curves append the first point.
 */
export function sampleSpline(points: P[], closed: boolean, perSegment: number): P[] {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) return [[...points[0]]];

  const per = Math.max(1, Math.min(64, Math.floor(perSegment)));
  const at = (i: number): P => points[closed ? ((i % n) + n) % n : clamp(i, 0, n - 1)];

  const out: P[] = [];
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);

    // centripetal knot sequence, guarded against coincident points
    const t0 = 0;
    const t1 = t0 + Math.max(1e-4, Math.sqrt(dist(p0, p1)));
    const t2 = t1 + Math.max(1e-4, Math.sqrt(dist(p1, p2)));
    const t3 = t2 + Math.max(1e-4, Math.sqrt(dist(p2, p3)));

    for (let s = 0; s < per; s++) {
      const t = t1 + (s / per) * (t2 - t1);
      const a1 = mixp(p0, p1, (t - t0) / (t1 - t0));
      const a2 = mixp(p1, p2, (t - t1) / (t2 - t1));
      const a3 = mixp(p2, p3, (t - t2) / (t3 - t2));
      const b1 = mixp(a1, a2, (t - t0) / (t2 - t0));
      const b2 = mixp(a2, a3, (t - t1) / (t3 - t1));
      out.push(mixp(b1, b2, (t - t1) / (t2 - t1)));
    }
  }
  out.push(closed ? [...points[0]] : [...points[n - 1]]);
  return out;
}

/** Sample a planar profile; closed profiles do not repeat the first point. */
export function sampleProfile(points: P[], closed: boolean, perSegment: number): P[] {
  const out = sampleSpline(points, closed, perSegment);
  if (closed && out.length > 1) out.pop();
  return out;
}

export interface CurvatureSpike {
  /** point on the curve (2d) */
  point: [number, number];
  /** outward unit direction (away from the centre of curvature) */
  dir: [number, number];
  /** signed curvature magnitude, 1 / radius */
  k: number;
}

/**
 * Discrete curvature combs for a planar polyline. Spikes point away from the
 * local centre of curvature; nearly straight spans produce no spike.
 */
export function curvatureCombs(
  points: number[][],
  closed: boolean,
  step = 1,
): { spikes: CurvatureSpike[]; maxK: number } {
  const n = points.length;
  if (n < 3) return { spikes: [], maxK: 0 };
  const at = (i: number): number[] =>
    points[closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))];

  const spikes: CurvatureSpike[] = [];
  const stride = Math.max(1, Math.floor(step));
  for (let i = 0; i < n; i += stride) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const a = at(i - 1);
    const b = at(i);
    const c = at(i + 1);
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-12) continue;
    const a2 = a[0] * a[0] + a[1] * a[1];
    const b2 = b[0] * b[0] + b[1] * b[1];
    const c2 = c[0] * c[0] + c[1] * c[1];
    const cx = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
    const cy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
    const dx = b[0] - cx;
    const dy = b[1] - cy;
    const r = Math.hypot(dx, dy);
    if (!Number.isFinite(r) || r < 1e-9) continue;
    spikes.push({ point: [b[0], b[1]], dir: [dx / r, dy / r], k: 1 / r });
  }
  const maxK = spikes.reduce((m, s) => Math.max(m, s.k), 0);
  return { spikes, maxK };
}
