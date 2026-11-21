import type { ParamSchema, ParamValues } from './controls';
import type { TreeNode } from './sceneTree';
import type { Aabb, Material, SplineInfo } from './types';

/** A compiled program stripped of its (non-serializable) scene graph. */
export interface ProgramView {
  glsl: string;
  values: Float32Array;
  bounds: Aabb;
  materials: Material[];
  stats: { nodes: number; values: number; materials: number; lines: number };
  usesTime: boolean;
}

export interface CompileFilters {
  hidden: string[];
  isolated: string | null;
}

export interface CompileRequest {
  source: string;
  values: ParamValues;
  overrides: Record<string, number[][]>;
  filters: CompileFilters;
}

export interface CompileSuccess {
  ok: true;
  /** the filtered scene that should be rendered (null when everything is hidden) */
  program: ProgramView | null;
  /** editable splines including the current point offsets */
  splines: SplineInfo[];
  /** points before offsets: the base for the spline editor */
  baseSplines: SplineInfo[];
  tree: TreeNode;
  schema: ParamSchema;
  values: ParamValues;
  animated: boolean;
  ms: number;
}

export interface CompileFailure {
  ok: false;
  error: string;
  schema: ParamSchema;
  ms: number;
}

export type CompileOutcome = CompileSuccess | CompileFailure;

export interface AnimateSuccess {
  ok: true;
  program: ProgramView;
  ms: number;
}

export interface AnimateFailure {
  ok: false;
  error: string;
}

export type AnimateOutcome = AnimateSuccess | AnimateFailure;

export type CompileWorkerMessage =
  | ({ type: 'compiled'; id: number } & CompileOutcome)
  | ({ type: 'animated'; id: number } & AnimateOutcome);

export type CompileWorkerRequest =
  | ({ type: 'compile'; id: number } & CompileRequest)
  | { type: 'animate'; id: number; time: number };
