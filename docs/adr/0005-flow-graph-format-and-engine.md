# 0005. Flow: plik w kształcie React Flow, czysty silnik `runFlow` z hookami, `pm.setNextRequest` ignorowane

## Kontekst
Etap 2 zmienia flow z listy kroków na graf (SPEC, „Zmiana 2026-11-22”): węzły Start i Request, piny OK/Fail, cykle z limitem. Pliki `flows/<id>.json` zostaną u użytkowników, więc ich format trudno zmienić. Ten sam silnik ma w etapie 3 obsłużyć N wirtualnych użytkowników w `worker_threads`, bez zapisu zmiennych i bez zdarzeń per węzeł do GUI. Kolekcje Postmana mogą wołać `pm.setNextRequest(name)`, co w grafie konkuruje z kablami.

## Decyzja
- **Format pliku = podzbiór typów `Node`/`Edge` z `@xyflow/react`**: `{ id, type, position, data }` i `{ id, source, sourceHandle, target }`. GUI podaje tablice wprost do `<ReactFlow>`, bez warstwy konwersji. Pola specyficzne dla nas żyją tylko w `data` (`collectionId`, `requestId`, `continueWhen`).
- **Silnik to czysta funkcja `runFlow()` w `server/core/flow.ts`**: bez I/O, bez `postMessage`, bez zapisu plików. Dostaje flow, kolekcje, scopes, `send` i hooki (`onNodeStart`, `onNodeEnd`, `signal`). Rola `run` w workerze podpina pod hooki diff zmiennych i postęp do głównego wątku. Rola `load` (etap 3) podpina statystyki i nic nie zapisuje.
- **`pm.setNextRequest` jest w grafie ignorowane**. Przebieg wyznaczają tylko kable. Engine dopisuje do konsoli węzła ostrzeżenie `pm.setNextRequest() is ignored in flows; connect the OK/Fail pins instead.` Mapowanie po nazwie odrzucone, bo ten sam request może być kilkoma węzłami (nazwa nie wskazuje węzła jednoznacznie), a skok poza kablami ukryłby przebieg widoczny na płótnie.

## Konsekwencje
- Major update `@xyflow/react`, który zmieni kształt `Node`/`Edge`, wymaga migracji plików. Ryzyko jest małe: pola `id/type/position/data/source/target/sourceHandle` są stabilne od v10.
- Silnik da się testować bez workera i bez Fastify, wywołując `runFlow` bezpośrednio przeciw `test/mockServer.ts`.
- Flow zaimportowany z logiką opartą o `setNextRequest` trzeba odtworzyć kablami. Ostrzeżenie w konsoli pokazuje, gdzie.
- Ewentualne przyszłe wsparcie `setNextRequest` sprowadza się do jednej zmiany w `runFlow` (wybór następnego węzła), bez zmiany formatu pliku.
