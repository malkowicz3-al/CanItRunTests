import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { notifications } from '@mantine/notifications';
import { ActionIcon, Button, Group, Menu, NumberInput, ScrollArea, Text, TextInput, Tooltip, useComputedColorScheme } from '@mantine/core';
import { Background, Controls, ReactFlow, type ReactFlowInstance } from '@xyflow/react';
import type { FlowRunState } from '../../../shared/api';
import { FLOW_MAX_NODE_RUNS_CAP, nodeOutcome, validateFlow } from '../../../shared/flow';
import type { Flow, FlowEdge, FlowNode, Id, RequestItem } from '../../../shared/model';
import { api, ApiError } from '../api';
import { notifyError, runEnvironmentId, useApp } from '../context';
import { addRequestNode, applyRunEvent, connect, fromTrack } from '../flow';
import { findPath } from '../util';
import { subscribe } from '../ws';
import { EnvironmentSelect } from './EnvironmentEditor';
import { FlowRunContext, nodeTypes } from './FlowNodes';
import { Inspector } from './Inspector';
import { EndpointDock, ItemMenu, TICKET_MIME } from './Library';
import { ConfirmModal, EmptyState, Icons } from './ui';

const FLOW_KEY = 'cirt.flow';
const TRACK_KEY = 'cirt.track'; // Stage 1 scratch track, migrated once into a flow
// localStorage throws in some privacy modes; the open flow is just not remembered then
const readFlowId = () => { try { return localStorage.getItem(FLOW_KEY); } catch { return null; } };
const writeFlowId = (id: string | null) => { try { if (id) localStorage.setItem(FLOW_KEY, id); else localStorage.removeItem(FLOW_KEY); } catch { /* not persisted */ } };
const MISSING = 'This request no longer exists. Remove the node or add the endpoint again.';
const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
const FIT = { padding: 0.2, maxZoom: 1 };
let migrated = false; // StrictMode mounts twice in dev: the track must become one flow, not two

// Start cannot be deleted; React Flow reads `deletable`, the server drops it on save
const lockStart = (f: Flow): Flow => ({ ...f, nodes: f.nodes.map((n) => (n.type === 'start' ? ({ ...n, deletable: false } as FlowNode) : n)) });

