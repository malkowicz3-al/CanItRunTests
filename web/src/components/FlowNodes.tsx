import { createContext, useContext } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { FlowRunState } from '../../../shared/api';
import type { FlowNode, RequestItem } from '../../../shared/model';
import { useApp } from '../context';
import { scriptVars } from '../flow';
import { findPath, formatMs } from '../util';
import { MethodGlyph } from './ui';

/** Last run of the open flow (from /ws), a node run alone and its failures; nodes read it here so a result does not rewrite `nodes`. */
export interface FlowRunView { run: FlowRunState | null; single: string | null; failures: Record<string, string> }
export const FlowRunContext = createContext<FlowRunView>({ run: null, single: null, failures: {} });

type RequestData = Extract<FlowNode, { type: 'request' }>['data'];
type Signal = 'caution' | 'go' | 'stop' | undefined;

function nodeSignal({ run, single, failures }: FlowRunView, id: string): Signal {
  if (single === id || (run?.status === 'running' && run.currentNodeId === id)) return 'caution';
  if (failures[id]) return 'stop';
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

function RequestNode({ id, data, selected }: NodeProps<Node<RequestData, 'request'>>) {
  const app = useApp();
  const view = useContext(FlowRunContext);
  const { run, failures } = view;
  const c = app.collections.find((x) => x.id === data.collectionId);
  const saved = c && findPath(c.items, data.requestId).at(-1);
  const req = saved?.kind === 'request' ? ((app.drafts[saved.id] as RequestItem | undefined) ?? saved) : undefined;
  const state = run?.nodes[id];
  const r = state?.result;
  const tests = r ? [...r.preScripts, ...r.testScripts].flatMap((s) => s.tests) : [];
  const passed = tests.filter((t) => t.passed).length;
  const sets = req ? scriptVars(req.scripts) : [];
  const signal = nodeSignal(view, id);
  return (
    <div className="flow-node" data-signal={signal} data-selected={selected || undefined} data-missing={!req || undefined}>
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-head">
        <MethodGlyph method={req?.method ?? '?'} />
        <span className="flow-node-name">{req?.name ?? 'Missing request'}</span>
      </div>
      <div className="flow-node-collection">{c?.name ?? 'Unknown collection'}</div>
      {req && <div className="flow-node-url">{req.url || '—'}</div>}
      {sets.length > 0 && <div className="flow-node-sets">Sets: {sets.join(', ')}</div>}
      <div className="flow-node-meta">
        {signal === 'caution' ? 'Running…' : r?.response ? `${r.response.status} · ${formatMs(r.response.timings.total)}` : r?.error ? r.error.code : failures[id] ? 'Error' : '—'}
        {tests.length > 0 && <> · <span className="signal-text" data-signal={passed === tests.length ? 'go' : 'stop'}>{passed}/{tests.length}</span></>}
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
