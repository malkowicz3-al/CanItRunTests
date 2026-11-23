# 0006. Testy obciążeniowe jako tryb uruchomienia flow: jeden endpoint, brak zapisu zmiennych, statystyki z kubełków logarytmicznych

## Kontekst
Etap 3 zawęził aplikację do flow (plan `docs/plans/stage-3.md`): pojedynczy request to flow z jednym blokiem, a uruchomienie ma tryby Once / N iteracji / Loop do Stop oraz równoległych VU. Pierwotny projekt (ARCHITECTURE §5 „Etap 3”) zakładał osobne `POST /api/load`, osobną blokadę, limit RPS, ramp-up i raporty z historią. Cel wydajnościowy: ~1000 RPS w jednym procesie, ze skryptami `pm.*` na każdym requeście.

## Decyzja
- **Jeden endpoint** `POST /api/flows/:id/run` z `{ environmentId?, overrides?, mode?: 'once'|'iterations'|'loop', iterations?, vus? }`. Cancel (`POST /api/flows/:id/cancel`) działa jako Stop dla obu ścieżek. Blokada `current` w `server/flows.ts` jest wspólna (409).
- **Once + 1 VU = dotychczasowa ścieżka** (`runPool`, zdarzenia `flow.node`, `persistDiff` po każdym węźle). Każda inna kombinacja to ścieżka load **bez zapisu zmiennych**: N równoległych kopii tokenu nie ma jednego wyniku do zapisania.
- **Silnik**: `server/loadRun.ts` tworzy per przebieg W = min(vus, availableParallelism − 1, 4) wątków `worker.ts` z `role: 'load'` (bez nowego wpisu w bundlu). VU są rozdzielone równo; `iterations` jest per VU (każdy VU robi dokładnie tyle iteracji, `LoadStats.iterations` = iterations × vus). Każdy VU to pętla asynchroniczna wokół istniejącego `runFlow`, z własnym `structuredClone(scopes)` (token zdobyty w iteracji 1 zostaje dla kolejnych iteracji tego VU) i `runtime` czyszczonym co iterację. `send` = `execute` z agentami keep-alive dla http i https.
- **Statystyki**: worker co 1 s wysyła delty per węzeł (`NodeStats`: count/ok/fail/sum/min/max, histogram, kody statusu lub błędu, ostatni wynik i ostatni błąd z body ≤ 64 KB i bez `scopes`). Czas = czas węzła (skrypty + HTTP). Główny wątek scala je (`shared/stats.ts`, `merge`) i raz na sekundę rozsyła skumulowany stan jako `flow.stats`.
- **Lista wywołań**: worker w każdym ticku dołącza per węzeł podsumowania wywołań `{ vu, iteration, at, status?, code?, ms, outcome }` z próbką (`ResultSample`, body i logi ≤ 16 KB) — najnowsze 50 i najnowsze 50 błędnych. Główny wątek nadaje `seq` i trzyma per węzeł dwa pierścienie: 200 ostatnich i 100 ostatnich błędnych, tylko w pamięci i tylko dla ostatniego przebiegu flow. Nie idą przez WS: `GET /api/flows/:id/run/calls?node=&filter=all|failed` → `{ calls, truncated }` (bez próbek, najnowsze pierwsze), `GET /api/flows/:id/run/calls/:seq` → próbka; 404 bez przebiegu load lub nieznany `seq`. Histogram ma kubełki logarytmiczne co 2% od 0,01 ms (błąd percentyla ≤ 1%), scalany sumowaniem; ten sam moduł liczy percentyle w przeglądarce.
- **Limity** (`config.ts`): 200 VU, 1 000 000 iteracji na VU i 10 000 000 łącznie (przekroczenie → 400), 30 min (potem Stop ze statusem `limit`). Stop: `postMessage('stop')` → abort `signal` (requesty w locie przerwane, nie liczone jako błędy), końcowy tick, `terminate()` po `SCRIPT_TIMEOUT_MS + 1 s`. Watchdog: brak ticku od workera przez 15 s → błąd „worker stalled”.
- **Raport minimalny**: końcowe statystyki w `lastRuns` (`FlowRunState.load`) i plik `reports/<runId>.json` w `DATA_DIR`.

## Konsekwencje
- Zmiana zachowania: przebieg z N > 1 nie zapisuje tokenów do environment (podpowiedź w GUI).
- VU w jednym wątku współdzielą `globalThis` skryptów ([ADR 0003](0003-script-execution-model.md)); skrypty zapisujące globalny stan bez `var` mogą sobie przeszkadzać.
- Pomiar na lokalnym mock serwerze (GET bez skryptów, 50 VU, 2000 iteracji, 12 rdzeni): ~5500 RPS wraz ze startem workerów. Koszt podpisów RS256 w skryptach nie był mierzony.
- Odłożone: limit RPS i ramp-up, historia raportów, eksport HTML/JSON, 5 próbek na typ błędu, wykresy na żywo, tryb „przez X min”.
