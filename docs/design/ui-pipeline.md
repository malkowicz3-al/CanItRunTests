# UI redesign: Pipeline (2026-11-22)

Cel: GUI ma **w niczym nie przypominać Postmana**. Zero drzewa kolekcji po lewej, zero pomarańczu, zero rzędu zakładek Params/Auth/Headers/Body nad edytorem, zero układu „request na górze, response na dole”. Wybrany kierunek: **Pipeline** — metafora toru kolejowego / nastawni: requesty to stacje na torze, wynik to sygnał.

## Aktualizacja 2026-11-22: dwa ekrany robocze
Użytkownik chce **oba** układy:
- **Requests** (nowy, domyślny ekran): klasyczny warsztat do pojedynczych strzałów, układem jak wcześniejsza wersja (drzewo kolekcji z lewej, edytor requestu z zakładkami u góry, odpowiedź na dole z przeciąganym podziałem), ale w obecnej stylistyce: tokeny kolorów i fonty z tego dokumentu, glif metody zamiast kolorowych etykiet, brak pomarańczu.
- **Flows** (dotychczasowy „Track”): tor ze stacjami, do budowania i uruchamiania flow.
- Pasek ikon: Requests, Flows, Library, Environments, Load tests (wyłączone, etap 3).
- Z ekranu Requests: przycisk „Add to flow” dodaje bieżący request jako stację na koniec toru; w drzewie menu kontekstowe też ma „Add to flow”.
- Edytor i widok odpowiedzi są współdzielone z inspektorem Flows (te same komponenty pól i `LastResult`), różni się tylko układ: zakładki w Requests, zwijane sekcje w inspektorze.

## Koncepcja
- Głównym widokiem jest **tor** (track): pozioma linia ze stacjami. Pojedynczy strzał to tor z jedną stacją. Wiele stacji = flow (ad-hoc teraz, zapisywane i warunkowe w etapie 2).
- **Biblioteka** (zaimportowane kolekcje) to dok pod torem: endpointy jako „bilety” pogrupowane po kolekcji/folderze, z wyszukiwarką. Kliknięcie „+” albo przeciągnięcie dodaje stację na koniec toru.
- **Inspektor** stacji wysuwa się z prawej po kliknięciu stacji: edycja requestu w pionowych sekcjach (nie zakładkach), raport ostatniego wyniku stacji.
- Lewy **pasek ikon** (rail): Track, Library (pełny ekran biblioteki + import), Environments, Load tests (etap 3, na razie wyłączone z podpowiedzią „Stage 3”).

```
┌──┬─────────────────────────────────────────────────────────┐
│◉ │ Scratch track ✎            [env: Free APIs ▾]  [Run ▶]   │  top bar
│▤ ├─────────────────────────────────────────────────┬───────┤
│⚙ │                                                 │Inspec-│
│⚡│   ●━━━━━━━━━●━━━━━━━━━●━━━━━━━━━○                │tor    │
│  │  POST       POST      GET       PATCH           │(slide │
│  │  Create     Create    Get       Update          │ in)   │
│  │  token      booking   booking   booking         │       │
│  │  200 · 84ms 200       200       —               │       │
│  │                                                 │       │
│  ├─────────────────────────────────────────────────┤       │
│  │ Library  [search…]                    [Import]  │       │
│  │ Free APIs demo › Restful-Booker                 │       │
│  │  [POST Create token +] [GET Get booking +] …    │       │
└──┴─────────────────────────────────────────────────┴───────┘
```

## Tokeny

### Kolor (ciemny motyw jest domyślny; jasny to „papier nastawni”)
| nazwa | dark | light | rola |
|---|---|---|---|
| `ink` | `#0E1923` | `#EEF2F5` | tło aplikacji (granatowy łupek, nie neutralna czerń) |
| `panel` | `#15232F` | `#FFFFFF` | dok, inspektor, top bar |
| `rail` | `#2C4558` | `#B9C7D3` | linia toru, obramowania, separatory |
| `cobalt` | `#4F7CFF` | `#2F5BE0` | akcja główna (Run, zaznaczona stacja, focus) |
| `go` | `#36D399` | `#12925F` | sygnał: sukces / test zaliczony |
| `stop` | `#FF6363` | `#D33A3A` | sygnał: błąd / test oblany / status poza warunkiem |
| `caution` | `#F4C04E` | `#B7860B` | sygnał: w toku / ostrzeżenie / 3xx |

Kolory metod **nie** są kolorowymi etykietami jak w Postmanie: metoda to mały, monochromatyczny glif w kolorze `rail`/tekstu, z wagą (GET regular, mutujące — POST/PUT/PATCH/DELETE — semibold). Kolor w UI niesie tylko **stan** (go/stop/caution) i akcję (cobalt).

### Typografia (fonty lokalnie, bez Google Fonts — komputer firmowy może być offline)
- **IBM Plex Sans** (400/500/600) — cały interfejs. Techniczny, „inżynierski” charakter pasuje do nastawni.
- **JetBrains Mono** (400/500) — tylko tam, gdzie treść jest kodem: URL, nagłówki, body, skrypty, wartości zmiennych. Nie dla etykiet.
- Paczki: `@fontsource/ibm-plex-sans`, `@fontsource/jetbrains-mono` (bundlowane przez Vite do `dist/public`).
- Skala: 12 / 13 (bazowy UI) / 15 / 20 / 28. Nazwy stacji 13/500, nazwa toru w top barze 20/600. Sentence case wszędzie, bez ALL CAPS, bez etykiet-„eyebrow” nad sekcjami.

