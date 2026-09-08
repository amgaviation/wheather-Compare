# WX Compare — aviation forecast verification & outlook

Self-hosted web app that continuously records aviation weather **forecasts** (TAF, NWS gridpoint forecast, multi-model NWP guidance) and **actual observations** (METAR/SPECI) for the airports you care about, scores every forecast hour against what really happened, and uses that station-specific track record to produce a calibrated, probabilistic **flight-category outlook for the next several days** — with the reasons behind it.

Only free, public data sources are used. No API keys.

## What it does

**Now & TAF** — fully decoded current METAR (wind, RVR, sky, precise temps, pressure tendency, peak wind, variable ceiling/vis, lightning, sensor flags, remarks), the current TAF decoded group-by-group and expanded into a 30-hour strip of prevailing plus TEMPO/PROB/BECMG alternates, a forecast-vs-actual timeline (ceiling, visibility, wind, category rows for observed / TAF prevailing / TAF worst case, NWS grid overlay), and an hour-by-hour scorecard for the last 24 h.

**Outlook (next 3–7 days)** — hourly probabilities of VFR / MVFR / IFR / LIFR, expected and pessimistic ceiling/visibility, wind (bias-adjusted), temperature/dew-point spread, PoP and thunder probability, day cards with windows of concern and the probability of any IFR period, an insights list and an observed-trend panel (3-h/6-h pressure change, spread trend, ceiling trend, wind shift, TAF-to-TAF drift, model agreement). Click any hour to see exactly what each source said, its calibrated probability, its measured skill and its weight in the blend.

**Forecast vs Actual** — verification statistics over 30–365 days: hit rate, TEMPO/PROB credit, optimistic/pessimistic bias, POD / FAR / CSI / HSS / PSS / frequency bias contingency tables for IFR-, MVFR- and LIFR-or-worse, 4×4 confusion matrix, calibration tables by lead time ("when the TAF says IFR at 12–18 h, what happened"), diurnal behaviour (hit rate and IFR under/over-forecasting by hour), error histograms (ceiling, visibility, wind speed/direction), present-weather POD/FAR (rain, snow, TS, fog/mist, freezing, haze), amendment statistics, the biggest busts with raw METAR/TAF, NWS gridpoint forecast verification by lead day, NWP model verification by model and lead day, and station climatology.

**Hazards & Winds** — map of current SIGMETs, convective SIGMETs, G-AIRMETs (Sierra/Tango/Zulu), CWAs and PIREPs around the station, tables of products affecting the airport, NWS alerts, and decoded winds/temperatures aloft (FB) for the nearest FB stations at 06/12/24 h.

**Stations & Data** — add/remove airports (ICAO), backfill history, source status, ingest log, and a METAR/TAF decoder.

## Data sources (all free and public)

