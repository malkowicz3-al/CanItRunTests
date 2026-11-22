# CanItRunTests — architektura

Dokument opisuje strukturę kodu, model danych i API. Decyzje produktowe są w [SPEC.md](SPEC.md); nieoczywiste decyzje techniczne w [adr/](adr/).

## 1. Układ repo

Jeden pakiet npm (jeden `package.json`, `"type": "module"`), podział na katalogi zamiast workspaces — patrz [ADR 0001](adr/0001-single-package-committed-bundle.md).

```
server/
  main.ts            # start: sprawdzenie wersji Node, config, Fastify, static, rejestracja tras
  config.ts          # PORT, HOST, DATA_DIR, limity (VU/RPS/czas), timeouty
  storage.ts         # odczyt/zapis JSON w DATA_DIR (atomowy zapis, kolejka per plik)
  routes.ts          # wszystkie trasy REST etapu 1 (rozbić na pliki dopiero gdy urośnie)
  flows.ts           # etap 2: trasy /api/flows, bieżący przebieg, ostatni wynik w pamięci (sekcja 10)
  importers/
    postman.ts       # Collection v2.1 + environment/globals -> model wewnętrzny
    openapi.ts       # etap 4: Swagger 2.0 / OpenAPI 3.x -> ten sam model
  runPool.ts         # główny wątek: jeden stały worker do pojedynczych strzałów/flow, respawn po awarii
  load/engine.ts     # etap 3: spawn workerów, agregacja, blokada "jeden test naraz", Stop, zapis raportu
  ws.ts              # etap 2-3: /ws, broadcast postępu
  core/              # czysta logika wykonania, bez Fastify; działa w workerach i w testach
    variables.ts     # Scopes, resolve('{{x}}'), zmienne dynamiczne
    prepare.ts       # dziedziczenie auth, łańcuch skryptów, budowa finalnego requestu
    http.ts          # execute(): node:http/https, timingi, TLS/mTLS
    sandbox.ts       # uruchamianie skryptu (node:vm), obiekt pm, require() bibliotek, console
    run.ts           # runRequest(), diffScopes(), applyDiff()
    flow.ts          # etap 2: runFlow() — przejście grafu (sekcja 10)
    stats.ts         # etap 3: histogram latencji, percentyle, liczniki błędów
  worker.ts          # entry workera: role 'run' (pojedynczy strzał / flow) i 'load' (VU)
shared/
  model.ts           # typy danych (sekcja 4)
  api.ts             # DTO REST i wiadomości WS
  flow.ts            # etap 2: czyste funkcje grafu wspólne dla silnika i GUI (sekcja 10)
web/                 # GUI (Vite root)
  index.html
  src/main.tsx, App.tsx, api.ts, monaco.ts, components/...
test/
  fixtures/          # syntetyczne kolekcje Postmana / specy OpenAPI (bez danych użytkownika)
  mockServer.ts      # lokalny serwer HTTP(S) do testów executora, flow i load
build.mjs            # esbuild serwera + workera (+ tryb --watch dla dev)
vite.config.ts       # root: web, outDir: ../dist/public, proxy /api i /ws na :3000; sekcja test dla Vitest
tsconfig.json
start.bat, start.sh
.gitattributes       # *.sh eol=lf, *.bat eol=crlf, dist/** linguist-generated -diff
dist/                # COMMITOWANY wynik builda
  server.cjs         # serwer + wszystkie zależności runtime
  worker.cjs         # worker (core + biblioteki sandboxa)
  public/            # zbudowane GUI, łącznie z Monaco i jego web workerami
```

Testy jednostkowe leżą obok kodu (`server/core/variables.test.ts` itd.), wspólne narzędzia testowe w `test/`.

## 2. Build i uruchomienie

**Serwer** — `build.mjs` (esbuild API): `entryPoints: ['server/main.ts', 'server/worker.ts']`, `bundle: true`, `platform: 'node'`, `format: 'cjs'`, `target: 'node22.0'`, `outExtension: .cjs`, `external: ['bufferutil', 'utf-8-validate']` (opcjonalne natywne dodatki `ws`, które `ws` ładuje w try/catch), bez minifikacji (czytelne stack trace). Format CJS, bo zależności CJS (Fastify, ws) robią `require('node:...')`, co w bundlu ESM wymaga hacka z `createRequire`; zależności ESM-only (jose, chai) esbuild przepisuje na CJS — warunek: brak top-level await w kodzie i zależnościach.

- Worker musi być osobnym entry: `new Worker(path.join(__dirname, 'worker.cjs'))` — `__dirname` w bundlu wskazuje `dist/`.
- Static: `@fastify/static` z `root: path.join(__dirname, 'public')`, fallback na `index.html`.
- Uruchomienie wymaga tylko `node` i katalogu `dist/`; `node_modules` nie istnieje u użytkownika.

**GUI** — `vite build` do `dist/public`. Monaco serwowany lokalnie (brak CDN): `@monaco-editor/react` + `loader.config({ monaco })`, import `monaco-editor/esm/vs/editor/editor.api` i tylko potrzebnych języków (javascript, json, xml), web workery Monaco przez `?worker` Vite i `self.MonacoEnvironment.getWorker`. Do Monaco dokładamy `addExtraLib` z deklaracją `pm` (podpowiedzi).

**start.bat**: `cd /d "%~dp0"`, `node dist\server.cjs`, `pause` (okno nie znika przy błędzie). **start.sh**: `cd "$(dirname "$0")"; exec node dist/server.cjs` — uruchamiać `sh start.sh` (zip z GitHuba nie gwarantuje bitu wykonywalności). `server/main.ts` na starcie sprawdza `process.versions.node` (>= 22) i drukuje faktyczny URL (także przy `PORT=0`).

**Skrypty npm (dev)**: `build` (= `node build.mjs && vite build`), `dev:server` (`node build.mjs --watch` — esbuild watch + proces potomny `node --watch dist/server.cjs`, bez tsx/concurrently), `dev:web` (`vite`, proxy na :3000), `test` (`vitest run`), `test:dist` (smoke test zbudowanego bundla), `typecheck` (`tsc --noEmit`). Do uzupełnienia w CLAUDE.md w sekcji Komendy.

## 3. Stack

