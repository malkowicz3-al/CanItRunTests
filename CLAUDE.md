# CanItRunTests

## Cel projektu
Lokalne narzędzie (zamiennik Postmana) do testów integracyjnych i wydajnościowych mikroserwisów: import kolekcji/env Postmana i Swaggera, skrypty `pm.*` (podpisy JWS), flow, testy obciążeniowe z raportem. Pełna specyfikacja: [docs/SPEC.md](docs/SPEC.md).

## Stack
TypeScript monorepo. Backend Fastify (REST + WebSocket), frontend React + Vite + Mantine + Monaco + Recharts. Dane jako pliki JSON w `DATA_DIR` (domyślnie `~/.canitruntests`).

## Twarde ograniczenia
- Użytkownik uruchamia z **zipa repo** na Node 22+ (dowolna 22.x), **bez `npm install`**: zbudowany `dist/` jest commitowany, zero natywnych zależności, `start.bat` / `start.sh`.
- Nie używać `node:sqlite` ani modułów natywnych.
- W repo nigdy żadnych sekretów, certyfikatów ani eksportów użytkownika (`samples/` jest ignorowane).
- Windows to priorytet, Linux (Rocky) też musi działać.

## Komendy
- Instalacja (dev): `npm ci`
- Dev: `npm run dev:server` (esbuild watch + `node --watch dist/server.cjs`, :3000) i `npm run dev:web` (Vite, proxy `/api` i `/ws` na :3000)
- Testy: `npm test` (Vitest bez smoke testu), `npm run typecheck`, `npm run test:dist` (smoke test zbudowanego `dist/`, wymaga wcześniejszego builda)
- Build bundla do `dist/`: `npm run build` (esbuild -> `dist/server.cjs`, `dist/worker.cjs`; Vite -> `dist/public`)
- Uruchomienie z `dist/`: `node dist/server.cjs` albo `start.bat` / `sh start.sh` (env: `PORT`, `HOST`, `DATA_DIR`)

## Zasady
- Odpowiadaj po polsku; kod, GUI i commity po angielsku.
- Po każdej zmianie kodu uruchom testy.
- Przed commitem przebuduj `dist/`.
