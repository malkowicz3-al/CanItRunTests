# CanItRunTests — specyfikacja (ustalona w wywiadzie 2026-11-22)

Lokalne narzędzie do testów integracyjnych i wydajnościowych mikroserwisów, zastępujące Postmana w codziennej pracy. Otwarty dostęp, bez logowania.

## Dystrybucja i uruchomienie
- Publiczne repo GitHub. W repo tylko kod — żadnych sekretów, certyfikatów ani danych. `samples/` i katalog danych w `.gitignore`.
- Użytkownik pobiera **zip repo**, rozpakowuje, uruchamia `start.bat` (Windows — priorytet) lub `start.sh` (Rocky Linux).
- Wymagany tylko **Node 22+** (dowolna 22.x). **Brak `npm install` po stronie użytkownika**: zbudowany bundle (`dist/`) jest commitowany w repo. Zero natywnych zależności.
- Serwer: `http://localhost:3000`, domyślnie bind `localhost`; `HOST=0.0.0.0` udostępnia w sieci; `PORT` konfigurowalny.
- Dane: pliki JSON (jeden plik na obiekt: kolekcja, environment, flow, raport) w `%USERPROFILE%\.canitruntests` (Linux: `~/.canitruntests`), zmiana przez `DATA_DIR`. **Nie SQLite** (node:sqlite niedostępny bez flagi na Node < 22.13).
- Na razie bez Dockera/k8s; architektura backend + GUI ma pozwalać na wrzucenie na poda później.

## Architektura
- TypeScript, monorepo.
- Backend: Fastify, REST + WebSocket (wyniki na żywo). **Backend wykonuje wszystkie requesty**, skrypty i testy obciążeniowe; GUI tylko steruje i wyświetla.
- Frontend: React + Vite + Mantine, Monaco (edytor skryptów), Recharts (wykresy). GUI po angielsku, motyw jasny/ciemny, układ jak Postman (drzewo kolekcji z lewej, edytor requestu + odpowiedź z prawej, zakładki Flows i Load tests).
- Backend serwuje zbudowane GUI.

## Etap 1 — import i pojedynczy strzał
- Import Postman Collection **v2.1** + eksport environment.
  - Foldery (drzewo), skrypty pre-request/test na poziomie kolekcji, folderu i requestu.
  - Auth kolekcji/folderu/requestu: Bearer, Basic, API key (OAuth2 → tylko Bearer z gotowym tokenem).
  - Zmienne kolekcji, globals.
  - Ponowny import tej samej kolekcji pyta o nadpisanie.