export function FlowsScreen({ active, addToFlow }: { active: boolean; addToFlow: MutableRefObject<(collectionId: Id, requestId: Id) => void> }) {
  const app = useApp();
  const scheme = useComputedColorScheme('dark');
  const [list, setList] = useState<{ id: Id; name: string }[]>([]);
  const [openId, setOpenId] = useState<Id | null>(readFlowId);
  const [flow, setFlowState] = useState<Flow | null>(null);
  const [run, setRun] = useState<FlowRunState | null>(null);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [single, setSingle] = useState<string | null>(null); // node run alone through /api/run
  const [selected, setSelected] = useState<string | null>(null);
  const [editName, setEditName] = useState(false);
  const [del, setDel] = useState<{ id: Id; name: string } | null>(null);
  const [split, setSplit] = useState(0.65);
  const [rf, setRf] = useState<ReactFlowInstance<FlowNode, FlowEdge>>();
  const fitted = useRef<unknown>(null);
  const flowRef = useRef<Flow | null>(null); // React Flow can send several changes before a re-render
  const openRef = useRef(openId);
  openRef.current = openId;
  const pending = useRef<Flow | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const creating = useRef<Promise<void> | null>(null); // one "Untitled flow" for fast repeated adds
  // the flow run this tab started: it holds claimRun until flow.done
  const mine = useRef<{ runId: Id; flowId: Id; collectionIds: Id[] } | null>(null);

  const setFlow = (f: Flow | null) => { flowRef.current = f; setFlowState(f); };
  /** Saves queued after collection saves; with nothing pending it still waits for saves in flight. */
  const flush = () => {
    clearTimeout(timer.current);
    const f = pending.current;
    pending.current = null;
    const p = app.enqueue(f ? () => api.saveFlow(f) : async () => undefined);
    if (f) p.catch(notifyError);
    return p;
  };
  /** Graph change: shown at once, saved 500 ms after the last one (moving a node is a change too, so no Save button). */
  const edit = (fn: (f: Flow) => Flow) => {
    if (!flowRef.current) return;
    const next = fn(flowRef.current);
    setFlow(next);
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { flush().catch(() => {}); }, 500);
  };
  const open = (id: Id | null) => {
    if (id === openRef.current) return;
    flush().catch(() => {});
    setFlow(null);
    setRun(null);
    setFailures({});
    setSelected(null);
    setEditName(false);
    setOpenId(id);
  };

  const settle = (runId: Id, status: FlowRunState['status']) => {
    const m = mine.current;
    if (!m || m.runId !== runId || status === 'running') return;
    mine.current = null;
    app.releaseRun();
    for (const id of m.collectionIds) app.refreshAfterRun(id).catch(() => {}); // only refreshes the UI
  };
  const fetchRun = (id: Id) => {
    const m = mine.current; // only a GET sent after the POST reply can tell that run is gone
    const lost = () => {
      if (!m || mine.current !== m || m.flowId !== id) return false;
      settle(m.runId, 'error');
      notifications.show({ color: 'stop', message: 'Run lost (the server restarted).' });
      return true;
    };
    return api.getFlowRun(id).then((r) => {
      if (openRef.current === id) setRun(r);
      if (r.runId !== m?.runId) lost();
      settle(r.runId, r.status);
    }, (e) => { // 404: never run since the server started
      if (!(e instanceof ApiError && e.status === 404)) return;
      lost();
      // a run watched from another tab is gone too; per-node results (no running status) stay
      if (openRef.current === id) setRun((s) => (s?.status === 'running' ? null : s));
    });
  };

  useEffect(() => {
    writeFlowId(openId);
    if (!openId || flowRef.current?.id === openId) return; // a flow created by addToFlow is already in state
    let live = true;
    api.getFlow(openId).then((f) => { if (live) setFlow(lockStart(f)); }, (e) => {
      if (!live) return;
      setOpenId(null);
      if (!(e instanceof ApiError && e.status === 404)) notifyError(e);
    });
    void fetchRun(openId);
    return () => { live = false; };
  }, [openId]);

  useEffect(() => { // edits still in the 500 ms debounce would be lost with the tab
    const hide = () => {
      const f = pending.current;
      if (f) void fetch(`/api/flows/${f.id}`, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) }).catch(() => {});
    };
    window.addEventListener('pagehide', hide);
    return () => window.removeEventListener('pagehide', hide);
  }, []);

  useEffect(() => { // the screen loads hidden (display: none), so the initial fit sees no size
    if (!active || !rf || fitted.current === rf) return; // fit once per canvas, keep the user's zoom later
    fitted.current = rf;
    let raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => { void rf.fitView(FIT); }); }); // after the resize observers
    return () => cancelAnimationFrame(raf);
  }, [active, rf]);

  useEffect(() => subscribe((e) => {
    if (e.type === 'open') { // events sent while disconnected are lost: catch up from the server
      for (const id of new Set([openRef.current, mine.current?.flowId])) if (id) void fetchRun(id);
      return;
    }
    if (e.flowId === openRef.current) setRun((s) => applyRunEvent(s, e));
    if (e.type === 'flow.done') settle(e.runId, e.status);
  }), []); // one subscription: handlers read refs

  useEffect(() => {
    api.listFlows().then(async (flows) => {
      let raw: unknown = null;
      try { raw = JSON.parse(localStorage.getItem(TRACK_KEY) ?? 'null'); } catch { /* unreadable: nothing to migrate */ }
      const track = !migrated && fromTrack(raw);
      migrated = true;
      if (track) {
        try {
          const f = await api.createFlow(track);
          flows = [...flows, { id: f.id, name: f.name }];
          try { localStorage.removeItem(TRACK_KEY); } catch { /* migrates again next time */ }
          if (!openRef.current) open(f.id);
        } catch (e) { notifyError(e); } // the key stays, so the next start retries
      }
      setList(flows.sort(byName));
    }).catch(notifyError);
  }, []);

  const create = async (name: string, from?: Flow) => {
    const f = await api.createFlow(from ? { ...from, name } : { name });
    setList((l) => [...l, { id: f.id, name: f.name }].sort(byName));
    return lockStart(f);
  };
  const add = async (collectionId: Id, requestId: Id, at?: { x: number; y: number }) => {
    if (!flowRef.current && openRef.current && !creating.current) { notifications.show({ message: 'Flow is loading.' }); return; }
    if (!flowRef.current) {
      try {
        await (creating.current ??= create('Untitled flow').then((f) => {
          open(f.id);
          setFlow(f); // after open, which clears it; the load effect then sees it and skips the fetch
        }).finally(() => { creating.current = null; }));
      } catch (e) { notifyError(e); return; }
    }
    edit((f) => addRequestNode(f, collectionId, requestId, at));
  };
  addToFlow.current = (c, r) => { void add(c, r); };
  const duplicate = async (id: Id) => {
    try {
      await flush();
      const src = await api.getFlow(id);
      open((await create(`${src.name} copy`, src)).id);
    } catch (e) { notifyError(e); }
  };
  const remove = async (id: Id) => {
    try {
      await flush().catch(() => {});
      await app.enqueue(() => api.deleteFlow(id));
      setList((l) => l.filter((x) => x.id !== id));
      if (id === openRef.current) open(null);
    } catch (e) { notifyError(e); }
  };

  const runFlow = async () => {
    const f = flowRef.current;
    if (!f || !app.claimRun()) return;
    try { await flush(); } catch { app.releaseRun(); return; } // the save error is already shown
    const reqs = f.nodes.flatMap((n) => (n.type === 'request' ? [n.data] : []));
    const overrides = Object.fromEntries(reqs.flatMap((d) => (d.requestId in app.drafts ? [[d.requestId, app.drafts[d.requestId] as RequestItem]] : [])));
    setFailures({});
    try {
      const { runId } = await api.runFlow(f.id, { environmentId: runEnvironmentId(app), overrides });
      mine.current = { runId, flowId: f.id, collectionIds: [...new Set(reqs.map((d) => d.collectionId))] };
      void fetchRun(f.id); // flow.done may have come before the reply
    } catch (e) { app.releaseRun(); notifyError(e); }
  };
  const runNode = async (nodeId: Id, collectionId: Id, draft: RequestItem, continueWhen: number[]) => {
    if (!app.claimRun()) return;
    const flowId = openRef.current;
    setSingle(nodeId);
    setFailures(({ [nodeId]: _, ...rest }) => rest);
    try {
      const r = await api.run({ collectionId, requestId: draft.id, environmentId: runEnvironmentId(app), request: draft });
      if (openRef.current === flowId) {
        setRun((s) => ({ ...(s ?? { runId: '', flowId: flowId ?? '', status: 'done', startedAt: new Date().toISOString(), path: [] }), nodes: { ...s?.nodes, [nodeId]: { result: r, outcome: nodeOutcome(r, continueWhen), runs: 1 } } }));
      }
      await app.refreshAfterRun(collectionId).catch(() => {}); // only refreshes the UI
    } catch (e) {
      setFailures((fs) => ({ ...fs, [nodeId]: e instanceof Error ? e.message : String(e) }));
    } finally { app.releaseRun(); setSingle(null); }
  };

  const running = run?.status === 'running';
  const busy = app.busy || running;
  const startId = flow?.nodes.find((n) => n.type === 'start')?.id;
  // cables leaving a node by the pin of its last outcome show that outcome
  const edges = useMemo(() => flow?.edges.map((e) => {
    const s = run?.nodes[e.source];
    const on = e.source === startId ? !!run?.path.length : s?.outcome === e.sourceHandle;
    return on ? { ...e, className: e.sourceHandle === 'ok' ? 'edge-go' : 'edge-stop' } : e;
  }), [flow?.edges, run, startId]);

  const sel = flow?.nodes.find((n) => n.id === selected);
  const selData = sel?.type === 'request' ? sel.data : undefined;
  const selCollection = selData && app.collections.find((c) => c.id === selData.collectionId);
  const selPath = selCollection && selData ? findPath(selCollection.items, selData.requestId) : [];
  const selRequest = selPath.at(-1)?.kind === 'request' ? selPath.at(-1) : undefined;
  const removeNode = (id: Id) => {
    edit((f) => ({ ...f, nodes: f.nodes.filter((n) => n.id !== id), edges: f.edges.filter((e) => e.source !== id && e.target !== id) }));
    setSelected(null);
  };

  const onDrop = (e: React.DragEvent) => {
    const ticket = e.dataTransfer.getData(TICKET_MIME);
    if (!ticket) return;
    e.preventDefault();
    try {
      const { collectionId, requestId } = JSON.parse(ticket) as { collectionId: unknown; requestId: unknown };
      if (typeof collectionId === 'string' && typeof requestId === 'string') void add(collectionId, requestId, rf?.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    } catch { /* not our ticket */ }
  };
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!(e.buttons & 1)) return;
    const r = e.currentTarget.parentElement!.getBoundingClientRect();
    setSplit(Math.min(0.85, Math.max(0.2, (e.clientY - r.top) / r.height)));
  };

  return (
    <div className="track-screen">
      <div className="track-body">
        <aside className="tree-pane flow-list" aria-label="Flows">
          <Group className="tree-head" gap={4} wrap="nowrap">
            <Text fw={600} style={{ flex: 1 }}>Flows</Text>
            <Tooltip label="New flow" openDelay={300}>
              <ActionIcon variant="subtle" color="gray" aria-label="New flow" onClick={() => { create('New flow').then((f) => open(f.id), notifyError); }}>{Icons.plus()}</ActionIcon>
            </Tooltip>
          </Group>
          <ScrollArea style={{ flex: 1 }} type="hover">
            <div className="tree">
              {!list.length && <Text size="xs" c="dimmed" px="md">No flows yet.</Text>}
              {list.map((x) => {
                const name = x.id === flow?.id ? flow.name : x.name;
                return (
                  <ItemMenu key={x.id} label={name} className="tree-row" menu={<>
                    <Menu.Item onClick={() => { open(x.id); setEditName(true); }}>Rename</Menu.Item>
                    <Menu.Item onClick={() => { void duplicate(x.id); }}>Duplicate</Menu.Item>
                    <Menu.Divider />
                    <Menu.Item color="stop" onClick={() => setDel({ id: x.id, name })}>Delete</Menu.Item>
                  </>}>
                    <button type="button" className="tree-main" style={{ paddingLeft: 16 }} aria-current={x.id === openId || undefined} onClick={() => open(x.id)}>
                      <span className="tree-name">{name}</span>
                    </button>
                  </ItemMenu>
                );
              })}
            </div>
          </ScrollArea>
        </aside>
        <div className="track-column">
          <header className="topbar">
            <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
              {flow && (editName ? (
                <TextInput
                  autoFocus variant="unstyled" size="lg" fw={600} value={flow.name} aria-label="Flow name"
                  onChange={(e) => { const name = e.currentTarget.value; edit((f) => ({ ...f, name })); }}
                  onBlur={() => { setEditName(false); if (!flow.name.trim()) edit((f) => ({ ...f, name: 'Untitled flow' })); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
                />
              ) : (
                <button type="button" className="track-name" onClick={() => setEditName(true)} aria-label="Rename flow">
                  <span>{flow.name}</span>{Icons.edit()}
                </button>
              ))}
            </Group>
            <Group gap="sm" wrap="nowrap">
              <EnvironmentSelect />
              {flow && <>
                <Group gap={6} wrap="nowrap">
                  <Text size="xs" c="dimmed">Max node runs</Text>
                  <NumberInput
                    size="xs" w={90} placeholder="100" min={1} max={FLOW_MAX_NODE_RUNS_CAP} allowDecimal={false} allowNegative={false} clampBehavior="strict"
                    aria-label="Max node runs" value={flow.maxNodeRuns ?? ''}
                    onChange={(v) => edit((f) => ({ ...f, maxNodeRuns: typeof v === 'number' && v >= 1 ? v : undefined }))}
                  />
                </Group>
                {running
                  ? <Button color="stop" leftSection={Icons.close()} onClick={() => { api.cancelFlow(flow.id).catch(notifyError); }}>Cancel</Button>
                  : <Button leftSection={Icons.play()} onClick={() => { void runFlow(); }} disabled={busy}>Run flow</Button>}
              </>}
            </Group>
          </header>
          <div
            className="flow-canvas" style={{ flex: `0 0 ${split * 100}%` }}
            onDragOver={(e) => { if (e.dataTransfer.types.includes(TICKET_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={onDrop}
          >
            {flow ? (
              <FlowRunContext.Provider value={{ run, single, failures }}>
                <ReactFlow<FlowNode, FlowEdge>
                  key={flow.id} nodes={flow.nodes} edges={edges} nodeTypes={nodeTypes} forceColorMode={scheme} fitView fitViewOptions={FIT}
                  deleteKeyCode={['Backspace', 'Delete']} onInit={setRf}
                  onNodesChange={(changes) => {
                    const f = flowRef.current;
                    if (!f) return;
                    const nodes = changes.applyTo(f.nodes);
                    if (changes.toArray().some((c) => c.type !== 'select' && c.type !== 'dimensions')) edit((x) => ({ ...x, nodes }));
                    else setFlow({ ...f, nodes });
                  }}
                  onEdgesChange={(changes) => {
                    const f = flowRef.current;
                    if (!f) return;
                    const next = { ...f, edges: changes.applyTo(f.edges) };
                    if (changes.toArray().some((c) => c.type !== 'select')) edit(() => next);
                    else setFlow(next);
                  }}
                  onConnect={(c) => edit((f) => connect(f, c))}
                  isValidConnection={(c) => !!flowRef.current && !validateFlow(connect(flowRef.current, c))}
                  onNodeClick={(_, n) => setSelected(n.id)} onPaneClick={() => setSelected(null)}
                >
                  <Background />
                  <Controls />
                </ReactFlow>
              </FlowRunContext.Provider>
            ) : (
              <EmptyState title={openId ? 'Loading…' : 'Create a flow, or add an endpoint from the dock below.'}>
                {!openId && <Button leftSection={Icons.plus()} onClick={() => { create('New flow').then((f) => open(f.id), notifyError); }}>New flow</Button>}
              </EmptyState>
            )}
          </div>
          <div
            className="splitter" role="separator" aria-orientation="horizontal" aria-label="Resize endpoint dock" tabIndex={0}
            aria-valuenow={Math.round(split * 100)} aria-valuemin={20} aria-valuemax={85}
            onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)} onPointerMove={drag}
            onKeyDown={(e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setSplit((s) => Math.min(0.85, Math.max(0.2, s + (e.key === 'ArrowUp' ? -0.05 : 0.05)))); } }}
          />
          <div style={{ flex: 1, minHeight: 0 }}><EndpointDock onAdd={(c, r) => { void add(c, r); }} /></div>
        </div>
        {sel && selData && selCollection && selRequest && (
          <Inspector
            key={sel.id} collection={selCollection} path={selPath} result={run?.nodes[sel.id]?.result} failure={failures[sel.id]}
            running={single === sel.id || (running && run?.currentNodeId === sel.id)} busy={busy} active={active && !del}
            continueWhen={selData.continueWhen}
            onContinueWhen={(continueWhen) => edit((f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === sel.id && n.type === 'request' ? { ...n, data: { ...n.data, continueWhen } } : n)) }))}
            onRun={(draft) => { void runNode(sel.id, selData.collectionId, draft, selData.continueWhen); }}
            onClose={() => setSelected(null)}
          />
        )}
        {sel && selData && !selRequest && (
          <aside className="inspector" aria-label="Node inspector">
            <div className="inspector-head">
              <Text fw={600}>Missing request</Text>
              <Text c="dimmed" mt={4}>{MISSING}</Text>
              <Group mt="sm"><Button variant="default" onClick={() => removeNode(sel.id)}>Remove node</Button><Button variant="subtle" onClick={() => setSelected(null)}>Close</Button></Group>
            </div>
          </aside>
        )}
      </div>
      <ConfirmModal
        opened={!!del} onClose={() => setDel(null)} onConfirm={() => { if (del) void remove(del.id); }}
        title="Delete flow" message={<>Delete <b>{del?.name}</b>? This cannot be undone.</>}
      />
    </div>
  );
}
