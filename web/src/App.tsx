import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActionIcon, Drawer, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import type { Collection, Environment, Globals, Id } from '../../shared/model';
import { api } from './api';
import { EnvironmentsView } from './components/EnvironmentEditor';
import { ImportDialog } from './components/ImportDialog';
import { FlowsScreen } from './components/Flows';
import { RequestsScreen } from './components/Requests';
import { Icons } from './components/ui';
import { AppContext, notifyError, SCREENS, type AppData, type Screen } from './context';
import { createRunLock } from './track';
import { itemIds } from './util';

const ENV_KEY = 'cirt.activeEnvironment';
// localStorage throws in some privacy modes; the selection is just not remembered then
const readEnvId = () => { try { return localStorage.getItem(ENV_KEY); } catch { return null; } };
const writeEnvId = (id: string | null) => { try { if (id) localStorage.setItem(ENV_KEY, id); else localStorage.removeItem(ENV_KEY); } catch { /* not persisted */ } };
const SCREEN_KEY = 'cirt.screen';
const readScreen = (): Screen => { try { return SCREENS.find((s) => s === localStorage.getItem(SCREEN_KEY)) ?? 'requests'; } catch { return 'requests'; } };

function RailButton({ label, icon, active, onClick }: { label: string; icon: ReactNode; active?: boolean; onClick: () => void }) {
  return (
    <Tooltip label={label} position="right" openDelay={200}>
      <ActionIcon
        variant="subtle" color="gray" size={40} className="rail-button" data-active={active || undefined}
        aria-label={label} aria-current={active ? 'page' : undefined} onClick={onClick}
      >{icon}</ActionIcon>
    </Tooltip>
  );
}

