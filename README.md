# Waze metadata collector (Chrome rozšírenie)

MV3 rozšírenie obnovuje Waze Live Map podľa intervalu, zbiera cookies / session metadata a voliteľne ich **POST**-ne na ingest endpoint Next.js aplikácie. Server zápis spracuje v [`src/app/api/waze-metadata-ingest`](../src/app/api/waze-metadata-ingest/route.ts) a ukladá JSON napr. do `var/waze-metadata.json`.

## Inštalácia (vývoj)

1. Otvor `chrome://extensions` → **Režim pre vývojárov** → **Načítať rozbalené** → vyber priečinok `waze-metadata-extension`.
2. Otvor **Možnosti** rozšírenia (pravý klik na ikonu alebo odkaz z karty rozšírenia).
3. Vyplň **Ingest URL** a **Ingest token**, ulož. Host ingestu musí byť v `host_permissions` v `manifest.json` (predvolene je tam `waze-assistance.site`); pre lokálny vývoj pridaj napr. `http://localhost:3000/*` a znova načítať rozbalené rozšírenie.

## Ingest URL (príklady)

| Prostredie | URL |
|------------|-----|
| Produkcia | `https://waze-assistance.site/api/waze-metadata-ingest` |
| Lokálne (Next, port 3000) | `http://localhost:3000/api/waze-metadata-ingest` |

## Autentifikácia (Bearer)

Ak je na serveri nastavený `WAZE_METADATA_INGEST_SECRET`, request musí mať hlavičku:

```http
Authorization: Bearer <rovnaká hodnota ako WAZE_METADATA_INGEST_SECRET>
```

Do poľa **Ingest token** v možnostiach zadaj tú istú hodnotu (bez predpony `Bearer `). Rozšírenie ju posiela ako `Authorization: Bearer …`.

Pozri [`env.example`](./env.example) ako šablónu — **neskladaj skutočné tajomstvá do Gitu**.

## Ďalšie polia v Možnostiach

- **Live Map URL** — napr. `https://www.waze.com/sk/live-map/` (lokalizovaná doména je v poriadku).
- **Georss overenie** — testovacia URL pre kontrolu dostupnosti API (voliteľné).
- **Interval obnovy** — v minútach.
- **Po načítaní počkať (ms)** — oneskorenie pred zberom cookies po reload-e.

## Ladenie

- **Service worker:** `chrome://extensions` → toto rozšírenie → **Service worker** → Inspect.
- **Stránka Waze:** DevTools na karte Live Map — logy zo skriptu vloženého do stránky.

## Súvisiaci backend

V Next aplikácii nastav napr. `WAZE_METADATA_INGEST_SECRET` (zhodný s **Ingest token** v rozšírení), voliteľne `WAZE_METADATA_GEORSS_ALERT_WEBHOOK_URL` a ďalšie — pozri `docker-compose.yml` / `docker-compose.dev.yml` a lokálny `.env` (ten do Gitu nepatrí).
