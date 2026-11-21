import { useCallback, useEffect, useState } from 'react';
import { track, trackPageView } from '../analytics';
import type { Preset } from '../core/presets';
import type { ProjectRecord } from '../store/projects';
import {
  deleteProject,
  getProject,
  listProjects,
  newProject,
  saveProject,
  storageIsPersistent,
} from '../store/projects';
import { Editor } from './Editor';
import { Landing } from './Landing';

const parseProjectId = (hash: string): string | null => {
  const m = /^#\/p\/([^/?#]+)/.exec(hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
};

const uniqueName = (base: string, list: ProjectRecord[]): string => {
  if (!list.some((p) => p.name === base)) return base;
  let i = 2;
  while (list.some((p) => p.name === `${base} ${i}`)) i++;
  return `${base} ${i}`;
};

export function App() {
  const [hash, setHash] = useState(() => window.location.hash || '#/');
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null);
  const [persistent, setPersistent] = useState(true);
  const [active, setActive] = useState<ProjectRecord | null>(null);
  const routeId = parseProjectId(hash);

  useEffect(() => {
    trackPageView(routeId ? 'editor' : 'landing');
  }, [routeId]);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    void listProjects().then((rows) => {
      setProjects(rows);
      setPersistent(storageIsPersistent());
    });
  }, []);

  const go = useCallback((id: string | null) => {
    window.location.hash = id ? `#/p/${encodeURIComponent(id)}` : '#/';
  }, []);

  // load the project named by the route
  useEffect(() => {
    if (!routeId) {
      setActive(null);
      return;
    }
    let cancelled = false;
    setActive(null);
    void getProject(routeId).then((rec) => {
      if (cancelled) return;
      if (rec) {
        setActive(rec);
      } else {
        // stale link: go back to the project list
        go(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [routeId, go]);

  const onSaved = useCallback((record: ProjectRecord) => {
    setProjects((prev) => {
      const list = prev ?? [];
      return [record, ...list.filter((p) => p.id !== record.id)].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      );
    });
  }, []);

  const create = useCallback(
    async (source?: string, preferredName?: string, example?: Preset) => {
      const list = projects ?? [];
      const name = uniqueName(preferredName ?? `Untitled ${list.length + 1}`, list);
      const record = newProject(name, source);
      await saveProject(record);
      setProjects((prev) => [record, ...(prev ?? [])]);
      track('project_create', {
        mode: example ? 'example' : 'blank',
        ...(example ? { example: example.id } : {}),
      });
      go(record.id);
    },
    [projects, go],
  );

  const createFromExample = useCallback(
    (preset: Preset) => {
      track('example_open', { example: preset.id });
      void create(preset.source, preset.name, preset);
    },
    [create],
  );

  const openProject = useCallback(
    (id: string) => {
      track('project_open', { surface: 'card' });
      go(id);
    },
    [go],
  );

  const remove = useCallback(async (id: string) => {
    await deleteProject(id);
    track('project_delete');
    setProjects((prev) => (prev ?? []).filter((p) => p.id !== id));
  }, []);

  if (routeId && active) {
    return (
      <Editor
        key={active.id}
        initial={active}
        onSaved={onSaved}
        onExit={() => go(null)}
      />
    );
  }

  if (routeId) {
    return (
      <div className="boot">
        <span className="boot-dot" />
        loading project…
      </div>
    );
  }

  return (
    <Landing
      projects={projects}
      persistent={persistent}
      onCreate={() => void create()}
      onCreateFromExample={createFromExample}
      onOpen={openProject}
      onDelete={(id) => void remove(id)}
    />
  );
}
