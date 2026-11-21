export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export type OpKind =
  | 'union'
  | 'intersect'
  | 'subtract'
  | 'smoothUnion'
  | 'smoothIntersect'
  | 'smoothSubtract';

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/**
 * Opaque point on a named spline. Created by `spline(...).at(t)`, accepted by
 * capsule endpoints and translations, and resolved by the compiler after
 * spline overrides have been applied.
 */
export interface SplinePointRef {
  readonly __splinePoint: true;
  readonly name: string;
  readonly t: number;
}

export interface SplineInfo {
  /** stable id: user supplied name, or the traversal index */
  id: string;
  name: string;
  kind: 'spline' | 'extrude' | 'lathe';
  dim: 2 | 3;
  points: number[][];
  closed: boolean;
  /** shape parameters, used by the 3D spline preview */
  r?: number;
  h?: number;
  round?: number;
  seg?: number;
}

export interface Material {
  color: Vec3; // linear rgb
  rough: number;
}

/* ------------------------------------------------------------------ *
 * Scene graph. Everything below is plain, serialisable data: the DSL
 * builds it, the compiler consumes it. No behaviour, no references to
 * the outside world.
 * ------------------------------------------------------------------ */

export type Node =
  | SphereNode
  | BoxNode
  | EllipsoidNode
  | TorusNode
  | CylinderNode
  | ConeNode
  | CapsuleNode
  | PlaneNode
  | ImplicitNode
  | SplineNode
  | ExtrudeNode
  | LatheNode
  | OpNode
  | GroupNode
  | OffsetNode
  | ShellNode
  | PaintNode;

export interface SphereNode {
  kind: 'sphere';
  r: number;
}

export interface BoxNode {
  kind: 'box';
  s: Vec3; // half extents
  round: number;
}

export interface EllipsoidNode {
  kind: 'ellipsoid';
  r: Vec3;
}

export interface TorusNode {
  kind: 'torus';
  R: number;
  r: number;
}

export interface CylinderNode {
  kind: 'cylinder';
  r: number;
  h: number;
  round: number;
}

export interface ConeNode {
  kind: 'cone';
  r: number;
  h: number;
}

export interface CapsuleNode {
  kind: 'capsule';
  a: Vec3;
  b: Vec3;
  /** unresolved spline references (the compiler fills a/b from these) */
  aRef?: SplinePointRef;
  bRef?: SplinePointRef;
  r: number;
}

export interface PlaneNode {
  kind: 'plane';
  n: Vec3;
  d: number;
}

export interface ImplicitNode {
  kind: 'implicit';
  /** the equation, in the tiny expression language */
  source: string;
  /** named constants referenced by the equation (emitted as uniforms) */
  vars: Record<string, number>;
  normalize: boolean;
  bounds: Vec3;
}

export interface SplineNode {
  kind: 'spline';
  points: Vec3[];
  r: number;
  closed: boolean;
  seg: number;
  name?: string;
}

export interface ExtrudeNode {
  kind: 'extrude';
  points: Vec2[];
  h: number;
  round: number;
  closed: boolean;
  seg: number;
  name?: string;
}

export interface LatheNode {
  kind: 'lathe';
  points: Vec2[];
  closed: boolean;
  seg: number;
  name?: string;
}

export interface OpNode {
  kind: 'op';
  op: OpKind;
  k: number;
  children: Node[];
}

export interface GroupNode {
  kind: 'group';
  /** optional label shown in the component tree */
  name?: string;
  t: Vec3;
  /** unresolved spline reference for the translation */
  tRef?: SplinePointRef;
  r: Vec3; // euler degrees, applied X then Y then Z
  s: Vec3;
  op: OpKind;
  k: number;
  children: Node[];
}

export interface OffsetNode {
  kind: 'offset';
  d: number;
  child: Node;
}

export interface ShellNode {
  kind: 'shell';
  t: number;
  child: Node;
}

export interface PaintNode {
  kind: 'paint';
  color: Vec3;
  rough: number;
  child: Node;
}
