import { useEffect, useState } from 'react';
import type { Preset } from '../core/presets';
import { PRESETS } from '../core/presets';
import type { ProjectRecord } from '../store/projects';
import { Icon } from './Icon';

const EXAMPLE_BASE = `${import.meta.env.BASE_URL}examples/`;

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function ProjectCard({
  project,
  onOpen,
  onDelete,
}: {
  project: ProjectRecord;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (!confirm) return;
    const t = window.setTimeout(() => setConfirm(false), 3200);
    return () => window.clearTimeout(t);
  }, [confirm]);

  return (
    <article className="project-card">
      <button className="card-main" onClick={() => onOpen(project.id)} title={`Open ${project.name}`}>
        <div className="thumb">
          {project.thumbnail ? (
            <img src={project.thumbnail} alt="" loading="lazy" decoding="async" />
          ) : (
            <div className="thumb-empty">
              <Icon name="logo" size={24} />
              <span>no preview yet</span>
            </div>
          )}
        </div>
        <div className="card-text">
          <h3>{project.name}</h3>
          <time dateTime={new Date(project.updatedAt).toISOString()}>{timeAgo(project.updatedAt)}</time>
        </div>
      </button>
      <button
        className={`card-del ${confirm ? 'confirm' : ''}`}
        title={confirm ? 'Delete forever' : 'Delete project'}
        aria-label={confirm ? `Confirm delete ${project.name}` : `Delete ${project.name}`}
        onClick={(e) => {
          e.stopPropagation();
          if (confirm) onDelete(project.id);
          else setConfirm(true);
        }}
      >
        {confirm ? 'delete?' : <Icon name="trash" size={14} />}
      </button>
    </article>
  );
}

function ExampleCard({ preset, onUse }: { preset: Preset; onUse: (preset: Preset) => void }) {
  return (
    <article className="example-card">
      <button className="example-main" onClick={() => onUse(preset)}>
        <img
          src={`${EXAMPLE_BASE}${preset.id}.jpg`}
          alt={`${preset.name} render`}
          loading="lazy"
          decoding="async"
        />
        <span className="example-overlay">
          <span>Open as project</span>
          <Icon name="chevron" size={13} />
        </span>
      </button>
      <div className="example-body">
        <h3>{preset.name}</h3>
        <p>{preset.blurb}</p>
        <button className="ghostbtn example-use" onClick={() => onUse(preset)}>
          <Icon name="plus" size={12} /> start from this
        </button>
      </div>
    </article>
  );
}

export interface LandingProps {
  projects: ProjectRecord[] | null;
  persistent: boolean;
  onCreate: () => void;
  onCreateFromExample: (preset: Preset) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}

export function Landing({
  projects,
  persistent,
  onCreate,
  onCreateFromExample,
  onOpen,
  onDelete,
}: LandingProps) {
  const count = projects?.length ?? 0;

  return (
    <div className="landing">
      <header className="landing-top">
        <div className="brand">
          <span className="logo">
            <Icon name="logo" size={19} />
          </span>
          <span className="wordmark">
            para<em>plot</em>
          </span>
          <span className="tag">pure sdf cad</span>
        </div>
        <div className="topgap" />
        <button className="primarybtn" onClick={onCreate}>
          <Icon name="plus" size={14} />
          New project
        </button>
      </header>

      <main className="landing-main">
        <section className="landing-hero">
          <h1>
            Solid modelling,
            <br />
            <em>written as code.</em>
          </h1>
          <p>
            A parametric CAD toy in the browser: signed distance fields, implicit equations,
            boolean operations and splines, compiled straight to a WebGL2 raymarcher.
          </p>
        </section>

        {!persistent && (
          <div className="storage-warning">
            <strong>Local storage is unavailable.</strong> Projects will work for this session but
            will not survive a reload.
          </div>
        )}

        <section className="landing-section">
          <div className="section-head">
            <h2>Projects</h2>
            <span className="section-count">{count}</span>
            <span className="section-sub">saved in this browser</span>
          </div>

          <div className="project-grid">
            <button className="new-tile" onClick={onCreate}>
              <span className="new-thumb">
                <Icon name="plus" size={22} />
              </span>
              <span className="new-label">New project</span>
            </button>

            {projects === null
              ? Array.from({ length: 3 }, (_, i) => (
                  <div className="project-card skeleton" key={i}>
                    <div className="thumb" />
                    <div className="card-text">
                      <span className="skel-line" />
                      <span className="skel-line short" />
                    </div>
                  </div>
                ))
              : projects.map((p) => (
                  <ProjectCard key={p.id} project={p} onOpen={onOpen} onDelete={onDelete} />
                ))}
          </div>

          {projects !== null && projects.length === 0 && (
            <p className="empty-note">
              Nothing here yet — start a blank project, or open one of the examples below.
            </p>
          )}
        </section>

        <section className="landing-section">
          <div className="section-head">
            <h2>Examples</h2>
            <span className="section-count">{PRESETS.length}</span>
            <span className="section-sub">each one opens as a new, editable project</span>
          </div>

          <div className="example-grid">
            {PRESETS.map((p) => (
              <ExampleCard key={p.id} preset={p} onUse={onCreateFromExample} />
            ))}
          </div>
        </section>

        <footer className="landing-foot">
          <span>source → scene graph → glsl</span>
          <span className="sep">·</span>
          <span>projects and previews stay on this device</span>
        </footer>
      </main>
    </div>
  );
}
