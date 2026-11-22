# 0001. Jeden pakiet npm, bundle esbuild (CJS) commitowany w dist/

## Kontekst
Użytkownik uruchamia aplikację z zipa repo na dowolnym Node 22.x bez `npm install` i bez modułów natywnych. Spec mówi „monorepo” (backend + frontend + wspólne typy).

## Decyzja
- Jeden `package.json` z katalogami `server/`, `web/`, `shared/` zamiast npm workspaces — „monorepo” w sensie jednego repo; workspaces nic tu nie dają, a komplikują build i skrypty.
- Serwer i worker bundlowane esbuildem do `dist/server.cjs` i `dist/worker.cjs` (format CJS, `target: node22.0`, wszystkie zależności w środku, `bufferutil`/`utf-8-validate` jako external). GUI budowane Vite do `dist/public` z lokalnym Monaco.
- `dist/` jest commitowany; `start.bat`/`start.sh` uruchamiają tylko `node dist/server.cjs`.

## Konsekwencje
- Zależność runtime jest dopuszczalna tylko, jeśli da się ją zbundlować do czystego JS (bez natywnych addonów, plików ładowanych z dysku, top-level await) — weryfikuje to `npm run test:dist`.
- Każdy commit zmieniający kod musi zawierać przebudowany `dist/`; historia gita rośnie o kilka MB na build.
- Rozbicie na workspaces później jest możliwe, ale wymaga przeniesienia konfiguracji buildu.
