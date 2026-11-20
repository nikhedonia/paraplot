import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { compileScene, type CompileOk } from '../core/compile';
import { generate, type CompiledProgram } from '../core/codegen';
import type { Node } from '../core/types';
import {
  buildSceneTree,
  findTreeNode,
  isolateNode,
  pruneHidden,
  type TreeNode,
} from '../core/sceneTree';
import type { ParamValues } from '../core/controls';
import { API_REFERENCE } from '../core/typings';
import { DEFAULT_SETTINGS, type RenderSettings } from '../render/settings';
import type { ProjectRecord } from '../store/projects';
import { saveProject } from '../store/projects';
import { CodeEditor } from './CodeEditor';
import { ComponentTree } from './ComponentTree';
import { Icon } from './Icon';
import { ParamPanel } from './ParamPanel';
import { SplineEditor } from './SplineEditor';
import { Viewport } from './Viewport';

type Tab = 'tree' | 'scene' | 'shader';
type SaveState = 'saved' | 'pending' | 'saving' | 'error';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

const MIN_SPLIT = 24;
const MAX_SPLIT = 72;

function loadSplit(): number {
  try {
    const v = Number.parseFloat(localStorage.getItem('paraplot:split') ?? '');
    if (Number.isFinite(v)) return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, v));
  } catch {
    /* storage may be unavailable */
  }
  return 38;
}

function saveSplit(v: number): void {
  try {
    localStorage.setItem('paraplot:split', String(Math.round(v)));
  } catch {
    /* ignore */
  }
}

export interface EditorProps {
  initial: ProjectRecord;
  onSaved: (project: ProjectRecord) => void;
  onExit: () => void;
}

