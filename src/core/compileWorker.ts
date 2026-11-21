/**
 * Scene compiler worker. The DSL build, codegen, scene tree and visibility
 * filtering all run here so opening a heavy scene never blocks the UI.
 */
import { compileScene } from './compile';
import { generate } from './codegen';
import { buildSceneTree, isolateNode, pruneHidden } from './sceneTree';
import type { Node } from './types';
import type {
  CompileFilters,
  CompileRequest,
  CompileWorkerRequest,
  CompileWorkerMessage,
  ProgramView,
} from './compileProtocol';
import type { CompiledProgram } from './codegen';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

let last: (CompileRequest & { time: number }) | null = null;

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
  const payload = displayed ? view(displayed) : null;
  const transfer = payload ? [payload.values.buffer] : [];
  post(
    {
      type: 'compiled',
      id,
      ok: true,
      program: payload,
      splines: full.splines,
      baseSplines: res.baseSplines,
      tree: buildSceneTree(full.scene),
      schema: res.schema,
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
  post({ type: 'animated', id, ok: true, program: payload, ms: res.ms }, [payload.values.buffer]);
}

scope.onmessage = (event: MessageEvent) => {
  const msg = event.data as CompileWorkerRequest;
  if (msg?.type === 'compile') {
    compile(msg, msg.id, 0);
  } else if (msg?.type === 'animate') {
    animate(msg.id, msg.time);
  }
};
