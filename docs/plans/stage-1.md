# Plan: Stage 1

## Cel
Etap 1 z [SPEC.md](../SPEC.md): import Postman v2.1, edycja, pojedynczy strzał ze skryptami `pm.*`, executor HTTP, widok odpowiedzi. Całość działa z commitowanego `dist/` przez `node dist/server.cjs` na Node 22.

**Redirecty:** domyślnie follow (jak Postman), przełącznik per request/environment.
- `RequestItem.followRedirects?: boolean`, `Environment.followRedirects: boolean` (domyślnie true); priorytet request → env → true.
- Max 10 przekierowań. 301/302/303: POST→GET bez body; 307/308 zachowują metodę i body.
- Usuwanie `Authorization`/`Cookie` przy zmianie hosta. `finalRequest` pokazuje cały łańcuch redirectów.

## Zależności (piny exact, bez ^; przed instalacją sprawdzić `npm view <pkg> versions`, (?) = niepewne)
- Runtime: fastify 5.x (?), @fastify/static 8.x (?), jose 5.x/6.x (?, musi bundlować się do CJS), jsrsasign 11.1.0, crypto-js 4.2.0, chai 4.5.0 (nie 5 — ESM-only; Postman używa chai 4).
- GUI: react / react-dom 18.3.1, @mantine/core / hooks / notifications 7.x (?), monaco-editor 0.52.x (?), @monaco-editor/react 4.7.0.
- Dev: typescript 5.7.x, esbuild 0.25.x, vite 6.x, @vitejs/plugin-react 4.x, vitest 3.x, @types/node 22.x, @types/react(-dom) 18.3.x, @types/crypto-js, @types/jsrsasign, @types/chai 4.x.
- Pomijamy w etapie 1: @fastify/websocket / ws (etap 2), recharts (etap 3).

## Kroki ([S] sekwencyjny, [P] równoległy po spełnieniu zależności)

**K0 [S] Szkielet pionowy** — package.json (`"type":"module"`, skrypty z ARCHITECTURE §2), tsconfig.json, build.mjs, vite.config.ts, server/main.ts, server/config.ts, web/index.html, web/src/main.tsx, web/src/App.tsx (pusty AppShell), start.bat, start.sh, .gitattributes. build.mjs bundluje main+worker (stub) do `dist/*.cjs`; Fastify serwuje `dist/public` z fallbackiem index.html; `GET /api/health`; sprawdzenie Node ≥ 22; wypisanie faktycznego URL (także PORT=0); hook sprawdzający Host; bodyLimit 50 MB; odrzucanie nie-JSON content-type. Check: `npm run build && node dist/server.cjs` + curl `/api/health` i `/`; szkic `test/dist.test.ts` (spawn z PORT=0 i tymczasowym DATA_DIR) — „dist serves health and index”. Uzupełnić Komendy w CLAUDE.md.

**K1 [S] shared/model.ts + shared/api.ts** — typy z ARCHITECTURE §4 + followRedirects; DTO `RunRequestBody`, `RunResult`, `ImportResult`. Check: `npm run typecheck`.

**K2 [P] server/storage.ts** — readJson/writeJson (tmp + rename, retry EPERM/EBUSY, kolejka per plik), list, remove, walidacja id regexem. Testy: atomic write, serializes concurrent writes, rejects path traversal id, list skips tmp files.

**K3 [P] core/variables.ts** — resolve, getVar, zmienne dynamiczne, rekurencja do głębokości 10, nierozwiązane zostają dosłownie. Testy: precedence runtime>env>collection>globals, ignores disabled, recursive depth limit, unresolved kept, dynamic vars fresh per occurrence.

