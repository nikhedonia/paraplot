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
