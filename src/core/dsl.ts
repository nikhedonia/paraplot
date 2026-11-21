import type {
  Node,
  Vec2,
  Vec3,
  OpKind,
  SplineNode,
  ExtrudeNode,
  LatheNode,
  SplinePointRef,
  SurfaceNode,
  RepeatNode,
} from './types';
import { compileExpression } from './expr';
import { DEFAULT_SURFACE_CONNECT } from './surface';
import { isVec2, isVec3, parseHexColor, vec3 as toVec3, clamp as clampNum } from './math';
import {
  num,
  int,
  bool,
  color,
  select as selectControl,
  vec3Control,
  type NumberOpts,
  type Vec3Opts,
  type Vec3Control,
} from './controls';

export type { Node, Vec2, Vec3, OpKind } from './types';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const mk = <T extends object>(o: T): T => Object.freeze(o);

const fail = (msg: string): never => {
  throw new Error(msg);
};

const numArg = (
  fn: string,
  name: string,
  v: unknown,
  fallback?: number,
  check?: (n: number) => boolean,
  hint = '',
): number => {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    fail(`${fn}(): "${name}" must be a finite number${hint ? ` (${hint})` : ''}, got ${String(v)}`);
  }
  if (check && !check(v as number)) {
    fail(`${fn}(): "${name}" = ${v} is out of range${hint ? ` (${hint})` : ''}`);
  }
  return v as number;
};

const vecArg = (
  fn: string,
  name: string,
  v: unknown,
  fallback: Vec3,
  check?: (n: number) => boolean,
): Vec3 => {
  if (v === undefined) return [...fallback];
  if (typeof v === 'number' && Number.isFinite(v)) return [v, v, v];
  if (!isVec3(v)) fail(`${fn}(): "${name}" must be [x, y, z], got ${JSON.stringify(v)}`);
  const out = [...(v as Vec3)] as Vec3;
  if (check && !out.every(check)) fail(`${fn}(): "${name}" has an out-of-range component`);
  return out;
};

const isSplinePointRef = (v: unknown): v is SplinePointRef =>
  !!v && typeof v === 'object' && (v as { __splinePoint?: unknown }).__splinePoint === true;

/** a Vec3, or an opaque `spline.at(t)` reference resolved at compile time */
const pointArg = (
  fn: string,
  name: string,
  v: unknown,
  fallback: Vec3,
): { point: Vec3; ref?: SplinePointRef } => {
  if (isSplinePointRef(v)) return { point: [0, 0, 0], ref: v };
  return { point: vecArg(fn, name, v, fallback) };
};

const isNode = (v: unknown): v is Node =>
  !!v && typeof v === 'object' && typeof (v as { kind?: unknown }).kind === 'string';

function flatten(args: unknown[], fn: string): Node[] {
  const out: Node[] = [];
  const walk = (v: unknown) => {
    if (v === null || v === undefined || v === false) return;
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (!isNode(v)) {
      fail(`${fn}(): expected a shape, got ${typeof v}`);
    }
    out.push(v as Node);
  };
  args.forEach(walk);
  return out;
}

const OPS: OpKind[] = [
  'union',
  'intersect',
  'subtract',
  'smoothUnion',
  'smoothIntersect',
  'smoothSubtract',
];

const opArg = (fn: string, v: unknown): OpKind => {
  if (v === undefined) return 'union';
  if (!OPS.includes(v as OpKind)) fail(`${fn}(): unknown operation "${String(v)}"`);
  return v as OpKind;
};

const smoothness = (k: number) => (Number.isFinite(k) && k > 0 ? k : 0);

/* ------------------------------------------------------------------ */
/* groups & transforms                                                 */
/* ------------------------------------------------------------------ */

export interface Xform {
  /** label for the component tree */
  name?: string;
  /** translation (or an opaque spline point reference) */
  t?: Vec3 | number | SplinePointRef;
  /** euler rotation in degrees, applied X then Y then Z */
  r?: Vec3 | number;
  /** scale, uniform or per axis */
  s?: Vec3 | number;
  /** how children combine, default "union" */
  op?: OpKind;
  /** blend radius used by the smooth operations */
  k?: number;
}

