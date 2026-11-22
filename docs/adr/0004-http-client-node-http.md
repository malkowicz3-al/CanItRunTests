# 0004. Klient HTTP na node:http/node:https zamiast fetch/undici

## Kontekst
GUI ma pokazywać rozbicie czasu DNS/TCP/TLS/TTFB/transfer, obsługiwać mTLS z PEM-ów w zmiennych i przełącznik ignorowania błędów TLS; silnik obciążenia potrzebuje keep-alive i klasyfikacji błędów (timeout, connection refused…). Globalny `fetch` (undici) nie udostępnia zdarzeń socketu bez `diagnostics_channel`, a samo undici jako zależność też nie daje gotowego rozbicia faz.

## Decyzja
`core/http.ts` używa `http.request`/`https.request` z Node. Fazy mierzymy ze zdarzeń `socket` (`lookup`, `connect`, `secureConnect`) oraz `response`/`end`. TLS przez opcje `rejectUnauthorized`, `cert`, `key`, `passphrase`, `ca`. Pojedynczy strzał bez keep-alive (pełne fazy), load z `Agent({ keepAlive: true })` per worker. Dekompresja przez `node:zlib`.

## Konsekwencje
- Zero zależności i pełna kontrola nad timingami oraz kodami błędów (`err.code`).
- Bez HTTP/2 (node:http to HTTP/1.1); dodanie HTTP/2 wymagałoby osobnej ścieżki `node:http2`.
- Ręcznie obsługujemy przekierowania (domyślnie: nie podążamy, jak przy wyłączonym follow — do ustalenia przy implementacji, jeśli eksporty tego wymagają), dekompresję i limity rozmiaru body.

## Aktualizacja: przekierowania (etap 1)
Zastępuje „domyślnie nie podążamy” z Konsekwencji. Zaimplementowane w `core/http.ts`:
- Domyślnie follow (jak Postman); `RequestItem.followRedirects` → `Environment.followRedirects` → `true` (rozstrzygane w `core/run.ts`). Przy wyłączonym follow zwracamy odpowiedź 3xx.
- Obsługiwane statusy 301/302/303/307/308 z nagłówkiem `Location` (względny URL liczony od bieżącego).
- 303 → GET bez body (poza HEAD); 301/302 → GET bez body tylko dla POST; 307/308 zachowują metodę i body. Przy zmianie na GET usuwamy `Content-Type`/`Content-Length`.
- Zmiana hosta (porównanie `host`, czyli razem z portem) usuwa `Authorization` i `Cookie`.
- Więcej niż 10 przekierowań → błąd `ERR_TOO_MANY_REDIRECTS`.
- `finalRequest` to ostatni wysłany request, `redirects` — cały łańcuch hopów (status, metoda, URL) do pokazania w GUI.
