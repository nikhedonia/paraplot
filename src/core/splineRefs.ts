import type { Node, SplinePointRef, Vec3 } from './types';
import { sampleProfile, sampleSpline } from './spline';

interface NamedSpline {
  kind: 'spline' | 'extrude' | 'lathe';
  points: number[][];
  closed: boolean;
}

const hasRefs = (root: Node): boolean => {
  if (root.kind === 'group') {
    if (root.tRef) return true;
    return root.children.some(hasRefs);
  }
  if (root.kind === 'op') return root.children.some(hasRefs);
  if (root.kind === 'repeat') return hasRefs(root.child);
  if (root.kind === 'paint' || root.kind === 'offset' || root.kind === 'shell') {
    return hasRefs(root.child);
  }
  if (root.kind === 'capsule') return !!(root.aRef || root.bRef);
  return false;
};

interface NamedEntry {
  node: Node;
  data: NamedSpline;
}

function collectNamedSplines(
  root: Node,
  out: Map<string, NamedEntry>,
  duplicates: Set<string>,
): void {
  const walk = (node: Node) => {
    if (node.kind === 'spline' || node.kind === 'extrude' || node.kind === 'lathe') {
      if (node.name) {
        const existing = out.get(node.name);
        if (!existing) {
          out.set(node.name, {
            node,
            data: { kind: node.kind, points: node.points, closed: node.closed },
          });
        } else if (existing.node !== node) {
          // the same node reused under transforms is fine; two definitions are not
          duplicates.add(node.name);
        }
      }
      return;
    }
    if (node.kind === 'surface') {
      // construction curves are addressable with spline.at(t) elsewhere
      walk(node.a);
      walk(node.b);
      return;
    }
    if (node.kind === 'group' || node.kind === 'op') {
      node.children.forEach(walk);
    } else if (node.kind === 'repeat') {
      walk(node.child);
    } else if (node.kind === 'paint' || node.kind === 'offset' || node.kind === 'shell') {
      walk(node.child);
    }
  };
  walk(root);
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Point on a sampled spline; 2d profiles are lifted to z = 0. */
function pointOnSpline(spline: NamedSpline, t: number, samples: number[][]): Vec3 {
  if (!samples.length) return [0, 0, 0];

  const u = clamp01(t) * (samples.length - 1);
  const i = Math.min(samples.length - 1, Math.floor(u));
  const f = u - i;
  const a = samples[i];
  const b = samples[Math.min(samples.length - 1, i + 1)];
  if (spline.kind === 'spline') {
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, 0];
}

/**
 * PURE: replace every `SplinePointRef` with concrete coordinates, looking the
 * spline up by name in the *final* tree (after overrides). This is what lets a
 * bar stay anchored to a rail while you drag the rail in the spline editor.
 */
export function resolveSplinePointRefs(root: Node): Node {
  if (!hasRefs(root)) return root;

  const named = new Map<string, NamedEntry>();
  const duplicates = new Set<string>();
  collectNamedSplines(root, named, duplicates);

  // sample each referenced spline once per resolve pass, not once per ref
  const cache = new Map<NamedSpline, number[][]>();
  const samplesFor = (spline: NamedSpline): number[][] => {
    let samples = cache.get(spline);
    if (!samples) {
      samples =
        spline.kind === 'spline'
          ? sampleSpline(spline.points, spline.closed, 32)
          : sampleProfile(spline.points, spline.closed, 32);
      cache.set(spline, samples);
    }
    return samples;
  };

  const resolve = (ref: SplinePointRef): Vec3 => {
    const found = named.get(ref.name);
    if (!found) {
      throw new Error(`at(): no spline named "${ref.name}" in the scene`);
    }
    if (duplicates.has(ref.name)) {
      throw new Error(`at(): spline name "${ref.name}" is ambiguous — names used by at() must be unique`);
    }
    return pointOnSpline(found.data, ref.t, samplesFor(found.data));
  };

  // structural sharing: untouched subtrees keep their identity, so a spline
  // reused by several instances is still emitted (and edited) once
  const walk = (node: Node): Node => {
    switch (node.kind) {
      case 'group': {
        let changed = !!node.tRef;
        const children = node.children.map((child) => {
          const next = walk(child);
          if (next !== child) changed = true;
          return next;
        });
        if (!changed) return node;
        return {
          ...node,
          t: node.tRef ? resolve(node.tRef) : node.t,
          tRef: undefined,
          children,
        };
      }
      case 'op': {
        let changed = false;
        const children = node.children.map((child) => {
          const next = walk(child);
          if (next !== child) changed = true;
          return next;
        });
        return changed ? { ...node, children } : node;
      }
      case 'repeat': {
        const child = walk(node.child);
        return child === node.child ? node : { ...node, child };
      }
      case 'paint':
      case 'offset':
      case 'shell': {
        const child = walk(node.child);
        return child === node.child ? node : { ...node, child };
      }
      case 'capsule': {
        if (!node.aRef && !node.bRef) return node;
        return {
          ...node,
          a: node.aRef ? resolve(node.aRef) : node.a,
          b: node.bRef ? resolve(node.bRef) : node.b,
          aRef: undefined,
          bRef: undefined,
        };
      }
      default:
        return node;
    }
  };

  return walk(root);
}
