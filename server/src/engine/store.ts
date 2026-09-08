import type { DB } from '../db/index.js';
import { DbError, upsertChunked } from '../db/index.js';
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

export async function listStations(db: DB, enabledOnly = false): Promise<StationRow[]> {
  let q = db.from('wxc_stations').select('*').order('icao');
  if (enabledOnly) q = q.eq('enabled', 1);
  const res = await q;
  if (res.error) throw new DbError(`listStations: ${res.error.message}`, res.error);
  return (res.data ?? []) as StationRow[];
}

export async function getStation(db: DB, icao: string): Promise<StationRow | undefined> {
  const res = await db.from('wxc_stations').select('*').eq('icao', icao).maybeSingle();
  if (res.error) throw new DbError(`getStation: ${res.error.message}`, res.error);
  return (res.data as StationRow) ?? undefined;
}

export async function log(db: DB, source: string, station: string | null, ok: boolean, message: string, count?: number): Promise<void> {
  const res = await db.from('wxc_ingest_log').insert({ at: Date.now(), source, station, ok: ok ? 1 : 0, message: message.slice(0, 500), count: count ?? null });
  if (res.error) throw new DbError(`log: ${res.error.message}`, res.error);
  // Keep the log bounded; cheap best-effort prune, failure here must never break ingestion.
  if (Math.random() < 0.01) {
    try {
      const latest = await db.from('wxc_ingest_log').select('id').order('id', { ascending: false }).range(5000, 5000).maybeSingle();
      if (latest.data) await db.from('wxc_ingest_log').delete().lt('id', (latest.data as { id: number }).id);
    } catch {
      /* best-effort */
    }
  }
}

/** Decode a raw METAR and upsert it. `inserted` is true only when the row was newly written. */
export async function insertMetar(
  db: DB,
  station: string,
  raw: string,
  reference: Date,
  source: string,
  typeHint?: 'METAR' | 'SPECI',
): Promise<{ metar: Metar; inserted: boolean; id: number | null }> {
  const m = parseMetar(raw, reference);
  if (typeHint && !/^(METAR|SPECI)\s/.test(raw)) m.type = typeHint;
  if (m.nil || !m.station) return { metar: m, inserted: false, id: null };
  const wx = JSON.stringify(m.cond.weather.map((w) => w.raw));
  const clouds = JSON.stringify(m.cond.clouds);
  const row = {
    station,
    obs_time: m.time,
    hour_time: hourOf(m.time),
    type: m.type,
    raw: m.raw,
    ceiling_ft: m.ceilingFt,
    vis_sm: visValue(m.cond.visibility),
    category: m.category,
    wind_dir: m.cond.wind?.dirDeg ?? null,
    wind_var: m.cond.wind?.variable ? 1 : 0,
    wind_spd: m.cond.wind?.speedKt ?? null,
    wind_gust: m.cond.wind?.gustKt ?? null,
    temp_c: m.tempC,
    dewp_c: m.dewpC,
    altim_inhg: m.altimeterInHg,
    slp_hpa: m.remarks.slpHpa,
    wx,
    clouds,
    decoded: JSON.stringify(m),
    source,
  };
  const res = await db.from('wxc_metars').upsert(row, { onConflict: 'station,obs_time,raw', ignoreDuplicates: true }).select('id');
  if (res.error) throw new DbError(`insertMetar: ${res.error.message}`, res.error);
  const inserted = (res.data?.length ?? 0) > 0;
  return { metar: m, inserted, id: inserted ? (res.data![0] as { id: number }).id : null };
}