| Element | Uzasadnienie |
|---|---|
| Node 22, TypeScript | wymóg spec; target `node22.0`, żadnych API nowszych niż 22.0. |
| Fastify 5 + `@fastify/static` + `@fastify/websocket` (ws) | wymóg spec; oficjalne pluginy, bundlują się esbuildem. `@fastify/websocket` dochodzi w etapie 2 (sekcja 10.6). |
| `node:http`/`node:https` (bez undici/axios) | jedyna opcja bez zależności z dostępem do zdarzeń socketu (DNS/TCP/TLS) — [ADR 0004](adr/0004-http-client-node-http.md). |
| `node:vm` + `worker_threads` | wymóg spec; sposób użycia w [ADR 0003](adr/0003-script-execution-model.md). |
| jose, jsrsasign, crypto-js | wymóg spec (biblioteki dostępne w skryptach). |
| chai | `pm.expect` to w Postmanie chai — własna emulacja BDD byłaby większa i niekompatybilna. |
| esbuild | najprostszy bundler Node do jednego pliku bez konfiguracji. |
| React, Vite, Mantine (`core`, `hooks`, `notifications`), Monaco (`monaco-editor` + `@monaco-editor/react`), Recharts | wymóg spec. |
| `@xyflow/react` (etap 2) | wymóg spec (płótno flow); czysty JS + CSS, bundlowany przez Vite, bez CDN. |
| Vitest | wymóg spec; współdzieli konfigurację z Vite. |

Świadomie bez: routera (zakładki + hash `#/load/<id>`), menedżera stanu, biblioteki do zapytań, walidatora schematów (ręczna walidacja w importerze), loggera innego niż wbudowany pino Fastify (bez transportów — te wymagają osobnych plików workerów).

## 4. Model danych

Przechowujemy **znormalizowany model wewnętrzny**, nie format Postmana — [ADR 0002](adr/0002-internal-data-model.md).

```ts
// shared/model.ts
export type Id = string;                       // crypto.randomUUID()

export interface Variable { key: string; value: string; type?: 'default' | 'secret'; enabled: boolean }
export interface KeyValue { key: string; value: string; enabled: boolean }

export type Auth =
  | { type: 'inherit' }                        // brak auth w Postmanie = inherit
  | { type: 'none' }                           // Postman 'noauth'
  | { type: 'bearer'; token: string }          // także OAuth2 z gotowym tokenem
  | { type: 'basic'; username: string; password: string }
  | { type: 'apikey'; key: string; value: string; in: 'header' | 'query' };

export interface Scripts { pre: string; test: string }   // pusty string = brak

export type Body =
  | { mode: 'none' }
  | { mode: 'raw'; raw: string; language: 'json' | 'xml' | 'text' }
  | { mode: 'urlencoded'; params: KeyValue[] }
  | { mode: 'formdata'; params: KeyValue[] };   // shortcut: tylko pola tekstowe, pliki gdy ktoś poprosi

export interface RequestItem {
  kind: 'request'; id: Id; name: string;
  method: string;
  url: string;                                  // surowy z {{zmiennymi}}; query edytowane przez parsowanie URL w GUI
  pathVariables: KeyValue[];                    // Postman ':id'
  headers: KeyValue[]; body: Body; auth: Auth; scripts: Scripts;
}
export interface Folder { kind: 'folder'; id: Id; name: string; items: Item[]; auth: Auth; scripts: Scripts }
export type Item = Folder | RequestItem;

export interface Collection {
  id: Id; sourceId?: string;                    // info._postman_id — wykrywanie ponownego importu
  name: string; items: Item[]; auth: Auth; scripts: Scripts; variables: Variable[];
}

export interface Environment {
  id: Id; sourceId?: string; name: string; values: Variable[];
  ignoreTls: boolean;
  clientCert?: { cert: string; key: string; passphrase?: string; ca?: string }; // szablony, np. '{{clientCertPem}}'
}

export interface Globals { values: Variable[] }

// etap 2: Flow, FlowNode, FlowEdge — sekcja 10.1

// etap 3
export interface LoadConfig {
  target: { flowId: Id };                       // tylko zapisany flow (flow ad-hoc zastąpiła lista flow, SPEC "Zmiana 2026-11-22")
  environmentId: Id; vus: number; rps?: number;
  durationSec?: number; iterations?: number; rampUpSec: number;
}
// LoadReport: config, startedAt/endedAt, perNode + total: StepStats, timeline (1 s), errorSamples
```

**Pliki w DATA_DIR**: `collections/<id>.json`, `environments/<id>.json`, `globals.json`, `flows/<id>.json`, `reports/<id>.json`. Cała kolekcja (drzewo) w jednym pliku; edycja requestu = zapis całej kolekcji. Aktywny environment i motyw trzyma GUI w `localStorage` (per przeglądarka; serwer dostaje `environmentId` w każdym wywołaniu).

## 5. Moduły backendu

### storage.ts
```ts
readJson<T>(rel: string): Promise<T | undefined>
writeJson(rel: string, data: unknown): Promise<void>   // tmp w tym samym katalogu + fs.rename
list<T>(dir: string): Promise<T[]>
remove(rel: string): Promise<void>
```
- Zapisy do tego samego pliku serializowane łańcuchem Promise (`Map<path, Promise>`); jeden proces, więc wystarcza.
- Windows: `rename` na istniejący plik potrafi dać `EPERM/EBUSY` (antywirus, indeksowanie) — krótki retry (kilka prób, ~50 ms).
- `id` z URL walidowane regexem `^[A-Za-z0-9-]+$` przed złożeniem ścieżki (path traversal).
- Bez cache w pamięci — pliki są małe, odczyt przy każdym żądaniu.

### importers/postman.ts
```ts
importPostman(json: unknown): { kind: 'collection'; collection: Collection }
                            | { kind: 'environment'; environment: Environment }
                            | { kind: 'globals'; globals: Globals }
```
Rozpoznaje typ po `info.schema` (v2.1; v2.0 odrzucane z czytelnym błędem) albo `_postman_variable_scope`. Mapuje `event[].script.exec[]` → `Scripts`, `auth` → `Auth` (oauth2 → bearer z `accessToken`), `url` (string lub obiekt → `raw` + `variable`), `body`. Nieznane typy auth/body → `none` + ostrzeżenie w odpowiedzi importu. Waliduje kształt na wejściu (granica zaufania) i rzuca błąd 400 z opisem. `openapi.ts` (etap 4) zwraca ten sam `{ kind: 'collection' }`.

### core/variables.ts
```ts
interface Scopes { runtime: Record<string,string>; environment: Variable[]; collection: Variable[]; globals: Variable[] }
resolve(template: string, s: Scopes): string   // runtime -> environment -> collection -> globals; tylko enabled
getVar(s: Scopes, key: string): string | undefined
```
- `{{$guid}}`, `{{$randomUUID}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}` (0–1000 jak Postman) — nowa wartość przy każdym wystąpieniu.
- Rozwiązywanie rekurencyjne (wartość zawierająca `{{x}}`), limit głębokości 10; nierozwiązane zostają dosłownie (jak Postman).

