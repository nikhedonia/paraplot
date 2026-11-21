import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { track } from '../analytics';
import type { CompileOutcome, CompileSuccess } from '../core/compileProtocol';
import { CompileClient } from '../core/compileClient';
import { findTreeNode, type TreeNode } from '../core/sceneTree';
import type { ParamValues } from '../core/controls';
import { API_REFERENCE } from '../core/typings';
import { DEFAULT_SETTINGS, type RenderSettings } from '../render/settings';
import type { ProjectRecord } from '../store/projects';
import { saveProject } from '../store/projects';
import { CodeEditor } from './CodeEditor';
import { ComponentTree } from './ComponentTree';
import { Icon } from './Icon';
import { ParamPanel } from './ParamPanel';
import { SourcePreview } from './SourcePreview';
import { SplineEditor, type SplinePlane } from './SplineEditor';
import {
  SplineWorkspace,
  type SplinePlacement,
  type SplineViewMode,
} from './SplineWorkspace';
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

/**
 * Leading + trailing throttle. Sliders can emit faster than the worker can
 * compile; this keeps the viewport live during a drag without re-rendering on
 * every pointer sample.
 */
function useThrottled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  const last = useRef(0);
  const timer = useRef(0);
  useEffect(() => {
    const now = performance.now();
    const elapsed = now - last.current;
    if (elapsed >= ms) {
      last.current = now;
      setV(value);
    } else {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = 0;
        last.current = performance.now();
        setV(value);
      }, ms - elapsed);
    }
    return () => {
      if (timer.current) {
        window.clearTimeout(timer.current);
        timer.current = 0;
      }
    };
  }, [value, ms]);
  return v;
}

const MIN_SPLIT = 24;
const MAX_SPLIT = 72;

/** start fetching the editor bundle once, after the first rendered frame */
let monacoPrefetchStarted = false;

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

type ViewKey = 'code' | 'render' | 'inputs';
type ViewState = Record<ViewKey, boolean>;
const DEFAULT_VIEWS: ViewState = { code: true, render: true, inputs: true };

function loadViews(): ViewState {
  try {
    const raw = localStorage.getItem('paraplot:views');
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ViewState>;
      return {
        code: parsed.code !== false,
        render: parsed.render !== false,
        inputs: parsed.inputs !== false,
      };
    }
  } catch {
    /* storage may be unavailable */
  }
  return { ...DEFAULT_VIEWS };
}

