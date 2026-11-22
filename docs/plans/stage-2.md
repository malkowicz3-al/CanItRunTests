# Plan: Stage 2 (flow jako graf Blueprint)

## Cel
Flow jako graf (Start + Request, piny OK/Fail) zapisany na serwerze, wykonywany przez backendowy `runFlow`, z podglądem na żywo przez `/ws` i płótnem React Flow w GUI. Źródła: SPEC „Zmiana 2026-11-22”, ARCHITECTURE §10, ADR 0005.

Założenia do potwierdzenia przez użytkownika: `pm.setNextRequest` ignorowane w grafie (ostrzeżenie w `logs` węzła); ostatni wynik przebiegu tylko w pamięci serwera.

Kolejność: backend → dist smoke → frontend. [S] sekwencyjny, [P] równoległy po spełnieniu zależności. Po każdym kroku `npm test` i `npm run typecheck`.

## Kroki

**F0 [S] Wersje i instalacja** — `npm view` dla `@fastify/websocket` i `@xyflow/react` (także ostatnie 12.x). Jeśli 13 wymaga React 19 albo build/typecheck z `@types/react` 18 pada → ostatnie 12.x (format pliku bez zmian). `@fastify/websocket` zgodny z Fastify 5.12.8. Piny exact, bez `bufferutil`/`utf-8-validate`. Poprawić ARCHITECTURE §10.6/10.7, jeśli wersje inne. Check: `npm ci && npm run typecheck && npm run build`.

**F1 [S] Model, DTO, config** — `shared/model.ts`: `XY`, `FlowNode`, `Pin`, `FlowEdge`, `Flow` (§10.1). `shared/api.ts`: `FlowRunState`, `RunFlowBody { environmentId?, overrides? }`, `WsMessage` (4 zdarzenia z §10.5). `server/config.ts`: `FLOW_MAX_NODE_RUNS = 100`, `FLOW_MAX_NODE_RUNS_CAP = 10000`. Check: typecheck.

**F2 [P, po F1] `shared/flow.ts` + test** — `nodeOutcome(r, continueWhen)`, `nextNode(flow, id, pin)`, `validateFlow(x)`; warunek OK przeniesiony z `signalOf`. Testy: nodeOutcome default 2xx / custom list / failed pm.test / script error / network error; validateFlow two Starts / edge to Start / two edges from one pin / edge to missing node / bad continueWhen / maxNodeRuns out of range / Start with fail handle; nextNode undefined gdy pin bez kabla.

**F3 [P, po F1] Cancel w `runRequest` i `http.ts`** — `RunInput.signal?` → `HttpOptions.signal?` → `http.request({ signal })`; abort daje `error.code = 'ECANCELED'` i przerywa łańcuch redirectów. Test: „abort mid-request returns ECANCELED faster than mock delay”.

**F4 [S, po F2, F3] `server/core/flow.ts` + test** — `runFlow(input, hooks, send)` wg §10.2: pętla od `nextNode(start,'ok')`, `signal.aborted`, `maxNodeRuns`; scopes runtime/environment/globals wspólne, `collections[collectionId]` per kolekcja; wyjątek (też brak requestu) → `RunResult` z `error{code:'EFLOW'}` → Fail; `overrides[requestId]`; przy `nextRequest` ostrzeżenie w logs. Testy (mockServer, dopisać minimalnie statusy/opóźnienie jeśli brak): linear run passes token A→B; fail branch on 500; fail branch on ECONNREFUSED; retry cycle 500,500,200 done after 3 runs; self-loop limit stops at maxNodeRuns=5; cancel returns cancelled with ECANCELED; setNextRequest ignored with warning; missing request goes via fail; two collections keep separate variables.

**F5 [S, po F4] Worker i `runPool`: zdarzenia + cancel** — worker: `{ jobId, flow }`, hooki `postMessage` (start; end z diff i collectionId; done z status, nodeRuns); `{ jobId, cancel: true }` → abort. `runPool.runFlow(input, onEvent): { done, cancel }`, watchdog per węzeł, po cancel bez końca w `SCRIPT_TIMEOUT_MS + 1000` → `terminate()`; job w mapie `jobs`. Testy: flow job emits start/end/done in order; cancel before next node; watchdog kills worker when a node hangs and pool respawns.

**F6 [P, po F1] `persistDiff`** — wyciągnąć zapis diffu z `/api/run` do eksportowanej `persistDiff(diff, envId?, collectionId)`; zachowanie bez zmian. Check: routes.test zielony.

**F7 [S, po F5, F6] `server/ws.ts` + `server/flows.ts` + `main.ts`** — `/ws` z `Set<WebSocket>`, `broadcast`, Origin: brak nagłówka OK, inaczej host musi równać się `Host`, w przeciwnym razie zamknięcie 1008. Flows: CRUD + run/cancel/GET run (§10.5), POST bez nodes dodaje Start, PUT waliduje `validateFlow`, jedna blokada (409), `lastRuns` w pamięci, run zwraca `{ runId }` od razu, zdarzenia → broadcast + lastRuns + `await persistDiff`, DELETE trwającego → 409, cancel → 204. `main.ts`: websocket rejestrowany PRZED `registerRoutes` (hook Host obejmuje upgrade). Testy (inject + injectWS): CRUD; PUT 400 on invalid graph; second run returns 409; WS event order; env persisted after node 1 although node 2 cancelled; GET run returns last state; /ws rejects foreign Origin; /ws accepts missing Origin.

