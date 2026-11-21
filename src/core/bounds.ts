import type { Aabb, Node, Vec3 } from './types';
import {
  emptyAabb,
  growAabb,
  intersectAabb,
  isEmptyAabb,
  transformAabb,
  unionAabb,
} from './math';
import { sampleProfile, sampleSpline } from './spline';
import { resolveSurfaces } from './surface';

const box = (min: Vec3, max: Vec3): Aabb => ({ min, max });

function pointsBounds(points: number[][], r: number, dim: 2 | 3): Aabb {
  const b = emptyAabb();
  for (const p of points) {
    for (let i = 0; i < dim; i++) {
      b.min[i] = Math.min(b.min[i], p[i] - r);
      b.max[i] = Math.max(b.max[i], p[i] + r);
    }
  }
  return b;
}

export function boundsOf(node: Node): Aabb {
  switch (node.kind) {
    case 'sphere':
      return box([-node.r, -node.r, -node.r], [node.r, node.r, node.r]);

    case 'box':
      return box([-node.s[0], -node.s[1], -node.s[2]], node.s);

    case 'ellipsoid':
      return box([-node.r[0], -node.r[1], -node.r[2]], [node.r[0], node.r[1], node.r[2]]);

    case 'torus':
      return box(
        [-(node.R + node.r), -node.r, -(node.R + node.r)],
        [node.R + node.r, node.r, node.R + node.r],
      );

    case 'cylinder':
      return box([-node.r, -node.h / 2, -node.r], [node.r, node.h / 2, node.r]);

    case 'cone':
      return box([-node.r, -node.h / 2, -node.r], [node.r, node.h / 2, node.r]);

    case 'capsule': {
      const b = emptyAabb();
      for (const p of [node.a, node.b]) {
        for (let i = 0; i < 3; i++) {
          b.min[i] = Math.min(b.min[i], p[i] - node.r);
          b.max[i] = Math.max(b.max[i], p[i] + node.r);
        }
      }
      return b;
    }

    case 'plane': {
      const n = node.n;
      const big = 12;
      const b = box([-big, -big, -big], [big, big, big]);
      // keep the half space that contains the origin-ish side of the plane
      for (let i = 0; i < 3; i++) {
        if (Math.abs(n[i]) > 0.999) {
          b.min[i] = -big;
          b.max[i] = Math.max(-big, Math.min(big, -node.d * Math.sign(n[i]) + 2));
        }
      }
      return b;
    }

    case 'implicit':
      return box([-node.bounds[0], -node.bounds[1], -node.bounds[2]], node.bounds);

    case 'spline': {
      const pts = sampleSpline(node.points, node.closed, node.seg);
      return pointsBounds(pts, node.r, 3);
    }

    case 'extrude': {
      const pts = sampleProfile(node.points, node.closed, node.seg);
      const b = pointsBounds(pts, node.round, 2);
      b.min[2] = -node.h / 2 - node.round;
      b.max[2] = node.h / 2 + node.round;
      return b;
    }

    case 'lathe': {
      const pts = sampleProfile(node.points, node.closed, node.seg);
      let r = 0;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const p of pts) {
        r = Math.max(r, Math.abs(p[0]));
        y0 = Math.min(y0, p[1]);
        y1 = Math.max(y1, p[1]);
      }
      return box([-r, y0, -r], [r, y1, r]);
    }

    case 'repeat': {
      // conservative cylinder around the Y axis; count does not change the
      // envelope of a full polar array
      const b = boundsOf(node.child);
      const r = Math.max(
        Math.hypot(b.min[0], b.min[2]),
        Math.hypot(b.min[0], b.max[2]),
        Math.hypot(b.max[0], b.min[2]),
        Math.hypot(b.max[0], b.max[2]),
      );
      return box([-r, b.min[1], -r], [r, b.max[1], r]);
    }

    case 'surface': {
      const resolved = node.edges ? node : (resolveSurfaces(node) as typeof node);
      const r = node.thickness * 0.5 + node.margin;
      const b = emptyAabb();
      for (const p of [...(resolved.edges?.a ?? []), ...(resolved.edges?.b ?? [])]) {
        for (let i = 0; i < 3; i++) {
          b.min[i] = Math.min(b.min[i], p[i] - r);
          b.max[i] = Math.max(b.max[i], p[i] + r);
        }
      }
      return isEmptyAabb(b) ? box([-1, -1, -1], [1, 1, 1]) : b;
    }

    case 'op': {
      if (node.children.length === 0) return box([-1, -1, -1], [1, 1, 1]);
      if (node.op === 'intersect' || node.op === 'smoothIntersect') {
        let b = boundsOf(node.children[0]);
        for (let i = 1; i < node.children.length; i++) {
          b = intersectAabb(b, boundsOf(node.children[i]));
        }
        if (isEmptyAabb(b)) {
          // conservative fallback, avoids culling everything for smooth shapes
          return node.children.map(boundsOf).reduce(unionAabb, emptyAabb());
        }
        return node.op.startsWith('smooth') ? growAabb(b, node.k) : b;
      }
      if (node.op === 'subtract' || node.op === 'smoothSubtract') {
        return boundsOf(node.children[0]);
      }
      let b = emptyAabb();
      for (const c of node.children) b = unionAabb(b, boundsOf(c));
      return node.op.startsWith('smooth') ? growAabb(b, node.k) : b;
    }

    case 'group': {
      let b = emptyAabb();
      for (const c of node.children) b = unionAabb(b, boundsOf(c));
      if (node.op === 'intersect' || node.op === 'smoothIntersect') {
        b = emptyAabb();
        for (const c of node.children) {
          const cb = boundsOf(c);
          b = isEmptyAabb(b) ? cb : intersectAabb(b, cb);
        }
        if (isEmptyAabb(b)) b = box([-1, -1, -1], [1, 1, 1]);
      }
      if (node.op === 'subtract' || node.op === 'smoothSubtract') {
        b = boundsOf(node.children[0]);
      }
      const t = transformAabb(b, node.t, node.r, node.s);
      return node.op.startsWith('smooth') ? growAabb(t, node.k) : t;
    }

    case 'offset':
      return growAabb(boundsOf(node.child), node.d);

    case 'shell':
      return growAabb(boundsOf(node.child), node.t);

    case 'paint':
      return boundsOf(node.child);
  }
}
