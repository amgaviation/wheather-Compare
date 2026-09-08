-- WX Compare data schema for Supabase Postgres.
--
-- Tables live in the `public` schema (the schema Supabase's Data API exposes by default),
-- prefixed `wxc_` so they don't collide with anything else in a shared project. Access goes
-- through PostgREST over HTTPS using the project's anon key — not a direct Postgres
-- connection — because that also works from short-lived serverless functions (Vercel) without
-- exhausting Postgres' connection limit, and it is what server/src/db/index.ts expects
-- (SUPABASE_URL + SUPABASE_ANON_KEY). Run this once against a fresh Supabase project (SQL
-- Editor, or `supabase db execute -f supabase/schema.sql`) before pointing the app at it.
--
-- RLS is enabled with a permissive anon policy: this data has no per-user auth model (no PII,
-- everything is derived from free public aviation-weather sources), and the anon key is used
-- only server-side by this app — it is never sent to a browser. If you deploy against a
-- Supabase project that also serves a different, sensitive application, keep these tables in
-- their own project or verify no other RLS policy inadvertently widens access to them.

CREATE TABLE IF NOT EXISTS public.wxc_stations (
  icao TEXT PRIMARY KEY,
  name TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  elev_ft INTEGER,
  state TEXT,
  country TEXT,
  tz TEXT,
  iata TEXT,
  faa TEXT,
  has_taf INTEGER DEFAULT 1,
  nws_office TEXT,
  nws_grid_id TEXT,
  nws_grid_x INTEGER,
  nws_grid_y INTEGER,
  nws_radar TEXT,
  added_at BIGINT NOT NULL,
  backfill_days INTEGER,
  backfill_status TEXT DEFAULT 'pending',
  backfill_message TEXT,
  backfill_done_at BIGINT,
  enabled INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS public.wxc_metars (
  id BIGSERIAL PRIMARY KEY,
  station TEXT NOT NULL,
  obs_time BIGINT NOT NULL,
  hour_time BIGINT NOT NULL,
  type TEXT NOT NULL,
  raw TEXT NOT NULL,
  ceiling_ft INTEGER,
  vis_sm DOUBLE PRECISION,
  category TEXT,
  wind_dir INTEGER,
  wind_var INTEGER DEFAULT 0,
  wind_spd INTEGER,
  wind_gust INTEGER,
  temp_c DOUBLE PRECISION,
  dewp_c DOUBLE PRECISION,
  altim_inhg DOUBLE PRECISION,
  slp_hpa DOUBLE PRECISION,
  wx TEXT,
  clouds TEXT,
  decoded TEXT NOT NULL,
  source TEXT NOT NULL,
  UNIQUE(station, obs_time, raw)
);
CREATE INDEX IF NOT EXISTS idx_wxc_metars_station_time ON public.wxc_metars(station, obs_time);
CREATE INDEX IF NOT EXISTS idx_wxc_metars_station_hour ON public.wxc_metars(station, hour_time);

CREATE TABLE IF NOT EXISTS public.wxc_tafs (
  id BIGSERIAL PRIMARY KEY,
  station TEXT NOT NULL,
  issued BIGINT NOT NULL,
  valid_from BIGINT NOT NULL,
  valid_to BIGINT NOT NULL,
  amended INTEGER DEFAULT 0,
  raw TEXT NOT NULL,
  decoded TEXT NOT NULL,
  hours TEXT NOT NULL,
  source TEXT NOT NULL,
  UNIQUE(station, issued, raw)
);
CREATE INDEX IF NOT EXISTS idx_wxc_tafs_station_issued ON public.wxc_tafs(station, issued);

CREATE TABLE IF NOT EXISTS public.wxc_taf_verification (
  id BIGSERIAL PRIMARY KEY,
  station TEXT NOT NULL,
  metar_id BIGINT NOT NULL,
  taf_id BIGINT NOT NULL,
  obs_time BIGINT NOT NULL,
  hour_time BIGINT NOT NULL,
  taf_issued BIGINT NOT NULL,
  lead_hours DOUBLE PRECISION NOT NULL,
  operative INTEGER NOT NULL,
  hour_utc INTEGER NOT NULL,
  fcst_cat TEXT,
  obs_cat TEXT,
  worst_cat TEXT,
  cat_hit INTEGER,
  cat_err INTEGER,
  tempo_covered INTEGER,
  fcst_ceiling INTEGER,
  obs_ceiling INTEGER,
  fcst_vis DOUBLE PRECISION,
  obs_vis DOUBLE PRECISION,
  fcst_wdir INTEGER,
  obs_wdir INTEGER,
  fcst_wspd INTEGER,
  obs_wspd INTEGER,
  fcst_gust INTEGER,
  obs_gust INTEGER,
  fcst_wx TEXT,
  obs_wx TEXT,
  ceiling_err INTEGER,
  ceiling_log_err DOUBLE PRECISION,
  vis_err DOUBLE PRECISION,
  wdir_err INTEGER,
  wspd_err INTEGER,
  UNIQUE(metar_id, taf_id)
);
CREATE INDEX IF NOT EXISTS idx_wxc_tv_station_time ON public.wxc_taf_verification(station, hour_time);
CREATE INDEX IF NOT EXISTS idx_wxc_tv_station_lead ON public.wxc_taf_verification(station, lead_hours);

CREATE TABLE IF NOT EXISTS public.wxc_nws_hourly (
  station TEXT NOT NULL,
  issued BIGINT NOT NULL,
  valid_time BIGINT NOT NULL,
  fetched_at BIGINT NOT NULL,
  temp_c DOUBLE PRECISION,
  dewp_c DOUBLE PRECISION,
  rh INTEGER,
  wind_dir INTEGER,
  wind_spd INTEGER,
  wind_gust INTEGER,
  sky_pct INTEGER,
  pop INTEGER,
  ceiling_ft INTEGER,
  vis_sm DOUBLE PRECISION,
  wx TEXT,
  qpf_mm DOUBLE PRECISION,
  short_forecast TEXT,
  prob_thunder INTEGER,
  PRIMARY KEY(station, issued, valid_time)
);

CREATE TABLE IF NOT EXISTS public.wxc_model_hourly (
  station TEXT NOT NULL,
  model TEXT NOT NULL,
  run_time BIGINT NOT NULL,
  lead_days INTEGER NOT NULL,
  valid_time BIGINT NOT NULL,
  fetched_at BIGINT NOT NULL,
  temp_c DOUBLE PRECISION,
  dewp_c DOUBLE PRECISION,
  wind_dir INTEGER,
  wind_spd DOUBLE PRECISION,
  wind_gust DOUBLE PRECISION,
  cloud_pct INTEGER,
  cloud_low_pct INTEGER,
  cloud_mid_pct INTEGER,
  vis_m DOUBLE PRECISION,
  precip_mm DOUBLE PRECISION,
  pop INTEGER,
  wx_code INTEGER,
  cape DOUBLE PRECISION,
  pressure_hpa DOUBLE PRECISION,
  boundary_layer_m DOUBLE PRECISION,
  PRIMARY KEY(station, model, lead_days, valid_time)
);
CREATE INDEX IF NOT EXISTS idx_wxc_model_station_valid ON public.wxc_model_hourly(station, valid_time);

CREATE TABLE IF NOT EXISTS public.wxc_ingest_log (
  id BIGSERIAL PRIMARY KEY,
  at BIGINT NOT NULL,
  source TEXT NOT NULL,
  station TEXT,
  ok INTEGER NOT NULL,
  message TEXT,
  count INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wxc_ingest_at ON public.wxc_ingest_log(at);

CREATE TABLE IF NOT EXISTS public.wxc_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

ALTER TABLE public.wxc_stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wxc_metars ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wxc_tafs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wxc_taf_verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wxc_nws_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wxc_model_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wxc_ingest_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wxc_settings ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['wxc_stations','wxc_metars','wxc_tafs','wxc_taf_verification','wxc_nws_hourly','wxc_model_hourly','wxc_ingest_log','wxc_settings'])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS wxc_anon_all ON public.%I', t);
    EXECUTE format('CREATE POLICY wxc_anon_all ON public.%I FOR ALL TO anon USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO anon', t);
  END LOOP;
END $$;

GRANT USAGE, SELECT ON SEQUENCE public.wxc_metars_id_seq TO anon;
GRANT USAGE, SELECT ON SEQUENCE public.wxc_tafs_id_seq TO anon;
GRANT USAGE, SELECT ON SEQUENCE public.wxc_taf_verification_id_seq TO anon;
GRANT USAGE, SELECT ON SEQUENCE public.wxc_ingest_log_id_seq TO anon;
GRANT USAGE ON SCHEMA public TO anon;

NOTIFY pgrst, 'reload schema';
