/**
 * Ambient typings handed to Monaco. Kept in sync with core/dsl.ts by hand.
 */
export const DSL_TYPES = String.raw`
/* ------------------------------------------------------------------
 * paraplot DSL
 *
 *   export const params = { ... };
 *   export default function build(k, t) { ... }
 *
 * k holds the parameter values, t is the scene clock in seconds.
 * Declare the second argument to animate the scene graph.
 * ------------------------------------------------------------------ */

type Vec2 = [number, number];
type Vec3 = [number, number, number];

/** An opaque shape in the scene graph. */
interface Solid {
  readonly kind: string;
}

/**
 * An opaque point on a spline, created by spline(...).at(t).
 * Pass it to capsule endpoints or translate(); it is resolved by the
 * compiler after spline overrides, so anchored parts follow curve edits.
 */
interface SplinePoint {
  readonly __splinePoint: true;
}

/** A spline-like solid with a point accessor. */
interface SplineSolid extends Solid {
  /** Point at t in [0,1]. The spline must have a name. */
  at(t: number): SplinePoint;
}

type Point3 = Vec3 | SplinePoint;
type SolidInput = Solid | Solid[] | null | undefined | false;

interface NumberOpts {
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  unit?: string;
}
interface Vec3Opts {
  min?: number;
  max?: number;
  step?: number;
  label?: string;
}

/** A numeric constant with a slider in the parameter dock. */
declare function num(value: number, opts?: NumberOpts): number;
/** An integer constant with a stepped slider. */
declare function int(value: number, opts?: NumberOpts): number;
/** A boolean constant with a toggle. */
declare function bool(value: boolean, label?: string): boolean;
/** A colour constant: #rgb, #rgba, #rrggbb or #rrggbbaa (alpha is dropped). */
declare function color(value: string, label?: string): string;
/** A string constant picked from a list. */
declare function select(value: string, options: string[], label?: string): string;
/** A vector constant with three sliders. */
declare function vec3(value: Vec3, opts?: Vec3Opts): Vec3;

/* ---- groups and transforms ---- */

interface Xform {
  /** label shown in the component tree */
  name?: string;
  /** translation, or a spline point reference */
  t?: Point3 | number;
  /** euler rotation in degrees, applied X then Y then Z */
  r?: Vec3 | number;
  /** scale, uniform or per axis */
  s?: Vec3 | number;
  /** how children combine (default "union") */
  op?: OpKind;
  /** blend radius for the smooth operations */
  k?: number;
}

type OpKind =
  | "union"
  | "intersect"
  | "subtract"
  | "smoothUnion"
  | "smoothIntersect"
  | "smoothSubtract";

/**
 * Establish a local coordinate system. Forward transform is
 * translate * rotate * scale; children are built in local space.
 *
 *   group({ t: [0, 1, 0], r: [0, 45, 0], s: 0.5, op: "smoothUnion", k: 0.1 }, ...)
 */
declare function group(o: Xform, ...children: SolidInput[]): Solid;
declare function group(...children: SolidInput[]): Solid;
declare function translate(t: Point3 | number, ...children: SolidInput[]): Solid;
declare function rotate(r: Vec3 | number, ...children: SolidInput[]): Solid;
declare function scale(s: Vec3 | number, ...children: SolidInput[]): Solid;
declare const transform: typeof group;

/* ---- set operations ---- */

/** Boolean union (min). Accepts arrays and falsy values so you can map(). */
declare function union(...children: SolidInput[]): Solid;
declare function intersect(...children: SolidInput[]): Solid;
declare function subtract(base: SolidInput, ...children: SolidInput[]): Solid;
declare function smoothUnion(k: number, ...children: SolidInput[]): Solid;
declare function smoothIntersect(k: number, ...children: SolidInput[]): Solid;
declare function smoothSubtract(k: number, base: SolidInput, ...children: SolidInput[]): Solid;

/* ---- modifiers ---- */

/** Grow (positive d) or erode (negative d) a shape. */
declare function offset(node: SolidInput, d: number): Solid;
/** Hollow a shape, keeping a wall of thickness t. */
declare function shell(node: SolidInput, t: number): Solid;
/** Assign a material colour; the outermost paint wins. */
declare function paint(node: SolidInput, hex: string, opts?: { rough?: number }): Solid;

/* ---- primitives ---- */

/** Sphere of radius r. */
declare function sphere(o?: { r?: number }): Solid;
/** Box with half extents s, optional rounded edges. */
declare function box(o?: { s?: Vec3 | number; round?: number }): Solid;
/** Axis aligned ellipsoid. */
declare function ellipsoid(o?: { r?: Vec3 | number }): Solid;
/** Torus around the y axis. */
declare function torus(o?: { R?: number; r?: number }): Solid;
/** Capped cylinder centred on the origin, optional rounded rim. */
declare function cylinder(o?: { r?: number; h?: number; round?: number }): Solid;
/** Cone, apex on +y, base on -y. */
declare function cone(o?: { r?: number; h?: number }): Solid;
/** Capsule between two points (or spline point references). */
declare function capsule(o?: { a?: Point3; b?: Point3; r?: number }): Solid;
/** Half space: dot(p, n) + d < 0 is inside. */
declare function plane(o?: { n?: Vec3; d?: number }): Solid;

/* ---- implicit surfaces ---- */

interface ImplicitOpts {
  /** divide the field by its gradient so it can be marched (default true) */
  normalize?: boolean;
  /** conservative bounds, cube half size or explicit box */
  bounds?: number | Vec3;
  /** named constants usable in the equation */
  vars?: Record<string, number>;
}

/**
 * A shape from an implicit equation: negative inside, zero on the surface.
 * The equation is a string in a small expression language:
 *
 *   implicit("x*x + y*y + z*z - 1", { bounds: 1.2 })
 *   implicit("abs(sin(x*f) * cos(y*f)) - t", { vars: { f: 6, t: 0.4 } })
 *
 * Variables: x, y, z, p (vec3, so p.x works), time, pi, tau.
 * Functions: sin cos tan asin acos atan abs sign floor ceil round
 *            fract sqrt exp log pow min max mod clamp mix step
 *            smoothstep length dot cross normalize select vec2 vec3
 */
declare function implicit(equation: string, opts?: ImplicitOpts): Solid;

/* ---- splines ---- */

interface SplineOpts {
  /** control points, [x, y, z] */
  points: number[][];
  /** tube radius */
  r?: number;
  closed?: boolean;
  /** samples per span (default 10) */
  seg?: number;
  /** stable id used by the spline editor; required for at(t) */
  name?: string;
}
/** A tube swept along a centripetal Catmull-Rom spline. Name it to use .at(t). */
declare function spline(o: SplineOpts): SplineSolid;

interface ExtrudeOpts {
  /** profile in the xy plane, [x, y] */
  points: number[][];
  /** depth along z */
  h?: number;
  round?: number;
  closed?: boolean;
  seg?: number;
  name?: string;
}
/** Extrude a closed profile along z. Name it to use .at(t). */
declare function extrude(o: ExtrudeOpts): SplineSolid;

interface LatheOpts {
  /** profile as [radius, y] pairs */
  points: number[][];
  closed?: boolean;
  seg?: number;
  name?: string;
}
/** Revolve a closed [radius, y] profile around the y axis. Name it to use .at(t). */
declare function lathe(o: LatheOpts): SplineSolid;

/* ---- numeric helpers ---- */

declare const PI: number;
declare const TAU: number;
declare function rad(deg: number): number;
declare function deg(rad: number): number;
declare function lerp(a: number, b: number, t: number): number;
/** [0, 1, ..., n-1] */
declare function range(n: number): number[];
declare function v2(x: number, y: number): Vec2;
declare function v3(x: number, y: number, z: number): Vec3;
`;

