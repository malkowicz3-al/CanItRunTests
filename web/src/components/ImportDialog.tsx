import { useRef, useState } from 'react';
import { Box, Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { ImportConflict } from '../../../shared/api';
import { ApiError, api } from '../api';
import { notifyError, useApp } from '../context';
import { itemIds } from '../util';
import { Icons } from './ui';

type Pending = { json: unknown; conflict: ImportConflict };

export function ImportDialog({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const app = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState('');
  const [dragging, setDragging] = useState(false);
  const [conflicts, setConflicts] = useState<Pending[]>([]); // one confirm at a time when several files clash

  /** `overwriteId`: id of the conflicting item to replace; its drafts are dropped so they do not mask the imported values. */
  const importOne = async (label: string, json: unknown, overwriteId?: string) => {
    try {
      const r = await api.importPostman(json, overwriteId !== undefined);
      if (overwriteId !== undefined) {
        // request ids survive an overwrite (keepItemIds), so their drafts must be dropped explicitly too
        const old = app.collections.find((c) => c.id === overwriteId);
        const ids = old?.items.flatMap(itemIds) ?? [];
        for (const id of [overwriteId, `vars:${overwriteId}`, ...ids]) app.setDraft(id, undefined);
        app.forgetResults(ids);
      }
      notifications.show({
        color: r.warnings.length ? 'caution' : 'go',
        title: `Imported ${r.kind}${r.name ? ` "${r.name}"` : ''}`,
        message: r.warnings.length ? <Stack gap={2}>{r.warnings.slice(0, 8).map((w, i) => <Text key={i} size="xs">{w}</Text>)}{r.warnings.length > 8 && <Text size="xs">...and {r.warnings.length - 8} more</Text>}</Stack> : undefined,
        autoClose: r.warnings.length ? false : 4000,
      });
      await app.reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflicts((c) => [...c, { json, conflict: e.body as ImportConflict }]);
      else notifyError(new Error(`${label}: ${e instanceof Error ? e.message : String(e)}`));
    }
  };

  const importTexts = async (items: [label: string, text: string][]) => {
    onClose();
    for (const [label, text] of items) {
      let json: unknown;
      try { json = JSON.parse(text); } catch { notifyError(new Error(`${label}: not valid JSON`)); continue; }
      await importOne(label, json);
    }
  };
  const importFiles = async (files: FileList | null) => {
    if (files?.length) await importTexts(await Promise.all([...files].map(async (f) => [f.name, await f.text()] as [string, string])));
  };

  const current = conflicts[0];
  const next = () => setConflicts((c) => c.slice(1));
  return (
    <>
      <Modal opened={opened} onClose={onClose} title="Import" size="lg" centered>
        <Stack>
          <Box
            className="dropzone" data-dragging={dragging || undefined} role="button" tabIndex={0}
            onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter') input.current?.click(); }}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); void importFiles(e.dataTransfer.files); }}
          >
            <Stack align="center" gap={4}>
              {Icons.upload()}
              <Text fw={600}>Drop Postman exports here or click to choose</Text>
              <Text size="xs" c="dimmed">Collection v2.1, environment or globals (.json). Several files at once are fine.</Text>
            </Stack>
          </Box>
          <input ref={input} type="file" accept=".json,application/json" multiple hidden onChange={(e) => { void importFiles(e.currentTarget.files); e.currentTarget.value = ''; }} />
          <Textarea label="Or paste JSON" autosize minRows={3} maxRows={10} styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }} value={paste} onChange={(e) => setPaste(e.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button disabled={!paste.trim()} onClick={() => { void importTexts([['Pasted JSON', paste]]); setPaste(''); }}>Import</Button>
          </Group>
        </Stack>
      </Modal>
      <Modal opened={!!current} onClose={next} title="Already imported" size="sm" centered>
        <Text size="sm"><b>{current?.conflict.name}</b> was imported before. Overwrite it with this file? Local changes to it will be lost.</Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={next}>Skip</Button>
          <Button color="stop" data-autofocus onClick={() => { if (current) void importOne(current.conflict.name, current.json, current.conflict.existingId); next(); }}>Overwrite</Button>
        </Group>
      </Modal>
    </>
  );
}
