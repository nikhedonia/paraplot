/**
 * Scene compiler worker. The DSL build, codegen, scene tree and visibility
 * filtering all run here so opening a heavy scene never blocks the UI.
 */
import { compileScene } from './compile';
import { generate } from './codegen';
import { buildSceneTree, isolateNode, pruneHidden, type TreeNode } from './sceneTree';
import type { Node, SplineInfo } from './types';
import type { ParamSchema } from './controls';
import type {
  CompileFilters,
  CompileRequest,
  CompileWorkerRequest,
  CompileWorkerMessage,
  ProgramView,
  ProgramWire,
} from './compileProtocol';
import type { CompiledProgram } from './codegen';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

let last: (CompileRequest & { time: number }) | null = null;

/** editor-only payloads are rebuilt every compile, so remember what was sent */
interface StructuralCache {
  source: string;
  treeKey: string;
  tree: TreeNode;
  splinesKey: string;
  splines: SplineInfo[];
  baseKey: string;
  baseSplines: SplineInfo[];
  schema: ParamSchema;
}
let lastStruct: StructuralCache | null = null;
let lastGlsl = '';

const post = (message: CompileWorkerMessage, transfer: Transferable[] = []) =>
  scope.postMessage(message, transfer);

function view(program: CompiledProgram): ProgramView {
  return {
    glsl: program.glsl,
    values: program.values,
    bounds: program.bounds,
    materials: program.materials,
    stats: program.stats,
    usesTime: program.usesTime,
  };
}

/** Apply the component-tree filters in the worker; the UI never touches the graph. */
function filterRoot(root: Node, filters: CompileFilters): Node | null {
  let node = root;
  if (filters.isolated) {
    const solo = isolateNode(node, filters.isolated);
    if (solo) node = solo;
  }
  if (filters.hidden.length > 0) {
    const pruned = pruneHidden(node, new Set(filters.hidden));
    if (!pruned) return null;
    node = pruned;
  }
  return node;
}

function compile(req: CompileRequest, id: number, time: number): void {
  const res = compileScene(req.source, req.values, req.overrides, time);
  if (!res.ok) {
    // keep the previous successful inputs so animation continues on the
    // displayed (last valid) scene while the editor shows the error
    post({ type: 'compiled', id, ok: false, error: res.error, schema: res.schema, ms: res.ms });
    return;
  }
  last = { ...req, time };

  const full = res.program;
  const filtered = filterRoot(full.scene, req.filters);
  const displayed = filtered === null ? null : filtered === full.scene ? full : generate(filtered);

  // the editor payload (tree, splines, schema) only changes when the scene
  // graph changes; a parameter drag must not clone hundreds of nodes
  const tree = buildSceneTree(full.scene);
  const treeKey = JSON.stringify(tree);
  const splinesKey = JSON.stringify(full.splines);
  const baseKey = JSON.stringify(res.baseSplines);
  const cache = lastStruct;
  const treeOut = cache?.treeKey === treeKey ? null : tree;
  const splinesOut = cache?.splinesKey === splinesKey ? null : full.splines;
  const baseOut = cache?.baseKey === baseKey ? null : res.baseSplines;
  const schemaOut = cache?.source === req.source ? null : res.schema;
  lastStruct = {
    source: req.source,
    treeKey,
    tree,
    splinesKey,
    splines: full.splines,
    baseKey,
    baseSplines: res.baseSplines,
    schema: res.schema,
  };

  // numeric parameters live in the uniform pool: the shader text is stable
  // across slider drags, so only send it when it really changed
  const program = displayed ? view(displayed) : null;
  let wireProgram: ProgramWire | null = null;
  if (program) {
    wireProgram = program.glsl === lastGlsl ? { ...program, glsl: undefined } : program;
    lastGlsl = program.glsl;
  }
  const transfer = wireProgram ? [wireProgram.values.buffer] : [];
  post(
    {
      type: 'compiled',
      id,
      ok: true,
      program: wireProgram,
      splines: splinesOut,
      baseSplines: baseOut,
      tree: treeOut,
      schema: schemaOut,
      values: res.values,
      animated: res.animated,
      ms: res.ms,
    },
    transfer,
  );
}

function animate(id: number, time: number): void {
  if (!last) {
    post({ type: 'animated', id, ok: false, error: 'the scene has not been compiled yet' });
    return;
  }
  const res = compileScene(last.source, last.values, last.overrides, time);
  if (!res.ok) {
    post({ type: 'animated', id, ok: false, error: res.error });
    return;
  }
  const full = res.program;
  const filtered = filterRoot(full.scene, last.filters);
  if (!filtered) {
    post({ type: 'animated', id, ok: false, error: 'everything is hidden' });
    return;
  }
  const displayed = filtered === full.scene ? full : generate(filtered);
  const payload = view(displayed);
  let glsl: string | undefined;
  if (payload.glsl !== lastGlsl) {
    glsl = payload.glsl;
    lastGlsl = payload.glsl;
  }
  post(
    {
      type: 'animated',
      id,
      ok: true,
      values: payload.values,
      bounds: payload.bounds,
      materials: payload.materials,
      stats: payload.stats,
      usesTime: payload.usesTime,
      ...(glsl !== undefined ? { glsl } : {}),
      ms: res.ms,
    },
    [payload.values.buffer],
  );
}

scope.onmessage = (event: MessageEvent) => {
  const msg = event.data as CompileWorkerRequest;
  if (msg?.type === 'compile') {
    compile(msg, msg.id, msg.time ?? 0);
  } else if (msg?.type === 'animate') {
    animate(msg.id, msg.time);
  }
};
