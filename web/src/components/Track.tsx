import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Button, Group, Switch, Text, TextInput, Tooltip } from '@mantine/core';
import type { RunResult } from '../../../shared/api';
import type { RequestItem } from '../../../shared/model';
import { api } from '../api';
import { runEnvironmentId, useApp } from '../context';
import { moveItem, reorderToSlot, runSequence, signalOf, type Signal, type Station, type Track } from '../track';
import { findPath, formatMs } from '../util';
import { EnvironmentSelect } from './EnvironmentEditor';
import { Inspector } from './Inspector';
import { Library, TICKET_MIME } from './Library';
import { Icons, MethodGlyph } from './ui';

const STATION_MIME = 'application/x-cirt-station';
const PAD = 100; // x of the first station
const GAP = 160; // fixed spacing between stations
const Y = 44; // y of the line inside the SVG

const xOf = (i: number) => PAD + i * GAP;
const MISSING = 'This request no longer exists in the library. Remove the station or add the endpoint again.';

export function TrackScreen({ track, setTrack, active }: { track: Track; setTrack: (fn: (t: Track) => Track) => void; active: boolean }) {
  const app = useApp();
  const [results, setResults] = useState<Record<string, RunResult>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [trackRunning, setTrackRunning] = useState(false);
  const [stopOnFailure, setStopOnFailure] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [split, setSplit] = useState(0.65);
  const [editName, setEditName] = useState(false);
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const { stations } = track;
  // a running track reads these per station, so edits made during the run apply to the next stations
  const latest = useRef({ app, stations, stopOnFailure });
  latest.current = { app, stations, stopOnFailure };
  useEffect(() => app.onForgetResults((ids) => {
    const gone = new Set(latest.current.stations.filter((s) => ids.includes(s.requestId)).map((s) => s.id));
    const keep = <T,>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).filter(([k]) => !gone.has(k)));
    setResults(keep);
    setFailures(keep);
  }), []); // subscribe once: onForgetResults only touches a ref in App

  const lookup = (st: Station, collections = app.collections) => {
    const c = collections.find((x) => x.id === st.collectionId);
    const path = c ? findPath(c.items, st.requestId) : [];
    const req = path.at(-1);
    return { collection: c, path, request: req?.kind === 'request' ? req : undefined };
  };

  /** `claimed`: the caller (a track run) already holds the run claim for the whole sequence. */
  const runStation = async (st: Station, draft?: RequestItem, claimed = false): Promise<Signal> => {
    if (!claimed && !latest.current.app.claimRun()) {
      setFailures((f) => ({ ...f, [st.id]: 'Another run is in progress' }));
      return 'stop';
    }
    setRunning(st.id);
    setFailures(({ [st.id]: _, ...rest }) => rest);
    try {
      const a = latest.current.app;
      if (!lookup(st, a.collections).request) throw new Error(MISSING);
      const r = await api.run({ collectionId: st.collectionId, requestId: st.requestId, environmentId: runEnvironmentId(a), request: draft ?? (a.drafts[st.requestId] as RequestItem | undefined) });
      setResults((rs) => ({ ...rs, [st.id]: r }));
      await a.refreshAfterRun(st.collectionId).catch(() => {}); // only refreshes the UI, the next run reads variables from disk
      return signalOf(r, false);
    } catch (e) {
      setFailures((f) => ({ ...f, [st.id]: e instanceof Error ? e.message : String(e) }));
      return 'stop';
    } finally {
      if (!claimed) latest.current.app.releaseRun();
      setRunning(null);
    }
  };

  const runTrack = async () => {
    if (!app.claimRun()) return;
    setTrackRunning(true);
    setResults({});
    setFailures({});
    try {
      await runSequence(stations, (st) => runStation(st, undefined, true), () => latest.current.stopOnFailure, (st) => latest.current.stations.some((s) => s.id === st.id));
    } finally { app.releaseRun(); setTrackRunning(false); }
  };
  const busy = app.busy || trackRunning; // also blocked while the Requests screen sends

  const remove = (i: number) => {
    const st = stations[i];
    setTrack((t) => ({ ...t, stations: t.stations.filter((s) => s.id !== st.id) }));
    if (selected === st.id) setSelected(null);
    setTimeout(() => refs.current[Math.min(i, stations.length - 2)]?.focus());
  };

  const dropIndex = (clientX: number) => {
    const left = (box.current?.getBoundingClientRect().left ?? 0) - (box.current?.scrollLeft ?? 0);
    return Math.max(0, Math.min(stations.length, Math.round((clientX - left - PAD + GAP / 2) / GAP)));
  };
  const onDragOver = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    if (!types.includes(STATION_MIME) && !types.includes(TICKET_MIME)) return;
    e.preventDefault();
    setDropAt(types.includes(STATION_MIME) ? dropIndex(e.clientX) : stations.length);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropAt(null);
    const from = e.dataTransfer.getData(STATION_MIME);
    if (from !== '') {
      const f = Number(from), to = dropIndex(e.clientX);
      if (Number.isInteger(f) && f >= 0 && f < stations.length) setTrack((t) => ({ ...t, stations: reorderToSlot(t.stations, f, to) }));
      return;
    }
    const ticket = e.dataTransfer.getData(TICKET_MIME);
    if (!ticket) return;
    try {
      const { collectionId, requestId } = JSON.parse(ticket) as Station;
      if (typeof collectionId === 'string' && typeof requestId === 'string') app.addStation(collectionId, requestId);
    } catch { /* not our ticket */ }
  };

  const signals = stations.map((st) => signalOf(results[st.id], running === st.id, failures[st.id]));
  const signalAt = trackRunning && running ? stations.findIndex((s) => s.id === running) : -1;
  const width = Math.max(xOf(stations.length - 1) + PAD, 0);
  const sel = stations.find((s) => s.id === selected);
  const selInfo = sel && lookup(sel);

  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!(e.buttons & 1)) return;
    const r = e.currentTarget.parentElement!.getBoundingClientRect();
    setSplit(Math.min(0.85, Math.max(0.2, (e.clientY - r.top) / r.height)));
  };

  return (
    <div className="track-screen">
      <header className="topbar">
        <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          {editName ? (
            <TextInput
              autoFocus variant="unstyled" size="lg" fw={600} value={track.name} aria-label="Track name"
              onChange={(e) => { const name = e.currentTarget.value; setTrack((t) => ({ ...t, name })); }}
              onBlur={() => { setEditName(false); if (!track.name.trim()) setTrack((t) => ({ ...t, name: 'Scratch track' })); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
            />
          ) : (
            <button type="button" className="track-name" onClick={() => setEditName(true)} aria-label="Rename track">
              <span>{track.name}</span>{Icons.edit()}
            </button>
          )}
        </Group>
        <Group gap="sm" wrap="nowrap">
          <EnvironmentSelect />
          <Switch label="Stop on failure" checked={stopOnFailure} onChange={(e) => setStopOnFailure(e.currentTarget.checked)} />
          <Button leftSection={Icons.play()} onClick={runTrack} loading={trackRunning} disabled={!stations.length || busy}>Run track</Button>
        </Group>
      </header>
      <div className="track-body">
        <div className="track-column">
          <div
            ref={box} className="track-canvas" style={{ flex: `0 0 ${split * 100}%` }}
            onDragOver={onDragOver} onDragLeave={() => setDropAt(null)} onDrop={onDrop}
          >
            {stations.length === 0 ? (
              <div className="track-empty" data-drop={dropAt !== null || undefined}>
                <svg width="320" height="24" aria-hidden><line x1="0" y1="12" x2="320" y2="12" className="rail-line" strokeDasharray="6 8" /></svg>
                <Text c="dimmed">Add an endpoint from the library to start a track.</Text>
              </div>
            ) : (
              <div className="track-stage" style={{ width }}>
                <svg width={width} height={Y * 2} className="track-svg" aria-hidden>
                  <line x1={xOf(0) - 60} y1={Y} x2={xOf(stations.length - 1) + 60} y2={Y} className="rail-line" />
                  {stations.slice(1).map((st, i) => (signals[i + 1] !== 'idle') && (
                    <line key={st.id} x1={xOf(i)} y1={Y} x2={xOf(i + 1)} y2={Y} className="rail-line" data-signal={signals[i + 1]} />
                  ))}
                  {stations.map((st, i) => (
                    <circle key={st.id} cx={xOf(i)} cy={Y} r={9} className="station-dot" data-signal={signals[i]} data-selected={st.id === selected || undefined} />
                  ))}
                  {signalAt >= 0 && <circle cx={0} cy={Y} r={4} className="signal-train" style={{ transform: `translateX(${xOf(signalAt)}px)` }} />}
                  {dropAt !== null && <line x1={xOf(dropAt) - GAP / 2} y1={Y - 22} x2={xOf(dropAt) - GAP / 2} y2={Y + 22} className="drop-marker" />}
                </svg>
                {stations.map((st, i) => {
                  const { request } = lookup(st);
                  const r = results[st.id];
                  const tests = r ? [...r.preScripts, ...r.testScripts].flatMap((s) => s.tests) : [];
                  const passed = tests.filter((t) => t.passed).length;
                  const name = request?.name ?? 'Missing request';
                  return (
                    <div
                      key={st.id} ref={(el) => { refs.current[i] = el; }} className="station" role="button" tabIndex={0}
                      style={{ left: xOf(i) - GAP / 2, width: GAP }} data-selected={st.id === selected || undefined}
                      aria-label={`${request?.method ?? ''} ${name}, ${signals[i] === 'idle' ? 'not run' : signals[i]}. Arrow keys switch stations, Alt+arrows reorder, Delete removes.`}
                      draggable onDragStart={(e) => { e.dataTransfer.setData(STATION_MIME, String(i)); e.dataTransfer.effectAllowed = 'move'; }}
                      onClick={() => setSelected(st.id)}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        const to = i + (e.key === 'ArrowRight' ? 1 : -1);
                        if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.altKey) {
                          e.preventDefault();
                          if (to < 0 || to >= stations.length) return;
                          setTrack((t) => ({ ...t, stations: moveItem(t.stations, i, to) }));
                          setTimeout(() => refs.current[to]?.focus());
                        } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); refs.current[to]?.focus(); }
                        else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(i); }
                        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(st.id); }
                      }}
                    >
                      <div className="station-actions">
                        <Tooltip label="Run station" openDelay={300}>
                          <ActionIcon variant="subtle" color="gray" aria-label={`Run ${name}`} disabled={busy} onClick={(e) => { e.stopPropagation(); void runStation(st); }}>{Icons.play()}</ActionIcon>
                        </Tooltip>
                        <Tooltip label="Remove from flow" openDelay={300}>
                          <ActionIcon variant="subtle" color="gray" aria-label={`Remove ${name}`} onClick={(e) => { e.stopPropagation(); remove(i); }}>{Icons.close()}</ActionIcon>
                        </Tooltip>
                      </div>
                      <div className="station-label">
                        <MethodGlyph method={request?.method ?? '?'} />
                        <span className="station-name">{name}</span>
                        <span className="station-meta">
                          {r?.response ? `${r.response.status} · ${formatMs(r.response.timings.total)}` : r?.error ? r.error.code : failures[st.id] ? 'Error' : '—'}
                          {tests.length > 0 && <> · <span className="signal-text" data-signal={passed === tests.length ? 'go' : 'stop'}>{passed}/{tests.length}</span></>}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div
            className="splitter" role="separator" aria-orientation="horizontal" aria-label="Resize library" tabIndex={0}
            aria-valuenow={Math.round(split * 100)} aria-valuemin={20} aria-valuemax={85}
            onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)} onPointerMove={drag}
            onKeyDown={(e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setSplit((s) => Math.min(0.85, Math.max(0.2, s + (e.key === 'ArrowUp' ? -0.05 : 0.05)))); } }}
          />
          <div style={{ flex: 1, minHeight: 0 }}><Library mode="dock" /></div>
        </div>
        {sel && selInfo?.collection && selInfo.request && (
          <Inspector
            key={sel.id} collection={selInfo.collection} path={selInfo.path} result={results[sel.id]} failure={failures[sel.id]}
            running={running === sel.id} busy={busy} active={active}
            onRun={(draft) => { void runStation(sel, draft); }}
            onClose={() => { setSelected(null); refs.current[stations.indexOf(sel)]?.focus(); }}
          />
        )}
        {sel && !selInfo?.request && (
          <aside className="inspector" aria-label="Station inspector">
            <div className="inspector-head">
              <Text fw={600}>Missing request</Text>
              <Text c="dimmed" mt={4}>{MISSING}</Text>
              <Group mt="sm"><Button variant="default" onClick={() => remove(stations.indexOf(sel))}>Remove station</Button><Button variant="subtle" onClick={() => setSelected(null)}>Close</Button></Group>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
