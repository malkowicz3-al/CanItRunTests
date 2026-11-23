# Plan: flow only, runs N× / loop with workers, response on the graph

## Context
The user narrowed the app: import a collection and env from Postman, build a flow in the graph window, run it. The Endpoints tab goes away (one request = a one-block flow). Run modes: Once / N iterations / Loop until Stop, plus parallel workers (VUs) with live statistics. Responses must be visible on the graph: a short-lived bubble next to the block, and the full response in a side panel when a block is clicked.

## Decisions
- **One endpoint**: `POST /api/flows/:id/run` takes `{ environmentId?, overrides?, mode?: 'once'|'iterations'|'loop', iterations?, vus? }`. Cancel = Stop for both paths, one shared lock (409). ADR 0006.
- **Once + 1 VU** = today's path unchanged (live highlighting, `persistDiff`). Any other combination = load path, **no write-back of variables** (one-line hint in the UI).
- **Engine**: W = min(vus, availableParallelism-1, 4) worker threads created per run (`worker.ts` with `role:'load'`, no new bundle entry). Each thread runs its share of the VUs as async loops over the existing `runFlow`. Each VU gets its own `structuredClone(scopes)`; `runtime` resets each iteration. Keep-alive agents for http and https.
- **Statistics**: each worker sends a tick every 1 s with deltas (count/ok/fail/sum/min/max/log histogram/codes per node, plus the last result and last error, body ≤ 64 KB). The main thread merges them and broadcasts `flow.stats` once per second. Percentiles come from `shared/stats.ts` (log buckets of 2%, no deps, shared with the browser).
- **Limits** in `config.ts`: 200 VU (`MAX_VUS`), 30 min (`MAX_DURATION_MIN`), 1,000,000 iterations, 400 when exceeded. Stop: abort, final tick, `terminate()` after `SCRIPT_TIMEOUT_MS+1s`. Watchdog: no tick for 15 s → error "worker stalled".
- **Report (minimal)**: final stats in `lastRuns` + `reports/<runId>.json` in DATA_DIR.

## Steps
**Backend**
1. `shared/api.ts`: RunFlowBody (mode/iterations/vus), `NodeStats`, `FlowRunState.load`, WsMessage `flow.stats`. `shared/stats.ts`: record/merge/percentile.
2. `server/config.ts`: limits. `server/core/http.ts`: `agents {http, https}` with keepAlive.
3. `server/worker.ts`: the `load` branch (VU loops, 1 s tick, stop, done).
4. `server/loadRun.ts` (new): `startLoad(input, {vus, iterations}, workerFile, onTick) → {done, stop}`, splitting VUs, merging ticks, watchdog, max duration.
5. `server/flows.ts`: validate the body, branch once/load, ticks → `state.load` + broadcast, report on done.
6. Docs: ADR 0006; ARCHITECTURE §5/§6/§7/§10.4; SPEC stage 3 (what is deferred); `docs/plans/stage-3.md`.

**Tests**
7. `shared/stats.test.ts` (p50/p95 within ±2%, merge = joint record, edge cases).
8. `server/flows.test.ts`:
   - iterations=10/vus=3 → done, count correct, env file unchanged;
   - loop + cancel → cancelled in ≤ 2 s;
   - 409 while running; vus=201 → 400; `flow.stats` over WS;
   - Once still persists.
9. `http.test.ts`: keep-alive for http and https. `web/src/flow.test.ts`: `applyRunEvent` for `flow.stats`.

**Frontend**
10. Remove `Requests.tsx`, screen state in `App.tsx`/`context.ts`, `treeRows`, and the unused library actions. The collection menu (variables, rename, delete) moves to the collection header in the endpoint dock.
11. `Flows.tsx` top bar: Once / Iterations / Loop, iterations input, VUs input (1–200), Run/Stop. Config saved in `cirt.runConfig` (the flow format does not change).
12. `LoadStats.tsx` (new): during a load run the bottom panel shows status, time, iterations, RPS, plus a table per block + Total (count, ok, fail, err %, min, avg, p50, p95, max, codes). It can be switched back to Endpoints. No charts.
13. `FlowNodes.tsx`: bubble next to the block (status, time, 3 lines of body) that fades after 3 s, at most one at a time per block, `pointer-events:none`. In load mode the block shows `count · p95 · err%`.
14. `Inspector.tsx`: Response tab (`LastResult` in tabs: JSON body, headers, sent request, tests, logs, timings, plus "Last error" in load mode) and Request tab (current fields + Continue when). Response is the default when a result exists.

## Deferred
RPS limit and ramp-up, report history/HTML/JSON export, 5 error samples per type, live charts (Recharts is not installed), "run for X min" mode. Removing Requests also removes "new request/folder/duplicate" (collections only come from import).

## Verification
- `npm run typecheck`, `npm test`, `npm run build`, `npm run test:dist`. Then test-runner and code-reviewer, fix loop of at most 2 rounds.
- Manually in the browser after restarting :3000:
  - Once on a 3-block flow: bubbles, side panel with the response.
  - Iterations 50 × 5 VU: live stats, env unchanged.
  - Loop + Stop: ends quickly.
  - 409 from a second tab.
- Rough measurement of RPS against a local mock (vus=50) to see how far we are from ~1000.
- Rebuild dist, commit, push after approval.

## Risks
~1000 RPS not measured (RS256 signing may limit it). VUs within one thread share globalThis (ADR 0003). The size of ticks with samples (drop `scopes` if heavy). Behaviour change: N>1 does not save tokens to env.