const readXform = (fn: string, o: Xform = {}) => {
  const t = pointArg(fn, 't', o.t, [0, 0, 0]);
  return {
    name: typeof o.name === 'string' ? o.name : undefined,
    t: t.point,
    ...(t.ref ? { tRef: t.ref } : {}),
    r: vecArg(fn, 'r', o.r, [0, 0, 0]),
    s: vecArg(fn, 's', o.s, [1, 1, 1], (n) => n !== 0),
    op: opArg(fn, o.op),
    k: smoothness(numArg(fn, 'k', o.k, 0, (n) => n >= 0)),
  };
};

/**
 * A group establishes a local coordinate system for its children.
 * Forward transform is translate * rotate * scale.
 */
export function group(o: Xform = {}, ...children: unknown[]): Node {
  const x = readXform('group', o);
  const kids = flatten(children, 'group');
  if (kids.length === 0) fail('group(): needs at least one child');
  if (kids.length === 1 && x.op === 'union' && x.k === 0) {
    return mk({ kind: 'group' as const, ...x, children: [kids[0]] });
  }
  return mk({ kind: 'group' as const, ...x, children: kids });
}

export const transform = group;

export function translate(
  t: Vec3 | number | SplinePointRef,
  ...children: unknown[]
): Node {
  return group({ t }, ...children);
}

export function rotate(r: Vec3 | number, ...children: unknown[]): Node {
  return group({ r }, ...children);
}

export function scale(s: Vec3 | number, ...children: unknown[]): Node {
  return group({ s }, ...children);
}

/* ------------------------------------------------------------------ */
/* typed scenes                                                       */
/* ------------------------------------------------------------------ */

/**
 * Runtime identity helper for TypeScript scenes. The first argument is the
 * exported params schema; the build function receives its resolved values.
 *
 *   export const params = { size: num(1, { min: 0.2, max: 2 }) };
 *   export default defineScene(params, (k) => box({ s: k.size }));
 */
export function defineScene<P extends object>(
  _params: P,
  build: (values: P, time: number) => Node,
): (values: P, time: number) => Node {
  return build;
}

/* ------------------------------------------------------------------ */
/* set operations                                                      */
/* ------------------------------------------------------------------ */

const opNode = (op: OpKind, k: number, children: Node[]): Node => {
  if (children.length === 1) return children[0];
  return mk({ kind: 'op' as const, op, k: op.startsWith('smooth') ? k : 0, children });
};

export function union(...children: unknown[]): Node {
  const kids = flatten(children, 'union');
  if (kids.length === 0) fail('union(): needs at least one shape');
  return opNode('union', 0, kids);
}

export function intersect(...children: unknown[]): Node {
  const kids = flatten(children, 'intersect');
  if (kids.length === 0) fail('intersect(): needs at least one shape');
  return opNode('intersect', 0, kids);
}

export function subtract(a: unknown, ...children: unknown[]): Node {
  const [base] = flatten([a], 'subtract');
  if (!base) fail('subtract(): needs a base shape');
  const kids = flatten(children, 'subtract');
  if (kids.length === 0) return base;
  return mk({ kind: 'op' as const, op: 'subtract', k: 0, children: [base, ...kids] });
}

export function smoothUnion(k: number, ...children: unknown[]): Node {
  const kids = flatten(children, 'smoothUnion');
  if (kids.length === 0) fail('smoothUnion(): needs at least one shape');
  return opNode('smoothUnion', smoothness(k), kids);
}

export function smoothIntersect(k: number, ...children: unknown[]): Node {
  const kids = flatten(children, 'smoothIntersect');
  if (kids.length === 0) fail('smoothIntersect(): needs at least one shape');
  return opNode('smoothIntersect', smoothness(k), kids);
}

export function smoothSubtract(k: number, a: unknown, ...children: unknown[]): Node {
  const [base] = flatten([a], 'smoothSubtract');
  if (!base) fail('smoothSubtract(): needs a base shape');
  const kids = flatten(children, 'smoothSubtract');
  if (kids.length === 0) return base;
  return mk({
    kind: 'op' as const,
    op: 'smoothSubtract',
    k: smoothness(k),
    children: [base, ...kids],
  });
}

