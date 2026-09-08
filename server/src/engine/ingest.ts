/**
 * Live ingestion: polls free public sources and stores observations/forecasts, then runs
 * incremental verification.
 */
import type { DB } from '../db/index.js';
import { config } from '../config.js';
import * as awc from '../sources/awc.js';
import * as nws from '../sources/nws.js';
import * as om from '../sources/openmeteo.js';
import { insertMetar, insertTaf, listStations, log, type StationRow } from './store.js';
import { verifyStation } from './verify.js';

const HOUR = 3600_000;

export async function pollMetars(db: DB): Promise<void> {
  const stations = listStations(db, true);
  if (!stations.length) return;
  const ids = stations.map((s) => s.icao);
  try {
    const rows = await awc.fetchMetars(ids, 3);
    const touched = new Set<string>();
    let inserted = 0;
    const tx = db.transaction(() => {
      for (const r of rows) {
        const ref = new Date((r.obsTime ?? Date.now() / 1000) * 1000);
        const res = insertMetar(db, r.icaoId, r.rawOb, ref, 'awc', r.metarType);
        if (res.inserted) {
          inserted++;
          touched.add(r.icaoId);
        }
      }
    });
    tx();
    for (const s of touched) verifyStation(db, s, Date.now() - 36 * HOUR, Date.now() + HOUR);
    log(db, 'awc.metar', null, true, `fetched ${rows.length}, new ${inserted}`, inserted);
  } catch (e) {
    log(db, 'awc.metar', null, false, String(e));
  }
}

export async function pollTafs(db: DB): Promise<void> {
  const stations = listStations(db, true).filter((s) => s.has_taf);
  if (!stations.length) return;
  try {
    const rows = await awc.fetchTafs(stations.map((s) => s.icao));
    const touched = new Set<string>();
    let inserted = 0;
    const tx = db.transaction(() => {
      for (const r of rows) {
        const res = insertTaf(db, r.icaoId, r.rawTAF, new Date(r.issueTime), 'awc');
        if (res.inserted) {
          inserted++;
          touched.add(r.icaoId);
        }
      }
    });
    tx();
    for (const s of touched) verifyStation(db, s, Date.now() - 36 * HOUR, Date.now() + HOUR);
    log(db, 'awc.taf', null, true, `fetched ${rows.length}, new ${inserted}`, inserted);
  } catch (e) {
    log(db, 'awc.taf', null, false, String(e));
  }
}

function parseNwsWind(s: string): number | null {
  // "10 km/h" (si) or "6 mph" or "5 to 10 mph"
  const m = /(\d+)(?:\s+to\s+(\d+))?\s*(km\/h|mph|kt)/.exec(s);
  if (!m) return null;
  const v = m[2] ? parseInt(m[2], 10) : parseInt(m[1], 10);
  if (m[3] === 'km/h') return Math.round(v * 0.539957);
  if (m[3] === 'mph') return Math.round(v * 0.868976);
  return v;
}

