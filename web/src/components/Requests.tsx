import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Button, Group, ScrollArea, Tabs, Text, TextInput, Tooltip } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import type { RunResult } from '../../../shared/api';
import type { Collection, Id, Item, RequestItem } from '../../../shared/model';
import { api } from '../api';
import { modalOpen, runEnvironmentId, useApp } from '../context';
import { treeRows } from '../track';
import { findPath, requestCounts } from '../util';
import { EnvironmentSelect } from './EnvironmentEditor';
import { ItemMenu, useLibraryActions } from './Library';
import { REQUEST_PARTS, RequestLine, useRequestDraft } from './RequestEditor';
import { LastResult } from './ResponseView';
import { countBadge, EmptyState, Icons, MethodGlyph, shortcut } from './ui';

function RequestPane({ collection, path, result, failure, running, busy, active, onSend, onAddToFlow }: {
  collection: Collection; path: Item[]; result?: RunResult; failure?: string;
  running: boolean; busy: boolean; active: boolean; onSend: (r: RequestItem) => void; onAddToFlow: () => void;
}) {
  const saved = path[path.length - 1] as RequestItem;
  const { draft, set, dirty, saving, save } = useRequestDraft(collection, saved, active);
  const [tab, setTab] = useState<string | null>('params');
  const [split, setSplit] = useState(0.5);
  const send = () => { if (active && !busy) onSend(draft); };
  useHotkeys([['mod+S', () => { if (!modalOpen()) void save(); }], ['mod+Enter', () => { if (!modalOpen()) send(); }]], []);
  const counts = requestCounts(draft);
  const resize = (s: number) => setSplit(Math.min(0.85, Math.max(0.15, s)));

  return (
    <div className="workbench-main">
      <header className="topbar">
        <div style={{ flex: 1, minWidth: 0 }}>
          <TextInput variant="unstyled" size="md" fw={600} value={draft.name} onChange={(e) => set({ name: e.currentTarget.value })} aria-label="Request name" />
          <Text size="xs" c="dimmed" truncate>{[collection.name, ...path.slice(0, -1).map((p) => p.name)].join(' › ')}</Text>
        </div>
        <Group gap="xs" wrap="nowrap">
          {dirty && <Text size="xs" c="dimmed"><span className="signal-dot" data-signal="caution" /> Unsaved</Text>}
          <EnvironmentSelect />
          <Tooltip label={shortcut('S')} openDelay={300}>
            <Button variant="default" onClick={save} disabled={!dirty} loading={saving}>Save request</Button>
          </Tooltip>
          <Button variant="default" leftSection={Icons.plus()} onClick={onAddToFlow}>Add to flow</Button>
        </Group>
      </header>
      <div className="request-line">
        <RequestLine
          draft={draft} set={set} collection={collection}
          action={<Tooltip label={shortcut('Enter')} openDelay={300}><Button leftSection={Icons.play()} onClick={send} loading={running} disabled={busy && !running}>Send</Button></Tooltip>}
        />
      </div>
      <div className="workbench-split">
        <div className="workbench-pane" style={{ flex: `0 0 ${split * 100}%` }}>
          <Tabs value={tab} onChange={setTab} keepMounted={false} className="pane-tabs">
            <Tabs.List>
              {REQUEST_PARTS.map(({ id, title }) => <Tabs.Tab key={id} value={id} rightSection={countBadge(counts[id])}>{title}</Tabs.Tab>)}
            </Tabs.List>
            {REQUEST_PARTS.map(({ id, Fields }) => <Tabs.Panel key={id} value={id}><Fields draft={draft} set={set} scope="requests" /></Tabs.Panel>)}
          </Tabs>
        </div>
        <div
          className="splitter" role="separator" aria-orientation="horizontal" aria-label="Resize response" tabIndex={0}
          aria-valuenow={Math.round(split * 100)} aria-valuemin={15} aria-valuemax={85}
          onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
          onPointerMove={(e) => { if (e.buttons & 1) { const r = e.currentTarget.parentElement!.getBoundingClientRect(); resize((e.clientY - r.top) / r.height); } }}
          onKeyDown={(e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); resize(split + (e.key === 'ArrowUp' ? -0.05 : 0.05)); } }}
        />
        <div className="workbench-pane" style={{ flex: 1 }} role="region" aria-label="Response">
          <LastResult tabs result={result} failure={failure} running={running} />
        </div>
      </div>
    </div>
  );
}