**K4 [P] importers/postman.ts + test/fixtures/** — zakres z ARCHITECTURE §5 (kolekcja, environment, globals, auth, url string/obiekt, body, skrypty, ostrzeżenia, walidacja wejścia → 400). Testy: collection tree, scripts at 3 levels, auth mapping incl oauth2→bearer, noauth vs inherit, url object + path variables, environment secret type, globals, rejects v2.0, unknown body → none + warning.

**K5 [S, po K1, K3] core/http.ts + test/mockServer.ts** — `execute()` z timingami, `error.code`, dekompresja gzip/br/deflate, limit body 10 MB z flagą truncated, TLS (ignoreTls, mTLS), redirecty. Mock serwer generuje certyfikaty jsrsasign w trakcie testu. Testy: timings populated, gzip/br decoded, ECONNREFUSED code, ETIMEDOUT, self-signed rejected + ignoreTls passes, mTLS required cert, follows 302 by default, 303 POST→GET, 307 keeps body, followRedirects=false returns 3xx, redirect loop limit, auth header stripped cross-host.

**K6 [S, po K3; równolegle z K5] core/sandbox.ts** — `runScript` wg ADR 0003: `vm.Script` z cache, async IIFE, timeout 5 s (sync + Promise.race), licznik oczekujących (sendRequest, setTimeout); `pm.*` z ARCHITECTURE §5, chai dla `pm.expect`, `require` dla crypto/jose/jsrsasign/crypto-js, globalne `CryptoJS`; nieznane API → czytelny błąd w konsoli skryptu. Testy: env get/set mutates scopes, variables.set goes to runtime, pm.test pass/fail, pm.expect chai, setNextRequest, eval(pm.environment.get('lib')) jsrsasign, require jose signs JWS, require jsrsasign RS256 sign, crypto-js HMAC, node crypto, sync infinite loop times out, await never resolving times out, pm.sendRequest callback and promise, console.log captured.

**K7 [S, po K3, K5, K6] core/prepare.ts + core/run.ts** — prepare: łańcuch skryptów kolekcja → foldery → request, efektywne auth (w tym apikey w query), path variables, resolve, finalny request po pre-skryptach. runRequest: pre → prepare → execute → test, ze zmianami scopes. Testy prepare: script order, auth inheritance nearest, apikey query, basic header, pre-script mutates request before send. Testy run (mock serwer): full run returns finalRequest+tests, script var persisted in scopes, http error surfaces.

**K8 [S, po K7] worker.ts + runPool.ts** — worker roli run, jeden stały worker, hard-timeout z `terminate()` i respawn; wynik zawiera diff zmienionych zmiennych. Testy: runs job, hang after await killed and respawned, parallel jobs. build.mjs produkuje `dist/worker.cjs`.

**K9 [S, po K2, K4, K8] server/routes.ts + podpięcie w main.ts** — endpointy etapu 1 z ARCHITECTURE §6; import zwraca 409 z existingId bez overwrite; `/api/run` wczytuje kolekcję + env + globals, woła runPool, zapisuje tylko zmienione zmienne, zwraca RunResult. Testy (Fastify inject): import 409 then overwrite, collections CRUD, run persists env changes, rejects text/plain, rejects foreign Host.

**K10 [S, po K9, K0] rozszerzenie test:dist** — import + run ze skryptem z `require('jsrsasign')`, `require('jose')` i `pm.expect` na mock serwerze: „dist smoke: run with jsrsasign+jose”. Główny punkt kontrolny ryzyka bundlowania.

**K11 [S, po K0] GUI: dane, API, motyw** — web/src/api.ts, Context aplikacji, header z dropdownem environment (localStorage), motyw jasny/ciemny, Import (dialog nadpisania przy 409). Check: vite build, ręczny import fixture.

**K12–K15 [P po K11; ręczny test wymaga K9]**
- K12 CollectionTree.tsx — drzewo, wybór requestu, dodawanie/usuwanie.
- K13 monaco.ts + RequestEditor.tsx — lokalny Monaco z workerami (`?worker`, bez CDN), js/json/xml, addExtraLib z typami pm; URL/params/headers/body/auth/scripts, „unsaved”, Save + Ctrl+S, Send, toggle follow redirects.
- K14 VariablesTable.tsx + EnvironmentEditor.tsx — maskowanie secret z odkryciem po kliknięciu, ignoreTls, clientCert, followRedirects, edycja zmiennych kolekcji i globals.
- K15 ResponseView.tsx — body w Monaco read-only (JSON/XML sformatowane), nagłówki, status, timingi, console, pm.test, finalny request z łańcuchem redirectów. Po runie GUI odświeża env i kolekcję.
- Check: `npm run build` bez błędów, Monaco lokalnie w `dist/public`, brak żądań do CDN.

**K16 [S] Finalny build** — `npm run build`, `npm test`, `npm run test:dist`, `typecheck`; `dist/` zawiera server.cjs, worker.cjs, public/. Uruchomić start.bat na kopii bez node_modules.

**K17 [S] E2E na samples/** — `samples.test.ts` z `describe.skipIf(!existsSync('samples'))`: import eksportu, run requestu z JWS. Potwierdza ryzyko jsrsasign/navigator i brakujące `pm.*` (braki → K6).

## Równoległość
K0 → K1 → (K2 ∥ K3 ∥ K4) → (K5 ∥ K6) → K7 → K8 → K9 → K10. GUI: K11 → (K12 ∥ K13 ∥ K14 ∥ K15), najlepiej po K9. Na końcu K16, K17.

## Ryzyka
- Bundlowanie esbuild do CJS (jose ESM, jsrsasign) — wyłapie K10.
- Wersje (?) do weryfikacji przez `npm view`.
- jsrsasign oczekuje `navigator`/`window` — potwierdzenie w K17.
- Monaco w dist/: kilka MB, wrażliwa konfiguracja workerów, nietestowana przez vitest.
- Pętla po `await` — obsługuje `terminate()` w runPool; test „hang after await killed and respawned” kluczowy.
- Redirecty doprecyzowują ADR 0004 — dopisać aktualizację ADR.
- Windows: retry EPERM przy rename, CRLF w .bat, LF w .sh.
- Zapis collectionVariables równolegle z zapisem kolekcji z GUI: last write wins (ARCHITECTURE §9.3).
