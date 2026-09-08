/**
 * Live ingestion: polls free public sources and stores observations/forecasts, then runs
 * incremental verification.
 */
import type { DB } from '../db/index.js';
import { DbError, upsertChunked } from '../db/index.js';
import { config } from '../config.js';
import * as awc from '../sources/awc.js';
import * as nws from '../sources/nws.js';
import * as om from '../sources/openmeteo.js';
import { insertMetar, insertTaf, listStations, log, type StationRow } from './store.js';
import { verifyStation } from './verify.js';

const HOUR = 3600_000;

export async function pollMetars(db: DB): Promise<void> {
  const stations = await listStations(db, true);
  if (!stations.length) return;
  const ids = stations.map((s) => s.icao);
  try {
    const rows = await awc.fetchMetars(ids, 3);
    const results = await Promise.all(
      rows.map((r) => insertMetar(db, r.icaoId, r.rawOb, new Date((r.obsTime ?? Date.now() / 1000) * 1000), 'awc', r.metarType).then((res) => ({ icao: r.icaoId, res }))),
    );
    const touched = new Set(results.filter((r) => r.res.inserted).map((r) => r.icao));
    const inserted = results.filter((r) => r.res.inserted).length;
    for (const s of touched) await verifyStation(db, s, Date.now() - 36 * HOUR, Date.now() + HOUR);
    await log(db, 'awc.metar', null, true, `fetched ${rows.length}, new ${inserted}`, inserted);
  } catch (e) {
    await log(db, 'awc.metar', null, false, String(e));
  }
}

export async function pollTafs(db: DB): Promise<void> {
  const stations = (await listStations(db, true)).filter((s) => s.has_taf);
  if (!stations.length) return;
  try {
    const rows = await awc.fetchTafs(stations.map((s) => s.icao));
    const results = await Promise.all(rows.map((r) => insertTaf(db, r.icaoId, r.rawTAF, new Date(r.issueTime), 'awc').then((res) => ({ icao: r.icaoId, res }))));
    const touched = new Set(results.filter((r) => r.res.inserted).map((r) => r.icao));
    const inserted = results.filter((r) => r.res.inserted).length;
    for (const s of touched) await verifyStation(db, s, Date.now() - 36 * HOUR, Date.now() + HOUR);
    await log(db, 'awc.taf', null, true, `fetched ${rows.length}, new ${inserted}`, inserted);
  } catch (e) {
    await log(db, 'awc.taf', null, false, String(e));
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
    const rows = hourly.periods.map((p) => {
      const t = Date.parse(p.startTime);
      const tempC = p.temperatureUnit === 'F' ? Math.round(((p.temperature - 32) * 5) / 9 * 10) / 10 : p.temperature;
      const dewp = p.dewpoint?.value ?? null;
      const dewpC = dewp == null ? null : p.dewpoint.unitCode.includes('degF') ? Math.round((((dewp - 32) * 5) / 9) * 10) / 10 : Math.round(dewp * 10) / 10;
      const wdir = wdirGrid.get(t) ?? nws.compassToDeg(p.windDirection);
      const c = ceiling.get(t);
      const v = vis.get(t);
      const g = gust.get(t);
      const q = qpf.get(t);
      return {
        station: st.icao, issued, valid_time: t, fetched_at: now, temp_c: tempC, dewp_c: dewpC, rh: p.relativeHumidity?.value ?? null,
        wind_dir: wdir == null ? null : Math.round(wdir), wind_spd: parseNwsWind(p.windSpeed), wind_gust: g == null ? null : Math.round(g * 0.539957),
        sky_pct: sky.get(t) ?? null, pop: p.probabilityOfPrecipitation?.value ?? null, ceiling_ft: c == null ? null : Math.round(c * 3.28084),
        vis_sm: v == null ? null : Math.round((v / 1609.34) * 100) / 100, wx: wxMap.get(t) ?? null, qpf_mm: q ?? null, short_forecast: p.shortForecast, prob_thunder: thunder.get(t) ?? null,
      };
    });
    const written = await upsertChunked(db, 'wxc_nws_hourly', rows, 'station,issued,valid_time', { select: 'station' });
    await log(db, 'nws.hourly', st.icao, true, `issued ${hourly.updateTime}, ${written.length} hours`, written.length);
  } catch (e) {
    await log(db, 'nws.hourly', st.icao, false, String(e));
  }
}