**F8 [S, po F7] `test:dist`** — „dist smoke: flow run over /ws”: globalny `WebSocket` Node 22, import kolekcji, flow Start → A → B, run, czekanie na `flow.done`, zmienna przekazana A→B. Drugi przypadek: obcy Origin odrzucony (surowy upgrade przez `http.request`, jeśli trzeba). Check: `npm run build && npm run test:dist`.

**Bramka** — `npm test`, typecheck, build, test:dist zielone, dopiero potem frontend.

**F9 [S] `web/src/flow.ts` + test** — `scriptVars`, `parseStatuses`, `fromTrack`, `addRequestNode`, `connect`. Testy: scriptVars quotes/backticks/duplicates/dynamic key skipped; parseStatuses "200, 201" i puste; fromTrack linear Start→stations co 260 px; addRequestNode auto-connects only a free OK pin; connect replaces a cable from the same pin.

**F10 [S, po F9] `api.ts` + `ws.ts`** — funkcje endpointów flows; jedno WebSocket, ponawianie 1–5 s, `subscribe(fn)`, po (re)connect `GET /api/flows/:id/run`.

**F11 [P, po F10] Inspector: Continue when** — sekcja aktywna, pole „200, 201, 204” (puste = dowolne 2xx), `parseStatuses`.

**F12 [P, po F10] `FlowNodes.tsx` + `FlowRunContext`** — Start (pin ok), Request (target + ok/fail; metoda, nazwa, URL, „Sets: …”, status · czas · testy z `data-signal`, licznik runs, „Missing request”); stan z WS przez kontekst; kable z path ostatniego przebiegu z `data-signal`.

**F13 [S, po F11, F12] `Flows.tsx` zamiast Track** — lista flow (new/rename/duplicate/delete), top bar (nazwa, EnvironmentSelect, Max node runs, Run/Cancel), ReactFlow z Background i Controls, dok Library, drop biletów przez `screenToFlowPosition`, `isValidConnection`/`onConnect`, Start nieusuwalny, autosave PUT debounce 500 ms przez kolejkę (Run czeka i wysyła overrides z draftów), claimRun od POST run do flow.done, potem refreshAfterRun, Inspector dla wybranego węzła. CSS React Flow importowany przed app.css, style płótna z tokenami. `openFlowId` w localStorage (`cirt.flow`); `addStation` → `addToFlow` (otwarte flow albo nowe „Untitled flow”, podłącza wolny pin OK ostatniego węzła); usunąć `dropStations`. Check: typecheck, vite build.

**F14 [S, po F13] Migracja i sprzątanie** — `cirt.track` → `fromTrack` → POST, klucz usuwany po sukcesie. Usunąć Track.tsx, loadTrack/saveTrack/Station/Track, runSequence/moveItem/reorderToSlot i ich testy (jeśli brak innych użyć); `signalOf` woła `nodeOutcome`. Check: grep pusty, testy zielone.

**F15 [S] Dokumentacja i finalny build** — ARCHITECTURE §10.6/10.7, CLAUDE.md; build + test + test:dist + typecheck; ręcznie: dist bez node_modules, flow z 2 węzłami, Run, podgląd na żywo, Cancel, odświeżenie w trakcie.

## Zmiana 2026-11-22: tylko dwie zakładki (część F13/F14)
- Rail: tylko **Endpoints** (dotychczasowy ekran Requests, przemianowany w GUI) i **Flows**. Usunąć zakładkę Library (`Library mode="full"`, screen `'library'`) i przycisk Load tests: Stage 3. Menu zarządzania (new collection, rename, delete, collection variables, import) już są w drzewie Requests; przycisk New collection/Import ma być w nagłówku drzewa.
- Zakładka Environments znika z railu: `EnvironmentsView` otwierany w dużym Drawerze z przycisku „Manage” obok `EnvironmentSelect` w top barze (`editEnvironment` otwiera ten Drawer zamiast zmieniać screen). `SCREENS = ['requests', 'flows']`; stara wartość `cirt.screen` spoza listy → `'requests'`.
- Dok endpointów we Flows: drzewo pogrupowane po kolekcjach, każda kolekcja jako wyraźny, zwijany nagłówek (nazwa, licznik requestów, akcent koloru/ikona kolekcji), foldery jako wcięte podgrupy, wyszukiwarka filtruje i rozwija pasujące. Stan zwinięcia w localStorage (`cirt.dock.collapsed`). Wpisy przeciągalne (`TICKET_MIME`) i klikalne (dodaj do otwartego flow). Węzeł Request na płótnie pokazuje nazwę kolekcji, żeby się nie myliły requesty o tej samej nazwie.

## Równoległość
F0 → F1 → (F2 ∥ F3 ∥ F6) → F4 → F5 → F7 → F8 → bramka → F9 → F10 → (F11 ∥ F12) → F13 → F14 → F15.

## Ryzyka
- Kolejność rejestracji pluginu WS i hooka Host (F7).
- Proxy Vite w dev może nie przepisywać Origin → dopuścić `localhost:5173` tylko poza produkcją.
- `terminate()` po watchdogu ubija też równoległy pojedynczy strzał (akceptowane).
- `@xyflow/react` 13 vs React 18 — rozstrzyga F0.