### core/prepare.ts
Z kolekcji i ścieżki do requestu: łańcuch skryptów pre (kolekcja → foldery → request) i test (ta sama kolejność), efektywne auth (najbliższy przodek nie-`inherit`), a po pre-skryptach budowa `PreparedRequest { method, url, headers, body }` — z rozwiązanymi zmiennymi i zaaplikowanym auth. To jest „finalny wysłany request” pokazywany w GUI.

### core/sandbox.ts — patrz [ADR 0003](adr/0003-script-execution-model.md)
```ts
runScript(code: string, ctx: ScriptCtx): Promise<ScriptResult>
// ScriptCtx: scopes (mutowane w miejscu), request (pm.request, mutowalny w pre), response?, send (dla pm.sendRequest)
// ScriptResult: tests: {name, passed, error?}[], logs: {level, text}[], nextRequest?: string|null, error?: string
```
- Skrypt kompilowany raz (`new vm.Script`, cache po treści) jako `((pm, console, require, CryptoJS, setTimeout) => (async () => { <kod> })())(…)` i uruchamiany `script.runInThisContext({ timeout: 5000 })` — synchroniczna część z twardym limitem, reszta (await, callbacki) przez `Promise.race` z pozostałym czasem do 5 s.
- Koniec skryptu = Promise funkcji rozwiązany **i** licznik oczekujących (`pm.sendRequest`, `setTimeout`) = 0, albo timeout.
- `pm`: `environment`/`collectionVariables`/`globals`/`variables` (`get/set/unset/has`, `variables.set` → runtime), `request` (url, headers, body, method), `response` (`code`, `status`, `headers`, `responseTime`, `text()`, `json()`, `to.have.status()` w minimalnym zakresie), `test`, `expect` (chai), `setNextRequest`, `sendRequest(req, cb)` (string lub obiekt; także zwraca Promise), `info.requestName`.
- `require('crypto' | 'jose' | 'jsrsasign' | 'crypto-js')`; globalnie też `CryptoJS`. Wzorzec `eval(pm.environment.get('lib'))` działa, bo direct eval w funkcji skryptu widzi jej zakres; `navigator`/`window` nie są dostarczane globalnie — skrypty Postmana pod jsrsasign same je deklarują (`var navigator = {}`), a npm-owy jsrsasign ma je we własnym nagłówku. Do weryfikacji na `samples/`.

### core/http.ts — patrz [ADR 0004](adr/0004-http-client-node-http.md)
```ts
execute(req: PreparedRequest, opts: { ignoreTls: boolean; clientCert?: {cert,key,passphrase?,ca?}; timeoutMs: number; agent?: http.Agent })
  : Promise<HttpResult>
// HttpResult: status, statusText, headers, body (string; Buffer -> utf8), size,
//   timings: { dns, tcp, tls, ttfb, transfer, total } w ms, albo error: { code: 'ETIMEDOUT'|'ECONNREFUSED'|..., message }
```
- Timingi z `socket` events: `lookup`, `connect`, `secureConnect`, `response`, `end` (`performance.now()`). Przy reużytym sockecie DNS/TCP/TLS = 0.
- Pojedynczy strzał: bez keep-alive (zawsze pełne rozbicie czasu). Load: `Agent({ keepAlive: true })` per worker.
- TLS: `rejectUnauthorized: !ignoreTls`; mTLS: `cert`/`key`/`passphrase`/`ca` jako PEM ze zmiennych (po `resolve`).
- Dekompresja gzip/br/deflate przez `node:zlib`. Limit body odpowiedzi w wyniku dla GUI (np. 10 MB, potem obcięcie z flagą).
- Domyślny timeout HTTP w `config.ts` (np. 30 s) — potrzebny też jako typ błędu „timeout” w raportach load.

### core/run.ts
```ts
runRequest(input: { collection: Collection; requestId: Id; override?: RequestItem; scopes: Scopes; env: Environment }, send = execute)
  : Promise<RunResult>
// RunResult: finalRequest, response | error, preScripts/testScripts: ScriptResult[], scopes (po zmianach), nextRequest?
```
Kroki: pre-skrypty → `prepare` → `execute` → test-skrypty. `override` = niezapisane zmiany z edytora. Flow (etap 2) to osobny `core/flow.ts`, który woła `runRequest` per węzeł — sekcja 10.2.

### runPool.ts (główny wątek)
Jeden stały `Worker(dist/worker.cjs, { workerData: { role: 'run' } })`, zadania `{ jobId, input }`, wiele równoległych. Hard-timeout po stronie głównej (5 s × liczba skryptów + timeout HTTP + margines): `terminate()` i respawn przy następnym zadaniu — obsługuje pętlę nieskończoną po `await`, której `vm` nie przerwie. Po zakończeniu główny wątek zapisuje zmienione `environment`, `collection.variables`, `globals` (porównanie z wejściem, zapis tylko zmienionych). Zadania flow (etap 2) — sekcja 10.3.

### Etap 3: load/engine.ts + worker 'load' + core/stats.ts
- `W = min(os.availableParallelism() - 1, 4)` workerów (co najmniej 1); VU rozdzielone równo; każdy VU to pętla `runFlow` ze `structuredClone` scopes na start VU (nic nie wraca do environment) — styk opisany w sekcji 10.4.
- Limit RPS: token bucket per worker z `rps / W` (shortcut: równy podział, przy `rps < 100` używamy W=1, żeby nie zaokrąglać do zera).
- Ramp-up: start VU liniowo w `rampUpSec`.
- Worker co 1 s wysyła `tick`: per węzeł histogram latencji + liczniki statusów/typów błędów + nowe próbki błędów (max 5 na typ). Główny wątek scala, broadcastuje przez WS, na końcu zapisuje `reports/<id>.json`.
- `stats.ts`: histogram o stałych kubełkach logarytmicznych (~1% błędu), scalany sumowaniem — percentyle min/avg/p50/p90/p95/p99/max bez trzymania wszystkich próbek (1000 RPS × 30 min). Własne ~50 linii + test, bez zależności.
- Blokada: `let current: LoadRun | undefined` w engine; `POST /api/load` przy trwającym → 409 `{ runningId }`. Stop: `postMessage('stop')`, po 2 s `terminate()`. Limity (200 VU / 2000 RPS / 30 min) z `config.ts`, walidowane na wejściu.
- Eksport HTML: serwer renderuje samodzielny plik (szablon string + tabelki + inline SVG wykresów z timeline); JSON = plik raportu.

## 6. API

Wszystko pod `/api`, JSON. Fastify `bodyLimit` podniesiony do 50 MB (kolekcje z bibliotekami w zmiennych).

**Etap 1 (tylko REST — pojedynczy strzał to zwykłe żądanie–odpowiedź):**

