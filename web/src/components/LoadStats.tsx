import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Button, Group, Progress, ScrollArea, SegmentedControl, Table, Text, UnstyledButton } from '@mantine/core';
import type { FlowRunState, LoadCalls, LoadStats, NodeStats, ResultSample } from '../../../shared/api';
import { emptyStats, merge, summary } from '../../../shared/stats';
import type { Id } from '../../../shared/model';
import { api, ApiError } from '../api';
import { formatMs } from '../util';
import { LastResult } from './ResponseView';
import { Icons } from './ui';

const STATUS: Record<FlowRunState['status'], string> = { running: 'Running', done: 'Done', limit: 'Time limit', cancelled: 'Stopped', error: 'Error' };

const COLUMNS = ['Request', 'Count', 'OK', 'Fail', 'Err %', 'Min', 'Avg', 'p50', 'p95', 'Max', 'Codes'];
const rps = (load: LoadStats) => (load.elapsedMs ? (Object.values(load.nodes).reduce((n, s) => n + s.count, 0) * 1000) / load.elapsedMs : 0);

/** Large live counter over the canvas while a load run runs. */
export function LoadProgress({ load }: { load: LoadStats }) {
  return (
    <div className="load-progress" aria-label="Load run progress">
      <Text size="xl" fw={600} ff="monospace">Iteration {load.iterationsDone}{load.iterations !== undefined && ` / ${load.iterations}`}</Text>
      <Group gap="md" ff="monospace">
        <Text c="dimmed">Workers <Text span c="var(--mantine-color-text)">{load.vus}</Text></Text>
        <Text c="dimmed">RPS <Text span c="var(--mantine-color-text)">{rps(load).toFixed(1)}</Text></Text>
        <Text c="dimmed"><Text span c="var(--mantine-color-text)">{(load.elapsedMs / 1000).toFixed(1)}</Text> s</Text>
      </Group>
      {load.iterations !== undefined && <Progress size={4} mt={6} color="go" value={(100 * load.iterationsDone) / load.iterations} transitionDuration={200} aria-hidden />}
    </div>
  );
}

