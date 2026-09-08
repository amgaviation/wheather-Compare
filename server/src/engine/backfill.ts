/**
 * Station registration and historical backfill from the IEM archive.
 */
import type { DB } from '../db/index.js';
import { config } from '../config.js';
import * as awc from '../sources/awc.js';
import * as nws from '../sources/nws.js';
import * as iem from '../sources/iem.js';
import { getStation, insertMetar, insertTaf, log, type StationRow } from './store.js';
import { verifyStation } from './verify.js';
import { pollModels, pollNws } from './ingest.js';

const DAY = 86_400_000;

export async function registerStation(db: DB, icaoIn: string): Promise<StationRow> {
  const icao = icaoIn.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(icao)) throw new Error('ICAO identifier must be 4 characters (e.g. KTEB)');
  const existing = getStation(db, icao);
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
  db.prepare(
    `INSERT INTO stations(icao, name, lat, lon, elev_ft, state, country, tz, iata, faa, has_taf, nws_office, nws_grid_id, nws_grid_x, nws_grid_y, nws_radar, added_at, backfill_days, backfill_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
  ).run(
    icao, info.site, info.lat, info.lon, info.elev == null ? null : Math.round(info.elev * 3.28084), info.state ?? null, info.country ?? null, point?.timeZone ?? null,
    info.iataId ?? null, info.faaId ?? null, info.siteType?.includes('TAF') ? 1 : 0, point?.forecastOffice ?? null, point?.gridId ?? null, point?.gridX ?? null, point?.gridY ?? null,
    point?.radarStation ?? null, Date.now(), config.backfillDays,
  );
  return getStation(db, icao)!;
}

function setStatus(db: DB, icao: string, status: string, message: string) {
  db.prepare('UPDATE stations SET backfill_status=?, backfill_message=?, backfill_done_at=CASE WHEN ?=\'done\' THEN ? ELSE backfill_done_at END WHERE icao=?').run(status, message, status, Date.now(), icao);
}

const running = new Set<string>();

/** Pull `days` of METAR + TAF history and verify. Safe to re-run; skips existing rows. */
export async function backfillStation(db: DB, icao: string, days = config.backfillDays): Promise<void> {
  if (running.has(icao)) return;
  running.add(icao);
  const st = getStation(db, icao);
  if (!st) {
    running.delete(icao);
    return;
  }
  const end = new Date(Date.now() + DAY);
  const start = new Date(Date.now() - days * DAY);
  try {
    setStatus(db, icao, 'running', `Fetching ${days} days of METARs from IEM archive…`);
    const metars = await iem.fetchMetarArchive(icao, start, end);
    let nM = 0;
    let warn = 0;
    const tx = db.transaction(() => {
      for (const r of metars) {
        const res = insertMetar(db, icao, r.raw, new Date(r.validUtc), 'iem');
        if (res.inserted) nM++;
        if (res.metar.parseWarnings.length) warn++;
      }
    });
    tx();
    log(db, 'iem.metar', icao, true, `${metars.length} rows, ${nM} new, ${warn} with parse warnings`, nM);

    let nT = 0;
    if (st.has_taf) {
      setStatus(db, icao, 'running', `METARs done (${nM}). Fetching TAF archive…`);
      // monthly chunks to keep responses small
      let chunkStart = start;
      while (chunkStart < end) {
        const chunkEnd = new Date(Math.min(end.getTime(), chunkStart.getTime() + 31 * DAY));
        const tafs = await iem.fetchTafArchive(icao, chunkStart, chunkEnd);
        const txT = db.transaction(() => {
          for (const t of tafs) {
            const res = insertTaf(db, icao, t.raw, new Date(t.issued), 'iem');
            if (res.inserted) nT++;
          }
        });
        txT();
        chunkStart = chunkEnd;
      }
      log(db, 'iem.taf', icao, true, `${nT} new TAFs`, nT);
    }
    setStatus(db, icao, 'running', `Verifying ${nM} obs × TAFs…`);
    const nV = verifyStation(db, icao, start.getTime(), end.getTime());
    log(db, 'verify', icao, true, `${nV} verification rows`, nV);
    setStatus(db, icao, 'running', 'Fetching NWS forecast and model guidance…');
    await pollNws(db, st);
    await pollModels(db, st, true);
    setStatus(db, icao, 'done', `${nM} METARs, ${nT} TAFs, ${nV} verification pairs over ${days} days`);
  } catch (e) {
    setStatus(db, icao, 'error', String(e));
    log(db, 'backfill', icao, false, String(e));
  } finally {
    running.delete(icao);
  }
}