| Metoda i ścieżka | Opis |
|---|---|
| `GET /api/collections` | lista `{ id, name }` |
| `GET/PUT/DELETE /api/collections/:id` | cała kolekcja |
| `GET /api/environments`, `POST /api/environments`, `GET/PUT/DELETE /api/environments/:id` | jak wyżej (pusty env tworzony w GUI) |
| `GET/PUT /api/globals` | |
| `POST /api/import?overwrite=true` | body: JSON Postmana; 409 `{ existingId, name }` gdy `sourceId` już istnieje i brak `overwrite` — GUI pyta i ponawia |
| `POST /api/run` | `{ collectionId, requestId, environmentId?, request?: RequestItem }` → `RunResult` |
| `GET /api/health` | do smoke testu |

**Etap 2:** trasy flow i zdarzenia WS — sekcja 10.5.
**Etap 3:** `POST /api/load` (config) → `{ id }` / 409, `POST /api/load/:id/stop`, `GET /api/load/current`, `GET /api/reports`, `GET /api/reports/:id`, `GET /api/reports/:id/export?format=html|json`.
**Etap 4:** `POST /api/import/openapi` `{ url } | spec` → kolekcja jak import Postmana.

**WebSocket `/ws`** (od etapu 2): serwer → klient, `{ type: 'flow.*' | 'load.tick' | 'load.done', ... }`; klient tylko słucha, sterowanie zawsze przez REST. Szczegóły w sekcji 10.5–10.6.

**Bezpieczeństwo:** brak logowania jest decyzją produktową, ale przy domyślnym `HOST=localhost` hook `onRequest` odrzuca żądania z nagłówkiem `Host` innym niż `localhost:PORT`/`127.0.0.1:PORT` (DNS rebinding — strona z internetu mogłaby inaczej czytać sekrety i strzelać z sieci firmowej). Bez CORS. Fastify odrzuca nie-JSON content-type (blokuje proste CSRF z formularzy). `/ws` dodatkowo sprawdza `Origin` (sekcja 10.6).

## 7. Frontend

```
web/src/
  main.tsx           # MantineProvider (tokeny z docs/design/ui-pipeline.md, ciemny domyślnie), fonty @fontsource, Notifications
  api.ts             # cienki fetch<T>() + funkcje per endpoint, typy z shared/
  monaco.ts          # lokalny loader Monaco, workery, extraLib z typami pm
  track.ts           # sygnał węzła, grupy biblioteki, wiersze drzewa kolekcji, blokada uruchomień
  flow.ts            # etap 2: czyste helpery płótna (sekcja 10.7)
  ws.ts              # etap 2: jedno połączenie /ws z ponawianiem, subskrypcje
  context.ts         # AppContext: dane, drafty (useDraft), jedna blokada uruchomień dla wszystkich ekranów (claimRun/releaseRun/busy)
  App.tsx            # pasek ikon (Requests / Flows / Library / Environments / Load tests), ostatni ekran w localStorage; Requests i Flows zawsze zamontowane
  components/
    Requests.tsx (warsztat: drzewo kolekcji z filtrem i menu, zakładki requestu, odpowiedź w zakładkach, przeciągany podział)
    Flows.tsx (etap 2, zastępuje Track.tsx: lista flow, płótno React Flow, dok biblioteki)  FlowNodes.tsx (węzły Start i Request)
    Inspector.tsx (zwijane sekcje requestu wybranego węzła)
    RequestEditor.tsx (wspólne pola requestu: RequestLine, Query & path, Headers, Body, Auth, Scripts, Settings; useRequestDraft = draft + Save)
    ResponseView.tsx (LastResult: status, czasy, testy, konsola, body, nagłówki, sent request; sekcje w inspektorze, `tabs` w Requests)
    Library.tsx (bilety, import; useLibraryActions = menu zarządzania + dialogi, wspólne z drzewem Requests)
    VariablesTable.tsx (maskowanie secret, odkrycie po kliknięciu)  EnvironmentEditor.tsx (widok environments, EnvironmentSelect)
    (etap 3) LoadTestView.tsx, LoadCharts.tsx (Recharts)
```
Stan: `useState`/`useEffect` + jeden React Context na „dane aplikacji” (lista kolekcji, environments, aktywny env, otwarty request). Edycja jak w Postmanie: zmiany lokalne z oznaczeniem „niezapisane”, zapis przyciskiem Save / Ctrl+S (`PUT`); Send wysyła bieżący stan jako `request` override. Po `run` ponowne pobranie environment/kolekcji (skrypty mogły zmienić zmienne). Bez routera; link do trwającego testu = `#/load/<id>`.

## 8. Testy

- Vitest (`environment: 'node'`), testy obok kodu: `importers/postman`, `core/variables`, `core/sandbox` (pm API, eval biblioteki, jose/jsrsasign/crypto-js, timeout pętli), `core/stats` (percentyle vs. sortowanie), `core/http` i `core/run` przeciw `test/mockServer.ts`. Flow (etap 2) — sekcja 10.8.
- `mockServer.ts`: HTTP i HTTPS na porcie 0; certyfikaty serwera i klienta (mTLS) generowane w trakcie testu przez jsrsasign (`KJUR.asn1.x509.Certificate`, klucze z `crypto.generateKeyPairSync`) — żadnych PEM-ów w repo.
- Load engine (etap 3): krótki test ~2 s na mock serwerze, sprawdza limit RPS i Stop.
- `samples/`: test `describe.skipIf(!existsSync('samples'))` importuje i wykonuje prawdziwy eksport lokalnie; w repo się pomija.
- `test:dist`: uruchamia `node dist/server.cjs` z tymczasowym `DATA_DIR` i `PORT=0`, sprawdza `/api/health`, `/` (index.html) i jeden `POST /api/run` ze skryptem używającym `require('jsrsasign')`, `require('jose')` i `pm.expect` na mock serwerze — łapie błędy bundlowania, których testy na źródłach nie widzą.

## 9. Ryzyka

