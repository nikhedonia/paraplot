/**
 * Ambient typings handed to Monaco. Kept in sync with core/dsl.ts by hand.
 */
export const DSL_TYPES = String.raw`
/* ------------------------------------------------------------------
 * paraplot DSL — TypeScript scene
 *
 *   export const params = {
 *     size: num(1, { min: 0.2, max: 2 }),
 *     tint: color('#c9d2da'),
 *   };
 *
 *   export default function build(k: typeof params, t: number) { ... }
 *
 * k holds the resolved parameter values (so k.size is a number and k.tint is
 * a string), and t is the scene clock in seconds. Declare t to animate the
 * scene graph. defineScene(params, (k, t) => ...) is an alternative that
 * infers k automatically.
 * ------------------------------------------------------------------ */

type Vec2 = [number, number];
type Vec3 = [number, number, number];

/** An opaque scene-graph node returned by every DSL shape. */
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

/**
 * Type a scene build function and infer its parameter values from params.
 *
 *   export const params = {
 *     size: num(1, { min: 0.2, max: 2 }),
 *     tint: color('#c9d2da'),
 *   };
 *
 *   export default defineScene(params, (k, t) => {
 *     // k.size: number, k.tint: string, t: number
 *     return paint(box({ s: k.size }), k.tint);
 *   });
 *
 * The explicit alternative is:
 *
 *   export default function build(k: typeof params, t: number) { ... }
 *
 * Omit t to build a static scene. The params argument is only used for type
 * inference; the runtime passes the resolved values to build.
 */
declare function defineScene<P extends object>(
  params: P,
  build: (k: P, t: number) => Solid,
): (k: P, t: number) => Solid;

/** A point, or an opaque spline reference resolved at compile time. */
type Point3 = Vec3 | SplinePoint;
/** A shape, or an array / falsy value that can be flattened away. */
type SolidInput = Solid | Solid[] | null | undefined | false;

interface NumberOpts {
  /** minimum slider value */
  min?: number;
  /** maximum slider value */
  max?: number;
  /** slider step; also the number of decimals shown */
  step?: number;
  /** label shown in the parameter dock (defaults to the key) */
  label?: string;
  /** unit shown next to the value */
  unit?: string;
}
interface Vec3Opts {
  /** minimum value for each component */
  min?: number;
  /** maximum value for each component */
  max?: number;
  /** slider step for each component */
  step?: number;
  /** label shown in the parameter dock (defaults to the key) */
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

interface PolarRepeatOpts {
  /** number of identical copies around the Y axis */
  count: number;
  /** angular offset of the first copy, degrees */
  offset?: number;
  /** angular width of the child behind the copy angle, degrees */
  spread?: number;
  /** label shown in the component tree */
  name?: string;
}

/**
 * Polar array of one shape around the Y axis. The shader folds the query
 * point into the nearest sector and evaluates the child once, so the cost is
 * independent of the copy count; changing count only updates a uniform.
 */
declare function polarRepeat(o: PolarRepeatOpts, child: SolidInput): Solid;

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
interface PaintOpts {
  /** surface roughness in [0, 1] (default 0.55) */
  rough?: number;
}
/** Assign a material colour; the outermost paint wins. */
declare function paint(node: SolidInput, hex: string, opts?: PaintOpts): Solid;

/* ---- primitives ---- */

interface SphereOpts { /** radius (default 1) */ r?: number }
interface BoxOpts { /** half extents */ s?: Vec3 | number; /** edge rounding */ round?: number }
interface EllipsoidOpts { /** per-axis radii */ r?: Vec3 | number }
interface TorusOpts { /** ring radius */ R?: number; /** tube radius */ r?: number }
interface CylinderOpts { /** radius */ r?: number; /** total height */ h?: number; /** rounded rim */ round?: number }
interface ConeOpts { /** base radius */ r?: number; /** total height */ h?: number }
interface CapsuleOpts { /** start point */ a?: Point3; /** end point */ b?: Point3; /** radius */ r?: number }
interface PlaneOpts { /** normal */ n?: Vec3; /** plane offset */ d?: number }

/** Sphere of radius r. */
declare function sphere(o?: SphereOpts): Solid;
/** Box with half extents s, optional rounded edges. */
declare function box(o?: BoxOpts): Solid;
/** Axis aligned ellipsoid. */
declare function ellipsoid(o?: EllipsoidOpts): Solid;
/** Torus around the y axis. */
declare function torus(o?: TorusOpts): Solid;
/** Capped cylinder centred on the origin, optional rounded rim. */
declare function cylinder(o?: CylinderOpts): Solid;
/** Cone, apex on +y, base on -y. */
declare function cone(o?: ConeOpts): Solid;
/** Capsule between two points (or spline point references). */
declare function capsule(o?: CapsuleOpts): Solid;
/** Half space: dot(p, n) + d < 0 is inside. */
declare function plane(o?: PlaneOpts): Solid;

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

/* ---- ruled surfaces ---- */

interface SurfaceOpts {
  /** first construction curve a(t) */
  a: SplineSolid;
  /** second construction curve b(t) */
  b: SplineSolid;
  /** thickness of the solidified sheet; rulings are round-edged */
  thickness?: number;
  /** rulings along t; keep the spacing below thickness so the sheet is solid */
  samples?: number;
  /** subdivisions of each ruling evaluated in the shader (default 1) */
  sSamples?: number;
  /**
   * GLSL for vec3 connect(vec3 a, vec3 b, float s), evaluated on the GPU.
   * Pass an expression ("mix(a, b, s)") or a body with a return. Defaults
   * to the straight ruling mix(a, b, s).
   */
  connect?: string;
  /** extra bounds margin for connects that leave the a/b segment */
  margin?: number;
}
/**
 * A ruled surface between two construction curves, solidified into a thin
 * sheet. Both curves are editable in the spline editor but are not rendered
 * themselves. The connect shader maps a(t) to b(t) for s in [0,1] on the GPU.
 */
declare function surface(o: SurfaceOpts): Solid;

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
  { name: 'defineScene', signature: 'export default defineScene(params, (k, t) => …)', note: 'Typed scene · k inferred' },
  { name: 'build', signature: 'build(k: typeof params, t?: number)', note: 'Pure scene function · typed args' },
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
  { name: 'surface', signature: 'surface({ a, b, thickness })', note: 'Ruled surface · GPU connect' },
  { name: 'polarRepeat', signature: 'polarRepeat({ count }, shape)', note: 'Polar array · one GPU fold' },
];
