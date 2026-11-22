# 0002. Znormalizowany model wewnętrzny zamiast natywnego formatu Postmana

## Kontekst
Kolekcje pochodzą z Postmana v2.1 (etap 1) i ze Swaggera/OpenAPI (etap 4), są edytowane w GUI i wykonywane przez silnik. Format Postmana jest rozwlekły i wieloznaczny (url jako string lub obiekt, auth jako tablice key/value, skrypty jako tablice linii w `event[]`, brak auth = inherit). Eksport do Postmana jest poza MVP.

## Decyzja
Na dysku i w API trzymamy własny model z `shared/model.ts` (Collection/Folder/RequestItem/Auth/Body/Scripts/Variable/Environment). Importery (`postman.ts`, później `openapi.ts`) konwertują raz przy imporcie. `info._postman_id` zapisujemy jako `sourceId`, żeby wykrywać ponowny import.

## Konsekwencje
- GUI, executor i flow operują na jednym prostym kształcie; Swagger generuje ten sam model.
- Pola Postmana, których nie mapujemy (np. opisy, `protocolProfileBehavior`, pliki w form-data), giną przy imporcie — ponowny import jest jedyną drogą odzyskania.
- Ewentualny eksport do Postmana będzie wymagał osobnego konwertera w drugą stronę.
- Zmiana modelu po zebraniu danych użytkownika wymaga migracji plików w `DATA_DIR`.
