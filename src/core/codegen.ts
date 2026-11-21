import type { Material, Node, OpKind, Vec3, Aabb, SplineInfo } from './types';
import { sampleProfile, sampleSpline } from './spline';
import { compileExpression } from './expr';
import { resolveSplinePointRefs } from './splineRefs';
import { boundsOf } from './bounds';
import { resolveSurfaces, surfaceSegments } from './surface';
import { fragmentShader } from '../render/glsl';

export interface CompiledProgram {
  /** the scene graph this program was generated from */
  scene: Node;
  /** full GLSL fragment shader */
  glsl: string;
  /** flat float pool uploaded to `u_values` */
  values: Float32Array;
  bounds: Aabb;
  materials: Material[];
  splines: SplineInfo[];
  /** true when an implicit equation reads the shader clock */
  usesTime: boolean;
  stats: { nodes: number; values: number; materials: number; lines: number };
}

const DEFAULT_MATERIAL: Material = { color: [0.24, 0.26, 0.29], rough: 0.55 };

class Gen {
  private values: number[] = [];
  private materials: Material[] = [DEFAULT_MATERIAL];
  /** identical paint nodes share one material slot */
  private materialIndex = new Map<string, number>();
  private fns: string[] = [];
  /** nodes are emitted once per identity, so reused subgraphs share code/uniforms */
  private emitted = new Map<Node, string>();
  private id = 0;
  private nodes = 0;
  private usesTime = false;

  generate(root: Node): CompiledProgram {
    // point references and ruled surfaces resolve after spline overrides
    const scene = resolveSurfaces(resolveSplinePointRefs(root));
    const entry = this.emit(scene);

    const mapFn = `/* ${this.nodes} nodes, ${this.values.length} parameters */
${this.fns.join('\n')}
vec2 map(vec3 p) { return ${entry}(p); }
`;

    const glsl = fragmentShader({
      mapFn,
      valueCount: this.values.length,
      materialCount: this.materials.length,
    });

    return {
      scene,
      glsl,
      values: new Float32Array(this.values),
      bounds: boundsOf(scene),
      materials: this.materials.map((m) => ({ ...m, color: [...m.color] as Vec3 })),
      splines: collectSplines(scene),
      usesTime: this.usesTime,
      stats: {
        nodes: this.nodes,
        values: this.values.length,
        materials: this.materials.length,
        lines: glsl.split('\n').length,
      },
    };
  }

  /* ---------------- emitters ---------------- */

  private f(x: number): string {
    const i = this.values.length;
    this.values.push(x);
    return `u_values[${i}]`;
  }

  private v3(v: Vec3): string {
    const i = this.values.length;
    this.values.push(v[0], v[1], v[2]);
    return `v3(${i})`;
  }

  private v2(v: [number, number]): string {
    const i = this.values.length;
    this.values.push(v[0], v[1]);
    return `v2(${i})`;
  }

  private emit(node: Node): string {
    const cached = this.emitted.get(node);
    if (cached) return cached;
    this.nodes++;
    const name = `n${this.id++}`;
    this.fns.push(this.body(node, name));
    this.emitted.set(node, name);
    return name;
  }