1. **Bundlowanie**: zależność z dynamicznym `require`, plikami poza JS lub top-level await rozjedzie się z esbuild CJS. Mitygacja: `test:dist` po każdym buildzie; pino bez transportów.
2. **Kompatybilność skryptów Postmana**: emulujemy podzbiór `pm.*`; skrypty użytkownika mogą używać `pm.response.to.be.*`, `_`/lodash, `xml2Json`, `postman.*`. Mitygacja: dokładać na podstawie `samples/`, nieznane API → czytelny błąd w konsoli skryptu.
3. **Synchroniczne `pm.*` vs worker**: rozwiązane kopią scopes w workerze ([ADR 0003](adr/0003-script-execution-model.md)); konsekwencja — zmiany zmiennych widoczne w GUI dopiero po zakończeniu runu, a jednoczesny zapis kolekcji z GUI i zapis `collectionVariables` po runie = last write wins.
4. **Timeout skryptu**: `vm` przerywa tylko synchroniczną część; pętla po `await` blokuje worker — obsłużone `terminate()` w `runPool`, w load przez Stop.
5. **Brak izolacji skryptów** (`runInThisContext`): skrypt może zmienić globalny stan workera (np. przypisanie bez `var`), co wycieka do kolejnych runów w tym workerze. Akceptowalne przy zaufanym kodzie; restart workera czyści.
6. **jsrsasign** zakłada przeglądarkowe `navigator`/`window` — wersja npm ma własne deklaracje, wariant wklejany do zmiennej deklaruje je w skrypcie. Do potwierdzenia na `samples/` w etapie 1.
7. **Windows**: `rename` przy otwartym pliku (EPERM) — retry; ścieżki tylko przez `path.join`; CRLF w `start.sh` zepsuje skrypt — `.gitattributes`.
8. **Rozmiar `dist/`** (Monaco i bundle serwera po kilka MB) rośnie w historii gita z każdym buildem. Akceptowane decyzją „dist w repo”; `linguist-generated -diff` ukrywa diffy.
9. **dist niezsynchronizowany ze źródłem** — zależne od dyscypliny (CLAUDE.md: przebuduj przed commitem).
10. **HOST=0.0.0.0 bez logowania** udostępnia sekrety environment i wykonywanie requestów każdemu w sieci — świadoma decyzja produktowa; ostrzeżenie w logu startowym.
11. **1000 RPS z podpisem RSA w skrypcie** — koszt podpisu ~1 ms CPU; stąd kilka workerów. Do zmierzenia w etapie 3.
12. Ryzyka etapu 2 — sekcja 10.9.

## 10. Etap 2 — flow jako graf (Blueprint)

Podstawa: SPEC „Etap 2 / Zmiana 2026-11-22”. Ta zmiana zastępuje liniową listę kroków, `stopOnError` i flow ad-hoc: brak kabla z pinu Fail oznacza zatrzymanie. Nieoczywiste decyzje opisuje [ADR 0005](adr/0005-flow-graph-format-and-engine.md).

### 10.1 Model (`shared/model.ts`)

Plik `flows/<id>.json` ma kształt podzbioru typów `Node`/`Edge` z React Flow, więc GUI podaje go do `<ReactFlow>` bez konwersji (ADR 0005). Typy `FlowStep` i `Flow.steps/stopOnError` znikają (nikt ich jeszcze nie zapisywał).

```ts
export interface XY { x: number; y: number }
export type FlowNode =
  | { id: Id; type: 'start'; position: XY; data: Record<string, never> }
  | { id: Id; type: 'request'; position: XY; data: { collectionId: Id; requestId: Id; continueWhen: number[] } }; // [] = dowolne 2xx
export type Pin = 'ok' | 'fail';                // Start ma tylko 'ok'
export interface FlowEdge { id: Id; source: Id; sourceHandle: Pin; target: Id }
export interface Flow { id: Id; name: string; nodes: FlowNode[]; edges: FlowEdge[]; maxNodeRuns?: number } // brak = FLOW_MAX_NODE_RUNS
```

- Ten sam request może występować jako kilka węzłów. Węzeł wskazuje request przez `(collectionId, requestId)`, a te id przetrwają ponowny import (`keepItemIds`). Węzeł wskazujący usunięty request zostaje na płótnie jako „Missing request”, a w przebiegu idzie pinem Fail. Usunięcie requestu nie czyści flow (inaczej niż dotychczasowe `dropStations`), bo flow żyją na serwerze i jest ich wiele.
- Pola, których nie zapisujemy: `selected`, `measured`, `dragging` itp. od React Flow. `flows.ts` przy `PUT` zapisuje tylko pola z typu (odfiltrowanie jest też walidacją na granicy zaufania).
- `shared/flow.ts` (czyste funkcje, importowane przez silnik i przez GUI):
  - `nodeOutcome(r: RunResult, continueWhen: number[]): Pin`, sekcja 10.2. `signalOf` w `web/src/track.ts` woła tę funkcję zamiast własnej kopii warunku.
  - `nextNode(flow, nodeId, pin): FlowNode | undefined`.
  - `validateFlow(x: unknown): string | undefined`: dokładnie jeden Start, unikalne id, krawędzie wskazują istniejące węzły, co najwyżej jeden kabel na `(source, sourceHandle)`, brak kabli do Start, `sourceHandle` z węzła Start to tylko `'ok'`, `continueWhen` to liczby całkowite 100–599, `maxNodeRuns` w zakresie 1–`FLOW_MAX_NODE_RUNS_CAP`. Serwer zwraca 400 z tym komunikatem. GUI używa tej samej funkcji w `isValidConnection`.

### 10.2 Silnik: `server/core/flow.ts`

Czysta funkcja bez I/O, wykonywana w workerze (rola `run` teraz, `load` w etapie 3):

```ts
export interface FlowInput {
  flow: Flow;
  collections: Record<Id, Collection>;          // tylko kolekcje używane przez węzły
  env?: Environment;
  scopes: { runtime: Record<string, string>; environment: Variable[]; globals: Variable[]; collections: Record<Id, Variable[]> }; // mutowane w miejscu
  overrides?: Record<Id, RequestItem>;          // niezapisane drafty z GUI, po requestId
  maxNodeRuns: number;
}
export interface FlowHooks {
  signal?: AbortSignal;
  onNodeStart?(node: FlowNode, scopes: Scopes): void;
  onNodeEnd?(node: FlowNode, result: RunResult, outcome: Pin, scopes: Scopes): void;
}
export type FlowStatus = 'done' | 'limit' | 'cancelled';
export async function runFlow(input: FlowInput, hooks?: FlowHooks, send?: Send): Promise<{ status: FlowStatus; nodeRuns: number }>;
```

