/**
 * TAF-vs-METAR verification. Each routine hourly observation is scored against every TAF that
 * covered that hour and was issued before the observation (giving a spread of lead times);
 * the most recently issued of those is flagged `operative` (the TAF actually in force).
 */
import type { DB } from '../db/index.js';
import { DbError, selectAll, upsertChunked } from '../db/index.js';
import { CATEGORY_RANK, type FlightCategory, type TafHour } from '../wx/types.js';
import { visValue } from '../wx/flightcat.js';
import type { MetarRow, TafRow } from './store.js';

const HOUR = 3600_000;
/** "Unlimited" ceiling sentinel for error math (ft). */
export const CEILING_CAP = 12000;
/** TAFs cap visibility at P6SM; cap both sides for error math. */
export const VIS_CAP = 6;

export function angleDiff(a: number, b: number): number {
  let d = ((a - b + 540) % 360) - 180;
  if (d === -180) d = 180;
  return d;
}

export function wxCodes(cond: TafHour['prevailing']): string[] {
  const out = new Set<string>();
  for (const w of cond.weather) {
    if (w.descriptor === 'TS') out.add('TS');
    if (w.descriptor === 'FZ') out.add('FZ');
    for (const p of w.phenomena) out.add(p);
  }
  return [...out].sort();
}

function metarWxCodes(m: MetarRow): string[] {
  const d = JSON.parse(m.decoded) as { cond: TafHour['prevailing'] };
  return wxCodes(d.cond);
}

/** Pick one routine observation per hour (closest to the top of the hour; SPECIs only if no METAR). */
export function hourlyObs(rows: MetarRow[]): MetarRow[] {
  const byHour = new Map<number, MetarRow>();
  for (const r of rows) {
    const cur = byHour.get(r.hour_time);
    if (!cur) {
      byHour.set(r.hour_time, r);
      continue;
    }
    const better =
      (r.type === 'METAR' && cur.type !== 'METAR') ||
      (r.type === cur.type && Math.abs(r.obs_time - r.hour_time) < Math.abs(cur.obs_time - cur.hour_time));
    if (better) byHour.set(r.hour_time, r);
  }
  return [...byHour.values()].sort((a, b) => a.hour_time - b.hour_time);
}

interface VerificationRow {
  station: string;
  metar_id: number;
  taf_id: number;
  obs_time: number;
  hour_time: number;
  taf_issued: number;
  lead_hours: number;
  operative: number;
  hour_utc: number;
  fcst_cat: FlightCategory | null;
  obs_cat: FlightCategory | null;
  worst_cat: FlightCategory | null;
  cat_hit: number | null;
  cat_err: number | null;
  tempo_covered: number | null;
  fcst_ceiling: number | null;
  obs_ceiling: number | null;
  fcst_vis: number | null;
  obs_vis: number | null;
  fcst_wdir: number | null;
  obs_wdir: number | null;
  fcst_wspd: number | null;
  obs_wspd: number | null;
  fcst_gust: number | null;
  obs_gust: number | null;
  fcst_wx: string;
  obs_wx: string;
  ceiling_err: number;
  ceiling_log_err: number;
  vis_err: number | null;
  wdir_err: number | null;
  wspd_err: number | null;
}

/**
 * Compute and upsert verification rows for every (obs, covering-TAF) pair for a station within
 * [from, to). Deterministic given the same METAR/TAF data, so re-running (e.g. after a
 * late-arriving TAF changes which one was "operative") safely overwrites prior rows —
 * upserted with merge-on-conflict rather than insert-or-ignore.
 */
