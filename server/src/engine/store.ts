import type { DB } from '../db/index.js';
import { parseMetar } from '../wx/metar.js';
import { expandTaf, parseTaf } from '../wx/taf.js';
import type { Metar, Taf, TafHour } from '../wx/types.js';
import { visValue } from '../wx/flightcat.js';

const HOUR = 3600_000;

export function hourOf(t: number): number {
  return Math.round(t / HOUR) * HOUR;
}

export interface StationRow {
  icao: string;
  name: string | null;
  lat: number;
  lon: number;
  elev_ft: number | null;
  state: string | null;
  country: string | null;
  tz: string | null;
  iata: string | null;
  faa: string | null;
  has_taf: number;
  nws_office: string | null;
  nws_grid_id: string | null;
  nws_grid_x: number | null;
  nws_grid_y: number | null;
  nws_radar: string | null;
  added_at: number;
  backfill_days: number | null;
  backfill_status: string;
  backfill_message: string | null;
  backfill_done_at: number | null;
  enabled: number;
}

export function listStations(db: DB, enabledOnly = false): StationRow[] {
  return db.prepare(`SELECT * FROM stations ${enabledOnly ? 'WHERE enabled=1' : ''} ORDER BY icao`).all() as StationRow[];
}

export function getStation(db: DB, icao: string): StationRow | undefined {
  return db.prepare('SELECT * FROM stations WHERE icao=?').get(icao) as StationRow | undefined;
}

export function log(db: DB, source: string, station: string | null, ok: boolean, message: string, count?: number) {
  db.prepare('INSERT INTO ingest_log(at, source, station, ok, message, count) VALUES (?,?,?,?,?,?)').run(Date.now(), source, station, ok ? 1 : 0, message.slice(0, 500), count ?? null);
  if (Math.random() < 0.01) db.prepare('DELETE FROM ingest_log WHERE id < (SELECT MAX(id) FROM ingest_log) - 5000').run();
}

/** Insert a raw METAR; returns the decoded METAR and whether it was new. */
export function insertMetar(db: DB, station: string, raw: string, reference: Date, source: string, typeHint?: 'METAR' | 'SPECI'): { metar: Metar; inserted: boolean; id: number | null } {
  const m = parseMetar(raw, reference);
  if (typeHint && !/^(METAR|SPECI)\s/.test(raw)) m.type = typeHint;
  if (m.nil || !m.station) return { metar: m, inserted: false, id: null };
  const wx = JSON.stringify(m.cond.weather.map((w) => w.raw));
  const clouds = JSON.stringify(m.cond.clouds);
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO metars(station, obs_time, hour_time, type, raw, ceiling_ft, vis_sm, category, wind_dir, wind_var, wind_spd, wind_gust, temp_c, dewp_c, altim_inhg, slp_hpa, wx, clouds, decoded, source)
       VALUES (@station,@obs_time,@hour_time,@type,@raw,@ceiling_ft,@vis_sm,@category,@wind_dir,@wind_var,@wind_spd,@wind_gust,@temp_c,@dewp_c,@altim_inhg,@slp_hpa,@wx,@clouds,@decoded,@source)`,
    )
    .run({
      station, obs_time: m.time, hour_time: hourOf(m.time), type: m.type, raw: m.raw, ceiling_ft: m.ceilingFt, vis_sm: visValue(m.cond.visibility), category: m.category,
      wind_dir: m.cond.wind?.dirDeg ?? null, wind_var: m.cond.wind?.variable ? 1 : 0, wind_spd: m.cond.wind?.speedKt ?? null, wind_gust: m.cond.wind?.gustKt ?? null,
      temp_c: m.tempC, dewp_c: m.dewpC, altim_inhg: m.altimeterInHg, slp_hpa: m.remarks.slpHpa, wx, clouds, decoded: JSON.stringify(m), source,
    });
  return { metar: m, inserted: res.changes > 0, id: res.changes > 0 ? Number(res.lastInsertRowid) : null };
}

export function insertTaf(db: DB, station: string, raw: string, reference: Date, source: string): { taf: Taf; inserted: boolean; id: number | null } {
  const taf = parseTaf(raw, reference);
  if (taf.nil || !taf.station) return { taf, inserted: false, id: null };
  const hours = expandTaf(taf);
  const res = db
    .prepare(`INSERT OR IGNORE INTO tafs(station, issued, valid_from, valid_to, amended, raw, decoded, hours, source) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(station, taf.issued, taf.validFrom, taf.validTo, taf.amended ? 1 : 0, taf.raw, JSON.stringify(taf), JSON.stringify(hours), source);
  return { taf, inserted: res.changes > 0, id: res.changes > 0 ? Number(res.lastInsertRowid) : null };
}

export interface TafRow {
  id: number;
  station: string;
  issued: number;
  valid_from: number;
  valid_to: number;
  amended: number;
  raw: string;
  decoded: string;
  hours: string;
  source: string;
}

export function tafRowToObjects(r: TafRow): { taf: Taf; hours: TafHour[] } {
  return { taf: JSON.parse(r.decoded) as Taf, hours: JSON.parse(r.hours) as TafHour[] };
}

export interface MetarRow {
  id: number;
  station: string;
  obs_time: number;
  hour_time: number;
  type: string;
  raw: string;
  ceiling_ft: number | null;
  vis_sm: number | null;
  category: string | null;
  wind_dir: number | null;
  wind_var: number;
  wind_spd: number | null;
  wind_gust: number | null;
  temp_c: number | null;
  dewp_c: number | null;
  altim_inhg: number | null;
  slp_hpa: number | null;
  wx: string;
  clouds: string;
  decoded: string;
  source: string;
}

export function latestMetar(db: DB, station: string): MetarRow | undefined {
  return db.prepare('SELECT * FROM metars WHERE station=? ORDER BY obs_time DESC LIMIT 1').get(station) as MetarRow | undefined;
}

export function latestTaf(db: DB, station: string): TafRow | undefined {
  return db.prepare('SELECT * FROM tafs WHERE station=? ORDER BY issued DESC LIMIT 1').get(station) as TafRow | undefined;
}

export function getSetting(db: DB, key: string): string | null {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
export function setSetting(db: DB, key: string, value: string) {
  db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