- **Pętla**: `node = nextNode(start, 'ok')`. Dopóki `node` istnieje: jeśli `signal.aborted`, kończy z `cancelled`. Jeśli wykonano już `maxNodeRuns` węzłów, kończy z `limit`. Dalej `onNodeStart`, `runRequest`, `outcome`, `onNodeEnd`, a następny węzeł to `nextNode(node, outcome)`. Brak kabla z pinu oznacza `done`. Wynik `done` nie mówi, czy flow „się udał”: GUI widzi to po kolorach węzłów i po tym, którym pinem przebieg się zakończył.
- **Scopes**: jeden obiekt `runtime`/`environment`/`globals` na cały przebieg, przenoszony między węzłami. Zmienne kolekcji trzymamy per kolekcja (flow może łączyć kilka kolekcji). Dla węzła składamy `Scopes { ..., collection: scopes.collections[collectionId] }`. Sandbox mutuje tablice w miejscu (`push`/`splice`), więc zmiany zostają w mapie bez kopiowania. Zmiany zrobione w GUI w trakcie przebiegu (np. edycja environment) nie są widoczne dla tego przebiegu.
- **OK/Fail** (`nodeOutcome`): OK, gdy jest `response`, a jej status należy do `continueWhen` (pusty = 200–299), żaden skrypt pre/test nie ma `error` i wszystkie `pm.test` przeszły. Cała reszta to Fail, w tym błąd sieci, timeout, błąd pre-skryptu (`ESCRIPT`) i brak requestu. Wyjątek z `runRequest`/`prepare` (np. 404 requestu) silnik łapie i zamienia na `RunResult` z `error: { code: 'EFLOW', message }`. Taki węzeł idzie pinem Fail i nie przerywa przebiegu.
- **Warunek JS** ze starej spec (`condition`) nie wchodzi. To samo daje `pm.test` w test-skrypcie: oblany test to Fail.
- **`pm.setNextRequest`**: silnik je ignoruje i dopisuje ostrzeżenie do `logs` wyniku węzła (ADR 0005).
- **Limit cykli**: `config.ts` dostaje `FLOW_MAX_NODE_RUNS = 100` (domyślny) i `FLOW_MAX_NODE_RUNS_CAP = 10000`. Wartość per flow to `Flow.maxNodeRuns`, edytowana w top barze.
- **Cancel**: `RunInput` dostaje `signal?: AbortSignal`, który `runRequest` przekazuje do `HttpOptions.signal` i dalej do `http.request(url, { signal })`. Trwający request przerywa się od razu (`error.code = 'ECANCELED'`). Trwający skrypt kończy się sam, najpóźniej po 5 s. Silnik nie zaczyna następnego węzła.

### 10.3 Worker i `runPool.ts`

- `worker.ts`, rola `run`, dostaje nowy rodzaj wiadomości `{ jobId, flow: FlowInput }` oraz `{ jobId, cancel: true }` (wtedy `AbortController.abort()`). Hooki silnika wysyłają `postMessage`:
  - `onNodeStart`: `{ jobId, event: 'start', nodeId }` i zapamiętanie `structuredClone(scopes)`.
  - `onNodeEnd`: `{ jobId, event: 'end', nodeId, outcome, result, diff: diffScopes(before, scopes), collectionId }`.
  - na końcu: `{ jobId, status, nodeRuns }`.
- `runPool.ts` dostaje `runFlow(input, onEvent): { done: Promise<{ status, nodeRuns }>; cancel(): void }`. Watchdog działa per węzeł, a nie per zadanie: timer jest resetowany przy każdym `start` na `hardTimeout` danego węzła, bo cały flow nie ma znanego z góry czasu. `cancel()` wysyła `cancel`. Jeśli flow nie skończy się w ciągu `SCRIPT_TIMEOUT_MS + 1 s`, worker dostaje `terminate()`, tak jak przy watchdogu. Ubija to też ewentualne równoległe pojedyncze strzały z innej karty. Akceptujemy to, bo GUI i tak blokuje równoległe uruchomienia.
- **Zapis zmiennych po każdym węźle** (nie na końcu): główny wątek po każdym `end` stosuje `diff` przez `updateJson`/`applyDiff`, czyli tę samą ścieżkę co `/api/run`. Ten kod przenosimy z `routes.ts` do wspólnej funkcji `persistDiff(diff, envId, collectionId)`. Uzasadnienie: semantyka jak w pojedynczym strzale (każde wykonanie requestu utrwala swoje zmiany), token zdobyty przed anulowaniem, awarią workera czy limitem nie przepada, a koszt to kilka małych zapisów na węzeł. Zmienne `runtime` (`pm.variables`) żyją tylko w przebiegu.

### 10.4 Styk z etapem 3 (load)

Rola `load` w workerze woła **ten sam** `runFlow` bezpośrednio, bez `runPool` i bez zdarzeń per węzeł:

```ts
// per VU: własna kopia zmiennych, nic nie wraca do environment
const scopes = structuredClone(baseScopes);
while (!stopped) await runFlow({ ...input, scopes }, { signal, onNodeEnd: (n, r) => stats.record(n.id, r) }, limitedSend);
```

- `limitedSend` = `execute` z `Agent({ keepAlive: true })` i token bucketem RPS przed wysłaniem. Wpinamy go przez istniejący parametr `send` (`runFlow` przekazuje go do `runRequest`).
- `onNodeStart` i diffy nie są podpinane, więc rola `load` nie robi `structuredClone` na węzeł ani nie zapisuje plików.
- Statystyki są „per krok” = per `nodeId`. Limit `maxNodeRuns` obowiązuje per iteracja VU.
- Etap 3 nie zmienia silnika. Dochodzi tylko kod wokół niego (`load/engine.ts`, rola `load`, `stats.ts`).

### 10.5 API

| Metoda i ścieżka | Opis |
|---|---|
| `GET /api/flows` | lista `{ id, name }` |
| `POST /api/flows` | body `Partial<Flow>` → nowy flow (bez `nodes` serwer dodaje sam węzeł Start) |
| `GET/PUT/DELETE /api/flows/:id` | cały flow; `PUT` waliduje przez `validateFlow` (400); `DELETE` trwającego przebiegu → 409 |
| `POST /api/flows/:id/run` | `{ environmentId?, overrides?: Record<Id, RequestItem> }` → `{ runId }`; trwa inny przebieg flow → 409 `{ runId, flowId }` |
| `POST /api/flows/:id/cancel` | 204 (również gdy nic nie trwa) |
| `GET /api/flows/:id/run` | ostatni przebieg z pamięci: `FlowRunState` albo 404 |

- Przebieg czyta flow, kolekcje, environment i globals z dysku w chwili startu. GUI przed Run czeka na zakończenie zapisu flow (sekcja 10.7).
- **Blokada**: `server/flows.ts` trzyma `let current: { runId; flowId; cancel } | undefined`, czyli jeden przebieg flow naraz w całej aplikacji. Wynika to z tego, że zmienne env są wspólne, a GUI pokazuje jeden przebieg. Pojedyncze strzały serwer nadal przyjmuje równolegle (diffy są per klucz). Wyklucza je blokada GUI: `claimRun` trzymany od `POST run` do `flow.done`.
- **Ostatni wynik**: tylko w pamięci, bez zapisu na dysk. Historię przebiegów dadzą raporty etapu 3. `lastRuns: Map<flowId, FlowRunState>`:
  ```ts
  interface FlowRunState { runId: Id; flowId: Id; status: 'running' | FlowStatus | 'error'; error?: string; startedAt: string;
    currentNodeId?: Id; path: Id[];                  // kolejność wykonanych węzłów (≤ maxNodeRuns), do kolorowania kabli
    nodes: Record<Id, { result: RunResult; outcome: Pin; runs: number }> } // tylko ostatnie wykonanie każdego węzła
  ```
  Pamięć ograniczają liczba węzłów × limit body 10 MB. Wynik flow usuniętego lub nadpisanego importem zostaje do restartu, co jest nieszkodliwe.