export function Editor({ initial, onSaved, onExit }: EditorProps) {
  const [name, setName] = useState(initial.name);
  const [source, setSource] = useState(initial.source);
  const [paramValues, setParamValues] = useState<ParamValues>(initial.params ?? {});
  const [overrides, setOverrides] = useState<Record<string, number[][]>>(initial.overrides ?? {});
  const [selectedSpline, setSelectedSpline] = useState<string | null>(null);
  const [settings, setSettings] = useState<RenderSettings>(initial.settings ?? DEFAULT_SETTINGS);
  const [tab, setTab] = useState<Tab>('scene');
  const [playing, setPlaying] = useState(true);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');

  /* component tree: transient render filters */
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [isolated, setIsolated] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [frameSignal, setFrameSignal] = useState(0);

  /* editor / viewport split */
  const [split, setSplit] = useState<number>(loadSplit);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const splitDrag = useRef(false);

  const debouncedSource = useDebounced(source, 110);
  const compiled = useMemo(
    () => compileScene(debouncedSource, paramValues, overrides),
    [debouncedSource, paramValues, overrides],
  );

  /** apply visibility + solo filters to a freshly compiled program */
  const applyFilters = useCallback(
    (base: CompiledProgram): CompiledProgram | null => {
      let root: Node = base.scene;
      if (isolated) {
        const solo = isolateNode(root, isolated);
        if (solo) root = solo;
      }
      if (hidden.size > 0) {
        const pruned = pruneHidden(root, hidden);
        if (!pruned) return null;
        root = pruned;
      }
      return root === base.scene ? base : generate(root);
    },
    [isolated, hidden],
  );

  /** the animated clock calls this every frame; it never touches react state */
  const animate = useCallback(
    (time: number) => {
      const r = compileScene(debouncedSource, paramValues, overrides, time);
      if (!r.ok) return { program: null, error: r.error };
      return { program: applyFilters(r.program) };
    },
    [debouncedSource, paramValues, overrides, applyFilters],
  );

  const lastGood = useRef<CompileOk | null>(null);
  useEffect(() => {
    if (compiled.ok) lastGood.current = compiled;
  }, [compiled]);

  const good = compiled.ok ? compiled : lastGood.current;
  const fullProgram = good?.program ?? null;
  const displayProgram = useMemo(
    () => (fullProgram ? applyFilters(fullProgram) : null),
    [fullProgram, applyFilters],
  );
  const scene = fullProgram?.scene ?? null;
  const tree = useMemo(() => (scene ? buildSceneTree(scene) : null), [scene]);
  const schema = good?.schema ?? {};
  const values = good?.values ?? {};

  const nodeCount = useMemo(() => {
    if (!tree) return 0;
    let n = 0;
    const walk = (node: TreeNode) => {
      n++;
      node.children.forEach(walk);
    };
    walk(tree);
    return n;
  }, [tree]);

  useEffect(() => {
    const ids = fullProgram?.splines.map((s) => s.id) ?? [];
    if (!selectedSpline || !ids.includes(selectedSpline)) {
      setSelectedSpline(ids[0] ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullProgram]);

  // drop a solo target that no longer exists
  useEffect(() => {
    if (isolated && scene && !isolateNode(scene, isolated)) setIsolated(null);
  }, [scene, isolated]);

  // forget hidden ids that disappeared from the tree
  useEffect(() => {
    if (!tree || hidden.size === 0) return;
    const ids = new Set<string>();
    const walk = (node: TreeNode) => {
      ids.add(node.id);
      node.children.forEach(walk);
    };
    walk(tree);
    let changed = false;
    const next = new Set<string>();
    for (const id of hidden) {
      if (ids.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setHidden(next);
  }, [tree, hidden]);

  useEffect(() => {
    if (!help) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHelp(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [help]);

  /* ------------------------------------------------------------------ *
   * persistence: the editor owns the record, saves are debounced and a
   * fresh thumbnail is captured from the canvas when edits settle.
   * ------------------------------------------------------------------ */

  const latest = useRef<ProjectRecord>(initial);
  latest.current = { ...latest.current, name, source, params: paramValues, overrides, settings };

  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const captureRef = useRef<(() => Promise<string | null>) | null>(null);
  const capture = useCallback(async (): Promise<string | null> => {
    // filters are a viewing aid: never bake them into the project preview
    if (hidden.size > 0 || isolated) return null;
    const fn = captureRef.current;
    if (!fn) return null;
    try {
      return await Promise.race([
        fn(),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 3000)),
      ]);
    } catch {
      return null;
    }
  }, [hidden, isolated]);

  const persist = useCallback(async (extra?: { thumbnail?: string }) => {
    const record: ProjectRecord = {
      ...latest.current,
      name: latest.current.name.trim() || 'Untitled',
      ...(extra?.thumbnail ? { thumbnail: extra.thumbnail } : {}),
      updatedAt: Date.now(),
    };
    latest.current = record;
    setSaveState('saving');
    try {
      await saveProject(record);
      onSavedRef.current(record);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }, []);

  // debounced save on any change (skip the initial render)
  const saveArmed = useRef(false);
  useEffect(() => {
    if (!saveArmed.current) {
      saveArmed.current = true;
      return;
    }
    setSaveState('pending');
    const t = window.setTimeout(() => void persist(), 600);
    return () => window.clearTimeout(t);
  }, [name, source, paramValues, overrides, settings, persist]);

  // refresh the thumbnail once edits have settled (skip the initial render)
  const snapArmed = useRef(false);
  useEffect(() => {
    if (!snapArmed.current) {
      snapArmed.current = true;
      return;
    }
    const t = window.setTimeout(() => {
      if (document.hidden) return;
      void capture().then((thumbnail) => {
        if (thumbnail) void persist({ thumbnail });
      });
    }, 1700);
    return () => window.clearTimeout(t);
  }, [source, paramValues, overrides, settings, capture, persist]);

  const leaving = useRef(false);
  const handleExit = useCallback(async () => {
    if (leaving.current) return;
    leaving.current = true;
    setSaveState('saving');
    const thumbnail = await capture();
    await persist(thumbnail ? { thumbnail } : undefined);
    onExitRef.current();
  }, [capture, persist]);

  // browser back / unmount: save the data even if the snapshot is skipped
  useEffect(() => {
    return () => {
      if (leaving.current) return;
      const record: ProjectRecord = {
        ...latest.current,
        name: latest.current.name.trim() || 'Untitled',
        updatedAt: Date.now(),
      };
      void saveProject(record).then(() => onSavedRef.current(record));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void persist();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [persist]);

  /* ---- component tree actions ---- */

  const toggleHidden = useCallback((id: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const solo = useCallback((id: string | null) => {
    setIsolated(id);
    setFrameSignal((n) => n + 1);
  }, []);

  const clearFilters = useCallback(() => {
    setHidden(new Set());
    setIsolated(null);
    setFrameSignal((n) => n + 1);
  }, []);

  const filterLabel = useMemo(() => {
    const parts: string[] = [];
    if (isolated && tree) {
      const node = findTreeNode(tree, isolated);
      parts.push(`solo ${node?.label ?? 'component'}`);
    }
    if (hidden.size) parts.push(`${hidden.size} hidden`);
    return parts.length ? parts.join(' · ') : null;
  }, [isolated, tree, hidden]);

  /* ---- splitter ---- */

  const onSplitDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    splitDrag.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add('dragging');
    document.body.classList.add('resizing');
    e.preventDefault();
  };

  const onSplitMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!splitDrag.current || !workspaceRef.current) return;
    const rect = workspaceRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setSplit(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, pct)));
  };

  const onSplitUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!splitDrag.current) return;
    splitDrag.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    e.currentTarget.classList.remove('dragging');
    document.body.classList.remove('resizing');
    const rect = workspaceRef.current?.getBoundingClientRect();
    const pct = rect
      ? Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ((e.clientX - rect.left) / rect.width) * 100))
      : split;
    saveSplit(pct);
  };

  const onSplitKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = Math.min(
      MAX_SPLIT,
      Math.max(MIN_SPLIT, split + (e.key === 'ArrowLeft' ? -2 : 2)),
    );
    setSplit(next);
    saveSplit(next);
  };

  const compileMs = compiled.ms < 1 ? compiled.ms.toFixed(2) : compiled.ms.toFixed(1);
  const stale = !compiled.ok && !!lastGood.current;
  const saveLabel =
    saveState === 'saved'
      ? 'saved'
      : saveState === 'pending'
        ? 'unsaved'
        : saveState === 'saving'
          ? 'saving'
          : 'save failed';
  const everythingHidden = hidden.size > 0 && !displayProgram;

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand brand-btn" onClick={() => void handleExit()} title="Back to all projects">
          <span className="logo">
            <Icon name="logo" size={17} />
          </span>
          <span className="wordmark">
            para<em>plot</em>
          </span>
        </button>

        <button className="backbtn" onClick={() => void handleExit()} title="Back to all projects">
          <Icon name="arrowLeft" size={15} />
          <span className="back-label">projects</span>
        </button>

        <input
          className="project-title"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (!name.trim()) setName('Untitled');
          }}
          spellCheck={false}
          aria-label="project name"
        />
        <span className={`save-state ${saveState}`} title="changes are saved locally in this browser">
          <span className="dot" />
          {saveLabel}
        </span>

        <div className="topgap" />

        <div className={`status ${compiled.ok ? 'ok' : 'bad'}`}>
          <span className="dot" />
          {compiled.ok ? 'compiled' : 'error'}
          <span className="status-num">{compileMs} ms</span>
        </div>
        {displayProgram && (
          <div className="status dims">
            {displayProgram.stats.nodes} nodes
            <span className="sep">/</span>
            {displayProgram.stats.values} uniforms
          </div>
        )}
        <button className="iconbtn helpbtn" onClick={() => setHelp((h) => !h)} title="DSL reference">
          ?
        </button>
      </header>

      <main
        className="workspace"
        ref={workspaceRef}
        style={{ ['--split' as string]: `${split}%` }}
      >
        <section className="pane editor-pane">
          <div className="tabs">
            <button
              className={`tab ${tab === 'tree' ? 'active' : ''}`}
              onClick={() => setTab('tree')}
              title="Component tree — visibility and solo"
            >
              <Icon name="tree" size={12} />
              components
            </button>
            <button className={`tab ${tab === 'scene' ? 'active' : ''}`} onClick={() => setTab('scene')}>
              <span className="filedot js" />
              scene.js
            </button>
            <button className={`tab ${tab === 'shader' ? 'active' : ''}`} onClick={() => setTab('shader')}>
              <span className="filedot glsl" />
              shader.glsl
            </button>
            <span className="tabs-gap" />
            <span className="tab-hint">
              {tab === 'tree'
                ? 'visibility · solo'
                : tab === 'scene'
                  ? 'pure · javascript dsl'
                  : 'generated · read only'}
            </span>
          </div>

          <div className="editor-stack">
            <div className={`editor-layer tree-layer ${tab === 'tree' ? 'visible' : ''}`}>
              {tree ? (
                <ComponentTree
                  tree={tree}
                  hidden={hidden}
                  isolated={isolated}
                  selected={selectedNode}
                  onSelect={(id) => setSelectedNode(id)}
                  onToggleHidden={toggleHidden}
                  onSolo={solo}
                  onClear={clearFilters}
                />
              ) : (
                <div className="tree-empty">
                  No components to show. Fix the scene errors and the tree will appear here.
                </div>
              )}
            </div>

            <div className={`editor-layer ${tab === 'scene' ? 'visible' : ''}`}>
              <CodeEditor value={source} onChange={setSource} active={tab === 'scene'} path="scene.js" />
            </div>
            <div className={`editor-layer ${tab === 'shader' ? 'visible' : ''}`}>
              <CodeEditor
                value={displayProgram?.glsl ?? '// compile a scene to see the generated shader'}
                readOnly
                language="cpp"
                active={tab === 'shader'}
                path="shader.glsl"
              />
            </div>
          </div>

          <div className="editor-status">
            <span>
              {tab === 'tree' ? 'components' : tab === 'scene' ? 'javascript' : 'glsl es 3.00'}
            </span>
            <span className="sep">·</span>
            <span>
              {tab === 'tree'
                ? `${nodeCount} nodes${hidden.size ? ` · ${hidden.size} hidden` : ''}${
                    isolated ? ' · solo' : ''
                  }`
                : displayProgram
                  ? `${displayProgram.glsl.split('\n').length} glsl lines`
                  : 'no program'}
            </span>
            <span className="grow" />
            <span className={compiled.ok ? 'ok-text' : 'bad-text'}>
              {compiled.ok ? 'scene is valid' : 'scene has errors'}
            </span>
          </div>

          {!compiled.ok && (
            <div className="errorbar">
              <div className="errorbar-head">
                <span>compile error</span>
                {stale && <span className="stale">showing last valid scene</span>}
              </div>
              <pre>{compiled.error}</pre>
            </div>
          )}
        </section>

        <div
          className="splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize editor and viewport"
          aria-valuemin={MIN_SPLIT}
          aria-valuemax={MAX_SPLIT}
          aria-valuenow={Math.round(split)}
          tabIndex={0}
          title="Drag to resize · double click to reset"
          onPointerDown={onSplitDown}
          onPointerMove={onSplitMove}
          onPointerUp={onSplitUp}
          onPointerCancel={onSplitUp}
          onDoubleClick={() => {
            setSplit(38);
            saveSplit(38);
          }}
          onKeyDown={onSplitKey}
        />

        <section className="pane view-pane">
          <Viewport
            program={displayProgram}
            settings={settings}
            onSettings={setSettings}
            onError={setRenderError}
            animate={animate}
            animated={good?.animated ?? false}
            playing={playing}
            onTogglePlay={() => setPlaying((p) => !p)}
            snapshotRef={captureRef}
            frameSignal={frameSignal}
            filterLabel={filterLabel}
            onClearFilter={clearFilters}
            emptyLabel={everythingHidden ? 'Everything is hidden — clear the filters to see the scene.' : null}
          />
          {renderError && (
            <div className="render-error">
              <strong>renderer</strong>
              <pre>{renderError}</pre>
              <button onClick={() => setRenderError(null)}>dismiss</button>
            </div>
          )}
          <div className="dock">
            <ParamPanel
              schema={compiled.ok ? compiled.schema : schema}
              values={values}
              onChange={setParamValues}
              onReset={() => setParamValues({})}
            />
            <SplineEditor
              splines={fullProgram?.splines ?? []}
              selected={selectedSpline}
              onSelect={setSelectedSpline}
              onChange={(id, points) => setOverrides((o) => ({ ...o, [id]: points }))}
              onReset={(id) =>
                setOverrides((o) => {
                  const next = { ...o };
                  delete next[id];
                  return next;
                })
              }
            />
          </div>
        </section>
      </main>

      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>paraplot DSL</h2>
              <button className="iconbtn" onClick={() => setHelp(false)}>
                ×
              </button>
            </header>
            <p className="modal-lede">
              A scene is a <em>pure</em> function: source + parameters → scene graph → GLSL.
              Nothing is mutated, so any state (parameters, spline points) is just an input. The
              <strong> components</strong> tab shows the graph; hide nodes with the eye, or solo a
              node to render only that component in place.
            </p>
            <div className="api-grid">
              {API_REFERENCE.map((a) => (
                <div className="api-row" key={a.name}>
                  <code>{a.signature}</code>
                  <span>{a.note}</span>
                </div>
              ))}
            </div>
            <p className="modal-note">
              Name a group to label it in the tree:{' '}
              <code>{'group({ name: "wheel", t: … }, …)'}</code>.
              Implicit equations use a small expression language: <code>x</code>, <code>y</code>,{' '}
              <code>z</code>, <code>p</code>, <code>time</code>, and functions like <code>sin</code>,{' '}
              <code>abs</code>, <code>length</code>, <code>clamp</code>. To animate the scene graph,
              take a second argument: <code>export default (k, t) =&gt; …</code>.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
