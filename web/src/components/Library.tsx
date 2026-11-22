import { useState, type ReactNode } from 'react';
import { ActionIcon, Button, Drawer, Group, Menu, Modal, ScrollArea, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Collection, Folder, Item, RequestItem } from '../../../shared/model';
import { api } from '../api';
import { notifyError, useApp } from '../context';
import { libraryGroups } from '../track';
import { itemIds, uid, updateTree } from '../util';
import { VariablesEditor } from './EnvironmentEditor';
import { ConfirmModal, EmptyState, Icons, MethodGlyph } from './ui';

export const TICKET_MIME = 'application/x-cirt-ticket';

type Target = { collection: Collection; item?: Item }; // no item = the collection itself

const newRequest = (): RequestItem => ({
  kind: 'request', id: uid(), name: 'New request', method: 'GET', url: '', pathVariables: [], headers: [],
  body: { mode: 'none' }, auth: { type: 'inherit' }, scripts: { pre: '', test: '' },
});
const newFolder = (): Folder => ({ kind: 'folder', id: uid(), name: 'New folder', items: [], auth: { type: 'inherit' }, scripts: { pre: '', test: '' } });

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

/** Add / rename / duplicate / delete / collection variables / add to flow, as menus plus the dialogs they open (render `dialogs`). */
export function useLibraryActions() {
  const app = useApp();
  const [rename, setRename] = useState<(Target & { name: string }) | null>(null);
  const [del, setDel] = useState<Target | null>(null);
  const [vars, setVars] = useState<Collection | null>(null);
  const save = (id: string, update: (latest: Collection) => Collection) => app.saveCollection(id, update).catch(notifyError);
  const add = (t: Target, item: Item) => {
    void save(t.collection.id, (c) => ({ ...c, items: t.item ? updateTree(c.items, t.item.id, (f) => (f.kind === 'folder' ? { ...f, items: [...f.items, item] } : f)) : [...c.items, item] }));
  };
  const duplicate = (c: Collection, r: RequestItem) => {
    // insert the copy right after the original, in the same folder
    const copy = { ...r, id: uid(), name: `${r.name} copy` };
    const insert = (items: Item[]): Item[] => items.flatMap((it) => (it.id === r.id ? [it, copy] : it.kind === 'folder' ? [{ ...it, items: insert(it.items) }] : [it]));
    void save(c.id, (latest) => ({ ...latest, items: insert(latest.items) }));
  };
  const doRename = () => {
    if (!rename || !rename.name.trim()) return;
    const { collection, item, name } = rename;
    void save(collection.id, (c) => (item ? { ...c, items: updateTree(c.items, item.id, (i) => ({ ...i, name: name.trim() })) } : { ...c, name: name.trim() }));
    if (item && item.id in app.drafts) app.setDraft(item.id, { ...(app.drafts[item.id] as Item), name: name.trim() });
    setRename(null);
  };
  const doDelete = async ({ collection: c, item }: Target) => {
    const ids = item ? itemIds(item) : c.items.flatMap(itemIds);
    try {
      if (item) await app.saveCollection(c.id, (latest) => ({ ...latest, items: updateTree(latest.items, item.id, () => null) }));
      else await app.deleteCollection(c.id);
      for (const id of ids) if (id in app.drafts) app.setDraft(id, undefined);
      app.forgetResults(ids);
      app.dropStations(ids);
    } catch (e) { notifyError(e); }
  };
  const newCollection = () => {
    const c: Collection = { id: uid(), name: 'New collection', items: [], auth: { type: 'none' }, scripts: { pre: '', test: '' }, variables: [] };
    api.saveCollection(c).then(() => app.reload()).catch(notifyError);
  };

  const containerMenu = (t: Target) => (
    <>
      <Menu.Item onClick={() => add(t, newRequest())}>Add request</Menu.Item>
      <Menu.Item onClick={() => add(t, newFolder())}>Add folder</Menu.Item>
      {!t.item && <Menu.Item onClick={() => setVars(t.collection)}>Collection variables</Menu.Item>}
      <Menu.Item onClick={() => setRename({ ...t, name: t.item?.name ?? t.collection.name })}>Rename</Menu.Item>
      <Menu.Divider />
      <Menu.Item color="stop" onClick={() => setDel(t)}>Delete</Menu.Item>
    </>
  );
  const addToFlow = (c: Collection, r: RequestItem) => {
    app.addStation(c.id, r.id);
    notifications.show({ message: `${r.name} added to the flow.` });
  };
  const requestMenu = (c: Collection, r: RequestItem) => (
    <>
      <Menu.Item onClick={() => addToFlow(c, r)}>Add to flow</Menu.Item>
      <Menu.Item onClick={() => setRename({ collection: c, item: r, name: r.name })}>Rename</Menu.Item>
      <Menu.Item onClick={() => duplicate(c, r)}>Duplicate</Menu.Item>
      <Menu.Divider />
      <Menu.Item color="stop" onClick={() => setDel({ collection: c, item: r })}>Delete</Menu.Item>
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
        title={del?.item ? `Delete ${del.item.kind}` : 'Delete collection'}
        message={<>Delete <b>{del?.item?.name ?? del?.collection.name}</b>{del?.item?.kind === 'request' ? '' : ' and everything in it'}? Stations using it are removed from the flow. This cannot be undone.</>}
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
  const dialogOpen = !!rename || !!del || !!varsCollection;
  return { containerMenu, requestMenu, addToFlow, newCollection, dialogs, dialogOpen };
}

/** Imported collections as tickets grouped by collection and folder. `full` adds management menus. */
export function Library({ mode }: { mode: 'dock' | 'full' }) {
  const app = useApp();
  const actions = useLibraryActions();
  const full = mode === 'full';
  const [filter, setFilter] = useState('');
  const groups = libraryGroups(app.collections, filter).filter((g) => full || g.requests.length);

  return (
    <div className="library" data-mode={mode}>
      <Group className="library-head" gap="sm" wrap="nowrap">
        <Text size={full ? 'lg' : 'md'} fw={600}>Library</Text>
        <TextInput
          placeholder="Search by name, URL or method" leftSection={Icons.search()} value={filter} aria-label="Search library"
          onChange={(e) => setFilter(e.currentTarget.value)} style={{ flex: 1, maxWidth: 360 }}
        />
        <Group gap="xs" ml="auto" wrap="nowrap">
          {full && <Button variant="default" leftSection={Icons.plus()} onClick={actions.newCollection}>New collection</Button>}
          <Button variant="default" leftSection={Icons.upload()} onClick={app.openImport}>Import</Button>
        </Group>
      </Group>
      {app.collections.length === 0 ? (
        <EmptyState title="Import a Postman collection or environment.">
          <Button leftSection={Icons.upload()} onClick={app.openImport}>Import</Button>
        </EmptyState>
      ) : (
        <ScrollArea style={{ flex: 1 }} type="hover">
          <div className="library-groups">
            {groups.length === 0 && <Text c="dimmed">Nothing matches "{filter}".</Text>}
            {groups.map(({ collection: c, folders, requests }) => {
              const folder = folders.at(-1);
              const title = [c.name, ...folders.map((f) => f.name)].join(' › ');
              return (
                <div key={folder?.id ?? c.id} className="library-group">
                  {full
                    ? <ItemMenu label={title} className="group-title" menu={actions.containerMenu({ collection: c, item: folder })}><Text size="xs" c="dimmed">{title}</Text></ItemMenu>
                    : <Text size="xs" c="dimmed" className="group-title">{title}</Text>}
                  <div className="tickets">
                    {requests.map((r) => {
                      const ticket = (
                        <button
                          type="button" className="ticket-add" draggable title="Add to flow" aria-label={`Add ${r.method} ${r.name} to flow`}
                          onDragStart={(e) => { e.dataTransfer.setData(TICKET_MIME, JSON.stringify({ collectionId: c.id, requestId: r.id })); e.dataTransfer.effectAllowed = 'copy'; }}
                          onClick={() => app.addStation(c.id, r.id)}
                        >
                          <MethodGlyph method={r.method} />
                          <span className="ticket-name">{r.name}</span>
                          {r.id in app.drafts && <span className="signal-dot" data-signal="caution" title="Unsaved changes" />}
                          <span className="ticket-plus" aria-hidden>+</span>
                        </button>
                      );
                      return full ? (
                        <ItemMenu key={r.id} label={r.name} className="ticket" menu={actions.requestMenu(c, r)}>{ticket}</ItemMenu>
                      ) : <div key={r.id} className="ticket">{ticket}</div>;
                    })}
                    {full && !(folder ?? c).items.length && <Text size="xs" c="dimmed">Empty. Add a request from the menu.</Text>}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}

      {actions.dialogs}
    </div>
  );
}