- **Zdarzenia `/ws`** (`shared/api.ts`, `WsMessage`), wysyłane do wszystkich klientów:
  ```ts
  | { type: 'flow.started'; flowId; runId }
  | { type: 'flow.node'; flowId; runId; nodeId; phase: 'start' }
  | { type: 'flow.node'; flowId; runId; nodeId; phase: 'end'; outcome: Pin; runs: number; result: RunResult }
  | { type: 'flow.done'; flowId; runId; status: FlowStatus | 'error'; error?: string }
  ```
  `end` niesie pełny `RunResult`, a nie osobny typ podsumowania. Inspektor i tak go potrzebuje (`LastResult`), więc nie trzeba dodatkowego endpointu ani drugiego typu. Dane idą do tego samego, lokalnego klienta, który dostaje je przez REST w `/api/run`.

### 10.6 WebSocket: zależność i bezpieczeństwo

- Nowe zależności: `@fastify/websocket` **11.3.7** (deps: `ws ^8.16`, `duplexify`, `fastify-plugin ^6`; Fastify 5). Wszystko to czysty JS. `bufferutil`/`utf-8-validate` to opcjonalne peery `ws`: nie instalujemy ich, a w `build.mjs` już są `external`. `ws` ładuje je w `try/catch`, więc w `dist/` po prostu używa ścieżki JS. Bez zmian w `build.mjs`.
- `server/ws.ts`: `register(websocket)`, trasa `GET /ws` z `{ websocket: true }`, `Set<WebSocket>` klientów, `broadcast(msg)` (`JSON.stringify` raz, pomija klientów z `readyState !== OPEN`). Klient nic nie wysyła, przychodzące wiadomości ignorujemy.
- Hook `Host` z `routes.ts` obejmuje też upgrade (to zwykłe żądanie w cyklu Fastify). **Dodatkowo sprawdzamy `Origin`**: przeglądarka nie stosuje same-origin do WebSocketów, więc obca strona mogłaby otworzyć `ws://localhost:3000/ws` (z poprawnym `Host`) i czytać wyniki z sekretami. Reguła: brak `Origin` (klient nieprzeglądarkowy) jest OK, w przeciwnym razie `new URL(origin).host === req.headers.host`, inaczej zamknięcie z kodem 1008. Proxy Vite ma `changeOrigin: true`, więc w dev to też przechodzi. Do sprawdzenia w implementacji, czy proxy przepisuje `Origin` (jeśli nie, dopuszczamy dodatkowo `localhost:5173` tylko przy `NODE_ENV !== 'production'`).
- `vite.config.ts` ma już proxy `/ws` z `ws: true`, bez zmian.

### 10.7 Frontend

- **`@xyflow/react` 13.0.2** (latest na 2026-11-22). Peer deps: `react >=18`, `react-dom >=18`, `@types/react >=18`, czyli React 18.3 jest wspierany. Deps: `zustand ^5`, `classcat`, `@xyflow/system 1.0.0`, `react-compiler-runtime ^1` (peer `react ^17 || ^18 || ^19`). Wszystko to czysty JS, bundlowany przez Vite do `dist/public`, działa offline (bez CDN, bez fontów, bez zasobów zdalnych). CSS: `import '@xyflow/react/dist/style.css'` w `main.tsx` **przed** `app.css`. Kolory nadpisujemy zmiennymi `--xy-*` z tokenami z `ui-pipeline.md`, a `colorMode` bierzemy z `useComputedColorScheme`. **Do weryfikacji przy instalacji**: `npm view @xyflow/react@13.0.2 peerDependencies` oraz `vite build` + `typecheck` z `@types/react` 18. Jeśli świeży major 13 sprawi kłopot, cofamy się do ostatniego 12.x (format pliku się nie zmienia).
- **`Flows.tsx`** (zastępuje `Track.tsx`; ekran `'track'` w `SCREENS` zostaje pod tą nazwą, żeby nie psuć zapamiętanego ekranu):
  - Wąska lista flow po lewej (New, rename, duplicate, delete) i top bar: nazwa, `EnvironmentSelect`, „Max node runs”, przycisk Run/Cancel.
  - Pod spodem `<ReactFlow nodes edges nodeTypes onNodesChange onEdgesChange onConnect isValidConnection>` z `<Background>` i `<Controls>` (bez MiniMap), a pod płótnem dok `Library` jak dotąd.
  - Otwarty flow `openFlowId` trzymamy w `App` + `localStorage` (`cirt.flow`).
  - Zmiany grafu zapisuje autosave: `PUT` z debounce 500 ms, przez kolejkę jak `saveCollection`. Run czeka na opróżnienie kolejki. Graf nie ma przycisku Save, bo przesuwanie węzłów to też zmiana. Edycja requestu nadal przez Save w inspektorze.
  - `onConnect` zastępuje istniejący kabel z tego samego `(source, sourceHandle)`, jak exec pin w Blueprint. Pętle i self-loop są dozwolone. Delete/Backspace usuwa zaznaczone (React Flow), węzła Start nie da się usunąć (`deletable: false`).
- **`FlowNodes.tsx`**:
  - `StartNode` ma jeden `Handle type="source" id="ok"`.
  - `RequestNode` ma `Handle target` po lewej oraz `source` `ok` i `fail` po prawej, z etykietami OK/Fail. Pokazuje `MethodGlyph`, nazwę, URL (mono, ucięty), „Sets: token, bookingId” i ostatni status · czas · testy `3/3` z `data-signal` (`caution` w trakcie, `go`/`stop` po wykonaniu) oraz licznik wykonań przy `runs > 1`.
  - Dane do renderu bierze z `useApp()` (kolekcje) i małego `FlowRunContext` (stan przebiegu z WS), a nie z `node.data`. Plik zostaje czysty, a zmiana wyniku nie wymaga przepisywania `nodes`.
  - Kable z `path` ostatniego przebiegu dostają `data-signal` według pinu.