- Rozwiązywanie `{{zmienna}}`: runtime → environment → collection → globals.
- Dynamiczne zmienne: `$guid`, `$randomUUID`, `$timestamp`, `$isoTimestamp`, `$randomInt` (reszta `$random*` później).
- Zmienne typu `secret` maskowane w GUI (podgląd po kliknięciu).
- Pełna edycja: URL, nagłówki, body, skrypty (Monaco), zmienne. Dropdown aktywnego environment w nagłówku.
- Skrypty: emulacja podzbioru `pm.*` (environment/collectionVariables/globals/variables get/set, `pm.request`, `pm.response`, `pm.test`, `pm.expect`, `pm.setNextRequest`, `pm.sendRequest`), uruchamiane w `node:vm` w workerze z timeoutem (5 s). Bez twardej izolacji — skrypty traktowane jako zaufany kod.
  - Wspierany wzorzec Postmana: `eval(pm.environment.get('lib'))` (np. jsrsasign trzymany w zmiennej).
  - Dodatkowo wbudowane w sandbox: `crypto` (Node), `jose`, `jsrsasign`, `crypto-js` — pod różne podpisy (JWS, HMAC itd.).
  - **Postman script compatibility**
    - Supported: `pm.environment` / `collectionVariables` / `globals` (get, set, has, unset, clear, toObject, replaceIn; `pm.environment.name`), `pm.variables` (+ toObject, replaceIn), `pm.request` (headers incl. has/each, `url.getHost/getPath/getQueryString`, `body.raw/mode`), `pm.response` (code, status, reason(), headers, json/text, responseTime, responseSize, `to.have.status/header/body/jsonBody`, `to.be.ok/success/error/clientError/serverError/json/withBody`, `.not`), `pm.test`, `pm.expect`, `pm.info`, `pm.cookies` (from set-cookie), `pm.iterationData` (empty), `pm.setNextRequest`, `pm.execution.setNextRequest/skipRequest`, `pm.sendRequest`.
    - Legacy API: `postman.set/get/clearEnvironmentVariable`, `postman.set/get/clearGlobalVariable`, `postman.setNextRequest`, `tests[...]`, `responseBody`, `responseCode`, `responseTime`, `responseHeaders`, `environment`, `globals`, `data`, `request`, `_`.
    - `require`: `crypto`, `jose`, `jsrsasign`, `crypto-js`, `lodash`, `moment`, `uuid` (v4), `chai`, `atob`, `btoa`.
    - Dynamic variables `{{$...}}`: guid/UUID, timestamps, randomInt and the common `$random*` set (names, emails, IPs, words, dates, ...) from small built-in lists, not faker.
    - Not supported: `xml2js`, `cheerio`, `tv4`, `csv-parse`, `pm.vault`, `pm.visualizer`, file fields in form-data, auth types other than bearer/basic/apikey/oauth2 (token only).
- Klucze prywatne i certyfikaty (także do mTLS) są zwykłymi zmiennymi env (jak w Postmanie). Przełącznik „ignoruj błędy TLS” per environment, opcjonalny certyfikat klienta (mTLS) ze zmiennych.
- Zmiany zmiennych przez skrypty w pojedynczym strzale/runie zapisują się w environment.
- Podgląd odpowiedzi: body sformatowane (JSON/XML), nagłówki, status, rozbicie czasu (DNS, TCP, TLS, TTFB, transfer), `console.log` ze skryptów, wyniki `pm.test`, **finalny wysłany request** po rozwiązaniu zmiennych i pre-scripcie.
- Weryfikacja na prawdziwym (zanonimizowanym) eksporcie użytkownika z JWS w `samples/`.

## Etap 2 — Flow
- Zaznaczenie wielu endpointów = flow ad-hoc; można zapisać jako nazwany flow.
- Liniowa lista kroków; każdy krok: request + warunek przejścia (status ∈ [...]) + opcjonalny warunek JS. Niespełniony → iteracja stop i błąd.
- Opcja „zatrzymaj przy błędzie”, respektowanie `pm.setNextRequest`.
- Dane między krokami przez zmienne z post-scriptów. Wynik per krok: status, czas, wyniki `pm.test`.

### Zmiana 2026-11-22 (zastępuje „liniową listę kroków” powyżej)
- Flow to **graf węzłów w stylu Blueprint** na swobodnym płótnie (przesuwanie, zoom, przeciąganie węzłów, kable między pinami). Biblioteka: React Flow (`@xyflow/react`).
- Typy węzłów na start: **Start** (jeden na flow) i **Request** (request z kolekcji). Branch / Set variable / Delay — nie teraz.
- Węzeł Request pokazuje: metodę, nazwę, URL, zmienne ustawiane przez skrypty, ostatni status, czas i wynik testów. Ma pin wejścia i dwa piny wyjścia: **OK** (status w warunku „Continue when”, domyślnie 2xx, i wszystkie `pm.test` przeszły) oraz **Fail** (pozostałe przypadki, w tym błąd sieci i błąd skryptu).
- Jeden kabel na pin wyjścia (jak exec w Blueprint), wiele kabli może wchodzić do jednego wejścia. Brak kabla z pinu = koniec przebiegu tą ścieżką. Cykle dozwolone (np. ponowienie), z limitem wykonań węzłów na przebieg.
- Flow zapisywane na serwerze (plik JSON w DATA_DIR), lista wielu flow na ekranie Flows. Wykonuje je **backend**; GUI pokazuje na żywo, który węzeł się wykonuje (WebSocket). Ten sam silnik posłuży testom wydajnościowym w etapie 3.
- „Add to flow” z ekranu Requests dodaje węzeł Request do aktualnie otwartego flow.

