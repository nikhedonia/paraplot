import type { Node, SurfaceNode, Vec3 } from './types';
import { sampleProfile, sampleSpline } from './spline';

/** The default connect: a straight rul(ing) between a(t) and b(t). */
export const linearConnect = (a: Vec3, b: Vec3, s: number): Vec3 => [
  a[0] + (b[0] - a[0]) * s,
  a[1] + (b[1] - a[1]) * s,
  a[2] + (b[2] - a[2]) * s,
];

const isCurve = (n: Node): boolean =>
  n.kind === 'spline' || n.kind === 'extrude' || n.kind === 'lathe';

/** A construction curve as a 3d polyline (2d profiles are lifted to z = 0). */
export function constructionCurve(node: Node): Vec3[] {
  if (!isCurve(node)) {
    throw new Error('surface(): construction curves must be spline, extrude or lathe nodes');
  }
  if (node.kind === 'spline') {
    return sampleSpline(node.points, node.closed, 32).map((p) => [p[0], p[1], p[2]]);
  }
  if (node.kind === 'extrude' || node.kind === 'lathe') {
    return sampleProfile(node.points, node.closed, 32).map((p) => [p[0], p[1], 0]);
  }
  throw new Error('surface(): unsupported construction curve');
}

export function pointAtPolyline(points: Vec3[], t: number): Vec3 {
  if (points.length === 0) return [0, 0, 0];
  const u = Math.min(1, Math.max(0, t)) * (points.length - 1);
  const i = Math.min(points.length - 1, Math.floor(u));
  const f = u - i;
  const a = points[i];
  const b = points[Math.min(points.length - 1, i + 1)];
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}

/**
 * PURE: sample both construction curves and apply the connect function.
 * Runs after spline overrides, so the surface tracks edits to either curve.
 */
export function resolveSurfaces(root: Node): Node {
  const cache = new Map<Node, Node>();

  const walk = (node: Node): Node => {
    if (node.kind === 'surface') {
      if (node.sections) return node;
      const cached = cache.get(node);
      if (cached) return cached;

      const aPts = constructionCurve(node.a);
      const bPts = constructionCurve(node.b);
      const sections: Vec3[][] = [];

      for (let i = 0; i <= node.samples; i++) {
        const t = i / node.samples;
        const a = pointAtPolyline(aPts, t);
        const b = pointAtPolyline(bPts, t);
        const ruling: Vec3[] = [];
        for (let j = 0; j <= node.sSamples; j++) {
          const p = node.connect(a, b, j / node.sSamples);
          if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) {
            throw new Error('surface(): connect(a, b, s) must return [x, y, z]');
          }
          ruling.push([p[0], p[1], p[2]]);
        }
        sections.push(ruling);
      }

      const resolved: SurfaceNode = { ...node, sections };
      cache.set(node, resolved);
      return resolved;
    }

    if (node.kind === 'group' || node.kind === 'op') {
      let changed = false;
      const children = node.children.map((c) => {
        const next = walk(c);
        if (next !== c) changed = true;
        return next;
      });
      return changed ? { ...node, children } : node;
    }

    if (node.kind === 'paint' || node.kind === 'offset' || node.kind === 'shell') {
      const child = walk(node.child);
      return child === node.child ? node : { ...node, child };
    }

    return node;
  };

  return walk(root);
}

/** Consecutive capsule rulings of a resolved surface. */
export function surfaceSegments(node: SurfaceNode): Array<[Vec3, Vec3]> {
  const out: Array<[Vec3, Vec3]> = [];
  for (const ruling of node.sections ?? []) {
    for (let j = 0; j < ruling.length - 1; j++) out.push([ruling[j], ruling[j + 1]]);
  }
  return out;
}