export async function pollNws(db: DB, st: StationRow): Promise<void> {
  if (!st.nws_grid_id || st.nws_grid_x == null || st.nws_grid_y == null) return;
  try {
    const [hourly, grid] = await Promise.all([nws.fetchHourly(st.nws_grid_id, st.nws_grid_x, st.nws_grid_y), nws.fetchGrid(st.nws_grid_id, st.nws_grid_x, st.nws_grid_y)]);
    const issued = Date.parse(hourly.updateTime);
    const now = Date.now();
    const from = Math.floor(now / HOUR) * HOUR - 6 * HOUR;
    const to = from + 8 * 24 * HOUR;
    const ceiling = nws.expandSeries(grid.ceilingHeight, from, to);
    const vis = nws.expandSeries(grid.visibility, from, to);
    const gust = nws.expandSeries(grid.windGust, from, to);
    const sky = nws.expandSeries(grid.skyCover, from, to);
    const thunder = nws.expandSeries(grid.probabilityOfThunder, from, to);
    const qpf = nws.expandSeries(grid.quantitativePrecipitation, from, to);
    const wdirGrid = nws.expandSeries(grid.windDirection, from, to);
    const wxMap = new Map<number, string>();
    if (grid.weather) {
      for (const v of grid.weather.values) {
        const [startStr, durStr] = v.validTime.split('/');
        const start = Date.parse(startStr);
        const dur = nws.parseIsoDuration(durStr);
        const txt = v.value
          .filter((w) => w.weather)
          .map((w) => [w.coverage, w.intensity, w.weather].filter(Boolean).join(' '))
          .join('; ');
        for (let t = Math.floor(start / HOUR) * HOUR; t < start + dur; t += HOUR) wxMap.set(t, txt);
      }
    }
    const ins = db.prepare(`INSERT OR REPLACE INTO nws_hourly(station, issued, valid_time, fetched_at, temp_c, dewp_c, rh, wind_dir, wind_spd, wind_gust, sky_pct, pop, ceiling_ft, vis_sm, wx, qpf_mm, short_forecast, prob_thunder)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let n = 0;
    const tx = db.transaction(() => {
      for (const p of hourly.periods) {
        const t = Date.parse(p.startTime);
        const tempC = p.temperatureUnit === 'F' ? Math.round(((p.temperature - 32) * 5) / 9 * 10) / 10 : p.temperature;
        const dewp = p.dewpoint?.value ?? null;
        const dewpC = dewp == null ? null : p.dewpoint.unitCode.includes('degF') ? Math.round((((dewp - 32) * 5) / 9) * 10) / 10 : Math.round(dewp * 10) / 10;
        const wdir = wdirGrid.get(t) ?? nws.compassToDeg(p.windDirection);
        const c = ceiling.get(t);
        const v = vis.get(t);
        const g = gust.get(t);
        const q = qpf.get(t);
        ins.run(
          st.icao, issued, t, now, tempC, dewpC, p.relativeHumidity?.value ?? null, wdir == null ? null : Math.round(wdir), parseNwsWind(p.windSpeed),
          g == null ? null : Math.round(g * 0.539957), sky.get(t) ?? null, p.probabilityOfPrecipitation?.value ?? null,
          c == null ? null : Math.round(c * 3.28084), v == null ? null : Math.round((v / 1609.34) * 100) / 100, wxMap.get(t) ?? null, q ?? null, p.shortForecast, thunder.get(t) ?? null,
        );
        n++;
      }
    });
    tx();
    log(db, 'nws.hourly', st.icao, true, `issued ${hourly.updateTime}, ${n} hours`, n);
  } catch (e) {
    log(db, 'nws.hourly', st.icao, false, String(e));
  }
}

export async function pollModels(db: DB, st: StationRow, includePreviousRuns = false): Promise<void> {
  if (!config.useOpenMeteo) return;
  const now = Date.now();
  const ins = db.prepare(`INSERT OR REPLACE INTO model_hourly(station, model, run_time, lead_days, valid_time, fetched_at, temp_c, dewp_c, wind_dir, wind_spd, wind_gust, cloud_pct, cloud_low_pct, cloud_mid_pct, vis_m, precip_mm, pop, wx_code, cape, pressure_hpa, boundary_layer_m)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  try {
    const rows = await om.fetchModelForecast(st.lat, st.lon, 7);
    const runTime = Math.floor(now / HOUR) * HOUR;
    const tx = db.transaction(() => {
      for (const r of rows) {
        ins.run(st.icao, r.model, runTime, 0, r.validTime, now, r.tempC, r.dewpC, r.windDir, r.windKt, r.gustKt, r.cloudPct, r.cloudLowPct, r.cloudMidPct, r.visM, r.precipMm, r.pop, r.wxCode, r.cape, r.pressureHpa, r.blHeightM);
      }
    });
    tx();
    log(db, 'openmeteo.forecast', st.icao, true, `${rows.length} rows`, rows.length);
  } catch (e) {
    log(db, 'openmeteo.forecast', st.icao, false, String(e));
  }
  if (includePreviousRuns) {
    try {
      const rows = await om.fetchPreviousRuns(st.lat, st.lon, 7, [1, 2, 3, 5]);
      const tx = db.transaction(() => {
        for (const r of rows) {
          ins.run(st.icao, r.model, r.validTime - r.leadDays * 24 * HOUR, r.leadDays, r.validTime, now, r.tempC, r.dewpC, r.windDir, r.windKt, r.gustKt, r.cloudPct, r.cloudLowPct, r.cloudMidPct, r.visM, r.precipMm, r.pop, r.wxCode, r.cape, r.pressureHpa, r.blHeightM);
        }
      });
      tx();
      log(db, 'openmeteo.previous', st.icao, true, `${rows.length} rows`, rows.length);
    } catch (e) {
      log(db, 'openmeteo.previous', st.icao, false, String(e));
    }
  }
}

/** Snapshot of lead-0 model data keeps only the latest run per valid hour; older lead-0 runs are pruned (previous-runs API supplies history). */
export function pruneModelRuns(db: DB) {
  db.prepare('DELETE FROM model_hourly WHERE lead_days=0 AND fetched_at < ?').run(Date.now() - 2 * 24 * HOUR);
  db.prepare('DELETE FROM nws_hourly WHERE fetched_at < ?').run(Date.now() - 400 * 24 * HOUR);
}