export async function insertTaf(db: DB, station: string, raw: string, reference: Date, source: string): Promise<{ taf: Taf; inserted: boolean; id: number | null }> {
  const taf = parseTaf(raw, reference);
  if (taf.nil || !taf.station) return { taf, inserted: false, id: null };
  const hours = expandTaf(taf);
  const row = {
    station,
    issued: taf.issued,
    valid_from: taf.validFrom,
    valid_to: taf.validTo,
    amended: taf.amended ? 1 : 0,
    raw: taf.raw,
    decoded: JSON.stringify(taf),
    hours: JSON.stringify(hours),
    source,
  };
  const res = await db.from('wxc_tafs').upsert(row, { onConflict: 'station,issued,raw', ignoreDuplicates: true }).select('id');
  if (res.error) throw new DbError(`insertTaf: ${res.error.message}`, res.error);
  const inserted = (res.data?.length ?? 0) > 0;
  return { taf, inserted, id: inserted ? (res.data![0] as { id: number }).id : null };
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

export async function latestMetar(db: DB, station: string): Promise<MetarRow | undefined> {
  const res = await db.from('wxc_metars').select('*').eq('station', station).order('obs_time', { ascending: false }).limit(1).maybeSingle();
  if (res.error) throw new DbError(`latestMetar: ${res.error.message}`, res.error);
  return (res.data as MetarRow) ?? undefined;
}

export async function latestTaf(db: DB, station: string): Promise<TafRow | undefined> {
  const res = await db.from('wxc_tafs').select('*').eq('station', station).order('issued', { ascending: false }).limit(1).maybeSingle();
  if (res.error) throw new DbError(`latestTaf: ${res.error.message}`, res.error);
  return (res.data as TafRow) ?? undefined;
}

export async function getSetting(db: DB, key: string): Promise<string | null> {
  const res = await db.from('wxc_settings').select('value').eq('key', key).maybeSingle();
  if (res.error) throw new DbError(`getSetting: ${res.error.message}`, res.error);
  return (res.data as { value: string } | null)?.value ?? null;
}
export async function setSetting(db: DB, key: string, value: string): Promise<void> {
  const res = await db.from('wxc_settings').upsert({ key, value }, { onConflict: 'key' });
  if (res.error) throw new DbError(`setSetting: ${res.error.message}`, res.error);
}


/**
 * Decode and upsert many raw METARs for one station in a single batched request (used by
 * backfill, which can have thousands of rows). Returns how many were newly inserted and how
 * many had parser warnings (for a quick data-quality signal in the ingest log).
 */
export async function insertMetarsBatch(db: DB, station: string, items: Array<{ raw: string; reference: Date }>, source: string): Promise<{ inserted: number; warnings: number; total: number }> {
  const decoded = items.map((it) => parseMetar(it.raw, it.reference)).filter((m) => !m.nil && m.station);
  const warnings = decoded.filter((m) => m.parseWarnings.length).length;
  const rows = decoded.map((m) => ({
    station,
    obs_time: m.time,
    hour_time: hourOf(m.time),
    type: m.type,
    raw: m.raw,
    ceiling_ft: m.ceilingFt,
    vis_sm: visValue(m.cond.visibility),
    category: m.category,
    wind_dir: m.cond.wind?.dirDeg ?? null,
    wind_var: m.cond.wind?.variable ? 1 : 0,
    wind_spd: m.cond.wind?.speedKt ?? null,
    wind_gust: m.cond.wind?.gustKt ?? null,
    temp_c: m.tempC,
    dewp_c: m.dewpC,
    altim_inhg: m.altimeterInHg,
    slp_hpa: m.remarks.slpHpa,
    wx: JSON.stringify(m.cond.weather.map((w) => w.raw)),
    clouds: JSON.stringify(m.cond.clouds),
    decoded: JSON.stringify(m),
    source,
  }));
  const written = await upsertChunked(db, 'wxc_metars', rows, 'station,obs_time,raw', { ignoreDuplicates: true, select: 'id' });
  return { inserted: written.length, warnings, total: items.length };
}

/** Decode and upsert many raw TAFs for one station in a single batched request. */
export async function insertTafsBatch(db: DB, station: string, items: Array<{ raw: string; reference: Date }>, source: string): Promise<{ inserted: number; total: number }> {
  const decoded = items.map((it) => ({ taf: parseTaf(it.raw, it.reference) })).filter((d) => !d.taf.nil && d.taf.station);
  const rows = decoded.map(({ taf }) => ({
    station,
    issued: taf.issued,
    valid_from: taf.validFrom,
    valid_to: taf.validTo,
    amended: taf.amended ? 1 : 0,
    raw: taf.raw,
    decoded: JSON.stringify(taf),
    hours: JSON.stringify(expandTaf(taf)),
    source,
  }));
  const written = await upsertChunked(db, 'wxc_tafs', rows, 'station,issued,raw', { ignoreDuplicates: true, select: 'id' });
  return { inserted: written.length, total: items.length };
}

/** Re-exported for callers that batch-write many rows at once (ingest.ts, backfill.ts). */
export { upsertChunked };
