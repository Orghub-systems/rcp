# RCP — multi-tenant MVP PWA

Jedna aplikacja RCP obsługująca wiele niezależnych firm w projekcie Supabase `RCP App` (`nouanhglqawrmvhlzrez`).

## Model multi-tenant

- `organizations` — firmy/podmioty,
- `organization_members` — przynależność użytkownika do firmy i rola `admin` / `employee`,
- jeden użytkownik Auth może należeć do wielu firm,
- ten sam e-mail może być dodany do wielu firm,
- użytkownik przełącza aktywną firmę w aplikacji,
- `ZACZYNAM / KOŃCZĘ` zawsze dostaje konkretny `member_id`, więc zapis nie może trafić przypadkiem do innej firmy,
- administrator działa tylko w aktualnie wybranej firmie,
- dane są izolowane przez RLS,
- właściciel platformy ma osobny panel `Firmy` i może tworzyć kolejne podmioty oraz wskazywać pierwszego administratora.

## Co działa

- logowanie e-mailem przez Supabase Auth (magic link),
- automatyczne podpinanie istniejącego konta Auth po dodaniu go do kolejnej firmy,
- wybór firmy, gdy użytkownik należy do kilku podmiotów,
- pracownik: `ZACZYNAM` / `KOŃCZĘ` przez RPC z czasem serwera,
- pracownik: czas dnia/miesiąca, zarobki, historia bez edycji,
- administrator firmy: dashboard, zespół, stawki, wpisy czasu i korekty,
- właściciel platformy: lista firm i tworzenie nowych firm,
- audyt zmian po stronie bazy,
- PWA: manifest + service worker + ikony.

## Hosting produkcyjny

Pliki statyczne są publikowane przez GitHub Pages pod adresem technicznym:

`https://orghub-systems.github.io/rcp/`

Adres użytkowy:

`https://rcp.orghub.pl`

Subdomena `rcp` jest zarezerwowana jako systemowa w Workerze ORG HUB i nie może zostać potraktowana jako `clubId`. Produkcyjny Worker przechwytuje `rcp.orghub.pl` przed logiką klubów i proxy'uje pliki z GitHub Pages. Repozytorium RCP nie używa pliku `CNAME`, aby uniknąć przekierowania GitHub Pages z adresu technicznego z powrotem na `rcp.orghub.pl`.

## Uruchomienie lokalne

Aplikacja musi być serwowana przez HTTP(S), nie `file://`.

```bash
python -m http.server 8080
```

Następnie otwórz `http://localhost:8080`.

## Auth redirect

W Supabase dodaj adres aplikacji do `Authentication > URL Configuration > Redirect URLs`.
Dla produkcji: `https://rcp.orghub.pl/**`.
Dla testu lokalnego: `http://localhost:8080/**`.

Frontend zawiera wyłącznie klucz `sb_publishable_...`. Sekret / `service_role` nie może trafić do plików publicznych.

## Następny etap

- Web Push dla administratorów,
- testy dwóch firm + użytkownika należącego do obu,
- raporty miesięczne / eksport XLSX i PDF,
- opcjonalnie abonamenty i limity per firma.
