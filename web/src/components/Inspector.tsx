import { useState } from 'react';
import { Button, CloseButton, Group, ScrollArea, Text, TextInput, Tooltip } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import type { RunResult } from '../../../shared/api';
import type { Collection, Item, RequestItem } from '../../../shared/model';
import { modalOpen } from '../context';
import { parseStatuses } from '../flow';
import { requestCounts } from '../util';
import { REQUEST_PARTS, RequestLine, useRequestDraft } from './RequestEditor';
import { LastResult } from './ResponseView';
import { Icons, Section, shortcut } from './ui';

export function Inspector({ collection, path, result, failure, running, busy, active, continueWhen, onContinueWhen, onRun, onClose }: {
  collection: Collection; path: Item[]; result?: RunResult; failure?: string;
  running: boolean; // this node is running
  busy: boolean; // any run is in progress
  active: boolean; // flows screen visible: global hotkeys only apply then
  continueWhen: number[]; onContinueWhen: (statuses: number[]) => void;
  onRun: (r: RequestItem) => void; onClose: () => void;
}) {
  const [statuses, setStatuses] = useState(continueWhen.join(', '));
  const saved = path[path.length - 1] as RequestItem;
  const { draft, set, dirty, saving, save } = useRequestDraft(collection, saved, active);
  const run = () => { if (active && !busy) onRun(draft); };
  useHotkeys([['mod+S', () => { if (!modalOpen()) void save(); }], ['mod+Enter', () => { if (!modalOpen()) run(); }]], []);
  useHotkeys([['esc', () => { if (active) onClose(); }]]);

  const counts = requestCounts(draft);
  return (
    <aside className="inspector" aria-label="Node inspector">
      <div className="inspector-head">
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <div style={{ flex: 1, minWidth: 0 }}>
            <TextInput variant="unstyled" size="md" fw={600} value={draft.name} onChange={(e) => set({ name: e.currentTarget.value })} aria-label="Request name" />
            <Text size="xs" c="dimmed" truncate>{[collection.name, ...path.slice(0, -1).map((p) => p.name)].join(' › ')}</Text>
          </div>
          <CloseButton onClick={onClose} aria-label="Close inspector (Esc)" />
        </Group>
        <Group gap="xs" mt={8}>
          <Tooltip label={shortcut('Enter')} openDelay={300}>
            <Button leftSection={Icons.play()} onClick={run} loading={running} disabled={busy && !running}>Run node</Button>
          </Tooltip>
          <Tooltip label={shortcut('S')} openDelay={300}>
            <Button variant="default" onClick={save} disabled={!dirty} loading={saving}>Save request</Button>
          </Tooltip>
          {dirty && <Text size="xs" c="dimmed"><span className="signal-dot" data-signal="caution" /> Unsaved</Text>}
        </Group>
      </div>
      <ScrollArea style={{ flex: 1 }} type="hover">
        <Section title="Request" defaultOpen><RequestLine draft={draft} set={set} collection={collection} /></Section>
        {REQUEST_PARTS.map(({ id, sectionTitle, Fields }) => (
          <Section key={id} title={sectionTitle} count={counts[id]}><Fields draft={draft} set={set} scope="flows" /></Section>
        ))}
        <Section title="Continue when" count={continueWhen.join(', ') || undefined}>
          <TextInput
            label="Response status is one of" description="Empty = any 2xx. A failed test or script error always goes to Fail." placeholder="200, 201, 204"
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }} value={statuses}
            error={parseStatuses(statuses) ? undefined : 'Status codes from 100 to 599, separated by commas'}
            onChange={(e) => { const text = e.currentTarget.value; setStatuses(text); const p = parseStatuses(text); if (p) onContinueWhen(p); }}
          />
        </Section>
        <Section title="Last result" defaultOpen>
          <LastResult result={result} failure={failure} running={running} />
        </Section>
      </ScrollArea>
    </aside>
  );
}