export async function verifyStation(db: DB, station: string, from: number, to: number): Promise<number> {
  const metarRows = await selectAll<MetarRow>((r0, r1) =>
    db.from('wxc_metars').select('*').eq('station', station).gte('hour_time', from).lt('hour_time', to).order('obs_time').range(r0, r1),
  );
  const obs = hourlyObs(metarRows);
  if (!obs.length) return 0;

  const tafs = await selectAll<TafRow>((r0, r1) =>
    db.from('wxc_tafs').select('*').eq('station', station).gt('valid_to', from).lt('valid_from', to).order('issued').range(r0, r1),
  );
  if (!tafs.length) return 0;

  const tafHours = new Map<number, Map<number, TafHour>>();
  for (const t of tafs) {
    const hrs = JSON.parse(t.hours) as TafHour[];
    tafHours.set(t.id, new Map(hrs.map((h) => [h.time, h])));
  }

  const rows: VerificationRow[] = [];
  for (const m of obs) {
    const covering = tafs.filter((t) => t.issued <= m.obs_time && t.valid_from <= m.hour_time && m.hour_time < t.valid_to);
    if (!covering.length) continue;
    let operativeId = covering[0].id;
    let latestIssued = covering[0].issued;
    for (const t of covering) if (t.issued > latestIssued) { latestIssued = t.issued; operativeId = t.id; }
    const obsWx = metarWxCodes(m);
    const obsCat = (m.category as FlightCategory | null) ?? null;
    for (const t of covering) {
      const h = tafHours.get(t.id)?.get(m.hour_time);
      if (!h) continue;
      const fcstCat = h.prevailingCategory;
      const fcstCeil = h.prevailingCeilingFt;
      const fcstVis = visValue(h.prevailing.visibility);
      const fw = h.prevailing.wind;
      const obsCeil = m.ceiling_ft;
      const obsVis = m.vis_sm;
      const catHit = fcstCat != null && obsCat != null ? (fcstCat === obsCat ? 1 : 0) : null;
      const catErr = fcstCat != null && obsCat != null ? CATEGORY_RANK[obsCat] - CATEGORY_RANK[fcstCat] : null;
      let tempoCovered: number | null = null;
      if (obsCat != null && h.worstCategory != null) {
        const lo = CATEGORY_RANK[fcstCat ?? 'VFR'];
        const hi = CATEGORY_RANK[h.worstCategory];
        tempoCovered = CATEGORY_RANK[obsCat] >= lo && CATEGORY_RANK[obsCat] <= hi ? 1 : 0;
        if (catHit === 1) tempoCovered = 1;
      }
      const fc = Math.min(fcstCeil ?? CEILING_CAP, CEILING_CAP);
      const oc = Math.min(obsCeil ?? CEILING_CAP, CEILING_CAP);
      const fv = fcstVis == null ? null : Math.min(fcstVis, VIS_CAP);
      const ov = obsVis == null ? null : Math.min(obsVis, VIS_CAP);
      const windOk = !!fw && !fw.variable && fw.dirDeg != null && m.wind_dir != null && !m.wind_var && fw.speedKt >= 4 && (m.wind_spd ?? 0) >= 4;
      rows.push({
        station, metar_id: m.id, taf_id: t.id, obs_time: m.obs_time, hour_time: m.hour_time, taf_issued: t.issued,
        lead_hours: Math.round(((m.hour_time - t.issued) / HOUR) * 10) / 10, operative: t.id === operativeId ? 1 : 0,
        hour_utc: new Date(m.hour_time).getUTCHours(),
        fcst_cat: fcstCat, obs_cat: obsCat, worst_cat: h.worstCategory, cat_hit: catHit, cat_err: catErr, tempo_covered: tempoCovered,
        fcst_ceiling: fcstCeil, obs_ceiling: obsCeil, fcst_vis: fcstVis, obs_vis: obsVis,
        fcst_wdir: fw?.dirDeg ?? null, obs_wdir: m.wind_dir, fcst_wspd: fw?.speedKt ?? null, obs_wspd: m.wind_spd, fcst_gust: fw?.gustKt ?? null, obs_gust: m.wind_gust,
        fcst_wx: JSON.stringify(wxCodes(h.prevailing)), obs_wx: JSON.stringify(obsWx),
        ceiling_err: fc - oc,
        ceiling_log_err: Math.log(fc + 100) - Math.log(oc + 100),
        vis_err: fv != null && ov != null ? fv - ov : null,
        wdir_err: windOk ? angleDiff(fw!.dirDeg!, m.wind_dir!) : null,
        wspd_err: fw && m.wind_spd != null ? fw.speedKt - m.wind_spd : null,
      });
    }
  }
  if (!rows.length) return 0;
  const written = await upsertChunked(db, 'wxc_taf_verification', rows, 'metar_id,taf_id', { ignoreDuplicates: false, select: 'id' });
  return written.length;
}