/* ------------------------------------------------------------------ */
/* modifiers                                                           */
/* ------------------------------------------------------------------ */

/** Grow (positive) or shrink (negative) a shape. */
export function offset(node: unknown, d: number): Node {
  const [child] = flatten([node], 'offset');
  if (!child) fail('offset(): needs a shape');
  return mk({ kind: 'offset' as const, d: numArg('offset', 'd', d), child });
}

/** Hollow out a shape, keeping a wall of thickness t. */
export function shell(node: unknown, t: number): Node {
  const [child] = flatten([node], 'shell');
  if (!child) fail('shell(): needs a shape');
  return mk({
    kind: 'shell' as const,
    t: numArg('shell', 't', t, undefined, (n) => n > 0, 'thickness must be > 0'),
    child,
  });
}

export interface PaintOpts {
  /** 0 = mirror, 1 = chalk */
  rough?: number;
}

/** Give a shape a material colour. Outermost paint wins. */
export function paint(node: unknown, hex: string, opts: PaintOpts = {}): Node {
  const [child] = flatten([node], 'paint');
  if (!child) fail('paint(): needs a shape');
  return mk({
    kind: 'paint' as const,
    color: parseHexColor(hex),
    rough: clampNum(numArg('paint', 'rough', opts.rough, 0.45, (n) => n >= 0), 0, 1),
    child,
  });
}

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

export interface SphereOpts {
  r?: number;
}
export const sphere = (o: SphereOpts = {}): Node =>
  mk({ kind: 'sphere' as const, r: numArg('sphere', 'r', o.r, 1, (n) => n > 0) });

export interface BoxOpts {
  /** half extents */
  s?: Vec3 | number;
  /** corner rounding */
  round?: number;
}
export const box = (o: BoxOpts = {}): Node => {
  const s = vecArg('box', 's', o.s, [1, 1, 1], (n) => n > 0);
  const r = numArg('box', 'round', o.round, 0, (n) => n >= 0);
  const minS = Math.min(s[0], s[1], s[2]);
  return mk({ kind: 'box' as const, s, round: Math.min(r, minS * 0.999) });
};

export interface EllipsoidOpts {
  r?: Vec3 | number;
}
export const ellipsoid = (o: EllipsoidOpts = {}): Node =>
  mk({
    kind: 'ellipsoid' as const,
    r: vecArg('ellipsoid', 'r', o.r, [1, 0.6, 0.4], (n) => n > 0),
  });

export interface TorusOpts {
  /** major radius */
  R?: number;
  /** minor radius */
  r?: number;
}
export const torus = (o: TorusOpts = {}): Node => {
  const R = numArg('torus', 'R', o.R, 1, (n) => n > 0);
  const r = numArg('torus', 'r', o.r, 0.25, (n) => n > 0 && n < R);
  return mk({ kind: 'torus' as const, R, r });
};

export interface CylinderOpts {
  r?: number;
  /** full height, centred on the origin */
  h?: number;
  round?: number;
}
export const cylinder = (o: CylinderOpts = {}): Node => {
  const r = numArg('cylinder', 'r', o.r, 1, (n) => n > 0);
  const h = numArg('cylinder', 'h', o.h, 1, (n) => n > 0);
  const round = numArg('cylinder', 'round', o.round, 0, (n) => n >= 0);
  return mk({ kind: 'cylinder' as const, r, h, round: Math.min(round, r * 0.999, (h / 2) * 0.999) });
};

export interface ConeOpts {
  r?: number;
  h?: number;
}
export const cone = (o: ConeOpts = {}): Node => {
  const r = numArg('cone', 'r', o.r, 1, (n) => n > 0);
  const h = numArg('cone', 'h', o.h, 1, (n) => n > 0);
  return mk({ kind: 'cone' as const, r, h });
};