### Kształty i głębia
- Promienie z hierarchią: stacja = koło; „bilety” w bibliotece = 6 px; panele = 0 (przyklejone do krawędzi), pola formularzy = 4 px.
- Bez cieni pod kartami. Głębia przez kolor tła (`ink` → `panel`) i 1 px linie `rail`.

## Tor (element sygnaturowy — tu idzie cała odwaga)
- SVG: gruba linia `rail` (3 px), stacje jako koła 18 px na linii, odstęp stałe 160 px, tor przewija się poziomo gdy się nie mieści.
- Stan stacji = wypełnienie koła: puste (nie uruchomiona), `caution` pulsujące (w toku), `go` (2xx i wszystkie testy OK), `stop` (błąd sieci, status poza warunkiem, oblany test).
- Pod kołem: metoda (glif) + nazwa (max 2 linie), pod spodem status + czas ostatniego przebiegu i liczba testów (`3/3`).
- Odcinek toru między stacjami po przejściu też zmienia kolor na `go`/`stop` — widać, dokąd „pociąg” dojechał.
- **Jedyna animacja bez akcji użytkownika** nie istnieje. Jedyny ruch: podczas Run punkt sygnału jedzie po linii do aktualnej stacji (prefers-reduced-motion → bez jazdy, tylko zmiana kolorów).
- Stację można: kliknąć (otwiera inspektor), przeciągnąć w poziomie (zmiana kolejności), usunąć (ikona po najechaniu / klawisz Delete z fokusem), uruchomić pojedynczo (ikona ▶ przy stacji).
- Run uruchamia stacje po kolei przez istniejące `POST /api/run`. Opcja „Stop on failure” (domyślnie włączona) w top barze. To flow ad-hoc; zapisywanie flow i warunki statusu per stacja dochodzą w etapie 2 — UI ma już na to miejsce w inspektorze (sekcja „Continue when”, na razie wyszarzona z podpowiedzią).
- Stan toru (lista stacji) trzymany w localStorage (try/catch), żeby przeżył odświeżenie.

## Inspektor (prawy panel, ~460 px, wysuwany, zamykany Esc)
Pionowo, sekcje zwijane (nie zakładki):
1. Nagłówek: nazwa stacji (edytowalna), ścieżka „kolekcja › folder”, przyciski Save (Ctrl+S) i Run station (Ctrl+Enter).
2. **Request**: metoda (select) + URL (mono, z podświetleniem `{{zmiennych}}`; najechanie pokazuje rozwiązaną wartość z aktywnego env).
3. **Query & path**, **Headers**, **Body**, **Auth**, **Scripts** (pre / test w Monaco), **Settings** (follow redirects) — każda zwijana, w nagłówku sekcji licznik („Headers 3”).
4. **Last result** — raport stacji: duży status + czas + rozmiar; pasek czasów DNS/TCP/TLS/TTFB/transfer jako jedna pozioma linia podzielona na odcinki (ta sama estetyka co tor); testy z sygnałami go/stop; konsola; body (Monaco read-only); nagłówki odpowiedzi; „Sent request” (finalny request + łańcuch redirectów).

## Biblioteka
- Dok pod torem (wysokość ~35%, przeciągalna granica) i pełny widok z paska ikon.
- Grupy: nagłówek „Kolekcja › Folder”, pod nim bilety w rzędzie (flex-wrap): glif metody + nazwa + „+”. Wyszukiwarka filtruje po nazwie, URL i metodzie.
- Import: przycisk w nagłówku biblioteki (ten sam dialog drag & drop / plik / wklej JSON, kolejka 409 → Overwrite/Skip).
- Zarządzanie (nowa kolekcja, folder, request, rename, duplicate, delete, zmienne kolekcji) — menu kontekstowe na nagłówku grupy / bilecie, w pełnym widoku biblioteki.

## Environments
Pełny widok z paska ikon: lista environmentów jako wiersze po lewej (wąska kolumna), edytor zmiennych po prawej (tabela key/value, mono dla wartości, maskowanie secretów z odkryciem po kliknięciu, przełączniki ignoreTls / followRedirects / clientCert). Globals jako osobny wiersz na górze listy.

## Copy
- Puste stany: tor bez stacji → „Add an endpoint from the library to start a track.” Biblioteka pusta → „Import a Postman collection or environment.” + przycisk Import.
- Przyciski mówią, co robią: „Run track”, „Run station”, „Add to track”, „Import”, „Save request”.
- Błędy: konkretnie co i jak naprawić („Variable {{bookerUrl}} is not defined in Free APIs - public.”).

## Jakość
Pełna obsługa klawiaturą (stacje w kolejności tabulacji, strzałki ←/→ między stacjami), widoczny focus w `cobalt`, kontrast AA w obu motywach, `prefers-reduced-motion`, sensowny układ od 1024 px wzwyż (poniżej: inspektor jako pełnoekranowa nakładka).

## Przegląd planu względem domyślnych wzorców
- Zamieniono pomarańczowy primary (Postman) i kolorowe etykiety metod (Postman/Insomnia) na kolor wyłącznie stanowy + cobalt.
- Ciemne tło to granatowy łupek z trzema semantycznymi sygnałami, a nie czerń z jednym kwasowym akcentem.
- Mono tylko dla treści-kodu, nie dla etykiet.
- Brak kart z cieniami; jedyny „efektowny” element to tor.