export async function pollModels(db: DB, st: StationRow, includePreviousRuns = false): Promise<void> {
  if (!config.useOpenMeteo) return;
  const now = Date.now();
  try {
    const forecast = await om.fetchModelForecast(st.lat, st.lon, 7);
    const runTime = Math.floor(now / HOUR) * HOUR;
    const rows = forecast.map((r) => ({
      station: st.icao, model: r.model, run_time: runTime, lead_days: 0, valid_time: r.validTime, fetched_at: now,
      temp_c: r.tempC, dewp_c: r.dewpC, wind_dir: r.windDir, wind_spd: r.windKt, wind_gust: r.gustKt, cloud_pct: r.cloudPct, cloud_low_pct: r.cloudLowPct,
      cloud_mid_pct: r.cloudMidPct, vis_m: r.visM, precip_mm: r.precipMm, pop: r.pop, wx_code: r.wxCode, cape: r.cape, pressure_hpa: r.pressureHpa, boundary_layer_m: r.blHeightM,
    }));
    const written = await upsertChunked(db, 'wxc_model_hourly', rows, 'station,model,lead_days,valid_time', { select: 'station' });
    await log(db, 'openmeteo.forecast', st.icao, true, `${written.length} rows`, written.length);
  } catch (e) {
    await log(db, 'openmeteo.forecast', st.icao, false, String(e));
  }
  if (includePreviousRuns) {
    try {
      const prev = await om.fetchPreviousRuns(st.lat, st.lon, 7, [1, 2, 3, 5]);
      const rows = prev.map((r) => ({
        station: st.icao, model: r.model, run_time: r.validTime - r.leadDays * 24 * HOUR, lead_days: r.leadDays, valid_time: r.validTime, fetched_at: now,
        temp_c: r.tempC, dewp_c: r.dewpC, wind_dir: r.windDir, wind_spd: r.windKt, wind_gust: r.gustKt, cloud_pct: r.cloudPct, cloud_low_pct: r.cloudLowPct,
        cloud_mid_pct: r.cloudMidPct, vis_m: r.visM, precip_mm: r.precipMm, pop: r.pop, wx_code: r.wxCode, cape: r.cape, pressure_hpa: r.pressureHpa, boundary_layer_m: r.blHeightM,
      }));
      const written = await upsertChunked(db, 'wxc_model_hourly', rows, 'station,model,lead_days,valid_time', { select: 'station' });
      await log(db, 'openmeteo.previous', st.icao, true, `${written.length} rows`, written.length);
    } catch (e) {
      await log(db, 'openmeteo.previous', st.icao, false, String(e));
    }
  }
}

/** Lead-0 model rows keep only the latest run per valid hour; older lead-0 rows are pruned (the previous-runs API supplies history instead). */
export async function pruneModelRuns(db: DB): Promise<void> {
  const cutoffModel = Date.now() - 2 * 24 * HOUR;
  const cutoffNws = Date.now() - 400 * 24 * HOUR;
  const r1 = await db.from('wxc_model_hourly').delete().eq('lead_days', 0).lt('fetched_at', cutoffModel);
  if (r1.error) throw new DbError(`pruneModelRuns: ${r1.error.message}`, r1.error);
  const r2 = await db.from('wxc_nws_hourly').delete().lt('fetched_at', cutoffNws);
  if (r2.error) throw new DbError(`pruneModelRuns: ${r2.error.message}`, r2.error);
}
