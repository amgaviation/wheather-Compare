import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export type DB = Database.Database;

let db: DB | null = null;

export function getDb(): DB {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = path.join(config.dataDir, 'wx.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function openMemoryDb(): DB {
  const m = new Database(':memory:');
  migrate(m);
  return m;
}

function migrate(d: DB) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS stations (
    icao TEXT PRIMARY KEY,
    name TEXT,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
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
    added_at INTEGER NOT NULL,
    backfill_days INTEGER,
    backfill_status TEXT DEFAULT 'pending',
    backfill_message TEXT,
    backfill_done_at INTEGER,
    enabled INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS metars (
    id INTEGER PRIMARY KEY,
    station TEXT NOT NULL,
    obs_time INTEGER NOT NULL,
    hour_time INTEGER NOT NULL,
    type TEXT NOT NULL,
    raw TEXT NOT NULL,
    ceiling_ft INTEGER,
    vis_sm REAL,
    category TEXT,
    wind_dir INTEGER,
    wind_var INTEGER DEFAULT 0,
    wind_spd INTEGER,
    wind_gust INTEGER,
    temp_c REAL,
    dewp_c REAL,
    altim_inhg REAL,
    slp_hpa REAL,
    wx TEXT,
    clouds TEXT,
    decoded TEXT NOT NULL,
    source TEXT NOT NULL,
    UNIQUE(station, obs_time, raw)
  );
  CREATE INDEX IF NOT EXISTS idx_metars_station_time ON metars(station, obs_time);
  CREATE INDEX IF NOT EXISTS idx_metars_station_hour ON metars(station, hour_time);

  CREATE TABLE IF NOT EXISTS tafs (
    id INTEGER PRIMARY KEY,
    station TEXT NOT NULL,
    issued INTEGER NOT NULL,
    valid_from INTEGER NOT NULL,
    valid_to INTEGER NOT NULL,
    amended INTEGER DEFAULT 0,
    raw TEXT NOT NULL,
    decoded TEXT NOT NULL,
    hours TEXT NOT NULL,
    source TEXT NOT NULL,
    UNIQUE(station, issued, raw)
  );
  CREATE INDEX IF NOT EXISTS idx_tafs_station_issued ON tafs(station, issued);

  CREATE TABLE IF NOT EXISTS taf_verification (
    id INTEGER PRIMARY KEY,
    station TEXT NOT NULL,
    metar_id INTEGER NOT NULL,
    taf_id INTEGER NOT NULL,
    obs_time INTEGER NOT NULL,
    hour_time INTEGER NOT NULL,
    taf_issued INTEGER NOT NULL,
    lead_hours REAL NOT NULL,
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
    fcst_vis REAL,
    obs_vis REAL,
    fcst_wdir INTEGER,
    obs_wdir INTEGER,
    fcst_wspd INTEGER,
    obs_wspd INTEGER,
    fcst_gust INTEGER,
    obs_gust INTEGER,
    fcst_wx TEXT,
    obs_wx TEXT,
    ceiling_err INTEGER,
    ceiling_log_err REAL,
    vis_err REAL,
    wdir_err INTEGER,
    wspd_err INTEGER,
    UNIQUE(metar_id, taf_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tv_station_time ON taf_verification(station, hour_time);
  CREATE INDEX IF NOT EXISTS idx_tv_station_lead ON taf_verification(station, lead_hours);

  CREATE TABLE IF NOT EXISTS nws_hourly (
    station TEXT NOT NULL,
    issued INTEGER NOT NULL,
    valid_time INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    temp_c REAL,
    dewp_c REAL,
    rh INTEGER,
    wind_dir INTEGER,
    wind_spd INTEGER,
    wind_gust INTEGER,
    sky_pct INTEGER,
    pop INTEGER,
    ceiling_ft INTEGER,
    vis_sm REAL,
    wx TEXT,
    qpf_mm REAL,
    short_forecast TEXT,
    prob_thunder INTEGER,
    PRIMARY KEY(station, issued, valid_time)
  );

  CREATE TABLE IF NOT EXISTS model_hourly (
    station TEXT NOT NULL,
    model TEXT NOT NULL,
    run_time INTEGER NOT NULL,
    lead_days INTEGER NOT NULL,
    valid_time INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    temp_c REAL,
    dewp_c REAL,
    wind_dir INTEGER,
    wind_spd REAL,
    wind_gust REAL,
    cloud_pct INTEGER,
    cloud_low_pct INTEGER,
    cloud_mid_pct INTEGER,
    vis_m REAL,
    precip_mm REAL,
    pop INTEGER,
    wx_code INTEGER,
    cape REAL,
    pressure_hpa REAL,
    boundary_layer_m REAL,
    PRIMARY KEY(station, model, lead_days, valid_time)
  );
  CREATE INDEX IF NOT EXISTS idx_model_station_valid ON model_hourly(station, valid_time);

  CREATE TABLE IF NOT EXISTS ingest_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    source TEXT NOT NULL,
    station TEXT,
    ok INTEGER NOT NULL,
    message TEXT,
    count INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ingest_at ON ingest_log(at);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  `);
}
