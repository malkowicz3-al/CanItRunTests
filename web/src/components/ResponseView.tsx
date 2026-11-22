import { useState } from 'react';
import { Box, Code, Group, Loader, Stack, Table, Tabs, Text } from '@mantine/core';
import type { RunResult, ScriptResult, Timings } from '../../../shared/api';
import { formatMs, formatSize, prettyBody } from '../util';
import { CodeEditor } from './CodeEditor';
import { MethodGlyph, Section } from './ui';

const statusSignal = (s: number) => (s >= 200 && s < 300 ? 'go' : s >= 300 && s < 400 ? 'caution' : 'stop');
const PHASES: [keyof Timings, string][] = [['dns', 'DNS'], ['tcp', 'TCP'], ['tls', 'TLS'], ['ttfb', 'TTFB'], ['transfer', 'Transfer']];
const LEVEL_SIGNAL: Record<string, string> = { error: 'stop', warn: 'caution' };

function HeaderTable({ headers }: { headers: Record<string, string | string[]> }) {
  const rows = Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => [k, x]));
  if (!rows.length) return <Text c="dimmed">No headers.</Text>;
  return (
    <Table withRowBorders verticalSpacing={3} fz="xs" ff="monospace" className="plain-table">
      <Table.Tbody>
        {rows.map(([k, v], i) => (
          <Table.Tr key={i}><Table.Td fw={500} w="38%" style={{ wordBreak: 'break-all' }}>{k}</Table.Td><Table.Td style={{ wordBreak: 'break-all' }}>{v}</Table.Td></Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/** Timing phases as one line split into segments, like the track. */
function TimingLine({ t }: { t: Timings }) {
  const total = Math.max(PHASES.reduce((s, [k]) => s + t[k], 0), 1);
  return (
    <Stack gap={6}>
      <div className="timing-line" role="img" aria-label={PHASES.map(([k, l]) => `${l} ${formatMs(t[k])}`).join(', ')}>
        {PHASES.map(([k], i) => <span key={k} data-phase={i} style={{ flexGrow: t[k] / total, flexBasis: t[k] ? 3 : 0 }} />)}
      </div>
      <Group gap="md">
        {PHASES.map(([k, label], i) => (
          <Text key={k} size="xs" c="dimmed"><span className="phase-key" data-phase={i} />{label} <Text span size="xs" ff="monospace" c="var(--mantine-color-text)">{formatMs(t[k])}</Text></Text>
        ))}
      </Group>
    </Stack>
  );
}

function Tests({ scripts }: { scripts: ScriptResult[] }) {
  const tests = scripts.flatMap((s) => s.tests);
  if (!tests.length) return <Text c="dimmed">No tests ran. Add <Code>pm.test()</Code> calls in Scripts.</Text>;
  return (
    <Stack gap={4}>
      {tests.map((t, i) => (
        <Group key={i} gap="xs" wrap="nowrap" align="flex-start">
          <span className="signal-dot" data-signal={t.passed ? 'go' : 'stop'} aria-label={t.passed ? 'Passed' : 'Failed'} />
          <div>
            <Text>{t.name}</Text>
            {t.error && <Text size="xs" ff="monospace" className="signal-text" data-signal="stop">{t.error}</Text>}
          </div>
        </Group>
      ))}
    </Stack>
  );
}

function ConsoleView({ r }: { r: RunResult }) {
  const logs = [...r.preScripts.flatMap((s) => s.logs.map((l) => ({ ...l, from: 'pre' }))), ...r.testScripts.flatMap((s) => s.logs.map((l) => ({ ...l, from: 'test' })))];
  if (!logs.length) return <Text c="dimmed">No console output.</Text>;
  return (
    <Stack gap={0}>
      {logs.map((l, i) => (
        <Group key={i} gap="xs" wrap="nowrap" align="flex-start" py={3} className="console-line">
          <Text size="xs" c="dimmed" w={32} style={{ flexShrink: 0 }}>{l.from}</Text>
          <Text size="xs" ff="monospace" className="signal-text" data-signal={LEVEL_SIGNAL[l.level]} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{l.text}</Text>
        </Group>
      ))}
    </Stack>
  );
}

function SentRequest({ r }: { r: RunResult }) {
  const f = r.finalRequest;
  return (
    <Stack gap="sm">
      {r.redirects.length > 0 && (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">Redirect chain</Text>
          {r.redirects.map((h, i) => (
            <Group key={i} gap="xs" wrap="nowrap">
              <MethodGlyph method={h.method} w={52} />
              <Text size="xs" ff="monospace" style={{ wordBreak: 'break-all', flex: 1 }}>{h.url}</Text>
              <Text size="xs" ff="monospace" className="signal-text" data-signal={statusSignal(h.status)}>{h.status}</Text>
            </Group>
          ))}
        </Stack>
      )}
      <Group gap="xs" wrap="nowrap">
        <MethodGlyph method={f.method} w={52} />
        <Text size="xs" ff="monospace" style={{ wordBreak: 'break-all' }}>{f.url}</Text>
      </Group>
      <HeaderTable headers={f.headers} />
      {f.body !== undefined && <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{f.body}</Code>}
    </Stack>
  );
}

/** Run report: collapsible sections in the Flows inspector, `tabs` in the Requests workbench (body fills the height). */
export function LastResult({ result, failure, running, tabs }: { result?: RunResult; failure?: string; running: boolean; tabs?: boolean }) {
  const [tab, setTab] = useState<string | null>('body'); // kept across runs: LastResult stays mounted
  if (running) return <Group gap="xs"><Loader size="xs" color="caution" /><Text c="dimmed">Running...</Text></Group>;
  if (failure) return <Text className="signal-text" data-signal="stop" ff="monospace" size="xs">{failure}</Text>;
  if (!result) return <Text c="dimmed">{tabs ? 'Not sent yet. Press Send or Ctrl + Enter.' : 'Not run yet. Press Run station or Ctrl + Enter.'}</Text>;
  const res = result.response;
  const all = [...result.preScripts, ...result.testScripts];
  const tests = all.flatMap((s) => s.tests);
  const failed = tests.filter((t) => !t.passed).length;
  const logCount = all.reduce((n, s) => n + s.logs.length, 0);
  const ct = res && [res.headers['content-type']].flat()[0];
  const body = res ? prettyBody(res.body, ct) : undefined;
  const scriptErrors = [...result.preScripts.map((s) => ['Pre-request', s.error]), ...result.testScripts.map((s) => ['Test', s.error])].filter(([, e]) => e);

  const summary = <>
    {res ? (
      <Group gap="lg" align="baseline">
        <Text size="xl" fw={600} ff="monospace" className="signal-text" data-signal={statusSignal(res.status)}>{res.status}</Text>
        <Text c="dimmed">{res.statusText}</Text>
        <Text c="dimmed">Time <Text span ff="monospace" c="var(--mantine-color-text)">{formatMs(res.timings.total)}</Text></Text>
        <Text c="dimmed">Size <Text span ff="monospace" c="var(--mantine-color-text)">{formatSize(res.size)}</Text></Text>
      </Group>
    ) : <Text size="lg" fw={600} className="signal-text" data-signal="stop">No response</Text>}
    {result.error && <Text size="xs" ff="monospace" className="signal-text" data-signal="stop">{result.error.code}: {result.error.message}</Text>}
    {scriptErrors.map(([kind, e], i) => <Text key={i} size="xs" ff="monospace" className="signal-text" data-signal="stop">{kind} script error: {e}</Text>)}
  </>;
  // separate Monaco model per screen: Requests and the Flows inspector are mounted at the same time
  const bodyView = res?.body ? (
    <Stack gap={4} h={tabs ? '100%' : undefined}>
      {res.truncated && <Text size="xs" className="signal-text" data-signal="caution">Body truncated for display ({formatSize(res.size)} total).</Text>}
      <Box className="editor-box" h={tabs ? undefined : 320} style={tabs ? { flex: 1, minHeight: 120 } : undefined}><CodeEditor path={tabs ? 'requests/response' : 'response'} readOnly language={body!.language} value={body!.text} /></Box>
    </Stack>
  ) : <Text c="dimmed">Empty body.</Text>;
  const parts = {
    body: { title: 'Body', count: res?.body ? formatSize(res.size) : 0, view: bodyView },
    headers: { title: tabs ? 'Headers' : 'Response headers', count: res ? Object.keys(res.headers).length : 0, view: res ? <HeaderTable headers={res.headers} /> : <Text c="dimmed">No response.</Text> },
    tests: { title: 'Tests', count: tests.length ? `${tests.length - failed}/${tests.length}` : 0, view: <Tests scripts={all} /> },
    console: { title: 'Console', count: logCount, view: <ConsoleView r={result} /> },
    timing: { title: 'Timing', count: 0, view: res ? <TimingLine t={res.timings} /> : <Text c="dimmed">No response.</Text> },
    sent: { title: 'Sent request', count: result.redirects.length ? `${result.redirects.length} redirect${result.redirects.length > 1 ? 's' : ''}` : 0, view: <SentRequest r={result} /> },
  };
  const count = (c: string | number) => (c === 0 ? null : <span className="section-count">{c}</span>);

  if (tabs) {
    return (
      <div className="result-tabs">
        <Stack gap={6}>{summary}</Stack>
        <Tabs value={tab} onChange={setTab} keepMounted={false} className="pane-tabs">
          <Tabs.List>
            {Object.entries(parts).map(([id, p]) => <Tabs.Tab key={id} value={id} rightSection={count(p.count)}>{p.title}</Tabs.Tab>)}
          </Tabs.List>
          {Object.entries(parts).map(([id, p]) => <Tabs.Panel key={id} value={id}>{p.view}</Tabs.Panel>)}
        </Tabs>
      </div>
    );
  }
  const section = (id: keyof typeof parts, open?: boolean) => <Section title={parts[id].title} count={parts[id].count} defaultOpen={open}>{parts[id].view}</Section>;
  return (
    <Stack gap="sm">
      {summary}
      {res && <TimingLine t={res.timings} />}
      <div>
        {section('tests', true)}
        {section('console')}
        {section('body', true)}
        {section('headers')}
        {section('sent')}
      </div>
    </Stack>
  );
}