/** The node's newest calls (refreshed every second while the run runs) and the request + response of the picked one. */
function Calls({ flowId, runId, id, running }: { flowId: Id; runId: Id; id: Id; running: boolean }) {
  const [filter, setFilter] = useState<'all' | 'failed'>('all');
  const [list, setList] = useState<LoadCalls>();
  const [seq, setSeq] = useState<number>();
  const [picked, setPicked] = useState<ResultSample>();
  const [error, setError] = useState<string>();
  const [callError, setCallError] = useState<string>();
  const paused = running && seq !== undefined; // the list holds still while a call is looked at
  useEffect(() => {
    if (paused) return;
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => api.getLoadCalls(flowId, runId, id, filter)
      .then((l) => { if (alive) { setList(l); setError(undefined); } }, (e: Error) => alive && setError(e.message))
      .finally(() => { if (alive && running) timer = setTimeout(load, 1000); }); // chained, so slow replies don't pile up
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [flowId, runId, id, filter, running, paused]);
  useEffect(() => {
    setPicked(undefined);
    setCallError(undefined);
    if (seq === undefined) return;
    let alive = true;
    api.getLoadCall(flowId, runId, seq).then((r) => alive && setPicked(r), (e: Error) => {
      if (alive) setCallError(e instanceof ApiError && e.status === 404 ? 'This call is no longer kept — pick a newer one.' : e.message);
    });
    return () => { alive = false; };
  }, [flowId, runId, seq]);
  const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false }) + `.${String(at % 1000).padStart(3, '0')}`;
  return (
    <Group align="stretch" wrap="nowrap" gap="md" style={{ height: 360 }}>
      <div style={{ width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <SegmentedControl size="xs" aria-label="Call filter" value={filter} onChange={(v) => { setFilter(v as 'all' | 'failed'); setSeq(undefined); }} data={[{ value: 'all', label: 'All' }, { value: 'failed', label: 'Failed' }]} />
        <Group gap="xs" wrap="nowrap">
          {list?.truncated && <Text size="xs" c="dimmed">Showing {list.calls.length} of {list.total} {filter === 'failed' ? 'failed calls' : 'calls'}</Text>}
          {paused && <Button size="compact-xs" variant="default" ml="auto" onClick={() => setSeq(undefined)}>Show newest</Button>}
        </Group>
        {error && <Text size="xs" ff="monospace" className="signal-text" data-signal="stop">{error}</Text>}
        <ScrollArea style={{ flex: 1 }} type="hover" role="group" aria-label="Calls">
          {list && !list.calls.length && <Text c="dimmed" size="sm">{filter === 'failed' ? 'No failed call yet.' : 'No call yet.'}</Text>}
          {list?.calls.map((c) => (
            <UnstyledButton key={c.seq} className="env-row" style={{ padding: '2px 8px' }} data-active={c.seq === seq || undefined} aria-pressed={c.seq === seq} onClick={() => setSeq(c.seq)}>
              <Group gap="sm" wrap="nowrap" ff="monospace">
                <Text size="xs" w={56}>#{c.iteration}</Text>
                <Text size="xs" w={40} c="dimmed">W{c.vu}</Text>
                <Text size="xs" w={92} c="dimmed">{time(c.at)}</Text>
                <Text size="xs" w={72} truncate>{c.status ?? c.code}</Text>
                <Text size="xs" w={64} ta="right">{formatMs(c.ms)}</Text>
                <Badge size="xs" variant="light" color={c.outcome === 'ok' ? 'go' : 'stop'}>{c.outcome === 'ok' ? 'OK' : 'Fail'}</Badge>
              </Group>
            </UnstyledButton>
          ))}
        </ScrollArea>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {callError
          ? <Text size="xs" ff="monospace" className="signal-text" data-signal="stop">{callError}</Text>
          : picked ? <LastResult result={picked} running={false} bodyPath={`load-call-${id}`} /> : seq === undefined && <Text c="dimmed">Pick a call to see its request and response.</Text>}
      </div>
    </Group>
  );
}

function Row({ id, name, s, total, open, onToggle, flowId, runId, running }: { id?: Id; name: string; s: NodeStats; total?: boolean; open?: boolean; onToggle?: () => void; flowId?: Id; runId?: Id; running?: boolean }) {
  const x = summary(s);
  const ms = (v: number) => (x.count ? formatMs(v) : '—');
  return (<>
    <Table.Tr fw={total ? 600 : undefined}>
      <Table.Td>
        {onToggle
          ? <button type="button" className="dock-collection-head" aria-expanded={!!open} onClick={onToggle}>{Icons.chevron(!!open)}{name}</button>
          : name}
      </Table.Td>
      <Table.Td ff="monospace">{x.count}</Table.Td>
      <Table.Td ff="monospace" className="signal-text" data-signal={x.ok ? 'go' : undefined}>{x.ok}</Table.Td>
      <Table.Td ff="monospace" className="signal-text" data-signal={x.fail ? 'stop' : undefined}>{x.fail}</Table.Td>
      <Table.Td ff="monospace">{x.errPct.toFixed(1)}%</Table.Td>
      {[x.min, x.avg, x.p50, x.p95, x.max].map((v, i) => <Table.Td key={i} ff="monospace">{ms(v)}</Table.Td>)}
      <Table.Td>
        <Group gap={4}>
          {Object.entries(s.codes).map(([code, n]) => <Badge key={code} size="xs" variant="default" ff="monospace">{code}×{n}</Badge>)}
        </Group>
      </Table.Td>
    </Table.Tr>
    {open && id && flowId && runId && <Table.Tr><Table.Td colSpan={COLUMNS.length}><Calls key={runId} flowId={flowId} runId={runId} id={id} running={!!running} /></Table.Td></Table.Tr>}
  </>);
}

/** Live totals of a load run, in place of the endpoint dock. */
export function LoadStatsPanel({ flowId, runId, load, status, error, nodes, tabs, onExpand }: {
  flowId: Id; runId: Id; load: LoadStats; status: FlowRunState['status']; error?: string;
  nodes: { id: Id; name: string }[]; // request nodes in flow order
  tabs: ReactNode; // the panel switcher, in place of a title
  onExpand?: () => void; // a row opened: the panel needs room for the call details
}) {
  const total = Object.values(load.nodes).reduce(merge, emptyStats());
  const sec = load.elapsedMs / 1000;
  const [open, setOpen] = useState<Id | null>(null);
  return (
    <div className="library">
      <Group className="library-head" gap="lg" wrap="nowrap">
        {tabs}
        <Text className="signal-text" data-signal={status === 'running' ? 'caution' : status === 'done' ? 'go' : 'stop'}>{STATUS[status]}</Text>
        <Text c="dimmed">Time <Text span ff="monospace" c="var(--mantine-color-text)">{sec.toFixed(1)} s</Text></Text>
        <Text c="dimmed">Iterations <Text span ff="monospace" c="var(--mantine-color-text)">{load.iterationsDone} / {load.iterations ?? '∞'}</Text></Text>
        <Text c="dimmed">Failed <Text span ff="monospace" c={load.failedIterations ? 'var(--mantine-color-stop-5)' : 'var(--mantine-color-text)'}>{load.failedIterations}</Text></Text>
        <Text c="dimmed">Workers <Text span ff="monospace" c="var(--mantine-color-text)">{load.vus}</Text></Text>
        <Text c="dimmed">RPS <Text span ff="monospace" c="var(--mantine-color-text)">{sec ? rps(load).toFixed(1) : '—'}</Text></Text>
      </Group>
      {error && <Text px="md" size="xs" ff="monospace" className="signal-text" data-signal="stop">{error}</Text>}
      <ScrollArea style={{ flex: 1 }} type="hover">
        <Table px="md" striped highlightOnHover withRowBorders={false}>
          <Table.Thead>
            <Table.Tr>{COLUMNS.map((h) => <Table.Th key={h}>{h}</Table.Th>)}</Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {nodes.map((n) => (
              <Row
                key={n.id} id={n.id} name={n.name} s={load.nodes[n.id] ?? emptyStats()} flowId={flowId} runId={runId} running={status === 'running'}
                open={open === n.id} onToggle={() => { if (open !== n.id) onExpand?.(); setOpen((o) => (o === n.id ? null : n.id)); }}
              />
            ))}
            <Row name="Total" s={total} total />
          </Table.Tbody>
        </Table>
      </ScrollArea>
    </div>
  );
}
