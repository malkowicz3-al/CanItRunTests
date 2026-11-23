import { useState, type ReactNode } from 'react';
import { ActionIcon, Button, Drawer, Group, Menu, Modal, ScrollArea, Text, TextInput } from '@mantine/core';
import type { Collection, Item } from '../../../shared/model';
import { notifyError, useApp } from '../context';
import { libraryGroups } from '../track';
import { itemIds } from '../util';
import { VariablesEditor } from './EnvironmentEditor';
import { ConfirmModal, EmptyState, Icons, MethodGlyph } from './ui';

export const TICKET_MIME = 'application/x-cirt-ticket';
const COLLAPSED_KEY = 'cirt.dock.collapsed';
// null: nothing saved yet, the dock picks a default from the collection count
const readCollapsed = (): string[] | null => { try { const v: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? 'null'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null; } catch { return null; } };

/** Actions menu behind a "..." button and the right click on `children`. */
export function ItemMenu({ label, children, menu, className }: { label: string; children: ReactNode; menu: ReactNode; className: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Menu opened={open} onChange={setOpen} position="bottom-end" withinPortal>
      <div className={className} onContextMenu={(e) => { e.preventDefault(); setOpen(true); }}>
        {children}
        <Menu.Target>
          <ActionIcon variant="subtle" color="gray" size="xs" aria-label={`Actions for ${label}`} className="item-menu">{Icons.dots()}</ActionIcon>
        </Menu.Target>
      </div>
      <Menu.Dropdown>{menu}</Menu.Dropdown>
    </Menu>
  );
}

/** Collection variables / rename / delete, as a menu plus the dialogs it opens (render `dialogs`). */
export function useLibraryActions() {
  const app = useApp();
  const [rename, setRename] = useState<{ collection: Collection; name: string } | null>(null);
  const [del, setDel] = useState<Collection | null>(null);
  const [vars, setVars] = useState<Collection | null>(null);
  const doRename = () => {
    if (!rename || !rename.name.trim()) return;
    const { collection, name } = rename;
    app.saveCollection(collection.id, (c) => ({ ...c, name: name.trim() })).catch(notifyError);
    setRename(null);
  };
  const doDelete = async (c: Collection) => {
    const ids = c.items.flatMap(itemIds);
    try {
      await app.deleteCollection(c.id);
      for (const id of ids) if (id in app.drafts) app.setDraft(id, undefined);
      app.forgetResults(ids);
    } catch (e) { notifyError(e); }
  };

  const collectionMenu = (c: Collection) => (
    <>
      <Menu.Item onClick={() => setVars(c)}>Collection variables</Menu.Item>
      <Menu.Item onClick={() => setRename({ collection: c, name: c.name })}>Rename</Menu.Item>
      <Menu.Divider />
      <Menu.Item color="stop" onClick={() => setDel(c)}>Delete</Menu.Item>
    </>
  );
  const varsCollection = vars && app.collections.find((c) => c.id === vars.id);
  const dialogs = (
    <>
      <Modal opened={!!rename} onClose={() => setRename(null)} title="Rename" size="sm" centered>
        <TextInput data-autofocus value={rename?.name ?? ''} onChange={(e) => { const name = e.currentTarget.value; setRename((r) => r && { ...r, name }); }} onKeyDown={(e) => { if (e.key === 'Enter') doRename(); }} />
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setRename(null)}>Cancel</Button>
          <Button onClick={doRename}>Rename</Button>
        </Group>
      </Modal>
      <ConfirmModal
        opened={!!del} onClose={() => setDel(null)} onConfirm={() => del && void doDelete(del)}
        title="Delete collection"
        message={<>Delete <b>{del?.name}</b> and everything in it? Flow nodes using it show as Missing request. This cannot be undone.</>}
      />
      <Drawer opened={!!varsCollection} onClose={() => setVars(null)} position="right" size={560} withCloseButton={false} padding={0} styles={{ body: { height: '100%' } }}>
        {varsCollection && (
          <VariablesEditor
            key={varsCollection.id} draftKey={`vars:${varsCollection.id}`} title={varsCollection.name} subtitle="Collection variables" values={varsCollection.variables}
            onSave={async (variables) => { await app.saveCollection(varsCollection.id, (latest) => ({ ...latest, variables })); app.discardDraft(`vars:${varsCollection.id}`, variables); }}
          />
        )}
      </Drawer>
    </>
  );
  return { collectionMenu, dialogs };
}

