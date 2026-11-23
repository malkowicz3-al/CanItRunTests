import { memo, useEffect, useState } from 'react';
import { Button, CloseButton, Group, Tabs, Text, TextInput, Tooltip } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import type { ResultSample } from '../../../shared/api';
import type { Collection, Item, RequestItem } from '../../../shared/model';
import { modalOpen } from '../context';
import { parseStatuses } from '../flow';
import { requestCounts } from '../util';
import { REQUEST_PARTS, RequestLine, useRequestDraft } from './RequestEditor';
import { LastResult } from './ResponseView';
import { Icons, Section, shortcut } from './ui';

/** Samples of a running load run change every tick: while frozen each one is kept until Show latest (gone -> cleared, none held -> the first one). */
export function useHeldSamples(frozen: boolean, result?: ResultSample, lastError?: ResultSample) {
  const [held, setHeld] = useState({ result, lastError });
  useEffect(() => setHeld((h) => (frozen ? { result: result && (h.result ?? result), lastError: lastError && (h.lastError ?? lastError) } : { result, lastError })), [frozen, result, lastError]);
  const shown = frozen ? held : { result, lastError };
  return { shown, stale: shown.result !== result || shown.lastError !== lastError, showLatest: () => setHeld({ result, lastError }) };
}

export const Inspector = memo(function Inspector({ collection, path, result, failure, lastError, frozen, running, busy, active, continueWhen, onContinueWhen, onRun, onClose }: {
  collection: Collection; path: Item[]; result?: ResultSample; failure?: string;
  lastError?: ResultSample; // sample of the last failed call in load mode: shown as its own tab when given
  frozen: boolean; // load run in progress: the samples change while it runs, so the shown ones wait for Show latest
  running: boolean; // this node is running
  busy: boolean; // any run is in progress
  active: boolean; // flows screen visible: global hotkeys only apply then
  continueWhen: number[]; onContinueWhen: (statuses: number[]) => void;
  onRun: (r: RequestItem) => void; onClose: () => void;
}) {
  const [statuses, setStatuses] = useState(continueWhen.join(', '));
  const [tab, setTab] = useState<string | null>(result || failure ? 'response' : 'request');
  const saved = path[path.length - 1] as RequestItem;
  const { draft, set, dirty, saving, save } = useRequestDraft(collection, saved, active);
  const run = () => { if (active && !busy) onRun(draft); };
  useHotkeys([['mod+S', () => { if (!modalOpen()) void save(); }], ['mod+Enter', () => { if (!modalOpen()) run(); }]], []);
  useHotkeys([['esc', () => { if (active) onClose(); }]]);

  const { shown, stale, showLatest } = useHeldSamples(frozen, result, lastError);
  const shownTab = tab === 'error' && !shown.lastError ? 'response' : tab;

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
          {stale && <Button variant="subtle" size="xs" onClick={showLatest}>Show latest</Button>}
        </Group>
      </div>
      <Tabs value={shownTab} onChange={setTab} keepMounted={false} className="pane-tabs">
        <Tabs.List px="md">
          <Tabs.Tab value="response">Response</Tabs.Tab>
          <Tabs.Tab value="request">Request</Tabs.Tab>
          {shown.lastError && <Tabs.Tab value="error">Last error</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="response" px="md" style={{ display: 'flex', flexDirection: 'column' }}>
          <LastResult result={shown.result} failure={failure} running={running} />
        </Tabs.Panel>
        {shown.lastError && (
          <Tabs.Panel value="error" px="md" style={{ display: 'flex', flexDirection: 'column' }}>
            <LastResult result={shown.lastError} running={false} />
          </Tabs.Panel>
        )}
        <Tabs.Panel value="request">
          <Section title="Request" defaultOpen><RequestLine draft={draft} set={set} collection={collection} /></Section>
          {REQUEST_PARTS.map(({ id, sectionTitle, Fields }) => (
            <Section key={id} title={sectionTitle} count={counts[id]}><Fields draft={draft} set={set} /></Section>
          ))}
          <Section title="Continue when" count={continueWhen.join(', ') || undefined}>
            <TextInput
              label="Response status is one of" description="Empty = any 2xx. A failed test or script error always goes to Fail." placeholder="200, 201, 204"
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }} value={statuses}
              error={parseStatuses(statuses) ? undefined : 'Status codes from 100 to 599, separated by commas'}
              onChange={(e) => { const text = e.currentTarget.value; setStatuses(text); const p = parseStatuses(text); if (p) onContinueWhen(p); }}
            />
          </Section>
        </Tabs.Panel>
      </Tabs>
    </aside>
  );
});
