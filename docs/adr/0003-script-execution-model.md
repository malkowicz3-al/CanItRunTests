# 0003. Cały pipeline requestu w workerze; skrypty przez vm.Script.runInThisContext

## Kontekst
API `pm.*` jest synchroniczne (`pm.environment.get` zwraca wartość od razu), skrypty mają 5 s timeout, mają działać w `node:vm` w workerze, mieć dostęp do jose/jsrsasign/crypto-js/crypto i `pm.sendRequest`. Ten sam kod wykonuje się w teście obciążeniowym do ~1000 RPS, czyli do ~2000 uruchomień skryptów na sekundę. Skrypty są zaufane (spec: bez twardej izolacji).

## Decyzja
- W workerze wykonuje się cały `runRequest` (pre-skrypty, przygotowanie, HTTP, test-skrypty), a nie same skrypty. Worker dostaje kopię `Scopes` i mutuje ją synchronicznie; po zakończeniu zwraca zmienione scopes, które główny wątek zapisuje (pojedynczy strzał/flow) albo porzuca (load). Brak synchronicznego round-tripu worker↔główny wątek; `pm.sendRequest` wykonuje się w workerze tym samym executorem.
- Skrypt kompilujemy raz (`new vm.Script`, cache po treści) jako async IIFE dostające `pm`, `console`, `require`, `CryptoJS`, `setTimeout` jako parametry, uruchamiane `runInThisContext({ timeout: 5000 })`. Nie tworzymy `vm.createContext` per uruchomienie.
- Powody rezygnacji z osobnego kontekstu: koszt `createContext` (ms i pamięć) przy tysiącach uruchomień/s oraz problemy cross-realm (np. `Uint8Array` z kontekstu odrzucane przez `instanceof` w jose, różne `Object`/`Array` w porównaniach chai).
- Timeout: `vm` przerywa synchroniczną część; część asynchroniczna jest ograniczona `Promise.race` do łącznych 5 s; zawieszony worker (pętla po `await`) jest zabijany `terminate()` przez główny wątek i tworzony na nowo.

## Konsekwencje
- Skrypty widzą globalny zakres workera i mogą go zanieczyścić (przypisania bez `var`); zanieczyszczenie żyje do restartu workera.
- Zmiany zmiennych są widoczne poza workerem dopiero po zakończeniu runu (dla flow — po każdym kroku przez wiadomość postępu).
- Przejście później na twardą izolację (osobny kontekst lub proces) wymaga zmiany tylko w `core/sandbox.ts`, ale zwiększy koszt na wykonanie.