export interface CapsuleOpts {
  a?: Vec3 | SplinePointRef;
  b?: Vec3 | SplinePointRef;
  r?: number;
}
export const capsule = (o: CapsuleOpts = {}): Node => {
  const a = pointArg('capsule', 'a', o.a, [0, -1, 0]);
  const b = pointArg('capsule', 'b', o.b, [0, 1, 0]);
  return mk({
    kind: 'capsule' as const,
    a: a.point,
    b: b.point,
    ...(a.ref ? { aRef: a.ref } : {}),
    ...(b.ref ? { bRef: b.ref } : {}),
    r: numArg('capsule', 'r', o.r, 0.25, (n) => n > 0),
  });
};

export interface PlaneOpts {
  n?: Vec3;
  /** plane offset: dot(p, n) + d = 0 */
  d?: number;
}
export const plane = (o: PlaneOpts = {}): Node => {
  const n = vecArg('plane', 'n', o.n, [0, 1, 0]);
  const len = Math.hypot(n[0], n[1], n[2]);
  if (len < 1e-6) fail('plane(): normal must be non-zero');
  return mk({
    kind: 'plane' as const,
    n: [n[0] / len, n[1] / len, n[2] / len],
    d: numArg('plane', 'd', o.d, 0),
  });
};

/* ------------------------------------------------------------------ */
/* implicit surfaces                                                   */
/* ------------------------------------------------------------------ */

export interface ImplicitOpts {
  /** divide the field by its gradient so it can be marched (default true) */
  normalize?: boolean;
  /** conservative bounds, a cube half-size or an explicit box */
  bounds?: number | Vec3;
  /** named constants usable in the equation */
  vars?: Record<string, number>;
}

export type { Vec3Control } from './controls';
/**
 * A shape defined by an implicit equation. Negative inside, zero on the
 * surface. The equation is compiled to GLSL from a tiny, safe expression
 * language (no eval):
 *
 *   implicit('x*x + y*y + z*z - 1', { bounds: 1.2 })
 *   implicit('abs(sin(x*f) * cos(y*f)) - t', { vars: { f: 6, t: 0.4 } })
 *
 * Available: x, y, z, p (vec3), pi, tau and the GLSL maths functions
 * (sin, cos, tan, abs, sqrt, pow, min, max, clamp, mix, length, dot, ...).
 */
export function implicit(source: string, opts: ImplicitOpts = {}): Node {
  if (typeof source !== 'string') {
    fail('implicit(): the first argument must be an equation string, e.g. "x*x + y*y - 1"');
  }
  const vars = opts.vars ?? {};
  compileExpression(source, vars); // validate eagerly, with source positions

  const b = opts.bounds ?? 2;
  let bounds: Vec3;
  if (typeof b === 'number') {
    bounds = toVec3(b);
  } else if (isVec3(b)) {
    bounds = b;
  } else {
    throw new Error('implicit(): bounds must be a number or [x, y, z]');
  }
  if (!bounds.every((n) => n > 0)) fail('implicit(): bounds must be positive');
  return mk({
    kind: 'implicit' as const,
    source,
    vars: { ...vars },
    normalize: opts.normalize !== false,
    bounds: [...bounds] as Vec3,
  });
}

/* ------------------------------------------------------------------ */
/* splines                                                             */
/* ------------------------------------------------------------------ */

const pointsArg = <T extends number[]>(
  fn: string,
  pts: unknown,
  dim: 2 | 3,
  min: number,
): T[] => {
  if (!Array.isArray(pts) || pts.length < min) {
    fail(`${fn}(): "points" must be an array of at least ${min} points`);
  }
  const out = (pts as unknown[]).map((p, i) => {
    const ok = dim === 2 ? isVec2(p) : isVec3(p);
    if (!ok) fail(`${fn}(): point ${i} must be a ${dim}d vector, got ${JSON.stringify(p)}`);
    return Object.freeze([...(p as number[])]) as T;
  });
  return Object.freeze(out) as T[];
};

const closedArg = (v: unknown, fallback: boolean) => (v === undefined ? fallback : !!v);

/**
 * Give spline-like nodes an `at(t)` accessor. It returns an opaque point
 * reference which the compiler resolves *after* spline overrides, so anything
 * anchored to the curve follows it while editing.
 */