export function App() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [globals, setGlobals] = useState<Globals>({ values: [] });
  const [activeEnvId, setActiveEnv] = useState<Id | null>(readEnvId);
  const [screen, setScreen] = useState<Screen>(readScreen);
  const [envSelection, setEnvSelection] = useState<string | null>(null);
  const [envOpen, setEnvOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runLock] = useState(() => createRunLock(setBusy));
  const latestCollections = useRef(collections);
  latestCollections.current = collections;
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const forgetters = useRef(new Set<(ids: Id[]) => void>());
  const addToFlow = useRef<(collectionId: Id, requestId: Id) => void>(() => {}); // set by the Flows screen, which owns the open flow
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('dark');

  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
  // saves, refreshes and deletes of collections run one at a time, so a refresh fetched before a save cannot undo it
  const enqueue = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const p = saveQueue.current.then(fn);
    saveQueue.current = p.catch(() => {});
    return p;
  }, []);
  const load = useCallback(async () => {
    const [list, envs, g] = await Promise.all([api.listCollections(), api.listEnvironments(), api.getGlobals()]);
    const cols = await Promise.all(list.map((c) => api.getCollection(c.id)));
    latestCollections.current = cols;
    setCollections(cols.sort(byName));
    setEnvironments(envs.sort(byName));
    setGlobals(g);
    // drafts of deleted or re-imported items would otherwise stay forever and keep beforeunload asking
    const keys = new Set(['globals', ...envs.map((e) => e.id), ...cols.flatMap((c) => [`vars:${c.id}`, ...c.items.flatMap(itemIds)])]);
    setDrafts((d) => (Object.keys(d).every((k) => keys.has(k)) ? d : Object.fromEntries(Object.entries(d).filter(([k]) => keys.has(k)))));
  }, []);
  const reload = useCallback(() => enqueue(load), [enqueue, load]); // never call reload from inside an enqueued step: it would wait for itself
  useEffect(() => { reload().catch(notifyError); }, [reload]);
  useEffect(() => { try { localStorage.setItem(SCREEN_KEY, screen); } catch { /* not persisted */ } }, [screen]);

  const hasDrafts = Object.keys(drafts).length > 0;
  useEffect(() => {
    if (!hasDrafts) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasDrafts]);

  const putCollection = (c: Collection) => setCollections((cs) => cs.map((x) => (x.id === c.id ? c : x)).sort(byName));
  const setDraft = (key: string, value: unknown) => setDrafts(({ [key]: _, ...rest }) => (value === undefined ? rest : { ...rest, [key]: value }));
  const discardDraft = (key: string, sent: unknown) => setDrafts((d) => {
    if (d[key] !== sent) return d;
    const { [key]: _, ...rest } = d;
    return rest;
  });
  const ctx: AppData = {
    collections, environments, globals, drafts, setDraft, discardDraft, screen, setScreen, envSelection,
    activeEnvId,
    setActiveEnvId: (id) => { setActiveEnv(id); writeEnvId(id); },
    editEnvironment: (id) => { setEnvSelection(id); if (id) setEnvOpen(true); },
    addToFlow: (collectionId, requestId) => addToFlow.current(collectionId, requestId),
    reload,
    refreshAfterRun: (collectionId) => enqueue(async () => {
      const [c, envs, g] = await Promise.all([api.getCollection(collectionId), api.listEnvironments(), api.getGlobals()]);
      latestCollections.current = latestCollections.current.map((x) => (x.id === c.id ? c : x));
      putCollection(c);
      setEnvironments(envs.sort(byName));
      setGlobals(g);
    }),
    saveCollection: (id, update) => enqueue(async () => {
      const latest = latestCollections.current.find((c) => c.id === id);
      if (!latest) throw new Error('The collection no longer exists.');
      const saved = await api.saveCollection(update(latest));
      latestCollections.current = latestCollections.current.map((c) => (c.id === id ? saved : c)); // the next queued save sees it before React re-renders
      putCollection(saved);
    }),
    deleteCollection: (id) => enqueue(async () => { await api.deleteCollection(id); await load(); }),
    enqueue,
    saveEnvironment: async (e) => {
      const saved = await api.saveEnvironment(e);
      setEnvironments((es) => es.map((x) => (x.id === saved.id ? saved : x)).sort(byName));
      discardDraft(e.id, e);
    },
    saveGlobals: async (g) => { setGlobals(await api.saveGlobals(g)); discardDraft('globals', g.values); },
    openImport: () => setImportOpen(true),
    busy,
    claimRun: runLock.claim,
    releaseRun: runLock.release,
    forgetResults: (ids) => forgetters.current.forEach((fn) => fn(ids)),
    onForgetResults: (fn) => { forgetters.current.add(fn); return () => { forgetters.current.delete(fn); }; },
  };

  return (
    <AppContext.Provider value={ctx}>
      <div className="app">
        <nav className="rail" aria-label="Main">
          <RailButton label="Endpoints" icon={Icons.requests()} active={screen === 'requests'} onClick={() => setScreen('requests')} />
          <RailButton label="Flows" icon={Icons.track()} active={screen === 'flows'} onClick={() => setScreen('flows')} />
          <div style={{ flex: 1 }} />
          <RailButton label={scheme === 'dark' ? 'Light theme' : 'Dark theme'} icon={scheme === 'dark' ? Icons.sun() : Icons.moon()} onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')} />
        </nav>
        <main className="screen">
          {/* both work screens stay mounted on other screens so runs in progress and their results survive */}
          <div style={{ display: screen === 'requests' ? 'contents' : 'none' }}>
            <RequestsScreen active={screen === 'requests'} />
          </div>
          <div style={{ display: screen === 'flows' ? 'contents' : 'none' }}>
            <FlowsScreen active={screen === 'flows'} addToFlow={addToFlow} />
          </div>
        </main>
      </div>
      <Drawer
        opened={envOpen} onClose={() => setEnvOpen(false)} position="right" size="80%" title="Environments"
        styles={{ content: { display: 'flex', flexDirection: 'column' }, body: { flex: 1, minHeight: 0, padding: 0 } }}
      >
        <EnvironmentsView />
      </Drawer>
      <ImportDialog opened={importOpen} onClose={() => setImportOpen(false)} />
    </AppContext.Provider>
  );
}