  private body(node: Node, name: string): string {
    const sig = `vec2 ${name}(vec3 p)`;
    switch (node.kind) {
      case 'sphere':
        return `${sig} { return vec2(sdSphere(p, ${this.f(node.r)}), 0.0); }`;

      case 'box':
        // rounded with r = 0 is exactly sdBox; keeping one code path means a
        // rounding parameter can change without recompiling the shader
        return `${sig} { return vec2(sdRoundBox(p, ${this.v3(node.s)}, ${this.f(node.round)}), 0.0); }`;

      case 'ellipsoid':
        return `${sig} { return vec2(sdEllipsoid(p, ${this.v3(node.r)}), 0.0); }`;

      case 'torus':
        return `${sig} { return vec2(sdTorus(p, ${this.f(node.R)}, ${this.f(node.r)}), 0.0); }`;

      case 'cylinder':
        return `${sig} { return vec2(sdRoundedCylinder(p, ${this.f(node.r)}, ${this.f(
          node.round,
        )}, ${this.f(node.h * 0.5)}), 0.0); }`;

      case 'cone':
        return `${sig} { return vec2(sdCone(p, ${this.f(node.h * 0.5)}, ${this.f(node.r)}), 0.0); }`;

      case 'capsule':
        return `${sig} { return vec2(sdCapsule(p, ${this.v3(node.a)}, ${this.v3(
          node.b,
        )}, ${this.f(node.r)}), 0.0); }`;

      case 'plane':
        return `${sig} { return vec2(dot(p, ${this.v3(node.n)}) + ${this.f(node.d)}, 0.0); }`;

      case 'implicit': {
        const fieldName = `field${this.id}`;
        const expr = compileExpression(node.source, node.vars, (_name, v) => this.f(v));
        if (/\bu_time\b/.test(expr)) this.usesTime = true;
        this.fns.push(`float ${fieldName}(vec3 p) { return ${expr}; }`);
        if (!node.normalize) {
          return `${sig} { return vec2(${fieldName}(p), 0.0); }`;
        }
        return `
${sig} {
  float f = ${fieldName}(p);
  float h = 0.0015;
  vec3 g = vec3(
    ${fieldName}(p + vec3(h, 0.0, 0.0)) - ${fieldName}(p - vec3(h, 0.0, 0.0)),
    ${fieldName}(p + vec3(0.0, h, 0.0)) - ${fieldName}(p - vec3(0.0, h, 0.0)),
    ${fieldName}(p + vec3(0.0, 0.0, h)) - ${fieldName}(p - vec3(0.0, 0.0, h))
  );
  float d = f * (2.0 * h) / max(length(g), 1e-6);
  return vec2(clamp(d, -4.0, 4.0), 0.0);
}`.trim();
      }

      case 'spline': {
        const pts = sampleSpline(node.points, node.closed, node.seg);
        const off = this.values.length;
        for (const p of pts) this.values.push(p[0], p[1], p[2]);
        return `${sig} { return vec2(sdPath(p, ${off}, ${pts.length}, ${this.f(node.r)}), 0.0); }`;
      }

      case 'extrude': {
        const pts = sampleProfile(node.points, node.closed, node.seg);
        const off = this.values.length;
        for (const p of pts) this.values.push(p[0], p[1]);
        const hh = node.h * 0.5;
        return `
${sig} {
  float d2 = sdPoly(p.xy, ${off}, ${pts.length});
  float rr = ${this.f(node.round)};
  vec2 w = vec2(d2 + rr, abs(p.z) - ${this.f(hh)} + rr);
  return vec2(min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - rr, 0.0);
}`.trim();
      }

      case 'lathe': {
        const pts = sampleProfile(node.points, node.closed, node.seg);
        const off = this.values.length;
        for (const p of pts) this.values.push(p[0], p[1]);
        return `${sig} { vec2 q = vec2(length(p.xz), p.y); return vec2(sdPoly(q, ${off}, ${pts.length}), 0.0); }`;
      }

      case 'surface': {
        const segments = surfaceSegments(node);
        if (segments.length === 0) return `${sig} { return vec2(1e6, 0.0); }`;
        const off = this.values.length;
        for (const [a, b] of segments) {
          this.values.push(a[0], a[1], a[2], b[0], b[1], b[2]);
        }
        const r = this.f(node.thickness * 0.5);
        // one loop over the rulings keeps the shader small even for dense sheets
        return `
${sig} {
  float rr = ${r};
  float d = 1e12;
  for (int i = 0; i < ${segments.length}; i++) {
    d = min(d, sdCapsule(p, v3(${off} + 6 * i), v3(${off} + 6 * i + 3), rr));
  }
  return vec2(d, 0.0);
}`.trim();
      }

      case 'op':
        return this.opBody(name, node.op, node.k, node.children.map((c) => this.emit(c)));

      case 'group': {
        const kids = node.children.map((c) => this.emit(c));
        const minScale = Math.min(Math.abs(node.s[0]), Math.abs(node.s[1]), Math.abs(node.s[2]));
        const blend = this.kValue(node.k, node.op);
        const combines = kids
          .slice(1)
          .map((k) => `  a = ${opCall(node.op, node.k, 'a', `${k}(q)`, blend)};`)
          .join('\n');
        const head = `
${sig} {
  vec3 q = p;
  q -= ${this.v3(node.t)};
  q = rotZ(q, -radians(${this.f(node.r[2])}));
  q = rotY(q, -radians(${this.f(node.r[1])}));
  q = rotX(q, -radians(${this.f(node.r[0])}));
  q /= ${this.v3(node.s)};
  vec2 a = ${kids[0]}(q);`;
        return `${head}${combines ? '\n' + combines : ''}\n  return vec2(a.x * ${this.f(minScale)}, a.y);\n}`;
      }

      case 'offset': {
        const child = this.emit(node.child);
        return `${sig} { vec2 r = ${child}(p); return vec2(r.x - ${this.f(node.d)}, r.y); }`;
      }

      case 'shell': {
        const child = this.emit(node.child);
        return `${sig} { vec2 r = ${child}(p); return vec2(abs(r.x) - ${this.f(node.t)}, r.y); }`;
      }

      case 'paint': {
        const child = this.emit(node.child);
        const key = `${node.color[0]},${node.color[1]},${node.color[2]},${node.rough}`;
        let idx = this.materialIndex.get(key);
        if (idx === undefined) {
          idx = this.materials.length;
          this.materials.push({ color: [...node.color] as Vec3, rough: node.rough });
          this.materialIndex.set(key, idx);
        }
        return `${sig} { vec2 r = ${child}(p); return vec2(r.x, ${idx}.0); }`;
      }
    }
  }

  private opBody(name: string, op: OpKind, k: number, kids: string[]): string {
    const sig = `vec2 ${name}(vec3 p)`;
    const blend = this.kValue(k, op);
    const lines = [`  vec2 a = ${kids[0]}(p);`];
    for (let i = 1; i < kids.length; i++) {
      lines.push(`  a = ${opCall(op, k, 'a', `${kids[i]}(p)`, blend)};`);
    }
    return `${sig} {\n${lines.join('\n')}\n  return a;\n}`;
  }

