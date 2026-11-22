import type { Collection, Environment, Folder, Globals, RequestItem } from '../../shared/model';

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