const attachAt = <T extends { name?: string }>(node: T): T => {
  Object.defineProperty(node, 'at', {
    enumerable: false,
    configurable: false,
    writable: false,
    value: function (this: T, t: number) {
      if (!this.name) {
        throw new Error(
          'at(): give the spline a name so the reference can be resolved, e.g. spline({ name: "rail", ... })',
        );
      }
      if (typeof t !== 'number' || !Number.isFinite(t)) {
        throw new Error('at(): expected a finite number between 0 and 1');
      }
      return Object.freeze({
        __splinePoint: true as const,
        name: this.name,
        t: Math.min(1, Math.max(0, t)),
      });
    },
  });
  return node;
};

export interface SplineOpts {
  points: Vec3[];
  /** tube radius */
  r?: number;
  closed?: boolean;
  /** samples per span; higher = smoother and heavier */
  seg?: number;
  name?: string;
}
export const spline = (o: SplineOpts): SplineNode =>
  mk(
    attachAt({
      kind: 'spline' as const,
      points: pointsArg<Vec3>('spline', o.points, 3, 2),
      r: numArg('spline', 'r', o.r, 0.05, (n) => n > 0),
      closed: closedArg(o.closed, false),
      seg: Math.round(numArg('spline', 'seg', o.seg, 10, (n) => n >= 1 && n <= 64)),
      name: typeof o.name === 'string' ? o.name : undefined,
    }),
  );

export interface ExtrudeOpts {
  /** profile in the xy plane */
  points: Vec2[];
  /** extrusion depth along z */
  h?: number;
  round?: number;
  closed?: boolean;
  seg?: number;
  name?: string;
}
export const extrude = (o: ExtrudeOpts): ExtrudeNode =>
  mk(
    attachAt({
      kind: 'extrude' as const,
      points: pointsArg<Vec2>('extrude', o.points, 2, 3),
      h: numArg('extrude', 'h', o.h, 1, (n) => n > 0),
      round: numArg('extrude', 'round', o.round, 0, (n) => n >= 0),
      closed: closedArg(o.closed, true),
      seg: Math.round(numArg('extrude', 'seg', o.seg, 8, (n) => n >= 1 && n <= 64)),
      name: typeof o.name === 'string' ? o.name : undefined,
    }),
  );

/** A construction curve for surface(): a spline, extruded profile or lathe profile. */
const curveArg = (fn: string, name: string, v: unknown): Node => {
  if (
    !v ||
    typeof v !== 'object' ||
    !('kind' in v) ||
    !['spline', 'extrude', 'lathe'].includes((v as Node).kind)
  ) {
    fail(
      `${fn}(): "${name}" must be a spline, extrude or lathe curve (got ${typeof v === 'object' ? String((v as Node | null)?.kind) : typeof v})`,
    );
  }
  return v as Node;
};

export interface SurfaceOpts {
  /** first construction curve a(t) */
  a: unknown;
  /** second construction curve b(t) */
  b: unknown;
  /** thickness of the solidified sheet (default 0.05) */
  thickness?: number;
  /** rulings along t (default 48); dense enough that rulings overlap */
  samples?: number;
  /** subdivisions of each ruling evaluated in the shader (default 1) */
  sSamples?: number;
  /**
   * GLSL for the connect, evaluated on the GPU:
   * a body of `vec3 connect(vec3 a, vec3 b, float s)` or a bare expression.
   * Defaults to `mix(a, b, s)`.
   */
  connect?: string;
  /** extra bounds margin for connects that leave the a/b segment */
  margin?: number;
}

/**
 * A ruled surface between two construction curves:
 *
 *   P(t, s) = connect(a(t), b(t), s)
 *
 * The result is solidified into a thick ribbon. The construction curves stay
 * editable in the spline editor (and animatable): the rulings are resampled
 * after spline overrides, so the surface tracks both curves. The connect is
 * GLSL and is evaluated per raymarch sample, not baked into uniforms.
 */
