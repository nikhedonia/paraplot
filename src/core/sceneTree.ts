import type { Node, Vec3 } from './types';
import { linearToHex } from './math';

export interface TreeNode {
  /** stable path of `kind + index` segments, e.g. `union0/group1/sphere0` */
  id: string;
  label: string;
  kind: Node['kind'];
  detail?: string;
  depth: number;
  children: TreeNode[];
}

const seg = (node: Node, index: number): string => `${node.kind}${index}`;
const childId = (parentId: string, child: Node, index: number): string =>
  `${parentId}/${seg(child, index)}`;

const num = (n: number): string => (Number.isInteger(n) ? String(n) : Number(n.toFixed(3)).toString());
const vec = (v: Vec3): string => v.map(num).join(' ');

const OP_LABEL: Record<string, string> = {
  union: 'union',
  intersect: 'intersect',
  subtract: 'subtract',
  smoothUnion: 'smooth union',
  smoothIntersect: 'smooth intersect',
  smoothSubtract: 'smooth subtract',
};

const isZero = (v: Vec3) => v.every((n) => Math.abs(n) < 1e-9);
const isOne = (v: Vec3) => v.every((n) => Math.abs(n - 1) < 1e-9);

export function describeNode(node: Node): { label: string; detail?: string } {
  switch (node.kind) {
    case 'sphere':
      return { label: 'sphere', detail: `r ${num(node.r)}` };

    case 'box':
      return {
        label: 'box',
        detail: `s ${vec(node.s)}${node.round > 0 ? ` · round ${num(node.round)}` : ''}`,
      };

    case 'ellipsoid':
      return { label: 'ellipsoid', detail: `r ${vec(node.r)}` };

    case 'torus':
      return { label: 'torus', detail: `R ${num(node.R)} · r ${num(node.r)}` };

    case 'cylinder':
      return {
        label: 'cylinder',
        detail: `r ${num(node.r)} · h ${num(node.h)}${node.round > 0 ? ` · round ${num(node.round)}` : ''}`,
      };

    case 'cone':
      return { label: 'cone', detail: `r ${num(node.r)} · h ${num(node.h)}` };

    case 'capsule':
      return { label: 'capsule', detail: `r ${num(node.r)}` };

    case 'plane':
      return { label: 'plane', detail: `n ${vec(node.n)} · d ${num(node.d)}` };

    case 'implicit': {
      const source = node.source.replace(/\s+/g, ' ').trim();
      return {
        label: 'implicit',
        detail: source.length > 44 ? `${source.slice(0, 44)}…` : source,
      };
    }

    case 'spline': {
      const label = node.name ?? 'spline';
      const bits = [`${node.points.length} pts`, `r ${num(node.r)}`];
      return { label, detail: node.name ? `spline · ${bits.join(' · ')}` : bits.join(' · ') };
    }

    case 'extrude': {
      const label = node.name ?? 'extrude';
      const bits = [`${node.points.length} pts`, `h ${num(node.h)}`];
      return { label, detail: node.name ? `extrude · ${bits.join(' · ')}` : bits.join(' · ') };
    }

    case 'lathe': {
      const label = node.name ?? 'lathe';
      const bits = [`${node.points.length} pts`];
      return { label, detail: node.name ? `lathe · ${bits.join(' · ')}` : bits.join(' · ') };
    }

    case 'group': {
      const bits: string[] = [];
      if (!isZero(node.t)) bits.push(`t ${vec(node.t)}`);
      if (!isZero(node.r)) bits.push(`r ${vec(node.r)}`);
      if (!isOne(node.s)) bits.push(`s ${vec(node.s)}`);
      if (node.op !== 'union') bits.push(`${OP_LABEL[node.op]}${node.k > 0 ? ` ${num(node.k)}` : ''}`);
      return {
        label: node.name ?? 'group',
        detail: node.name ? `group${bits.length ? ` · ${bits.join(' · ')}` : ''}` : bits.join(' · '),
      };
    }

    case 'op':
      return {
        label: OP_LABEL[node.op] ?? node.op,
        detail: node.op.startsWith('smooth') ? `k ${num(node.k)}` : undefined,
      };

    case 'paint':
      return {
        label: 'paint',
        detail: `${linearToHex(node.color).toUpperCase()} · rough ${num(node.rough)}`,
      };

    case 'offset':
      return { label: 'offset', detail: `d ${num(node.d)}` };

    case 'shell':
      return { label: 'shell', detail: `t ${num(node.t)}` };
  }
}