- **Zmienne ustawiane przez skrypty: statycznie, regexem** po `scripts.pre` + `scripts.test` samego requestu: `/pm\.(environment|collectionVariables|globals|variables)\.set\(\s*(['"`])([^'"`]+)\2/g`, unikalne klucze. Wybrane zamiast diffu z ostatniego przebiegu, bo działa przed pierwszym uruchomieniem, jest deterministyczne i nie zależy od tego, którą gałęzią poszedł skrypt. Klucze dynamiczne (`set(name, …)`) i skrypty folderu/kolekcji pomijamy. Skrypty kolekcji dotyczą każdego węzła i byłyby szumem.
- **Inspector** bez zmian w kontrakcie (`collection, path, result, failure, running, busy, active, onRun, onClose`). `onRun` to pojedyncze wykonanie węzła przez istniejące `POST /api/run`, jak „Run station”. Sekcja „Continue when” przestaje być wyszarzona i dostaje props `continueWhen` / `onContinueWhen`: pole tekstowe „200, 201, 204”, puste = dowolne 2xx, parsowanie w `web/src/flow.ts`.
- **Dodawanie węzłów**:
  - Bilet z biblioteki upuszczony na płótno (istniejący `TICKET_MIME`) trafia w miejsce kursora (`screenToFlowPosition`).
  - „+” na bilecie i „Add to flow” z Requests (`addStation` przemianowane na `addToFlow`) dodają węzeł do otwartego flow, na prawo od ostatnio dodanego. Jeśli jego pin OK jest wolny, od razu go podłączają, więc kilka kliknięć daje flow liniowy.
  - Gdy żaden flow nie jest otwarty, tworzony jest „Untitled flow”. `dropStations` znika (sekcja 10.1).
- **Migracja „Scratch track”**: przy pierwszym montażu `Flows`, jeśli `localStorage['cirt.track']` ma stacje, `fromTrack(track)` buduje flow liniowy (Start, potem stacje połączone pinami OK, x co 260 px) o nazwie toru. Po udanym `POST /api/flows` klucz jest usuwany. Przy błędzie klucz zostaje i migracja ponawia się przy następnym uruchomieniu. Potem `loadTrack/saveTrack` i `Track.tsx` są usuwane, a z `track.ts` również `runSequence`/`moveItem`/`reorderToSlot`, jeśli nie mają innych użyć.
- **`web/src/ws.ts`**: jedno `WebSocket` na `location` (`ws:`/`wss:`), ponawianie co 1 s do 5 s, `subscribe(fn)`. Po (ponownym) połączeniu i przy otwarciu flow GUI pobiera `GET /api/flows/:id/run`, co odtwarza stan po odświeżeniu strony. Po `flow.done` wywołuje `refreshAfterRun` dla kolekcji flow i zwalnia `claimRun`.
- **`web/src/flow.ts`** (czyste helpery z testami): `scriptVars(scripts)`, `parseStatuses(text)`, `fromTrack(track)`, `addRequestNode(flow, collectionId, requestId, at?)`, `connect(flow, edge)` (zastępowanie kabla z pinu).

### 10.8 Testy

- `shared/flow.test.ts`:
  - `nodeOutcome`: domyślne 2xx, własna lista, oblany test, błąd skryptu, błąd sieci.
  - `validateFlow`: dwa Starty, kabel do Start, dwa kable z jednego pinu, krawędź do nieistniejącego węzła.
  - `nextNode`.
- `server/core/flow.test.ts`, `runFlow` bezpośrednio przeciw `test/mockServer.ts`:
  - liniowy przebieg i przekazanie zmiennej (test-skrypt A ustawia `token`, nagłówek B go używa);
  - gałąź Fail przy 500 i przy `ECONNREFUSED`;
  - ponowienie w cyklu (mock zwraca 500, 500, 200; Fail → ten sam węzeł) z wynikiem `done` po 3 wykonaniach;
  - limit (self-loop zawsze Fail, `maxNodeRuns: 5`) z wynikiem `limit` i dokładnie 5 wykonaniami;
  - cancel (`abort()` w trakcie wolnego endpointu): wynik `cancelled` szybciej niż opóźnienie mocka, `ECANCELED`;
  - `setNextRequest` ignorowane z ostrzeżeniem w logach;
  - brakujący request idzie pinem Fail;
  - zmienne dwóch kolekcji się nie mieszają.
- `server/flows.test.ts` (Fastify `inject` + `injectWS` z `@fastify/websocket`):
  - CRUD i 400 z walidacji;
  - drugi `run` daje 409;
  - kolejność zdarzeń WS;
  - env zapisany po węźle 1, mimo że węzeł 2 został anulowany;
  - odrzucenie `/ws` z obcym `Origin`.
- `web/src/flow.test.ts`: `scriptVars` (cudzysłowy, backticki, duplikaty, klucz dynamiczny pominięty), `parseStatuses`, `fromTrack`, `addRequestNode` (autopodłączenie tylko przy wolnym pinie), `connect` (zastąpienie kabla).
- `test:dist`: dochodzi połączenie z `/ws` (klient `ws` z zależności) i 2-węzłowy flow na mock serwerze. Łapie bundlowanie `@fastify/websocket`/`ws`.

### 10.9 Ryzyka etapu 2

1. **`@xyflow/react` 13 to świeży major** z `react-compiler-runtime`. Kompatybilność z React 18 deklaruje tylko peer deps; potwierdzi ją dopiero build i typecheck. Fallback: 12.x.
2. **Cross-site WebSocket hijacking**: bez sprawdzenia `Origin` dowolna strona otwarta w przeglądarce czyta wyniki (tokeny, sekrety). Sprawdzenie jest obowiązkowe i ma test.
3. **Zapis env po każdym węźle a edycje w GUI**: per klucz obowiązuje last write wins, a przebieg nie widzi edycji zrobionych w trakcie. Udokumentowane, tak samo jak w ryzyku 3.
4. **Pamięć**: pełne `RunResult` (do 10 MB body) w `lastRuns` i w WS. Przechowujemy tylko ostatnie wykonanie węzła; przy dużych odpowiedziach w pętli rośnie tylko ruch WS, nie pamięć.
5. **Statyczne „Sets:”** nie pokaże kluczy dynamicznych ani ustawianych w skryptach folderu/kolekcji.
6. **`pm.setNextRequest` ignorowane**: kolekcje oparte na nim zachowają się inaczej niż w Postmanie runnerze. Ostrzeżenie w konsoli węzła łagodzi problem.
7. **Wspólny worker `run`**: `terminate()` po anulowaniu z zawieszonym skryptem albo po watchdogu ubija też równoległy pojedynczy strzał z innej karty.
8. **Autosave z dwóch kart** tego samego flow: last write wins na całym pliku. Akceptujemy, bo to jeden użytkownik lokalnie.
9. **Osierocone węzły** po usunięciu requestu: widoczne jako „Missing request”, bez automatycznego sprzątania.