/** Requests screen: collection tree on the left, the selected request with its last response on the right. */
export function RequestsScreen({ active }: { active: boolean }) {
  const app = useApp();
  const actions = useLibraryActions();
  const [selected, setSelected] = useState<{ collectionId: Id; requestId: Id } | null>(null);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // results live here, and this screen stays mounted, so they survive switching screens (memory only)
  const [results, setResults] = useState<Record<string, RunResult>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<string | null>(null);
  const tree = useRef<HTMLDivElement>(null);
  useEffect(() => app.onForgetResults((ids) => {
    const keep = <T,>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).filter(([k]) => !ids.includes(k)));
    setResults(keep);
    setFailures(keep);
  }), []); // subscribe once: onForgetResults only touches a ref in App

  const collection = selected ? app.collections.find((c) => c.id === selected.collectionId) : undefined;
  const path = collection && selected ? findPath(collection.items, selected.requestId) : [];
  const request = path.at(-1)?.kind === 'request' ? (path.at(-1) as RequestItem) : undefined;

  const send = async (c: Collection, draft: RequestItem) => {
    if (!app.claimRun()) return;
    setRunning(draft.id);
    setFailures(({ [draft.id]: _, ...rest }) => rest);
    try {
      const r = await api.run({ collectionId: c.id, requestId: draft.id, environmentId: runEnvironmentId(app), request: draft });
      setResults((rs) => ({ ...rs, [draft.id]: r }));
      await app.refreshAfterRun(c.id).catch(() => {}); // only refreshes the UI
    } catch (e) {
      setFailures((f) => ({ ...f, [draft.id]: e instanceof Error ? e.message : String(e) }));
    } finally { app.releaseRun(); setRunning(null); }
  };

  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });
  const arrows = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = [...tree.current!.querySelectorAll<HTMLElement>('.tree-main')];
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    all[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
  };
  const searching = !!filter.trim();
  const rows = treeRows(app.collections, filter, collapsed);

  return (
    <div className="workbench">
      <aside className="tree-pane" aria-label="Collections">
        <Group className="tree-head" gap={4} wrap="nowrap">
          <Text fw={600} style={{ flex: 1 }}>Collections</Text>
          <Tooltip label="New collection" openDelay={300}><ActionIcon variant="subtle" color="gray" aria-label="New collection" onClick={actions.newCollection}>{Icons.plus()}</ActionIcon></Tooltip>
          <Tooltip label="Import" openDelay={300}><ActionIcon variant="subtle" color="gray" aria-label="Import" onClick={app.openImport}>{Icons.upload()}</ActionIcon></Tooltip>
        </Group>
        <div className="tree-filter">
          <TextInput placeholder="Filter by name, URL or method" leftSection={Icons.search()} value={filter} aria-label="Filter requests" onChange={(e) => setFilter(e.currentTarget.value)} />
        </div>
        <ScrollArea style={{ flex: 1 }} type="hover">
          <div className="tree" ref={tree} onKeyDown={arrows}>
            {!app.collections.length && <Text size="xs" c="dimmed" px="md">No collections yet.</Text>}
            {searching && !rows.length && <Text size="xs" c="dimmed" px="md">Nothing matches "{filter}".</Text>}
            {rows.map(({ depth, collection: c, item }) => {
              if (item?.kind === 'request') {
                const shown = (app.drafts[item.id] as RequestItem | undefined) ?? item; // the tree follows unsaved renames
                const current = selected?.requestId === item.id;
                return (
                  <ItemMenu key={item.id} label={shown.name} className="tree-row" menu={actions.requestMenu(c, item)}>
                    <button
                      type="button" className="tree-main" style={{ paddingLeft: 12 + depth * 14 }} aria-current={current || undefined}
                      onClick={() => setSelected({ collectionId: c.id, requestId: item.id })}
                    >
                      <MethodGlyph method={shown.method} w={44} />
                      <span className="tree-name">{shown.name}</span>
                      {item.id in app.drafts && <span className="signal-dot" data-signal="caution" title="Unsaved changes" style={{ marginTop: 0 }} />}
                    </button>
                  </ItemMenu>
                );
              }
              const id = item?.id ?? c.id;
              const open = searching || !collapsed.has(id);
              return (
                <ItemMenu key={id} label={item?.name ?? c.name} className="tree-row" menu={actions.containerMenu({ collection: c, item })}>
                  <button type="button" className="tree-main" style={{ paddingLeft: 6 + depth * 14 }} aria-expanded={open} onClick={() => { if (!searching) toggle(id); }}>
                    {Icons.chevron(open)}
                    <span className="tree-name" data-root={!item || undefined}>{item?.name ?? c.name}</span>
                  </button>
                </ItemMenu>
              );
            })}
          </div>
        </ScrollArea>
      </aside>
      {collection && request ? (
        <RequestPane
          key={request.id} collection={collection} path={path} result={results[request.id]} failure={failures[request.id]}
          running={running === request.id} busy={app.busy} active={active && !actions.dialogOpen}
          onSend={(draft) => { void send(collection, draft); }} onAddToFlow={() => actions.addToFlow(collection, request)}
        />
      ) : (
        <div className="workbench-main">
          <EmptyState title="Pick a request from the tree, or import a Postman collection.">
            <Button leftSection={Icons.upload()} onClick={app.openImport}>Import</Button>
          </EmptyState>
        </div>
      )}
      {actions.dialogs}
    </div>
  );
}