## Etap 3 — Testy wydajnościowe
- Konfiguracja: liczba VU, opcjonalny limit RPS, czas trwania lub liczba iteracji, ramp-up, wybrane environment (niezależne od aktywnego).
- Własny silnik w Node (worker_threads) — każdy request przechodzi przez te same skrypty `pm.*`. Cel: do ~1000 RPS na jednym procesie, bez trybu rozproszonego.
- Każdy VU ma własną kopię zmiennych; nic nie wraca do environment.
- Limity w konfiguracji: domyślnie 200 VU, 2000 RPS, 30 min. Natychmiastowy Stop.
- Jeden test wydajnościowy naraz w całej aplikacji — Start zablokowany, link do trwającego testu.
- Raport: wykresy na żywo (RPS, latencja, błędy); po teście min/avg/p50/p90/p95/p99/max, RPS, sukcesy/błędy z podziałem na status i typ błędu (timeout, connection refused…), per krok i łącznie; do 5 próbek request/response na typ błędu; historia; eksport HTML i JSON.

### Zmiana 2026-11-23 (zakres zrealizowany w etapie 3, plan `docs/plans/stage-3.md`, ADR 0006)
- Test obciążeniowy to tryb uruchomienia flow: Once / N iteracji / Loop do Stop oraz liczba VU (1–200), environment wybrany przy Run. Once + 1 VU zapisuje zmienne jak dotąd; każdy inny tryb nie zapisuje nic.
- Liczba iteracji jest per VU: 10 iteracji × 2 VU = 20 przebiegów flow (licznik pokazuje „x / 20”).
- Limity: 200 VU, 1 000 000 iteracji na VU i 10 000 000 łącznie, 30 min. Stop natychmiastowy (requesty w locie przerwane).
- Statystyki na żywo co 250 ms (próbki wyników najwyżej co 1 s) per blok i łącznie: count, ok, fail, err %, min, avg, p50, p95, max, kody statusu i błędów. Po rozwinięciu bloku: lista jego ostatnich 200 wywołań (filtr Failed: ostatnie 100 błędnych) z iteracją, VU, godziną, kodem, czasem i OK/Fail; kliknięcie pokazuje request i response (body i logi ≤ 16 KB). Lista tylko w pamięci, dla ostatniego przebiegu. Raport końcowy w `reports/<runId>.json`.
- **Odłożone**: limit RPS i ramp-up, historia raportów i eksport HTML/JSON, do 5 próbek na typ błędu, wykresy na żywo, tryb „przez X min”, p90/p99 w GUI.

## Etap 4 — Swagger / OpenAPI
- Swagger 2.0 i OpenAPI 3.x, z pliku lub URL.
- Generuje zwykłą kolekcję (foldery wg tagów), base URL jako `{{baseUrl}}` z environment, body z `example` lub wygenerowane ze schematu.

## Jakość
- Vitest dla logiki: parser Postmana/Swaggera, rozwiązywanie zmiennych, emulacja `pm.*`, statystyki percentyli.
- Lokalny mock-serwer w testach do flow i silnika obciążenia. Bez E2E GUI w MVP.

## Poza MVP
Pełny OAuth2, proxy HTTP, data files CSV/JSON, rozgałęzione flow, porównanie przebiegów, tryb rozproszony, Docker/k8s/Helm, eksport do Postmana, kolejka testów wydajnościowych, logowanie.
