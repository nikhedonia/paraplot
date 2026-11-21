import * as DSL from './dsl';
import type { Node } from './types';
import type { ParamSchema, ParamValues } from './controls';
import { resolveParams } from './controls';
import { applySplineOverrides, collectSplines, generate } from './codegen';
import type { CompiledProgram } from './codegen';
import type { SplineInfo } from './types';

export interface CompileOk {
  ok: true;
  program: CompiledProgram;
  schema: ParamSchema;
  values: ParamValues;
  /** true when the scene function takes a time argument: `(k, t) => ...` */
  animated: boolean;
  /** wall clock time of the pure compile */
  ms: number;
  /** spline points before per-point overrides: the base for editing */
  baseSplines: SplineInfo[];
}

export interface CompileErr {
  ok: false;
  error: string;
  schema: ParamSchema;
  ms: number;
}

export type CompileResult = CompileOk | CompileErr;

interface UserModule {
  params?: ParamSchema;
  build?: (values: ParamValues) => Node;
  __default?: unknown;
}

const DSL_NAMES = Object.keys(DSL).filter((k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k));

/**
 * The user file is plain javascript with `params` and a default export.
 * We rewrite the module statements into function-body statements. No
 * transpiler: the DSL is injected as ordinary bindings.
 */
function rewrite(source: string): string {
  let out = source.replace(/^\s*import\s+(?:[^;]*?from\s+)?['"][^'"]*['"];?\s*$/gm, '');
  out = out.replace(/^\s*export\s+default\s+/gm, 'const __default = ');
  out = out.replace(/^\s*export\s+(?=(?:const|let|var|function|class|async)\b)/gm, '');
  return out;
}

/** `new Function` results are cached by source: the module is pure by contract. */
const moduleCache = new Map<string, UserModule>();

function evalModule(source: string): UserModule {
  const cached = moduleCache.get(source);
  if (cached) return cached;

  const body = `
"use strict";
const { ${DSL_NAMES.join(', ')} } = __dsl;
${rewrite(source)}
;
return {
  params: typeof params !== 'undefined' ? params : undefined,
  build: typeof build !== 'undefined' && typeof build === 'function' ? build : undefined,
  __default: typeof __default !== 'undefined' ? __default : undefined,
};
`;
  let factory: Function;
  try {
    // eslint-disable-next-line no-new-func
    factory = new Function('__dsl', body);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    throw new Error(`syntax error in the scene: ${msg}`);
  }
  const mod = factory(DSL) as UserModule;
  moduleCache.set(source, mod);
  if (moduleCache.size > 8) {
    const oldest = moduleCache.keys().next().value;
    if (oldest !== undefined) moduleCache.delete(oldest);
  }
  return mod;
}

function pickBuild(mod: UserModule): ((v: ParamValues, t: number) => Node) | null {
  if (typeof mod.__default === 'function') return mod.__default as (v: ParamValues, t: number) => Node;
  if (typeof mod.build === 'function') return mod.build;
  return null;
}

const isNode = (v: unknown): v is Node =>
  !!v && typeof v === 'object' && typeof (v as { kind?: unknown }).kind === 'string';

/**
 * PURE: source + parameter values + spline offsets + time in, a compiled
 * program out. Nothing is mutated; identical inputs give identical shaders.
 * (The parsed module is memoised, which is safe because modules are pure.)
 */
export function compileScene(
  source: string,
  values: ParamValues = {},
  overrides: Record<string, number[][]> = {},
  time = 0,
): CompileResult {
  const t0 = performance.now();
  let schema: ParamSchema = {};

  try {
    const mod = evalModule(source);

    if (mod.params !== undefined) {
      if (!mod.params || typeof mod.params !== 'object' || Array.isArray(mod.params)) {
        throw new Error('params must be a plain object');
      }
      schema = mod.params;
    }

    const build = pickBuild(mod);
    if (!build) {
      throw new Error(
        'No scene found. Export a default function: `export default (k) => union(...)`.',
      );
    }

    const resolved = resolveParams(schema, values);
    let node: unknown;
    try {
      node = build(resolved, time);
    } catch (err) {
      throw new Error(`scene: ${(err as Error).message ?? String(err)}`);
    }
    if (!isNode(node)) {
      throw new Error('The scene function must return a shape (sphere, union, group, ...).');
    }

    // points as generated, before the editor's per-point offsets are applied
    const baseSplines = collectSplines(node);
    const finalNode = applySplineOverrides(node, overrides);
    const program = generate(finalNode);

    return {
      ok: true,
      program,
      schema,
      values: resolved,
      animated: build.length >= 2,
      ms: performance.now() - t0,
      baseSplines,
    };
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      error: e?.message ? e.message : String(err),
      schema,
      ms: performance.now() - t0,
    };
  }
}

/** Exposed for tests / the shader tab. */
export { generate, applySplineOverrides };
