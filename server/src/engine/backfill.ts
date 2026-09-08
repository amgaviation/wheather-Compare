/**
 * Station registration and historical backfill from the IEM archive.
 */
import type { DB } from '../db/index.js';
import { DbError } from '../db/index.js';
import { config } from '../config.js';
import * as awc from '../sources/awc.js';
import * as nws from '../sources/nws.js';
import * as iem from '../sources/iem.js';
import { getStation, insertMetarsBatch, insertTafsBatch, log, type StationRow } from './store.js';
import { verifyStation } from './verify.js';
import { pollModels, pollNws } from './ingest.js';

const DAY = 86_400_000;

export async function registerStation(db: DB, icaoIn: string): Promise<StationRow> {
  const icao = icaoIn.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(icao)) throw new Error('ICAO identifier must be 4 characters (e.g. KTEB)');
  const existing = await getStation(db, icao);
  if (existing) return existing;
  const info = (await awc.fetchStationInfo([icao]))[0];
  if (!info) throw new Error(`Station ${icao} not found in aviationweather.gov station table`);
  let point: nws.NwsPoint | null = null;
  if (info.country === 'US' || (info.lat > 17 && info.lat < 72 && info.lon < -60 && info.lon > -180)) {
    try {
      point = await nws.fetchPoint(info.lat, info.lon);
    } catch {
      point = null;
    }
  }
  const res = await db.from('wxc_stations').insert({
    icao, name: info.site, lat: info.lat, lon: info.lon, elev_ft: info.elev == null ? null : Math.round(info.elev * 3.28084),
    state: info.state ?? null, country: info.country ?? null, tz: point?.timeZone ?? null, iata: info.iataId ?? null, faa: info.faaId ?? null,
    has_taf: info.siteType?.includes('TAF') ? 1 : 0, nws_office: point?.forecastOffice ?? null, nws_grid_id: point?.gridId ?? null,
    nws_grid_x: point?.gridX ?? null, nws_grid_y: point?.gridY ?? null, nws_radar: point?.radarStation ?? null, added_at: Date.now(),
    backfill_days: config.backfillDays, backfill_status: 'pending',
  });
  if (res.error) throw new DbError(`registerStation: ${res.error.message}`, res.error);
  return (await getStation(db, icao))!;
}

async function setStatus(db: DB, icao: string, status: string, message: string): Promise<void> {
  const patch: Record<string, unknown> = { backfill_status: status, backfill_message: message };
  if (status === 'done') patch.backfill_done_at = Date.now();
  const res = await db.from('wxc_stations').update(patch).eq('icao', icao);
  if (res.error) throw new DbError(`setStatus: ${res.error.message}`, res.error);
}

const running = new Set<string>();

/** Pull `days` of METAR + TAF history and verify. Safe to re-run; skips existing rows. */
export async function backfillStation(db: DB, icao: string, days = config.backfillDays): Promise<void> {
  if (running.has(icao)) return;
  running.add(icao);
  const st = await getStation(db, icao);
  if (!st) {
    running.delete(icao);
    return;
  }
  const end = new Date(Date.now() + DAY);
  const start = new Date(Date.now() - days * DAY);
  try {
    await setStatus(db, icao, 'running', `Fetching ${days} days of METARs from IEM archive…`);
    const metars = await iem.fetchMetarArchive(icao, start, end);
    const mRes = await insertMetarsBatch(db, icao, metars.map((r) => ({ raw: r.raw, reference: new Date(r.validUtc) })), 'iem');
    await log(db, 'iem.metar', icao, true, `${mRes.total} rows, ${mRes.inserted} new, ${mRes.warnings} with parse warnings`, mRes.inserted);

    let nT = 0;
    if (st.has_taf) {
      await setStatus(db, icao, 'running', `METARs done (${mRes.inserted}). Fetching TAF archive…`);
      // monthly chunks to keep archive responses small
      let chunkStart = start;
      while (chunkStart < end) {
        const chunkEnd = new Date(Math.min(end.getTime(), chunkStart.getTime() + 31 * DAY));
        const tafs = await iem.fetchTafArchive(icao, chunkStart, chunkEnd);
        const tRes = await insertTafsBatch(db, icao, tafs.map((t) => ({ raw: t.raw, reference: new Date(t.issued) })), 'iem');
        nT += tRes.inserted;
        chunkStart = chunkEnd;
      }
      await log(db, 'iem.taf', icao, true, `${nT} new TAFs`, nT);
    }
    await setStatus(db, icao, 'running', `Verifying ${mRes.inserted} obs × TAFs…`);
    const nV = await verifyStation(db, icao, start.getTime(), end.getTime());
    await log(db, 'verify', icao, true, `${nV} verification rows`, nV);
    await setStatus(db, icao, 'running', 'Fetching NWS forecast and model guidance…');
    await pollNws(db, st);
    await pollModels(db, st, true);
    await setStatus(db, icao, 'done', `${mRes.inserted} METARs, ${nT} TAFs, ${nV} verification pairs over ${days} days`);
  } catch (e) {
    await setStatus(db, icao, 'error', String(e));
    await log(db, 'backfill', icao, false, String(e));
  } finally {
    running.delete(icao);
  }
}