export function surface(o: SurfaceOpts): SurfaceNode {
  if (!o || typeof o !== 'object') fail('surface(): expected { a, b, ... }');
  const a = curveArg('surface', 'a', o.a);
  const b = curveArg('surface', 'b', o.b);
  if (o.connect !== undefined && typeof o.connect !== 'string') {
    fail('surface(): "connect" must be GLSL code, e.g. connect: "mix(a, b, s)"');
  }
  const connect =
    typeof o.connect === 'string' && o.connect.trim() ? o.connect : DEFAULT_SURFACE_CONNECT;
  return mk({
    kind: 'surface' as const,
    a,
    b,
    thickness: numArg('surface', 'thickness', o.thickness, 0.05, (n) => n > 0),
    samples: Math.round(numArg('surface', 'samples', o.samples, 48, (n) => n >= 2 && n <= 256)),
    sSamples: Math.round(numArg('surface', 'sSamples', o.sSamples, 1, (n) => n >= 1 && n <= 32)),
    connect,
    margin: numArg('surface', 'margin', o.margin, 0, (n) => n >= 0),
  });
}

export interface LatheOpts {
  /** profile as [radius, y] pairs */
  points: Vec2[];
  closed?: boolean;
  seg?: number;
  name?: string;
}
export const lathe = (o: LatheOpts): LatheNode =>
  mk(
    attachAt({
      kind: 'lathe' as const,
      points: pointsArg<Vec2>('lathe', o.points, 2, 3),
      closed: closedArg(o.closed, true),
      seg: Math.round(numArg('lathe', 'seg', o.seg, 8, (n) => n >= 1 && n <= 64)),
      name: typeof o.name === 'string' ? o.name : undefined,
    }),
  );

/* ------------------------------------------------------------------ */
/* polar repeat                                                        */
/* ------------------------------------------------------------------ */

export interface PolarRepeatOpts {
  /** number of identical copies around the Y axis */
  count: number;
  /** angular offset of the first copy, degrees */
  offset?: number;
  /**
   * angular width of the child behind the copy angle, degrees. Overlapping
   * copies evaluate their neighbours; omit for a child that fits at its angle.
   */
  spread?: number;
  /** label for the component tree */
  name?: string;
}

/**
 * A polar array of one shape around the Y axis. The shader folds the query
 * point into the nearest sector and evaluates the child once, so the runtime
 * cost is independent of `count`; count/offset are uniforms, so changing them
 * does not recompile the shader.
 */
export function polarRepeat(o: PolarRepeatOpts, child: unknown): RepeatNode {
  if (!o || typeof o !== 'object') fail('polarRepeat(): expected { count, ... }');
  const count = Math.round(
    numArg('polarRepeat', 'count', o.count, undefined, (n) => n >= 1 && n <= 256),
  );
  const kids = flatten([child], 'polarRepeat');
  if (kids.length !== 1) fail('polarRepeat(): expected exactly one shape');
  return mk({
    kind: 'repeat' as const,
    count,
    offset: numArg('polarRepeat', 'offset', o.offset, 0),
    spread: numArg('polarRepeat', 'spread', o.spread, 0, (n) => n >= 0),
    child: kids[0],
    name: typeof o.name === 'string' ? o.name : undefined,
  });
}

/* ------------------------------------------------------------------ */
/* numeric helpers + expression language                               */
/* ------------------------------------------------------------------ */

export const PI = Math.PI;
export const TAU = Math.PI * 2;
export const rad = (deg: number) => (deg * Math.PI) / 180;
export const deg = (r: number) => (r * 180) / Math.PI;
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const range = (n: number): number[] => Array.from({ length: Math.max(0, Math.floor(n)) }, (_, i) => i);
export const v2 = (x: number, y: number): Vec2 => [x, y];
export const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z];

/** A vector constant with three sliders, for `params`. */
export function vec3(value: Vec3, opts: Vec3Opts = {}): Vec3Control {
  return vec3Control(value, opts);
}

/** A string constant picked from a list. */
export function select(value: string, options: string[], label?: string) {
  if (typeof value !== 'string' || !Array.isArray(options)) {
    throw new Error('select(): expected select(value, [options])');
  }
  return selectControl(value, options, label);
}

export { num, int, bool, color };