function saveViews(v: ViewState): void {
  try {
    localStorage.setItem('paraplot:views', JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

export interface EditorProps {
  initial: ProjectRecord;
  onSaved: (project: ProjectRecord) => void;
  onExit: () => void;
}

function EditorImpl({ initial, onSaved, onExit }: EditorProps) {
  const [name, setName] = useState(initial.name);
  const [source, setSource] = useState(initial.source);
  const [paramValues, setParamValues] = useState<ParamValues>(initial.params ?? {});
  // v2 stores offsets. Older records store absolute points; they are migrated
  // in the background once the first compile has reported the base splines.
  const legacyOverrides = useRef<Record<string, number[][]> | null>(
    (initial.v ?? 1) < 2 ? initial.overrides ?? {} : null,
  );
  const [overrides, setOverrides] = useState<Record<string, number[][]>>(
    (initial.v ?? 1) >= 2 ? initial.overrides ?? {} : {},
  );
  const migratedLegacy = useRef(
    !legacyOverrides.current || Object.keys(legacyOverrides.current).length === 0,
  );
  const [selectedSpline, setSelectedSpline] = useState<string | null>(null);
  const [splinePlacement, setSplinePlacement] = useState<SplinePlacement>('dock');
  const [splineView, setSplineView] = useState<SplineViewMode>('split');
  const [comb, setComb] = useState(false);
  const trackedName = useRef(initial.name);
  const [combDensity, setCombDensity] = useState(40);
  const [combScale, setCombScale] = useState(1);
  const [splinePlane, setSplinePlane] = useState<SplinePlane>('XY');
  const [settings, setSettings] = useState<RenderSettings>({
    ...DEFAULT_SETTINGS,
    ...(initial.settings ?? {}),
  });
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
  // the tree pane stays mounted (CSS hides it); keep the last snapshot while
  // another tab is active so live numeric details don't re-render the whole
  // tree on every slider tick
  const treeSnapshotRef = useRef<TreeNode | null>(null);
  const splinePlacementRef = useRef(splinePlacement);
  splinePlacementRef.current = splinePlacement;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /* editor / viewport split */
  const [split, setSplit] = useState<number>(loadSplit);
  const [views, setViews] = useState<ViewState>(loadViews);
  const [monacoTabs, setMonacoTabs] = useState<Set<'scene' | 'shader'>>(() => new Set());
  /** Monaco panes are created on first use and then kept mounted, so tab
   *  switches are instant and the undo stack/scroll position survive */
  const openMonaco = useCallback((key: 'scene' | 'shader') => {
    setMonacoTabs((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);
  useEffect(() => {
    saveViews(views);
  }, [views]);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const splitDrag = useRef(false);

  const debouncedSource = useDebounced(source, 110);
  // slider drags can emit far faster than a full scene compile; the panel
  // stays immediate, the viewport updates at ~22 Hz plus the final value
  const compileValues = useThrottled(paramValues, 45);
  const [client] = useState(() => new CompileClient());
  useEffect(() => () => client.dispose(), [client]);

  const [compiled, setCompiled] = useState<CompileOutcome | null>(null);
  const [compiling, setCompiling] = useState(true);
  const requestSeq = useRef(0);

  // fetch Monaco while the GPU is already busy: opening the full editor should
  // not pay for a multi-megabyte download at the moment of the click
  const prefetchMonaco = useCallback(() => {
    if (monacoPrefetchStarted) return;
    monacoPrefetchStarted = true;
    const idle = (window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    const load = () => void import('../monaco-setup');
    if (idle) idle(load, { timeout: 5000 });
    else window.setTimeout(load, 2500);
  }, []);
  const filters = useMemo(
    () => ({ hidden: [...hidden], isolated }),
    [hidden, isolated],
  );

  // compilation happens in a worker; this effect only swaps in the result
  useEffect(() => {
    const seq = ++requestSeq.current;
    setCompiling(true);
    let cancelled = false;
    void client
      .compile({ source: debouncedSource, values: compileValues, overrides, filters })
      .then((res) => {
        if (cancelled || seq !== requestSeq.current || !res) return;
        setCompiling(false);
        // the scene swap is not urgent: typing and slider drags stay at
        // input priority even when a heavy compile result arrives
        startTransition(() => setCompiled(res));
      })
      .catch((err: unknown) => {
        if (cancelled || seq !== requestSeq.current) return;
        setCompiling(false);
        startTransition(() =>
          setCompiled({
            ok: false,
            error: (err as Error)?.message ?? String(err),
            schema: {},
            ms: 0,
          }),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [client, debouncedSource, compileValues, overrides, filters]);

  const lastGood = useRef<CompileSuccess | null>(null);
  useEffect(() => {
    if (compiled?.ok) lastGood.current = compiled;
  }, [compiled]);

  // v1 projects stored absolute spline points: turn them into offsets once
  // the worker has compiled the unedited base splines
  useEffect(() => {
    if (!compiled?.ok || migratedLegacy.current) return;
    migratedLegacy.current = true;
    const saved = legacyOverrides.current;
    legacyOverrides.current = null;
    if (!saved) return;
    const basePoints = new Map(compiled.baseSplines.map((sp) => [sp.id, sp.points]));
    const out: Record<string, number[][]> = {};
    for (const [id, pts] of Object.entries(saved)) {
      const b = basePoints.get(id);
      if (!b || b.length !== pts.length) continue;
      out[id] = pts.map((p, i) => p.map((v, k) => v - (b[i]?.[k] ?? 0)));
    }
    if (Object.keys(out).length > 0) setOverrides(out);
  }, [compiled]);

  const hadCompileError = useRef(false);
  useEffect(() => {
    if (!compiled) return;
    if (!compiled.ok) {
      if (!hadCompileError.current) {
        const kind = /unexpected token|syntax/i.test(compiled.error)
          ? 'syntax'
          : /implicit\(/.test(compiled.error)
            ? 'implicit'
            : 'dsl';
        track('compile_error', { kind });
      }
      hadCompileError.current = true;
    } else {
      hadCompileError.current = false;
    }
  }, [compiled]);

  const good = compiled?.ok ? compiled : lastGood.current;
  const displayProgram = good?.program ?? null;
  const splines = good?.splines ?? [];
  const tree = good?.tree ?? null;
  const schema = compiled?.schema ?? good?.schema ?? {};

  // the animated clock asks the worker for the next scene; it never compiles
  // on the main thread and never touches react state
  const animate = useCallback(
    async (time: number) => {
      const res = await client.animate(time);
      if (!res) return { program: null };
      if (!res.ok) return { program: null, error: res.error };
      return { program: res.program };
    },
    [client],
  );

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
    if (tab === 'tree' && tree) treeSnapshotRef.current = tree;
  }, [tab, tree]);

  const treeForView = tab === 'tree' ? tree : treeSnapshotRef.current;

  useEffect(() => {
    const ids = splines.map((s) => s.id);
    if (!selectedSpline || !ids.includes(selectedSpline)) {
      setSelectedSpline(ids[0] ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splines]);

  // drop a solo target that no longer exists
  useEffect(() => {
    if (isolated && tree && !findTreeNode(tree, isolated)) setIsolated(null);
  }, [tree, isolated]);

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
    // filters and analysis views are aids: never bake them into the preview;
    // when the spline workspace covers the viewport there is nothing to capture
    if (hidden.size > 0 || isolated || settings.view !== 'shaded' || splinePlacement === 'viewport') {
      return null;
    }
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
  }, [hidden, isolated, settings.view, splinePlacement]);

  const persist = useCallback(async (extra?: { thumbnail?: string }) => {
    const record: ProjectRecord = {
      ...latest.current,
      v: 2,
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
        v: 2,
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

  const toggleHidden = useCallback(
    (id: string) => {
      track('component_visibility', { hidden: !hidden.has(id) });
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [hidden],
  );

  const solo = useCallback((id: string | null) => {
    track('component_solo', { solod: !!id });
    setIsolated(id);
    setFrameSignal((n) => n + 1);
  }, []);

  const toggleView = useCallback((key: ViewKey) => {
    setViews((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      track('view_toggle', { view: key, visible: next[key] });
      return next;
    });
  }, []);

  const placeSpline = useCallback((next: SplinePlacement) => {
    if (splinePlacementRef.current === next) return;
    track('spline_workspace', { placement: next });
    setSplinePlacement(next);
  }, []);

  const dockSpline = useCallback(() => placeSpline('dock'), [placeSpline]);
  const selectNode = useCallback((id: string | null) => setSelectedNode(id), []);
  const resetParams = useCallback(() => setParamValues({}), []);

  const toggleComb = useCallback((enabled: boolean) => {
    track('curvature_comb', { enabled });
    setComb(enabled);
  }, []);

  const updateSettings = useCallback((next: RenderSettings) => {
    if (next.view !== settingsRef.current.view) {
      track('analysis_view', { view: next.view });
    }
    setSettings(next);
  }, []);

  const togglePlay = useCallback(() => {
    setPlaying((prev) => {
      const next = !prev;
      track('playback_toggle', { playing: next });
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setHidden(new Set());
    setIsolated(null);
    setFrameSignal((n) => n + 1);
  }, []);

  // spline edits are stored as offsets from the generated curve, so animated
  // splines keep moving around the edited shape. The base points come from the
  // compile worker, so dragging never compiles on the main thread.
  const basePoints = useRef<Map<string, number[][]>>(new Map());
  useEffect(() => {
    if (!compiled?.ok) return;
    basePoints.current = new Map(compiled.baseSplines.map((sp) => [sp.id, sp.points]));
  }, [compiled]);

  const setSplinePoints = useCallback((id: string, points: number[][]) => {
    const base = basePoints.current.get(id);
    if (!base || base.length !== points.length) return;
    const offsets = points.map((p, i) => p.map((v, k) => v - (base[i]?.[k] ?? 0)));
    setOverrides((o) => ({ ...o, [id]: offsets }));
  }, []);

  const resetSpline = useCallback((id: string) => {
    setOverrides((o) => {
      const next = { ...o };
      delete next[id];
      return next;
    });
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

  const compileMs = (compiled?.ms ?? 0) < 1
    ? (compiled?.ms ?? 0).toFixed(2)
    : (compiled?.ms ?? 0).toFixed(1);
  const stale = !!compiled && !compiled.ok && !!lastGood.current;
  const compileFailed = !!compiled && !compiled.ok;
  const saveLabel =
    saveState === 'saved'
      ? 'saved'
      : saveState === 'pending'
        ? 'unsaved'
        : saveState === 'saving'
          ? 'saving'
          : 'save failed';
  const everythingHidden = hidden.size > 0 && !displayProgram;
  const initialCompiling = compiling && !compiled;
  const nothingVisible = !views.code && !views.render && !views.inputs;
  const bootLabel = compiling
    ? 'compiling scene'
    : compileFailed && !lastGood.current
      ? 'the scene has errors'
      : displayProgram
        ? 'preparing the viewport'
        : 'waiting for the scene';

  const renderSplineWorkspace = (placement: 'editor' | 'viewport') => (
    <SplineWorkspace
      splines={splines}
      selected={selectedSpline}
      comb={comb}
      combDensity={combDensity}
      combScale={combScale}
      onCombDensity={setCombDensity}
      onCombScale={setCombScale}
      plane={splinePlane}
      view={splineView}
      placement={placement}
      onSelect={setSelectedSpline}
      onPoints={setSplinePoints}
      onReset={resetSpline}
      onComb={toggleComb}
      onPlane={setSplinePlane}
      onView={setSplineView}
      onClose={dockSpline}
    />
  );

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
            const trimmed = name.trim() || 'Untitled';
            if (!name.trim()) setName('Untitled');
            if (trimmed !== trackedName.current) {
              trackedName.current = trimmed;
              track('project_rename');
            }
          }}
          spellCheck={false}
          aria-label="project name"
        />
        <span className={`save-state ${saveState}`} title="changes are saved locally in this browser">
          <span className="dot" />
          {saveLabel}
        </span>

        <div className="topgap" />

        <div className="topseg viewseg" role="group" aria-label="Visible views">
          <span className="topseg-label">views</span>
          <div className="segmented small">
            <button
              className={views.code ? 'active' : ''}
              onClick={() => toggleView('code')}
              title={views.code ? 'Hide the code pane' : 'Show the code pane'}
              aria-pressed={views.code}
            >
              <Icon name="code" size={12} />
            </button>
            <button
              className={views.render ? 'active' : ''}
              onClick={() => toggleView('render')}
              title={views.render ? 'Hide the 3D viewport' : 'Show the 3D viewport'}
              aria-pressed={views.render}
            >
              <Icon name="cube" size={12} />
            </button>
            <button
              className={views.inputs ? 'active' : ''}
              onClick={() => toggleView('inputs')}
              title={views.inputs ? 'Hide the inputs dock' : 'Show the inputs dock'}
              aria-pressed={views.inputs}
            >
              <Icon name="sliders" size={12} />
            </button>
          </div>
        </div>

        <div className="topseg" role="group" aria-label="Spline editor position">
          <span className="topseg-label">splines</span>
          <div className="segmented small">
            <button
              className={splinePlacement === 'dock' ? 'active' : ''}
              onClick={() => placeSpline('dock')}
              title="Spline editor in the dock"
              aria-pressed={splinePlacement === 'dock'}
            >
              <Icon name="panelBottom" size={12} />
            </button>
            <button
              className={splinePlacement === 'editor' ? 'active' : ''}
              onClick={() => placeSpline('editor')}
              title="Spline editor in the editor pane"
              aria-pressed={splinePlacement === 'editor'}
            >
              <Icon name="panelLeft" size={12} />
            </button>
            <button
              className={splinePlacement === 'viewport' ? 'active' : ''}
              onClick={() => placeSpline('viewport')}
              title="Spline editor in place of the viewport"
              aria-pressed={splinePlacement === 'viewport'}
            >
              <Icon name="panelRight" size={12} />
            </button>
          </div>
        </div>

        <div className={`status ${compiling ? 'busy' : compiled?.ok ? 'ok' : compiled ? 'bad' : 'busy'}`}>
          {compiling ? <span className="spinner mini" aria-hidden="true" /> : <span className="dot" />}
          {compiling ? 'compiling' : compiled?.ok ? 'compiled' : compiled ? 'error' : 'starting'}
          {!compiling && compiled?.ok && <span className="status-num">{compileMs} ms</span>}
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
        className={`workspace ${views.code ? '' : 'no-code'} ${views.render ? '' : 'no-render'} ${
          views.inputs ? '' : 'no-inputs'
        }`}
        ref={workspaceRef}
        style={{ ['--split' as string]: `${split}%` }}
      >
        {nothingVisible && (
          <div className="workspace-empty">
            <Icon name="cube" size={22} />
            <span>All views are hidden — use the view toggles in the top bar.</span>
          </div>
        )}
        <section className="pane editor-pane">
          <div className={`editor-shell ${splinePlacement === 'editor' ? 'is-hidden' : ''}`}>
          <div className="tabs">
            <button
              className={`tab ${tab === 'tree' ? 'active' : ''}`}
              onClick={() => setTab('tree')}
              title="Component tree — visibility and solo"
            >
              <Icon name="tree" size={12} />
              components
            </button>
            <button
              className={`tab ${tab === 'scene' ? 'active' : ''}`}
              onClick={() => {
                setTab('scene');
                openMonaco('scene');
              }}
            >
              <span className="filedot js" />
              scene.js
            </button>
            <button
              className={`tab ${tab === 'shader' ? 'active' : ''}`}
              onClick={() => {
                setTab('shader');
                openMonaco('shader');
              }}
            >
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
              {treeForView ? (
                <ComponentTree
                  tree={treeForView}
                  hidden={hidden}
                  isolated={isolated}
                  selected={selectedNode}
                  onSelect={selectNode}
                  onToggleHidden={toggleHidden}
                  onSolo={solo}
                  onClear={clearFilters}
                />
              ) : compiling ? (
                <div className="tree-empty tree-busy">
                  <span className="spinner mini" />
                  compiling the scene — the tree appears when it is ready.
                </div>
              ) : (
                <div className="tree-empty">
                  No components to show. Fix the scene errors and the tree will appear here.
                </div>
              )}
            </div>

            <div className={`editor-layer ${tab === 'scene' ? 'visible' : ''}`}>
              {monacoTabs.has('scene') ? (
                <CodeEditor
                  value={source}
                  onChange={setSource}
                  readOnly={initialCompiling}
                  active={splinePlacement !== 'editor' && tab === 'scene'}
                  path="scene.js"
                />
              ) : (
                <SourcePreview
                  value={source}
                  busy={initialCompiling}
                  readOnly={initialCompiling}
                  onChange={setSource}
                  note={
                    initialCompiling
                      ? 'compiling the scene — the source is read-only until it is ready'
                      : 'basic source editor — open the full editor for Monaco'
                  }
                  onActivate={() => openMonaco('scene')}
                />
              )}
            </div>
            <div className={`editor-layer ${tab === 'shader' ? 'visible' : ''}`}>
              {/* keep the shader pane mounted once opened, but do not build it
                  (and tokenise the generated GLSL) before the tab is used */}
              {monacoTabs.has('shader') && (
                <CodeEditor
                  value={displayProgram?.glsl ?? '// compile a scene to see the generated shader'}
                  readOnly
                  language="cpp"
                  active={splinePlacement !== 'editor' && tab === 'shader'}
                  path="shader.glsl"
                />
              )}
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
            <span className={compiling ? 'busy-text' : compiled?.ok ? 'ok-text' : 'bad-text'}>
              {compiling ? 'compiling…' : compiled?.ok ? 'scene is valid' : 'scene has errors'}
            </span>
          </div>
          </div>

          {splinePlacement === 'editor' && renderSplineWorkspace('editor')}

          {compileFailed && compiled && (
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
          <div className="viewport-slot">
          <Viewport
            program={displayProgram}
            settings={settings}
            onSettings={updateSettings}
            onError={setRenderError}
            onFirstFrame={prefetchMonaco}
            animate={animate}
            animated={good?.animated ?? false}
            playing={playing}
            onTogglePlay={togglePlay}
            snapshotRef={captureRef}
            frameSignal={frameSignal}
            filterLabel={filterLabel}
            onClearFilter={clearFilters}
            emptyLabel={everythingHidden ? 'Everything is hidden — clear the filters to see the scene.' : null}
            hasSplines={splines.length > 0}
            paused={splinePlacement === 'viewport' || !views.render}
            preview={initial.thumbnail ?? null}
            bootLabel={bootLabel}
            bootFailed={!!compiled && !compiled.ok && !good}
          />
          {splinePlacement === 'viewport' && renderSplineWorkspace('viewport')}
          {renderError && (
            <div className="render-error">
              <strong>renderer</strong>
              <pre>{renderError}</pre>
              <button onClick={() => setRenderError(null)}>dismiss</button>
            </div>
          )}
          </div>
          <div className="dock">
            <ParamPanel
              schema={compiled?.schema ?? schema}
              values={paramValues}
              onChange={setParamValues}
              onReset={resetParams}
            />
            {splinePlacement === 'dock' ? (
              <SplineEditor
                splines={splines}
                selected={selectedSpline}
                onSelect={setSelectedSpline}
                onChange={setSplinePoints}
                onReset={resetSpline}
                comb={comb}
                onComb={toggleComb}
                combDensity={combDensity}
                combScale={combScale}
                onCombDensity={setCombDensity}
                onCombScale={setCombScale}
                plane={splinePlane}
                onPlane={setSplinePlane}
              />
            ) : (
              <div className="dock-panel splines dock-detached">
                <header className="dock-head">
                  <span className="dock-title">splines</span>
                  <span className="dock-count">{splines.length}</span>
                  <button
                    className="ghostbtn"
                    onClick={() => placeSpline('dock')}
                    title="Bring the spline editor back to the dock"
                  >
                    <Icon name="reset" size={12} /> restore
                  </button>
                </header>
                <div className="dock-empty">
                  The spline workspace is open in the{' '}
                  {splinePlacement === 'editor' ? 'editor pane' : 'viewport'}.
                </div>
              </div>
            )}
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
              <code>{'group({ name: "wheel", t: … }, …)'}</code>. Name a spline and use
              <code>rail.at(0.5)</code> to anchor capsule endpoints or translations to it. Analyse surfaces with the
              shaded / normals / curvature / gradient / zebra selector in the viewport; curvature
              combs are toggled in the splines dock header. Use the `splines` buttons in the top
              bar to place the spline editor in the dock, the editor pane or the viewport; the
              enlarged workspace includes a live 3D preview, 2D pan/zoom and 3D combs; the
              comb's density and scale sliders appear when it is enabled.
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

export const Editor = memo(EditorImpl);
