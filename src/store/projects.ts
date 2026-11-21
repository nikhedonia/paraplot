import type { ParamValues } from '../core/controls';
import { DEFAULT_SETTINGS, type RenderSettings } from '../render/settings';

export interface ProjectRecord {
  /** record version; v2 stores spline overrides as offsets */
  v?: number;
  id: string;
  name: string;
  source: string;
  params: ParamValues;
  overrides: Record<string, number[][]>;
  settings: RenderSettings;
  /** jpeg data url captured from the viewport */
  thumbnail?: string;
  createdAt: number;
  updatedAt: number;
}

export const STARTER_SOURCE = String.raw`// A fresh paraplot project.
// Change the parameters below, or rewrite everything.

export const params = {
  size:  num(0.7,  { min: 0.3, max: 1.4, step: 0.01 }),
  round: num(0.14, { min: 0.0, max: 0.3, step: 0.005 }),
  tint:  color('#c9d2da'),
};

export default function build(k) {
  const shell = group({ name: 'shell' },
    paint(box({ s: [k.size, k.size, k.size], round: k.round }), k.tint));

  const cavity = group({ name: 'cavity', t: [0, k.size * 0.72, 0] },
    sphere({ r: k.size * 0.66 }));

  return subtract(shell, cavity);
}
`;

const newId = (): string => {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
};

export function newProject(name: string, source = STARTER_SOURCE, thumbnail?: string): ProjectRecord {
  const now = Date.now();
  return {
    v: 2,
    id: newId(),
    name: name.trim() || 'Untitled',
    source,
    params: {},
    overrides: {},
    settings: { ...DEFAULT_SETTINGS },
    thumbnail,
    createdAt: now,
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------ *
 * Storage: IndexedDB with an in-memory fallback. Thumbnails are jpeg
 * data urls, so a real object store matters (localStorage quota).
 * ------------------------------------------------------------------ */

const DB_NAME = 'paraplot';
const DB_VERSION = 1;
const STORE = 'projects';

const memory = new Map<string, ProjectRecord>();
let unavailable = false;
let dbPromise: Promise<IDBDatabase> | null = null;

/** false when we had to fall back to memory (private mode / blocked IDB) */
export const storageIsPersistent = (): boolean => !unavailable;

const byUpdated = (a: ProjectRecord, b: ProjectRecord) => b.updatedAt - a.updatedAt;

function openDb(): Promise<IDBDatabase> {
  if (unavailable) return Promise.reject(new Error('storage unavailable'));
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open the project database'));
    req.onblocked = () => reject(new Error('the project database is blocked by another tab'));
  }).catch((err) => {
    unavailable = true;
    dbPromise = null;
    console.warn('[paraplot] persistent storage unavailable:', (err as Error).message);
    throw err;
  });

  return dbPromise;
}

async function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, mode);
    } catch (err) {
      reject(err);
      return;
    }
    const req = run(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('project storage request failed'));
    tx.onabort = () => reject(tx.error ?? new Error('project storage transaction aborted'));
  });
}

export async function listProjects(): Promise<ProjectRecord[]> {
  try {
    const rows = await transact<ProjectRecord[]>('readonly', (s) => s.getAll() as IDBRequest<ProjectRecord[]>);
    return rows.sort(byUpdated);
  } catch {
    return [...memory.values()].sort(byUpdated);
  }
}

export async function getProject(id: string): Promise<ProjectRecord | undefined> {
  try {
    const rec = await transact<ProjectRecord | undefined>('readonly', (s) => s.get(id) as IDBRequest<ProjectRecord | undefined>);
    return rec ?? memory.get(id);
  } catch {
    return memory.get(id);
  }
}

export async function saveProject(project: ProjectRecord): Promise<void> {
  memory.set(project.id, project);
  try {
    await transact<IDBValidKey>('readwrite', (s) => s.put(project));
  } catch {
    // memory cache already holds the record; the UI surfaces the warning
  }
}

export async function deleteProject(id: string): Promise<void> {
  memory.delete(id);
  try {
    await transact<undefined>('readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
  } catch {
    // already removed from the cache
  }
}
