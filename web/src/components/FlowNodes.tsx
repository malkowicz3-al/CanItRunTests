import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { FlowRunState, ResultSample } from '../../../shared/api';
import { summary } from '../../../shared/stats';
import type { FlowNode, RequestItem } from '../../../shared/model';
import { useApp } from '../context';
import { freshResult, scriptVars } from '../flow';
import { findPath, formatMs, prettyBody } from '../util';
import { statusSignal } from './ResponseView';
import { MethodGlyph } from './ui';

/** Last run of the open flow (from /ws), a node run alone and its failures; nodes read it here so a result does not rewrite `nodes`. */
export interface FlowRunView { run: FlowRunState | null; single: string | null; failures: Record<string, string> }
export const FlowRunContext = createContext<FlowRunView>({ run: null, single: null, failures: {} });

type RequestData = Extract<FlowNode, { type: 'request' }>['data'];
type Signal = 'caution' | 'go' | 'stop' | undefined;

function nodeSignal({ run, single, failures }: FlowRunView, id: string): Signal {
  if (single === id || (run?.status === 'running' && run.currentNodeId === id)) return 'caution';
  if (failures[id]) return 'stop';
  const l = run?.load?.nodes[id];
  if (l?.count) return l.fail ? 'stop' : 'go';
  const s = run?.nodes[id];
  return s && (s.outcome === 'ok' ? 'go' : 'stop');
}

function StartNode({ selected }: NodeProps) {
  return (
    <div className="flow-node flow-start" data-selected={selected || undefined}>
      <span>Start</span>
      <Handle type="source" id="ok" position={Position.Right} />
    </div>
  );
}

/** Short-lived summary next to a node after it runs; fades by CSS, at most one at a time (a result arriving while one is shown is skipped). */
function ResultBubble({ result, count, run, single }: { result?: ResultSample; count?: number; run: FlowRunState | null; single: boolean }) {
  const [shown, setShown] = useState<ResultSample>();
  const runId = run?.runId, running = run?.status === 'running';
  const prev = useRef({ result, count, runId });
  useEffect(() => {
    const next = { result, count, runId };
    const fresh = freshResult(prev.current, next, running, single);
    prev.current = next;
    if (fresh) setShown((s) => s ?? result);
  }, [result, count, runId, running, single]);
  const res = shown?.response;
  const lines = useMemo(() => (res?.body ? prettyBody(res.body, [res.headers['content-type']].flat()[0]).text.split('\n', 3).map((l) => l.slice(0, 200)) : []), [res]);
  if (!shown) return null;
  return (
    <div className="flow-bubble" aria-hidden onAnimationEnd={() => setShown(undefined)}>
      {res
        ? <div><span className="signal-text" data-signal={statusSignal(res.status)}>{res.status}</span> · {formatMs(res.timings.total)}</div>
        : <div className="signal-text" data-signal="stop">{shown.error?.code ?? 'No response'}</div>}
      {lines.length > 0 && <pre className="flow-bubble-body">{lines.join('\n')}</pre>}
    </div>
  );
}

/** True for ACTIVE_MS after `count` grew: a load node glows while its calls keep coming. */
const ACTIVE_MS = 600;
function useGrowing(count: number) {
  const [active, setActive] = useState(false);
  const prev = useRef(count);
  useEffect(() => {
    const grew = count > prev.current;
    prev.current = count;
    setActive(grew);
    if (!grew) return;
    const t = setTimeout(() => setActive(false), ACTIVE_MS);
    return () => clearTimeout(t);
  }, [count]);
  return active;
}

function RequestNode({ id, data, selected }: NodeProps<Node<RequestData, 'request'>>) {
  const app = useApp();
  const view = useContext(FlowRunContext);
  const { run, failures } = view;
  const c = app.collections.find((x) => x.id === data.collectionId);
  const saved = c && findPath(c.items, data.requestId).at(-1);
  const req = saved?.kind === 'request' ? ((app.drafts[saved.id] as RequestItem | undefined) ?? saved) : undefined;
  const state = run?.nodes[id];
  const stats = run?.load?.nodes[id];
  const r = state?.result ?? stats?.last;
  const sum = useMemo(() => stats && summary(stats), [stats]); // percentiles walk the histogram, 10 times a second in a load run
  const tests = r ? [...r.preScripts, ...r.testScripts].flatMap((s) => s.tests) : [];
  const passed = tests.filter((t) => t.passed).length;
  const scripts = req?.scripts;
  const sets = useMemo(() => (scripts ? scriptVars(scripts) : []), [scripts]);
  const signal = nodeSignal(view, id);
  const active = useGrowing(stats?.count ?? 0) && run?.status === 'running';
  return (
    <div className="flow-node" data-signal={signal} data-active={active || undefined} data-selected={selected || undefined} data-missing={!req || undefined}>
      <Handle type="target" position={Position.Left} />
      <ResultBubble result={r} count={state?.runs ?? stats?.count} run={run} single={view.single === id} />
      <div className="flow-node-head">
        <MethodGlyph method={req?.method ?? '?'} />
        <span className="flow-node-name">{req?.name ?? 'Missing request'}</span>
      </div>
      <div className="flow-node-collection">{c?.name ?? 'Unknown collection'}</div>
      {req && <div className="flow-node-url">{req.url || '—'}</div>}
      {sets.length > 0 && <div className="flow-node-sets">Sets: {sets.join(', ')}</div>}
      <div className="flow-node-meta">
        {sum ? `${sum.count} · p95 ${formatMs(sum.p95)} · ${sum.errPct.toFixed(1)}% err`
          : signal === 'caution' ? 'Running…' : r?.response ? `${r.response.status} · ${formatMs(r.response.timings.total)}` : r?.error ? r.error.code : failures[id] ? 'Error' : '—'}
        {!sum && tests.length > 0 && <> · <span className="signal-text" data-signal={passed === tests.length ? 'go' : 'stop'}>{passed}/{tests.length}</span></>}
        {state && state.runs > 1 && <> · ×{state.runs}</>}
      </div>
      <div className="flow-pins">
        <div className="flow-pin">OK<Handle type="source" id="ok" position={Position.Right} /></div>
        <div className="flow-pin" data-pin="fail">Fail<Handle type="source" id="fail" position={Position.Right} /></div>
      </div>
    </div>
  );
}

export const nodeTypes = { start: StartNode, request: RequestNode };