const countRequests = (items: Item[]): number => items.reduce((n, it) => n + (it.kind === 'request' ? 1 : countRequests(it.items)), 0);

/** Endpoint dock of the Flows screen: a grid of collapsible collection cards, folders as titled subgroups, requests as tickets. */
export function EndpointDock({ tabs, onAdd }: { tabs: ReactNode; onAdd: (collectionId: string, requestId: string) => void }) {
  const app = useApp();
  const actions = useLibraryActions();
  const [filter, setFilter] = useState('');
  const [saved, setSaved] = useState(readCollapsed);
  const collapsed = saved ?? (app.collections.length > 3 ? app.collections.map((c) => c.id) : []);
  const searching = !!filter.trim();
  const groups = libraryGroups(app.collections, filter).filter((g) => g.requests.length);
  const save = (next: string[]) => {
    setSaved(next);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch { /* not persisted */ }
  };
  const toggle = (id: string) => save(collapsed.includes(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id]);
  const anyOpen = app.collections.some((c) => !collapsed.includes(c.id));

  return (
    <div className="library">
      <Group className="library-head" gap="sm" wrap="nowrap">
        {tabs}
        <TextInput
          placeholder="Search by name, URL or method" leftSection={Icons.search()} value={filter} aria-label="Search endpoints"
          onChange={(e) => setFilter(e.currentTarget.value)} style={{ flex: 1, maxWidth: 360 }}
        />
        {app.collections.length > 0 && (
          <Button variant="subtle" color="gray" ml="auto" disabled={searching} onClick={() => save(anyOpen ? app.collections.map((c) => c.id) : [])}>
            {anyOpen ? 'Collapse all' : 'Expand all'}
          </Button>
        )}
        <Button variant="default" ml={app.collections.length > 0 ? undefined : 'auto'} leftSection={Icons.upload()} onClick={app.openImport}>Import</Button>
      </Group>
      {app.collections.length === 0 ? (
        <EmptyState title="Import a Postman collection or environment.">
          <Button leftSection={Icons.upload()} onClick={app.openImport}>Import</Button>
        </EmptyState>
      ) : (
        <ScrollArea style={{ flex: 1 }} type="hover">
          {searching && groups.length === 0 && <Text c="dimmed" p="md">Nothing matches "{filter}".</Text>}
          <div className="library-groups">
            {app.collections.map((c) => {
              const own = groups.filter((g) => g.collection.id === c.id);
              if (searching && !own.length) return null;
              const open = searching || !collapsed.includes(c.id);
              const count = countRequests(c.items);
              return (
                <section key={c.id} className="dock-card" aria-label={c.name}>
                  <ItemMenu label={c.name} className="dock-collection-row" menu={actions.collectionMenu(c)}>
                    <button type="button" className="dock-collection-head" aria-expanded={open} onClick={() => { if (!searching) toggle(c.id); }}>
                      {Icons.chevron(open)}
                      <span className="tree-name" data-root>{c.name}</span>
                      <span className="section-count">{count}</span>
                    </button>
                  </ItemMenu>
                  {open && own.map(({ folders, requests }) => (
                    <div key={folders.at(-1)?.id ?? c.id} className="library-group" data-folder={folders.length > 0 || undefined}>
                      {folders.length > 0 && <Text size="xs" c="dimmed" className="group-title">{folders.map((f) => f.name).join(' › ')}</Text>}
                      <div className="tickets">
                        {requests.map((r) => (
                          <div key={r.id} className="ticket">
                            <button
                              type="button" className="ticket-add" draggable title="Add to flow" aria-label={`Add ${r.method} ${r.name} to flow`}
                              onDragStart={(e) => { e.dataTransfer.setData(TICKET_MIME, JSON.stringify({ collectionId: c.id, requestId: r.id })); e.dataTransfer.effectAllowed = 'copy'; }}
                              onClick={() => onAdd(c.id, r.id)}
                            >
                              <MethodGlyph method={r.method} />
                              <span className="ticket-name">{r.name}</span>
                              {r.id in app.drafts && <span className="signal-dot" data-signal="caution" title="Unsaved changes" />}
                              <span className="ticket-plus" aria-hidden>+</span>
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </section>
              );
            })}
          </div>
        </ScrollArea>
      )}
      {actions.dialogs}
    </div>
  );
}
