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

/** A program whose shader text is omitted when it did not change. */
export interface ProgramWire extends Omit<ProgramView, 'glsl'> {
  glsl?: string;
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
  /** animation time to build at; keeps a live scene from snapping back to t=0 */
  time?: number;
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

/**
 * Worker payload: the editor-only parts (tree, splines, base splines, schema)
 * are omitted when they did not change since the previous successful compile.
 * The client merges them back into a full `CompileSuccess`.
 */
export interface CompileSuccessWire {
  ok: true;
  program: ProgramWire | null;
  splines: SplineInfo[] | null;
  baseSplines: SplineInfo[] | null;
  tree: TreeNode | null;
  schema: ParamSchema | null;
  values: ParamValues;
  animated: boolean;
  ms: number;
}

export type CompileOutcomeWire = CompileSuccessWire | CompileFailure;

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

/** Per-frame animation payload: only the values buffer changes every frame. */
export interface AnimateSuccessWire {
  ok: true;
  values: Float32Array;
  bounds: Aabb;
  materials: Material[];
  stats: ProgramView['stats'];
  usesTime: boolean;
  /** omitted when the shader text did not change */
  glsl?: string;
  ms: number;
}

export type AnimateOutcomeWire = AnimateSuccessWire | AnimateFailure;

export type CompileWorkerMessage =
  | ({ type: 'compiled'; id: number } & CompileOutcomeWire)
  | ({ type: 'animated'; id: number } & AnimateOutcomeWire);

export type CompileWorkerRequest =
  | ({ type: 'compile'; id: number } & CompileRequest)
  | { type: 'animate'; id: number; time: number };