export const API_REFERENCE: Array<{ name: string; signature: string; note: string }> = [
  { name: 'params', signature: 'export const params = { … }', note: 'Constants + controls' },
  { name: 'build', signature: 'export default (k, t) => Solid', note: 'Pure scene function · t in seconds' },
  { name: 'group', signature: 'group({ t, r, s, op, k }, ...kids)', note: 'Local coordinates' },
  { name: 'union', signature: 'union(...kids)', note: 'min' },
  { name: 'intersect', signature: 'intersect(...kids)', note: 'max' },
  { name: 'subtract', signature: 'subtract(base, ...kids)', note: 'max(a, -b)' },
  { name: 'smoothUnion', signature: 'smoothUnion(k, ...kids)', note: 'Blended min' },
  { name: 'offset', signature: 'offset(node, d)', note: 'Dilate / erode' },
  { name: 'shell', signature: 'shell(node, t)', note: 'Hollow' },
  { name: 'paint', signature: 'paint(node, "#hex")', note: 'Material' },
  { name: 'implicit', signature: 'implicit("x*x + y*y - 1")', note: 'Equation surface' },
  { name: 'spline', signature: 'spline({ points, r })', note: 'Tube path' },
  { name: 'extrude', signature: 'extrude({ points, h })', note: 'Profile → solid' },
  { name: 'lathe', signature: 'lathe({ points })', note: 'Revolve profile' },
];