| Source | Used for |
|---|---|
| [aviationweather.gov Data API](https://aviationweather.gov/data/api/) (NOAA/NWS Aviation Weather Center) | METAR/SPECI, TAF, PIREP, SIGMET/AIRMET, G-AIRMET, CWA, winds/temps aloft (FB), station table |
| [NWS API](https://www.weather.gov/documentation/services-web-api) (api.weather.gov) | Gridpoint hourly forecast; raw grid ceiling, visibility, sky cover, PoP, thunder probability, weather; active alerts |
| [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/) (Iowa State University) | Archived METARs and TAFs to backfill months of history on day one |
| [Open-Meteo](https://open-meteo.com/) (CC-BY 4.0) | Hourly guidance from NOAA GFS/HRRR, ECMWF IFS and DWD ICON, plus previous model runs for instant model verification. Not an aviation product; used as supplementary guidance and can be disabled (`USE_OPEN_METEO=false`). |

The NWS asks API users to send a descriptive `User-Agent` with contact information — set `WX_USER_AGENT`.

## How the verification works

* Each routine hourly observation (the METAR closest to the top of the hour; SPECIs only when no METAR exists) is scored against **every TAF that covered that hour and was issued before the observation**, giving a spread of lead times (0–30 h). The most recently issued of those is flagged *operative* — the TAF that was actually in force.
* The TAF is expanded hour by hour: FM groups replace everything; BECMG becomes prevailing at the end of its window (listed as an alternate during it); TEMPO, PROB30, PROB40 and PROB TEMPO are alternates with assumed likelihoods (50 %, 30 %, 40 %, 15–20 %).
* Category verification uses the FAA/AWC thresholds (LIFR < 500 ft / < 1 SM; IFR < 1,000 ft / < 3 SM; MVFR ≤ 3,000 ft / ≤ 5 SM). "Covered" means the observation fell between the prevailing and worst alternate category.
* Ceiling errors treat "no ceiling" as 12,000 ft; visibility is capped at 6 SM on both sides because TAFs stop at P6SM. Wind direction is scored only when both winds are ≥ 4 kt and not variable.
* NWS gridpoint and model forecasts are verified on temperature, dew point, wind, sky cover and a ceiling/visibility category (grid) or a category proxy (models: low cloud cover, dew-point depression, visibility, weather code).

## How the outlook works

For every hour out to the chosen horizon the engine collects: the TAF hour (within its validity), the NWS gridpoint hour, each model's hour, station climatology for that month and hour of day, and persistence of the current observation. Each categorical source is converted into P(observed category | forecast category) using the station's own verification history at that lead time (Laplace-smoothed), TEMPO/PROB alternates are mixed in by their assumed likelihood, and the distributions are blended with weights proportional to each source's measured hit rate (with defaults when history is thin), decaying persistence, and a climatology weight that grows with lead time. Deterministic elements come from the TAF first, then NWS, then the model mean; TAF wind speed is bias-corrected from history; NWS temperature is bias-corrected by lead day. Flags (fog set-up, model disagreement, LLWS, convection, gusts) and the insight text are rule-based on the same data.

It is a statistical aid, not an official forecast.

## Data store

The app is stateless application code in front of a Postgres database reached over
[Supabase](https://supabase.com)'s PostgREST HTTPS API — not a direct Postgres connection.
That is what lets the same code run either as one long-lived Node process (Docker, a VPS, a
laptop) or as short-lived Vercel serverless functions, without a connection pool to exhaust
across many concurrent Lambda instances.

1. Create a Supabase project (or reuse one — tables are prefixed `wxc_` and RLS-scoped so they
   won't collide with anything else already in it).
2. Run `supabase/schema.sql` against it once (Supabase Studio → SQL Editor, or
   `psql "$DATABASE_URL" -f supabase/schema.sql`).
3. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Project Settings → API) wherever the app runs.
   This key is a server-side secret in this app — the anon-role RLS policy grants it full
   access to the `wxc_*` tables, and it must never reach a browser. The frontend only ever
   talks to this app's own API, never to Supabase directly.

## Deploy to Vercel

```bash
vercel link          # or: vercel deploy for a one-off
vercel env add SUPABASE_URL
vercel env add SUPABASE_ANON_KEY
vercel env add CRON_SECRET        # any random string; gates api/cron/*
vercel deploy --prod
```

`vercel.json` builds the web app as the static output and the API as one catch-all serverless
function (`api/[...path].ts`, reusing the same Fastify app as the standalone server). Four
`api/cron/*.ts` endpoints replace the standalone server's `setInterval` scheduler — Vercel Cron
calls them on the schedules in `vercel.json` (METARs every 5 min, TAFs every 10 min, NWS
hourly, models every 3 h) — and are protected by `CRON_SECRET`: Vercel automatically sends it
as a bearer token when it invokes a Cron Job itself, once that env var is set on the project.

Unlike the standalone server, nothing auto-registers `DEFAULT_STATIONS` on a cold start (that
would re-trigger on every new Lambda instance). After the first deploy, add each airport once
from the Stations & Data page — its backfill runs via `waitUntil`, so the request returns
immediately while history keeps loading in the background.

## Run it standalone (Docker, VPS, local dev)

Requirements: Node 22+, plus a Supabase project as above.

```bash
npm install
SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run dev   # API on :8787, Vite UI on :5173 (proxies /api)
```

Production build and run (UI served by the API server):

```bash
npm run build
SUPABASE_URL=... SUPABASE_ANON_KEY=... DEFAULT_STATIONS=KTEB,KHPN BACKFILL_DAYS=120 npm start
# open http://localhost:8787
```

Docker:

```bash
docker compose up --build   # set SUPABASE_URL / SUPABASE_ANON_KEY in docker-compose.yml first
```

Environment variables: `PORT` (8787), `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DEFAULT_STATIONS`
(added on first boot — standalone mode only), `BACKFILL_DAYS` (120), `USE_OPEN_METEO` (true),
`WX_USER_AGENT`, `CRON_SECRET` (Vercel only).

On first boot (standalone mode) the default stations are registered and backfilled (about
15–30 s per station for 120 days). Live polling: METARs every 5 min, TAFs every 10 min, NWS
hourly, models every 3 h — via an in-process scheduler standalone, via Vercel Cron on Vercel.
NWS and model verification statistics accrue from the moment a station is added (model
"previous run" data gives an immediate 7-day baseline).

## Tests

```bash
npm test
```

Covers the METAR/TAF decoders (including TEMPO/BECMG/PROB expansion, month rollover, ICAO-format reports), flight-category thresholds, winds-aloft decoding, geometry and sunrise/sunset.

## API

`GET /api/stations` · `POST /api/stations {icao, days?}` · `DELETE /api/stations/:icao` · `POST /api/stations/:icao/backfill {days?}` · `GET /api/stations/:icao/current` · `GET /api/stations/:icao/history?hours=48` · `GET /api/stations/:icao/verification?days=90` · `GET /api/stations/:icao/outlook?hours=120` · `GET /api/stations/:icao/hazards?radius=200` · `GET /api/hazards` · `GET /api/stations/:icao/winds-aloft` · `POST /api/decode {text}` · `POST /api/refresh` · `GET /api/status`
