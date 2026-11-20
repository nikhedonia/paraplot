import type { SplineInfo } from '../core/types';
import { CombSettings } from './CombSettings';
import { Icon } from './Icon';
import { SplineEditor, type SplinePlane } from './SplineEditor';
import { SplineView3D } from './SplineView3D';

export type SplinePlacement = 'dock' | 'editor' | 'viewport';
export type SplineViewMode = '2d' | 'split' | '3d';

export interface SplineWorkspaceProps {
  splines: SplineInfo[];
  selected: string | null;
  comb: boolean;
  combDensity: number;
  combScale: number;
  plane: SplinePlane;
  view: SplineViewMode;
  placement: 'editor' | 'viewport';
  onSelect: (id: string) => void;
  onPoints: (id: string, points: number[][]) => void;
  onReset: (id: string) => void;
  onComb: (value: boolean) => void;
  onCombDensity: (value: number) => void;
  onCombScale: (value: number) => void;
  onPlane: (plane: SplinePlane) => void;
  onView: (view: SplineViewMode) => void;
  onClose: () => void;
}

/**
 * The enlarged spline editor: control point editing on the left, a live
 * orbitable 3D preview of the swept shape on the right.
 */
export function SplineWorkspace({
  splines,
  selected,
  comb,
  combDensity,
  combScale,
  plane,
  view,
  placement,
  onSelect,
  onPoints,
  onReset,
  onComb,
  onCombDensity,
  onCombScale,
  onPlane,
  onView,
  onClose,
}: SplineWorkspaceProps) {
  const spline = splines.find((s) => s.id === selected) ?? splines[0] ?? null;
  const is3d = spline?.dim === 3;

  return (
    <section className={`spline-workspace ${placement}`}>
      <header className="spline-ws-head">
        <div className="spline-ws-row">
          <span className="dock-title">spline workspace</span>
          <span className="dock-count">{splines.length}</span>
          <span className="topgap" />

          <div className="segmented small" role="group" aria-label="spline view">
            <button className={view === '2d' ? 'active' : ''} onClick={() => onView('2d')}>
              2D
            </button>
            <button className={view === 'split' ? 'active' : ''} onClick={() => onView('split')}>
              split
            </button>
            <button className={view === '3d' ? 'active' : ''} onClick={() => onView('3d')}>
              3D
            </button>
          </div>

          <button
            className={`ghostbtn combbtn ${comb ? 'on' : ''}`}
            onClick={() => onComb(!comb)}
            disabled={!spline}
            aria-pressed={comb}
            title="Curvature comb — spikes of length κ = 1/R"
          >
            <Icon name="comb" size={13} /> comb
          </button>

          <button className="iconbtn" title="Close the spline workspace (dock it)" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="spline-ws-row sub">
          <div className="spline-ws-tabs">
            {splines.map((s) => (
              <button
                key={s.id}
                className={`spline-tab ${s.id === spline?.id ? 'active' : ''}`}
                onClick={() => onSelect(s.id)}
                title={`${s.kind} · ${s.points.length} points`}
              >
                {s.name}
                <span className="kind">{s.kind}</span>
              </button>
            ))}
            {splines.length === 0 && <span className="spline-ws-empty">no splines in this scene</span>}
          </div>

          {is3d && view !== '3d' && (
            <div className="segmented tiny" role="group" aria-label="2D projection plane">
              {(['XY', 'XZ', 'YZ'] as SplinePlane[]).map((p) => (
                <button key={p} className={plane === p ? 'active' : ''} onClick={() => onPlane(p)}>
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>
        {comb && (
          <div className="spline-ws-row comb-row">
            <CombSettings
              density={combDensity}
              scale={combScale}
              onDensity={onCombDensity}
              onScale={onCombScale}
            />
          </div>
        )}
      </header>

      <div className={`spline-ws-body ${view}`}>
        {splines.length === 0 ? (
          <div className="tree-empty">
            No splines or profiles in this scene. Add <code>spline({'{ points, r }'})</code>, a lathe
            profile or an extruded profile to edit it here.
          </div>
        ) : (
          <>
            {view !== '3d' && (
              <div className="spline-ws-pane">
                <SplineEditor
                  splines={splines}
                  selected={spline?.id ?? null}
                  onSelect={onSelect}
                  onChange={onPoints}
                  onReset={onReset}
                  comb={comb}
                  onComb={onComb}
                  combDensity={combDensity}
                  combScale={combScale}
                  onCombDensity={onCombDensity}
                  onCombScale={onCombScale}
                  plane={plane}
                  onPlane={onPlane}
                  hideHeader
                />
              </div>
            )}
            {view !== '2d' && (
              <div className="spline-ws-pane">
                <SplineView3D
                  spline={spline}
                  comb={comb}
                  density={combDensity}
                  scale={combScale}
                />
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
