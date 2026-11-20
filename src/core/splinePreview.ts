import type { SplineInfo, Vec2, Vec3 } from './types';
import { generate, type CompiledProgram } from './codegen';
import { sampleProfile, sampleSpline } from './spline';
import {
  capsule,
  extrude,
  lathe,
  paint,
  sphere,
  spline,
  translate,
  union,
} from './dsl';

const SHAPE_COLOR = '#aebbc7';
const HANDLE_COLOR = '#e0a267';
const CAGE_COLOR = '#5f6c78';

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vlen = (a: V3) => Math.hypot(a[0], a[1], a[2]);

/** discrete curvature comb spikes: outward direction + 1/radius */
function combSpikes(points: V3[], closed: boolean, step: number) {
  const n = points.length;
  const out: Array<{ point: V3; dir: V3; k: number }> = [];
  if (n < 3) return out;
  const at = (i: number): V3 =>
    points[closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))];

  for (let i = 0; i < n; i += Math.max(1, step)) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const a = at(i - 1);
    const b = at(i);
    const c = at(i + 1);
    const ab = sub(b, a);
    const ac = sub(c, a);
    const abLen = vlen(ab);
    if (abLen < 1e-9) continue;
    const u = mul(ab, 1 / abLen);
    const acu = dot(ac, u);
    const vRaw = sub(ac, mul(u, acu));
    const cy = vlen(vRaw);
    if (cy < 1e-9) continue; // collinear
    const v = mul(vRaw, 1 / cy);

    // circumcentre in the triangle plane, coordinates (a = origin, u, v)
    const bx = abLen;
    const cx = acu;
    const centerX = bx / 2;
    const centerY = (cx * cx + cy * cy - bx * cx) / (2 * cy);
    const center = add(a, add(mul(u, centerX), mul(v, centerY)));

    const d = sub(b, center);
    const radius = vlen(d);
    if (!Number.isFinite(radius) || radius < 1e-8) continue;
    out.push({ point: b, dir: mul(d, 1 / radius), k: 1 / radius });
  }
  return out;
}

const to3 = (s: SplineInfo): Vec3[] =>
  s.kind === 'spline'
    ? s.points.map((p) => [p[0], p[1], p[2]] as Vec3)
    : s.points.map((p) => [p[0], p[1], 0] as Vec3);

/**
 * A small self-contained scene for the 3D spline preview: the swept shape plus
 * the control cage and handles, rendered by the same SDF raymarcher.
 */
export interface SplinePreviewOptions {
  density?: number;
  scale?: number;
}

export function buildSplinePreview(
  info: SplineInfo,
  comb = false,
  options: SplinePreviewOptions = {},
): CompiledProgram {
  const density = Math.max(8, Math.min(120, Math.round(options.density ?? 40)));
  const combScale = Math.max(0.1, options.scale ?? 1);
  const pts = info.points.map((p) => [...p]);
  const base =
    info.kind === 'spline'
      ? spline({
          points: pts as Vec3[],
          r: info.r ?? 0.05,
          closed: info.closed,
          seg: info.seg ?? 12,
        })
      : info.kind === 'lathe'
        ? lathe({ points: pts as Vec2[], closed: info.closed, seg: info.seg ?? 12 })
        : extrude({
            points: pts as Vec2[],
            h: info.h ?? 1,
            round: info.round ?? 0,
            closed: info.closed,
            seg: info.seg ?? 12,
          });

  const pts3 = to3(info);
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts3) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p[i]);
      max[i] = Math.max(max[i], p[i]);
    }
  }
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const handleR = Math.min(0.05, Math.max(0.005, diag * 0.012));

  const handles = pts3.map((p) => translate(p as Vec3, sphere({ r: handleR })));

  const cage = [];
  const n = pts3.length;
  const spans = info.closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    cage.push(
      capsule({
        a: pts3[i],
        b: pts3[(i + 1) % n],
        r: Math.max(0.002, handleR * 0.28),
      }),
    );
  }

  const parts = [paint(base, SHAPE_COLOR)];
  if (handles.length) parts.push(paint(union(handles), HANDLE_COLOR));
  if (cage.length) parts.push(paint(union(cage), CAGE_COLOR));

  if (comb) {
    const spans = info.closed
      ? Math.max(1, info.points.length)
      : Math.max(1, info.points.length - 1);
    const per = Math.max(2, Math.min(64, Math.ceil(density / spans)));
    const samples =
      info.kind === 'spline'
        ? sampleSpline(info.points, info.closed, per)
        : sampleProfile(info.points, info.closed, per);
    const sampled3: V3[] =
      info.kind === 'spline'
        ? samples.map((p) => [p[0], p[1], p[2]])
        : samples.map((p) => [p[0], p[1], 0]);
    const spikes = combSpikes(sampled3, info.closed, 1);
    if (spikes.length > 1) {
      const kMax = Math.max(...spikes.map((s) => s.k), 1e-9);
      const spikeRadius = Math.max(0.0015, diag * 0.0018);
      const tips: V3[] = [];
      const spikeNodes = spikes.map((s) => {
        const length = Math.max(diag * 0.012, (s.k / kMax) * diag * 0.18 * combScale);
        const tip = add(s.point, mul(s.dir, length));
        tips.push(tip);
        return capsule({ a: s.point, b: tip, r: spikeRadius });
      });
      parts.push(paint(union(spikeNodes), HANDLE_COLOR));

      const envelope = [];
      for (let i = 0; i < tips.length - 1; i++) {
        envelope.push(capsule({ a: tips[i], b: tips[i + 1], r: spikeRadius * 0.5 }));
      }
      if (info.closed && tips.length > 2) {
        envelope.push(capsule({ a: tips[tips.length - 1], b: tips[0], r: spikeRadius * 0.5 }));
      }
      if (envelope.length) parts.push(paint(union(envelope), '#7d5c40'));
    }
  }

  return generate(union(parts));
}