  /** smooth ops always take a uniform radius; the shader falls back to a hard op when k <= 0 */
  private kValue(k: number, op: OpKind): string | null {
    if (!op.startsWith('smooth')) return null;
    return this.f(k);
  }
}

function opCall(op: OpKind, _k: number, a: string, b: string, kUniform?: string | null): string {
  switch (op) {
    case 'union':
      return `opUnion(${a}, ${b})`;
    case 'intersect':
      return `opIntersect(${a}, ${b})`;
    case 'subtract':
      return `opSubtract(${a}, ${b})`;
    case 'smoothUnion':
      return kUniform ? `opSmoothUnion(${a}, ${b}, ${kUniform})` : `opUnion(${a}, ${b})`;
    case 'smoothIntersect':
      return kUniform ? `opSmoothIntersect(${a}, ${b}, ${kUniform})` : `opIntersect(${a}, ${b})`;
    case 'smoothSubtract':
      return kUniform ? `opSmoothSubtract(${a}, ${b}, ${kUniform})` : `opSubtract(${a}, ${b})`;
  }
}

/** Walk the tree in the same order the generator does, so ids line up. */
export function generate(root: Node): CompiledProgram {
  return new Gen().generate(root);
}

export function collectSplines(root: Node): SplineInfo[] {
  const out: SplineInfo[] = [];
  // a spline node reused under several transforms is one editable spline
  const seen = new Set<Node>();
  let index = 0;
  const walk = (n: Node) => {
    if (n.kind === 'spline' || n.kind === 'extrude' || n.kind === 'lathe') {
      if (seen.has(n)) return;
      seen.add(n);
      const i = index++;
      out.push({
        id: n.name ?? `#${i}`,
        name: n.name ?? `${n.kind} ${i + 1}`,
        kind: n.kind,
        dim: n.kind === 'spline' ? 3 : 2,
        points: n.points.map((p) => [...p]),
        closed: n.closed,
        seg: n.seg,
        ...(n.kind === 'spline' ? { r: n.r } : null),
        ...(n.kind === 'extrude' ? { h: n.h, round: n.round } : null),
      });
      return;
    }
    if (n.kind === 'surface') {
      // construction curves are editable but not rendered on their own
      walk(n.a);
      walk(n.b);
      return;
    }
    if (n.kind === 'op' || n.kind === 'group') n.children.forEach(walk);
    else if (n.kind === 'offset' || n.kind === 'shell' || n.kind === 'paint') walk(n.child);
  };
  walk(root);
  return out;
}

/**
 * Apply per-point offsets to spline control points. Using offsets (not absolute
 * points) keeps time-dependent splines animating around the edited shape.
 */
export function applySplineOverrides(root: Node, overrides: Record<string, number[][]>): Node {
  if (!overrides || Object.keys(overrides).length === 0) return root;
  const ids = new WeakMap<Node, string>();
  // structural sharing: one replacement per original node, so shared subtrees
  // stay shared (and keep producing identical shader text while editing)
  const replaced = new Map<Node, Node>();
  let index = 0;
  const idFor = (n: Node): string => {
    const existing = ids.get(n);
    if (existing) return existing;
    const i = index++;
    const id = (n as { name?: string }).name ?? `#${i}`;
    ids.set(n, id);
    return id;
  };
  const walk = (n: Node): Node => {
    const cached = replaced.get(n);
    if (cached) return cached;

    if (n.kind === 'spline' || n.kind === 'extrude' || n.kind === 'lathe') {
      const id = idFor(n);
      const ov = overrides[id];
      const dim = n.kind === 'spline' ? 3 : 2;
      if (
        ov &&
        Array.isArray(ov) &&
        ov.length === n.points.length &&
        ov.every((p) => Array.isArray(p) && p.length === dim && p.every(Number.isFinite))
      ) {
        const points = n.points.map((p, i) => p.map((v, k) => v + ov[i][k]));
        const copy = { ...n, points } as Node;
        replaced.set(n, copy);
        return copy;
      }
      return n;
    }

    if (n.kind === 'surface') {
      const a = walk(n.a);
      const b = walk(n.b);
      if (a === n.a && b === n.b) return n;
      // construction curves changed: the rulings must be resampled
      const next = { ...n, a, b, sections: undefined };
      replaced.set(n, next);
      return next;
    }

    if (n.kind === 'op' || n.kind === 'group') {
      let changed = false;
      const children = n.children.map((child) => {
        const next = walk(child);
        if (next !== child) changed = true;
        return next;
      });
      if (!changed) return n;
      const next = { ...n, children };
      replaced.set(n, next);
      return next;
    }

    if (n.kind === 'offset' || n.kind === 'shell' || n.kind === 'paint') {
      const child = walk(n.child);
      if (child === n.child) return n;
      const next = { ...n, child };
      replaced.set(n, next);
      return next;
    }

    return n;
  };
  return walk(root);
}