export function childEntries(node: Node): Array<{ node: Node; index: number }> {
  if (node.kind === 'op' || node.kind === 'group') {
    return node.children.map((child, index) => ({ node: child, index }));
  }
  if (node.kind === 'paint' || node.kind === 'offset' || node.kind === 'shell') {
    return [{ node: node.child, index: 0 }];
  }
  return [];
}

export function buildSceneTree(root: Node): TreeNode {
  const make = (node: Node, id: string, depth: number): TreeNode => {
    const desc = describeNode(node);
    return {
      id,
      label: desc.label,
      detail: desc.detail,
      kind: node.kind,
      depth,
      children: childEntries(node).map(({ node: child, index }) =>
        make(child, childId(id, child, index), depth + 1),
      ),
    };
  };

  const scene = make(root, seg(root, 0), 0);
  if (root.kind === 'group' && root.name) {
    scene.label = root.name;
    scene.detail = describeNode(root).detail;
  } else {
    scene.detail = describeNode(root).label;
    scene.label = 'scene';
  }
  return scene;
}

export function findTreeNode(root: TreeNode, id: string): TreeNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const hit = findTreeNode(child, id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Remove hidden components. `subtract` keeps its base; everything else keeps
 * whatever children survive (a hidden cutter simply stops cutting).
 */
export function pruneHidden(root: Node, hidden: ReadonlySet<string>): Node | null {
  if (hidden.size === 0) return root;

  const walk = (node: Node, id: string): Node | null => {
    if (hidden.has(id)) return null;

    switch (node.kind) {
      case 'group': {
        const mapped = node.children.map((child, i) => walk(child, childId(id, child, i)));
        if (node.op === 'subtract' || node.op === 'smoothSubtract') {
          const base = mapped[0];
          if (!base) return null;
          return { ...node, children: [base, ...mapped.slice(1).filter((n): n is Node => !!n)] };
        }
        const children = mapped.filter((n): n is Node => !!n);
        return children.length ? { ...node, children } : null;
      }

      case 'op': {
        const mapped = node.children.map((child, i) => walk(child, childId(id, child, i)));
        if (node.op === 'subtract' || node.op === 'smoothSubtract') {
          const base = mapped[0];
          if (!base) return null;
          return { ...node, children: [base, ...mapped.slice(1).filter((n): n is Node => !!n)] };
        }
        const children = mapped.filter((n): n is Node => !!n);
        return children.length ? { ...node, children } : null;
      }

      case 'paint':
      case 'offset':
      case 'shell': {
        const child = walk(node.child, childId(id, node.child, 0));
        return child ? { ...node, child } : null;
      }

      default:
        return node;
    }
  };

  return walk(root, seg(root, 0));
}

/**
 * Render only the component at `id`, keeping the transforms and modifiers of
 * its ancestors but dropping sibling geometry and set operations.
 */
export function isolateNode(root: Node, id: string): Node | null {
  const walk = (node: Node, currentId: string): Node | null => {
    if (currentId === id) return node;
    if (!id.startsWith(`${currentId}/`)) return null;

    switch (node.kind) {
      case 'group': {
        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i];
          const found = walk(child, childId(currentId, child, i));
          if (found) {
            return { ...node, op: 'union', k: 0, children: [found] };
          }
        }
        return null;
      }

      case 'op': {
        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i];
          const found = walk(child, childId(currentId, child, i));
          if (found) return found;
        }
        return null;
      }

      case 'paint':
      case 'offset':
      case 'shell': {
        const found = walk(node.child, childId(currentId, node.child, 0));
        return found ? { ...node, child: found } : null;
      }

      default:
        return null;
    }
  };

  return walk(root, seg(root, 0));
}
