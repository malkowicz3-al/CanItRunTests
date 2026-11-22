import type { RunResult } from '../../shared/api';
import type { Collection, Environment, Folder, Globals, Id, RequestItem } from '../../shared/model';

export interface Station { id: string; collectionId: Id; requestId: Id }
export interface Track { name: string; stations: Station[] }
export type Signal = 'idle' | 'caution' | 'go' | 'stop';

const TRACK_KEY = 'cirt.track';
const EMPTY: Track = { name: 'Scratch track', stations: [] };

// localStorage throws in some privacy modes; the track just does not survive a reload then
export function loadTrack(): Track {
  try {
    const t = JSON.parse(localStorage.getItem(TRACK_KEY) ?? 'null') as Track | null;
    if (!t || typeof t.name !== 'string' || !Array.isArray(t.stations)) return EMPTY;
    const valid = (s: Station | null) => !!s && typeof s.id === 'string' && typeof s.collectionId === 'string' && typeof s.requestId === 'string';
    return { name: t.name, stations: t.stations.filter(valid) };
  } catch { return EMPTY; }
}
export function saveTrack(t: Track) {
  try { localStorage.setItem(TRACK_KEY, JSON.stringify(t)); } catch { /* not persisted */ }
}

/** go = 2xx and every test passed; stop = network error, non-2xx, failed test or script error. */
export function signalOf(result: RunResult | undefined, running: boolean, failure?: string): Signal {
  if (running) return 'caution';
  if (failure) return 'stop';
  if (!result) return 'idle';
  const scripts = [...result.preScripts, ...result.testScripts];
  const ok = !result.error && !!result.response && result.response.status >= 200 && result.response.status < 300
    && scripts.every((s) => !s.error && s.tests.every((t) => t.passed));
  return ok ? 'go' : 'stop';
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [it] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, it);
  return next;
}

/** Moves list[from] into the gap `slot` (0 = before the first, length = after the last). */
export const reorderToSlot = <T>(list: T[], from: number, slot: number) => moveItem(list, from, from < slot ? slot - 1 : slot);

/** Runs stations in order; skips ones removed meanwhile and stops on the first 'stop' when stopOnFailure() says so at that moment. */
export async function runSequence<T>(stations: T[], runOne: (st: T) => Promise<Signal>, stopOnFailure: () => boolean, exists: (st: T) => boolean) {
  for (const st of stations) {
    if (!exists(st)) continue;
    if ((await runOne(st)) === 'stop' && stopOnFailure()) break;
  }
}

export interface Group { collection: Collection; folders: Folder[]; requests: RequestItem[] }

/** Library groups, one per collection root and folder; with a query (name, URL, method) only those with matches. */
export function libraryGroups(collections: Collection[], query: string): Group[] {
  const q = query.trim().toLowerCase();
  const out: Group[] = [];
  const walk = (collection: Collection, folders: Folder[], items: (Folder | RequestItem)[]) => {
    const requests = items.filter((it): it is RequestItem => it.kind === 'request' && (!q || `${it.method} ${it.name} ${it.url}`.toLowerCase().includes(q)));
    if (requests.length || !q) out.push({ collection, folders, requests });
    for (const it of items) if (it.kind === 'folder') walk(collection, [...folders, it], it.items);
  };
  for (const c of collections) walk(c, [], c.items);
  return out;
}

export type TreeRow = { depth: number; collection: Collection; item?: Folder | RequestItem }; // no item = the collection row

/** Visible rows of the collection tree. A query (name, URL, method) keeps matching requests and their ancestors, all expanded. */
export function treeRows(collections: Collection[], query: string, collapsed: Set<string>): TreeRow[] {
  const q = query.trim().toLowerCase();
  const walk = (collection: Collection, items: (Folder | RequestItem)[], depth: number): TreeRow[] => items.flatMap((item) => {
    if (item.kind === 'request') return !q || `${item.method} ${item.name} ${item.url}`.toLowerCase().includes(q) ? [{ depth, collection, item }] : [];
    const sub = q || !collapsed.has(item.id) ? walk(collection, item.items, depth + 1) : [];
    return q && !sub.length ? [] : [{ depth, collection, item }, ...sub];
  });
  return collections.flatMap((c) => {
    const sub = q || !collapsed.has(c.id) ? walk(c, c.items, 1) : [];
    return q && !sub.length ? [] : [{ depth: 0, collection: c }, ...sub];
  });
}

/** Value of {{key}} as the run would see it (environment over collection over globals), undefined when not defined. */
export function resolveVar(key: string, env: Environment | undefined, collection: Collection | undefined, globals: Globals) {
  for (const vars of [env?.values, collection?.variables, globals.values]) {
    const v = vars?.find((x) => x.enabled && x.key === key);
    if (v) return v;
  }
  return undefined;
}

/** One run at a time across screens (parallel runs would race on env variables); `onChange` mirrors the held state into React. */
export function createRunLock(onChange: (busy: boolean) => void) {
  let held = false;
  return {
    claim: () => {
      if (held) return false;
      held = true;
      onChange(true);
      return true;
    },
    release: () => { held = false; onChange(false); },
  };
}
