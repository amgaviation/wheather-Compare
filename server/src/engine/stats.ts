/**
 * Verification statistics: categorical skill scores, error distributions, conditional
 * (calibration) tables, diurnal behaviour, busts, amendments, NWS and model verification.
 */
import type { DB } from '../db/index.js';
import { DbError, selectAll } from '../db/index.js';
import { CATEGORY_ORDER, CATEGORY_RANK, type FlightCategory } from '../wx/types.js';
import { CEILING_CAP, VIS_CAP, angleDiff } from './verify.js';

const HOUR = 3600_000;
const DAY = 86_400_000;

export const LEAD_BUCKETS = [
  { key: '0-3', min: 0, max: 3 },
  { key: '3-6', min: 3, max: 6 },
  { key: '6-12', min: 6, max: 12 },
  { key: '12-18', min: 12, max: 18 },
  { key: '18-24', min: 18, max: 24 },
  { key: '24-30', min: 24, max: 30.01 },
] as const;
export type LeadKey = (typeof LEAD_BUCKETS)[number]['key'];

export function leadBucket(lead: number): LeadKey | null {
  for (const b of LEAD_BUCKETS) if (lead >= b.min && lead < b.max) return b.key;
  return null;
}

export interface VRow {
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
  ceiling_err: number | null;
  ceiling_log_err: number | null;
  vis_err: number | null;
  wdir_err: number | null;
  wspd_err: number | null;
  metar_id: number;
  taf_id: number;
}

export async function loadRows(db: DB, station: string, days: number): Promise<VRow[]> {
  const since = Date.now() - days * DAY;
  return selectAll<VRow>((r0, r1) =>
    db.from('wxc_taf_verification').select('*').eq('station', station).gte('hour_time', since).order('hour_time').range(r0, r1),
  );
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const mae = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + Math.abs(b), 0) / xs.length : null);
const rmse = (xs: number[]) => (xs.length ? Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length) : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r3 = (x: number | null) => (x == null ? null : Math.round(x * 1000) / 1000);

export interface Contingency {
  threshold: FlightCategory;
  hits: number;
  misses: number;
  falseAlarms: number;
  correctNegatives: number;
  n: number;
  pod: number | null; // probability of detection (hit rate)
  far: number | null; // false alarm ratio
  csi: number | null; // critical success index (threat score)
  bias: number | null; // frequency bias
  hss: number | null; // Heidke skill score
  pss: number | null; // Peirce skill score
  baseRate: number | null; // observed frequency
  /** Same scores when TEMPO/PROB groups are credited as "forecast yes". */
  withTempo: { hits: number; misses: number; falseAlarms: number; correctNegatives: number; pod: number | null; far: number | null; csi: number | null; bias: number | null };
}

export function contingency(rows: VRow[], threshold: FlightCategory): Contingency {
  const th = CATEGORY_RANK[threshold];
  let a = 0, b = 0, c = 0, d = 0;
  let a2 = 0, b2 = 0, c2 = 0, d2 = 0;
  for (const r of rows) {
    if (r.fcst_cat == null || r.obs_cat == null) continue;
    const fy = CATEGORY_RANK[r.fcst_cat] >= th;
    const oy = CATEGORY_RANK[r.obs_cat] >= th;
    if (fy && oy) a++; else if (fy && !oy) b++; else if (!fy && oy) c++; else d++;
    const fy2 = fy || (r.worst_cat != null && CATEGORY_RANK[r.worst_cat] >= th);
    if (fy2 && oy) a2++; else if (fy2 && !oy) b2++; else if (!fy2 && oy) c2++; else d2++;
  }
  const n = a + b + c + d;
  const scores = (a: number, b: number, c: number, d: number) => {
    const n = a + b + c + d;
    const pod = a + c ? a / (a + c) : null;
    const far = a + b ? b / (a + b) : null;
    const csi = a + b + c ? a / (a + b + c) : null;
    const bias = a + c ? (a + b) / (a + c) : null;
    const expected = n ? ((a + b) * (a + c) + (c + d) * (b + d)) / n : 0;
    const hss = n && n - expected ? (a + d - expected) / (n - expected) : null;
    const pss = a + c && b + d ? a / (a + c) - b / (b + d) : null;
    return { pod: r3(pod), far: r3(far), csi: r3(csi), bias: r3(bias), hss: r3(hss), pss: r3(pss) };
  };
  const s = scores(a, b, c, d);
  const s2 = scores(a2, b2, c2, d2);
  return {
    threshold, hits: a, misses: c, falseAlarms: b, correctNegatives: d, n, ...s, baseRate: n ? r3((a + c) / n) : null,
    withTempo: { hits: a2, misses: c2, falseAlarms: b2, correctNegatives: d2, pod: s2.pod, far: s2.far, csi: s2.csi, bias: s2.bias },
  };
}

export interface ElementErrors {
  n: number;
  ceiling: { mae: number | null; bias: number | null; medianErr: number | null; n: number; withinOneCat: number | null; logMae: number | null };
  visibility: { mae: number | null; bias: number | null; n: number };
  windSpeed: { mae: number | null; bias: number | null; rmse: number | null; n: number; gustMissed: number | null; gustFalse: number | null };
  windDir: { mae: number | null; bias: number | null; within30: number | null; n: number };
  category: { hitRate: number | null; tempoCoveredRate: number | null; meanErr: number | null; tooOptimistic: number | null; tooPessimistic: number | null; n: number };
}

export function elementErrors(rows: VRow[]): ElementErrors {
  const ce: number[] = [], cle: number[] = [], ve: number[] = [], se: number[] = [], de: number[] = [];
  let within1 = 0, cn = 0, within30 = 0;
  let hits = 0, cov = 0, catN = 0, opt = 0, pess = 0; const errs: number[] = [];
  let gustObs = 0, gustMissed = 0, gustFcst = 0, gustFalse = 0;
  for (const r of rows) {
    if (r.ceiling_err != null && (r.obs_ceiling != null || r.fcst_ceiling != null)) {
      ce.push(r.ceiling_err);
      if (r.ceiling_log_err != null) cle.push(r.ceiling_log_err);
      cn++;
      const fc = Math.min(r.fcst_ceiling ?? CEILING_CAP, CEILING_CAP);
      const oc = Math.min(r.obs_ceiling ?? CEILING_CAP, CEILING_CAP);
      if (Math.abs(CATEGORY_RANK[ceilCat(fc)] - CATEGORY_RANK[ceilCat(oc)]) <= 1) within1++;
    }
    if (r.vis_err != null) ve.push(r.vis_err);
    if (r.wspd_err != null) se.push(r.wspd_err);
    if (r.wdir_err != null) {
      de.push(r.wdir_err);
      if (Math.abs(r.wdir_err) <= 30) within30++;
    }
    if (r.cat_hit != null) {
      catN++;
      hits += r.cat_hit;
      if (r.tempo_covered) cov++;
      if (r.cat_err != null) {
        errs.push(r.cat_err);
        if (r.cat_err > 0) opt++;
        if (r.cat_err < 0) pess++;
      }
    }
    const og = (r.obs_gust ?? 0) >= 20 || (r.obs_wspd ?? 0) >= 20;
    const fg = (r.fcst_gust ?? 0) >= 20 || (r.fcst_wspd ?? 0) >= 20;
    if (og) { gustObs++; if (!fg) gustMissed++; }
    if (fg) { gustFcst++; if (!og) gustFalse++; }
  }
  return {
    n: rows.length,
    ceiling: { mae: r3(mae(ce)), bias: r3(mean(ce)), medianErr: r3(median(ce)), n: cn, withinOneCat: cn ? r3(within1 / cn) : null, logMae: r3(mae(cle)) },
    visibility: { mae: r3(mae(ve)), bias: r3(mean(ve)), n: ve.length },
    windSpeed: { mae: r3(mae(se)), bias: r3(mean(se)), rmse: r3(rmse(se)), n: se.length, gustMissed: gustObs ? r3(gustMissed / gustObs) : null, gustFalse: gustFcst ? r3(gustFalse / gustFcst) : null },
    windDir: { mae: r3(mae(de)), bias: r3(mean(de)), within30: de.length ? r3(within30 / de.length) : null, n: de.length },
    category: { hitRate: catN ? r3(hits / catN) : null, tempoCoveredRate: catN ? r3(cov / catN) : null, meanErr: r3(mean(errs)), tooOptimistic: catN ? r3(opt / catN) : null, tooPessimistic: catN ? r3(pess / catN) : null, n: catN },
  };
}

function ceilCat(c: number): FlightCategory {
  if (c < 500) return 'LIFR';
  if (c < 1000) return 'IFR';
  if (c <= 3000) return 'MVFR';
  return 'VFR';
}

/** 4x4 forecast (rows) × observed (cols) counts. */
export function confusion(rows: VRow[]): { matrix: number[][]; labels: FlightCategory[] } {
  const m = CATEGORY_ORDER.map(() => CATEGORY_ORDER.map(() => 0));
  for (const r of rows) {
    if (r.fcst_cat == null || r.obs_cat == null) continue;
    m[CATEGORY_RANK[r.fcst_cat]][CATEGORY_RANK[r.obs_cat]]++;
  }
  return { matrix: m, labels: CATEGORY_ORDER };
}

/**
 * Calibration table: P(observed category | forecast category, lead bucket).
 * Laplace-smoothed toward the identity (a perfect forecast) so sparse cells behave.
 */
export type Calibration = Record<LeadKey, Record<FlightCategory, { probs: Record<FlightCategory, number>; n: number }>>;

export function calibration(rows: VRow[], prior = 3): Calibration {
  const counts: Record<string, Record<string, number[]>> = {};
  for (const b of LEAD_BUCKETS) {
    counts[b.key] = {};
    for (const c of CATEGORY_ORDER) counts[b.key][c] = [0, 0, 0, 0];
  }
  for (const r of rows) {
    if (r.fcst_cat == null || r.obs_cat == null) continue;
    const b = leadBucket(r.lead_hours);
    if (!b) continue;
    counts[b][r.fcst_cat][CATEGORY_RANK[r.obs_cat]]++;
  }
  const out = {} as Calibration;
  for (const b of LEAD_BUCKETS) {
    out[b.key] = {} as Calibration[LeadKey];
    for (const c of CATEGORY_ORDER) {
      const arr = counts[b.key][c];
      const n = arr.reduce((a, x) => a + x, 0);
      // prior mass: mostly on the forecast category, some on neighbours
      const pri = CATEGORY_ORDER.map((o) => {
        const d = Math.abs(CATEGORY_RANK[o] - CATEGORY_RANK[c]);
        return d === 0 ? 0.7 : d === 1 ? 0.12 : 0.03;
      });
      const probs = {} as Record<FlightCategory, number>;
      const tot = n + prior;
      CATEGORY_ORDER.forEach((o, i) => (probs[o] = (arr[i] + prior * pri[i]) / tot));
      out[b.key][c] = { probs, n };
    }
  }
  return out;
}

export interface DiurnalRow {
  hourUtc: number;
  n: number;
  hitRate: number | null;
  obsIfrRate: number | null;
  fcstIfrRate: number | null;
  obsMvfrRate: number | null;
  fcstMvfrRate: number | null;
  meanCatErr: number | null;
  ceilingBias: number | null;
  windSpdBias: number | null;
}

export function diurnal(rows: VRow[]): DiurnalRow[] {
  const out: DiurnalRow[] = [];
  for (let h = 0; h < 24; h++) {
    const rs = rows.filter((r) => r.hour_utc === h && r.fcst_cat && r.obs_cat);
    const n = rs.length;
    const cnt = (f: (r: VRow) => boolean) => (n ? r3(rs.filter(f).length / n) : null);
    out.push({
      hourUtc: h, n,
      hitRate: cnt((r) => r.cat_hit === 1),
      obsIfrRate: cnt((r) => CATEGORY_RANK[r.obs_cat!] >= 2),
      fcstIfrRate: cnt((r) => CATEGORY_RANK[r.fcst_cat!] >= 2),
      obsMvfrRate: cnt((r) => CATEGORY_RANK[r.obs_cat!] >= 1),
      fcstMvfrRate: cnt((r) => CATEGORY_RANK[r.fcst_cat!] >= 1),
      meanCatErr: r3(mean(rs.map((r) => r.cat_err!).filter((x) => x != null))),
      ceilingBias: r3(mean(rs.map((r) => r.ceiling_err!).filter((x) => x != null))),
      windSpdBias: r3(mean(rs.map((r) => r.wspd_err!).filter((x) => x != null))),
    });
  }
  return out;
}

export function histogram(values: number[], edges: number[]): Array<{ from: number; to: number; n: number }> {
  const out = edges.slice(0, -1).map((e, i) => ({ from: e, to: edges[i + 1], n: 0 }));
  for (const v of values) {
    for (const b of out) if (v >= b.from && v < b.to) { b.n++; break; }
  }
  return out;
}

export function errorHistograms(rows: VRow[]) {
  return {
    ceiling: histogram(rows.map((r) => r.ceiling_err!).filter((x) => x != null), [-12000, -5000, -2000, -1000, -500, -200, -50, 50, 200, 500, 1000, 2000, 5000, 12001]),
    visibility: histogram(rows.map((r) => r.vis_err!).filter((x) => x != null), [-6, -4, -2, -1, -0.5, -0.25, 0.25, 0.5, 1, 2, 4, 6.01]),
    windSpeed: histogram(rows.map((r) => r.wspd_err!).filter((x) => x != null), [-30, -15, -10, -6, -3, -1, 1, 3, 6, 10, 15, 30]),
    windDir: histogram(rows.map((r) => r.wdir_err!).filter((x) => x != null), [-180, -120, -90, -60, -30, -10, 10, 30, 60, 90, 120, 181]),
  };
}

/** Present-weather verification for phenomenon classes. */
export function wxVerification(rows: VRow[]) {
  const classes: Record<string, (codes: string[]) => boolean> = {
    'Rain/Drizzle': (c) => c.some((x) => ['RA', 'DZ', 'SH'].includes(x)),
    Snow: (c) => c.some((x) => ['SN', 'SG', 'PL', 'IC', 'GS'].includes(x)),
    Thunderstorm: (c) => c.includes('TS'),
    'Fog/Mist': (c) => c.some((x) => ['FG', 'BR'].includes(x)),
    'Freezing precip': (c) => c.includes('FZ'),
    'Haze/Smoke': (c) => c.some((x) => ['HZ', 'FU'].includes(x)),
  };
  const out: Array<{ phenomenon: string; hits: number; misses: number; falseAlarms: number; pod: number | null; far: number | null; csi: number | null; obsHours: number }> = [];
  const parsed = rows.map((r) => ({ f: JSON.parse(r.fcst_wx) as string[], o: JSON.parse(r.obs_wx) as string[] }));
  for (const [name, fn] of Object.entries(classes)) {
    let a = 0, b = 0, c = 0;
    for (const p of parsed) {
      const fy = fn(p.f);
      const oy = fn(p.o);
      if (fy && oy) a++; else if (fy) b++; else if (oy) c++;
    }
    out.push({ phenomenon: name, hits: a, misses: c, falseAlarms: b, pod: a + c ? r3(a / (a + c)) : null, far: a + b ? r3(b / (a + b)) : null, csi: a + b + c ? r3(a / (a + b + c)) : null, obsHours: a + c });
  }
  return out;
}

export interface Bust {
  hourTime: number;
  leadHours: number;
  fcstCat: FlightCategory;
  obsCat: FlightCategory;
  worstCat: FlightCategory | null;
  fcstCeiling: number | null;
  obsCeiling: number | null;
  fcstVis: number | null;
  obsVis: number | null;
  metarRaw: string;
  tafRaw: string;
  tafIssued: number;
  kind: 'unforecast deterioration' | 'over-forecast' | 'category miss';
}

export async function busts(db: DB, rows: VRow[], limit = 40): Promise<Bust[]> {
  const cand = rows
    .filter((r) => r.operative && r.fcst_cat && r.obs_cat && Math.abs(r.cat_err ?? 0) >= 1)
    .map((r) => ({ r, score: Math.abs(r.cat_err ?? 0) * 10 + (r.tempo_covered ? -5 : 0) + (CATEGORY_RANK[r.obs_cat!] >= 2 ? 3 : 0) }))
    .sort((a, b) => b.score - a.score || b.r.hour_time - a.r.hour_time)
    .slice(0, limit);
  if (!cand.length) return [];
  const metarIds = [...new Set(cand.map((c) => c.r.metar_id))];
  const tafIds = [...new Set(cand.map((c) => c.r.taf_id))];
  const [mRes, tRes] = await Promise.all([
    db.from('wxc_metars').select('id,raw').in('id', metarIds),
    db.from('wxc_tafs').select('id,raw').in('id', tafIds),
  ]);
  if (mRes.error) throw new DbError(`busts metars: ${mRes.error.message}`, mRes.error);
  if (tRes.error) throw new DbError(`busts tafs: ${tRes.error.message}`, tRes.error);
  const mMap = new Map(((mRes.data ?? []) as Array<{ id: number; raw: string }>).map((x) => [x.id, x.raw]));
  const tMap = new Map(((tRes.data ?? []) as Array<{ id: number; raw: string }>).map((x) => [x.id, x.raw]));
  return cand.map(({ r }) => ({
    hourTime: r.hour_time, leadHours: r.lead_hours, fcstCat: r.fcst_cat!, obsCat: r.obs_cat!, worstCat: r.worst_cat,
    fcstCeiling: r.fcst_ceiling, obsCeiling: r.obs_ceiling, fcstVis: r.fcst_vis, obsVis: r.obs_vis,
    metarRaw: mMap.get(r.metar_id) ?? '', tafRaw: tMap.get(r.taf_id) ?? '', tafIssued: r.taf_issued,
    kind: (r.cat_err ?? 0) > 0 ? (r.tempo_covered ? 'category miss' : 'unforecast deterioration') : 'over-forecast',
  }));
}

export async function amendmentStats(db: DB, station: string, days: number) {
  const since = Date.now() - days * DAY;
  const tafs = await selectAll<{ issued: number; amended: number; valid_from: number; valid_to: number }>((r0, r1) =>
    db.from('wxc_tafs').select('issued,amended,valid_from,valid_to').eq('station', station).gte('issued', since).order('issued').range(r0, r1),
  );
  const total = tafs.length;
  const amended = tafs.filter((t) => t.amended).length;
  const gaps: number[] = [];
  for (let i = 1; i < tafs.length; i++) gaps.push((tafs[i].issued - tafs[i - 1].issued) / HOUR);
  const byHour = new Array(24).fill(0) as number[];
  for (const t of tafs) if (t.amended) byHour[new Date(t.issued).getUTCHours()]++;
  const perDay = days ? total / days : null;
  return { total, amended, amendmentRate: total ? r3(amended / total) : null, perDay: r3(perDay), amendmentsPerDay: r3(days ? amended / days : null), medianGapHours: r3(median(gaps)), amendmentsByHourUtc: byHour, days };
}

/** Observation-only climatology: category frequency by month and UTC hour. */
export async function climatology(db: DB, station: string) {
  const rows = await selectAll<{ obs_time: number; category: FlightCategory }>((r0, r1) =>
    db.from('wxc_metars').select('obs_time,category').eq('station', station).eq('type', 'METAR').not('category', 'is', null).range(r0, r1),
  );
  const table: Record<string, Record<string, Record<FlightCategory, number>>> = {};
  const byHour: Record<string, Record<string, Record<FlightCategory, number>>> = { all: {} };
  for (const r of rows) {
    const d = new Date(r.obs_time);
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const hr = String(d.getUTCHours()).padStart(2, '0');
    table[mo] ??= {};
    table[mo][hr] ??= { VFR: 0, MVFR: 0, IFR: 0, LIFR: 0 };
    table[mo][hr][r.category]++;
    byHour.all[hr] ??= { VFR: 0, MVFR: 0, IFR: 0, LIFR: 0 };
    byHour.all[hr][r.category]++;
  }
  const overall: Record<string, number> = { VFR: 0, MVFR: 0, IFR: 0, LIFR: 0 };
  for (const r of rows) overall[r.category]++;
  let a = Infinity, b = -Infinity;
  for (const r of rows) {
    if (r.obs_time < a) a = r.obs_time;
    if (r.obs_time > b) b = r.obs_time;
  }
  const span = rows.length ? { a, b, n: rows.length } : { a: 0, b: 0, n: 0 };
  return { byMonthHour: table, byHour, overall, span };
}

export function climoProbs(table: Awaited<ReturnType<typeof climatology>>['byMonthHour'], month: number, hourUtc: number, minN = 5): Record<FlightCategory, number> | null {
  const mo = month === 0 ? 'all' : String(month).padStart(2, '0');
  const hr = String(hourUtc).padStart(2, '0');
  const cell = table[mo]?.[hr];
  if (!cell) return null;
  const n = cell.VFR + cell.MVFR + cell.IFR + cell.LIFR;
  if (n < minN) return null;
  return { VFR: cell.VFR / n, MVFR: cell.MVFR / n, IFR: cell.IFR / n, LIFR: cell.LIFR / n };
}

/** Observed sky-cover percentage proxy from a METAR cloud list. */
export function obsSkyPct(cloudsJson: string): number | null {
  try {
    const clouds = JSON.parse(cloudsJson) as Array<{ cover: string }>;
    if (!clouds.length) return null;
    const map: Record<string, number> = { CLR: 0, SKC: 0, NSC: 0, NCD: 0, FEW: 19, SCT: 44, BKN: 75, OVC: 100, VV: 100 };
    return Math.max(...clouds.map((c) => map[c.cover] ?? 0));
  } catch {
    return null;
  }
}

function catFromCeilVis(ceilingFt: number | null, visSm: number | null): FlightCategory | null {
  if (ceilingFt == null && visSm == null) return null;
  const c = ceilingFt ?? Infinity;
  const v = visSm ?? Infinity;
  if (c < 500 || v < 1) return 'LIFR';
  if (c < 1000 || v < 3) return 'IFR';
  if (c <= 3000 || v <= 5) return 'MVFR';
  return 'VFR';
}

export interface NwsLeadStats {
  leadDay: number; // 0 = same day (<24h), 1 = 24-48h ...
  n: number;
  temp: { mae: number | null; bias: number | null };
  dewp: { mae: number | null; bias: number | null };
  windSpd: { mae: number | null; bias: number | null };
  windDir: { mae: number | null; within30: number | null; n: number };
  sky: { mae: number | null; bias: number | null; n: number };
  category: { hitRate: number | null; n: number; ifr: Contingency | null; mvfr: Contingency | null };
  confusion: number[][];
}

interface ObsForJoin {
  hour_time: number;
  temp_c: number | null;
  dewp_c: number | null;
  wind_dir: number | null;
  wind_var: number;
  wind_spd: number | null;
  clouds: string;
  category: FlightCategory | null;
  ceiling_ft: number | null;
}

async function loadObsForJoin(db: DB, station: string, since: number, until: number): Promise<Map<number, ObsForJoin>> {
  const rows = await selectAll<ObsForJoin>((r0, r1) =>
    db
      .from('wxc_metars')
      .select('hour_time,temp_c,dewp_c,wind_dir,wind_var,wind_spd,clouds,category,ceiling_ft')
      .eq('station', station)
      .eq('type', 'METAR')
      .gte('hour_time', since)
      .lt('hour_time', until)
      .range(r0, r1),
  );
  // one obs per hour: the fluent select has no dedup key issue here since (station,type='METAR',hour_time)
  // is not unique at the DB level (a station can log more than one METAR in the same hour in rare cases);
  // prefer the first encountered, matching the original "SELECT ... JOIN" which took whichever the join
  // produced first for a given hour (join is 1:1 keyed on hour_time in the overwhelming common case).
  const map = new Map<number, ObsForJoin>();
  for (const r of rows) if (!map.has(r.hour_time)) map.set(r.hour_time, r);
  return map;
}

/** NWS gridpoint hourly forecast verified against observations, by lead day. */
export async function nwsVerification(db: DB, station: string, days: number): Promise<NwsLeadStats[]> {
  const since = Date.now() - days * DAY;
  const now = Date.now();
  const [fcstRows, obsMap] = await Promise.all([
    selectAll<{ issued: number; valid_time: number; temp_c: number | null; dewp_c: number | null; wind_dir: number | null; wind_spd: number | null; sky_pct: number | null; ceiling_ft: number | null; vis_sm: number | null }>((r0, r1) =>
      db.from('wxc_nws_hourly').select('issued,valid_time,temp_c,dewp_c,wind_dir,wind_spd,sky_pct,ceiling_ft,vis_sm').eq('station', station).gte('valid_time', since).lt('valid_time', now).range(r0, r1),
    ),
    loadObsForJoin(db, station, since, now),
  ]);
  // one obs per hour: prefer the first
  const seen = new Set<string>();
  const groups = new Map<number, Array<Record<string, number | string | null>>>();
  for (const f of fcstRows) {
    if (f.issued > f.valid_time) continue;
    const key = `${f.issued}|${f.valid_time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const o = obsMap.get(f.valid_time);
    if (!o) continue;
    const lead = Math.floor((f.valid_time - f.issued) / DAY);
    if (lead < 0 || lead > 7) continue;
    const r: Record<string, number | string | null> = {
      ft: f.temp_c, fd: f.dewp_c, fwd: f.wind_dir, fws: f.wind_spd, fsky: f.sky_pct, fc: f.ceiling_ft, fv: f.vis_sm,
      ot: o.temp_c, od: o.dewp_c, owd: o.wind_dir, owv: o.wind_var, ows: o.wind_spd, oclouds: o.clouds, ocat: o.category,
    };
    const arr = groups.get(lead) ?? [];
    arr.push(r);
    groups.set(lead, arr);
  }
  const out: NwsLeadStats[] = [];
  for (const [lead, rs] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const te: number[] = [], de: number[] = [], se: number[] = [], we: number[] = [], sk: number[] = [];
    let hit = 0, catN = 0;
    const vrows: VRow[] = [];
    const conf = CATEGORY_ORDER.map(() => CATEGORY_ORDER.map(() => 0));
    for (const r of rs) {
      if (r.ft != null && r.ot != null) te.push((r.ft as number) - (r.ot as number));
      if (r.fd != null && r.od != null) de.push((r.fd as number) - (r.od as number));
      if (r.fws != null && r.ows != null) se.push((r.fws as number) - (r.ows as number));
      if (r.fwd != null && r.owd != null && !r.owv && (r.fws as number) >= 4 && (r.ows as number) >= 4) we.push(angleDiff(r.fwd as number, r.owd as number));
      const osky = obsSkyPct(r.oclouds as string);
      if (r.fsky != null && osky != null) sk.push((r.fsky as number) - osky);
      const fcat = catFromCeilVis(r.fc as number | null, r.fv as number | null);
      const ocat = r.ocat as FlightCategory | null;
      if (fcat && ocat) {
        catN++;
        if (fcat === ocat) hit++;
        conf[CATEGORY_RANK[fcat]][CATEGORY_RANK[ocat]]++;
        vrows.push({ fcst_cat: fcat, obs_cat: ocat, worst_cat: fcat } as VRow);
      }
    }
    out.push({
      leadDay: lead, n: rs.length,
      temp: { mae: r3(mae(te)), bias: r3(mean(te)) }, dewp: { mae: r3(mae(de)), bias: r3(mean(de)) },
      windSpd: { mae: r3(mae(se)), bias: r3(mean(se)) }, windDir: { mae: r3(mae(we)), within30: we.length ? r3(we.filter((x) => Math.abs(x) <= 30).length / we.length) : null, n: we.length },
      sky: { mae: r3(mae(sk)), bias: r3(mean(sk)), n: sk.length },
      category: { hitRate: catN ? r3(hit / catN) : null, n: catN, ifr: catN ? contingency(vrows, 'IFR') : null, mvfr: catN ? contingency(vrows, 'MVFR') : null },
      confusion: conf,
    });
  }
  return out;
}

export interface ModelLeadStats {
  model: string;
  leadDays: number;
  n: number;
  temp: { mae: number | null; bias: number | null };
  dewp: { mae: number | null; bias: number | null };
  windSpd: { mae: number | null; bias: number | null };
  windDir: { mae: number | null; within30: number | null; n: number };
  lowCloud: { mae: number | null; bias: number | null; n: number };
  /** Skill of the model-derived category proxy vs observed category. */
  category: { hitRate: number | null; n: number; ifrPod: number | null; ifrFar: number | null };
  confusion: number[][];
}

/** Category proxy from model fields (used both here and in the outlook). */
export function modelCategoryProxy(m: { cloudLowPct: number | null; cloudPct: number | null; visM: number | null; dewpC: number | null; tempC: number | null; wxCode: number | null; windKt: number | null; precipMm: number | null }): { cat: FlightCategory; ceilingGuessFt: number | null; visGuessSm: number | null } {
  const dd = m.tempC != null && m.dewpC != null ? m.tempC - m.dewpC : null;
  // Estimated cloud base from surface dewpoint depression (dry-adiabatic lifting): ~ 400 ft per °C of spread (~222 ft/°F is the classic rule; 125 m per °C ≈ 410 ft)
  const lclFt = dd != null ? Math.max(0, Math.round(dd * 400)) : null;
  const low = m.cloudLowPct ?? 0;
  let ceilingGuess: number | null = null;
  if (low >= 60 && lclFt != null) ceilingGuess = Math.max(100, lclFt);
  else if (low >= 60) ceilingGuess = 2500;
  else if (low >= 40 && lclFt != null && lclFt < 1500) ceilingGuess = lclFt; // shallow scattered/broken deck near LCL
  const visM = m.visM;
  let visGuess = visM != null ? visM / 1609.34 : null;
  const wmo = m.wxCode ?? 0;
  if ((wmo === 45 || wmo === 48) && (visGuess == null || visGuess > 1)) visGuess = 0.75;
  if (m.precipMm != null && m.precipMm >= 2 && (visGuess == null || visGuess > 3)) visGuess = 3;
  const cat = catFromCeilVis(ceilingGuess, visGuess == null ? null : Math.min(10, visGuess)) ?? 'VFR';
  return { cat, ceilingGuessFt: ceilingGuess, visGuessSm: visGuess == null ? null : Math.round(visGuess * 100) / 100 };
}

export async function modelVerification(db: DB, station: string, days: number): Promise<ModelLeadStats[]> {
  const since = Date.now() - days * DAY;
  const now = Date.now();
  const [fcstRows, obsMap] = await Promise.all([
    selectAll<{ model: string; lead_days: number; valid_time: number; temp_c: number | null; dewp_c: number | null; wind_dir: number | null; wind_spd: number | null; cloud_low_pct: number | null; cloud_pct: number | null; vis_m: number | null; wx_code: number | null; precip_mm: number | null }>((r0, r1) =>
      db
        .from('wxc_model_hourly')
        .select('model,lead_days,valid_time,temp_c,dewp_c,wind_dir,wind_spd,cloud_low_pct,cloud_pct,vis_m,wx_code,precip_mm')
        .eq('station', station)
        .gt('lead_days', 0)
        .gte('valid_time', since)
        .lt('valid_time', now)
        .range(r0, r1),
    ),
    loadObsForJoin(db, station, since, now),
  ]);
  const groups = new Map<string, Array<Record<string, number | string | null>>>();
  const seen = new Set<string>();
  for (const f of fcstRows) {
    const key = `${f.model}|${f.lead_days}|${f.valid_time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const o = obsMap.get(f.valid_time);
    if (!o) continue;
    const g = `${f.model}|${f.lead_days}`;
    const r: Record<string, number | string | null> = {
      ft: f.temp_c, fd: f.dewp_c, fwd: f.wind_dir, fws: f.wind_spd, flow: f.cloud_low_pct, fcl: f.cloud_pct, fv: f.vis_m, fwx: f.wx_code, fp: f.precip_mm,
      ot: o.temp_c, od: o.dewp_c, owd: o.wind_dir, owv: o.wind_var, ows: o.wind_spd, oclouds: o.clouds, ocat: o.category, oceil: o.ceiling_ft,
    };
    const arr = groups.get(g) ?? [];
    arr.push(r);
    groups.set(g, arr);
  }
  const out: ModelLeadStats[] = [];
  for (const [g, rs] of groups) {
    const [model, ld] = g.split('|');
    const te: number[] = [], de: number[] = [], se: number[] = [], we: number[] = [], lc: number[] = [];
    let hit = 0, catN = 0, a = 0, b = 0, c = 0;
    const conf = CATEGORY_ORDER.map(() => CATEGORY_ORDER.map(() => 0));
    for (const r of rs) {
      if (r.ft != null && r.ot != null) te.push((r.ft as number) - (r.ot as number));
      if (r.fd != null && r.od != null) de.push((r.fd as number) - (r.od as number));
      if (r.fws != null && r.ows != null) se.push((r.fws as number) - (r.ows as number));
      if (r.fwd != null && r.owd != null && !r.owv && (r.fws as number) >= 4 && (r.ows as number) >= 4) we.push(angleDiff(r.fwd as number, r.owd as number));
      const osky = obsSkyPct(r.oclouds as string);
      const oceil = r.oceil as number | null;
      if (r.flow != null && osky != null) lc.push((r.flow as number) - (oceil != null && oceil <= 6500 ? osky : 0));
      const ocat = r.ocat as FlightCategory | null;
      if (ocat) {
        const proxy = modelCategoryProxy({ cloudLowPct: r.flow as number | null, cloudPct: r.fcl as number | null, visM: r.fv as number | null, dewpC: r.fd as number | null, tempC: r.ft as number | null, wxCode: r.fwx as number | null, windKt: r.fws as number | null, precipMm: r.fp as number | null });
        catN++;
        if (proxy.cat === ocat) hit++;
        conf[CATEGORY_RANK[proxy.cat]][CATEGORY_RANK[ocat]]++;
        const fy = CATEGORY_RANK[proxy.cat] >= 2;
        const oy = CATEGORY_RANK[ocat] >= 2;
        if (fy && oy) a++; else if (fy) b++; else if (oy) c++;
      }
    }
    out.push({
      model, leadDays: parseInt(ld, 10), n: rs.length,
      temp: { mae: r3(mae(te)), bias: r3(mean(te)) }, dewp: { mae: r3(mae(de)), bias: r3(mean(de)) }, windSpd: { mae: r3(mae(se)), bias: r3(mean(se)) },
      windDir: { mae: r3(mae(we)), within30: we.length ? r3(we.filter((x) => Math.abs(x) <= 30).length / we.length) : null, n: we.length },
      lowCloud: { mae: r3(mae(lc)), bias: r3(mean(lc)), n: lc.length },
      category: { hitRate: catN ? r3(hit / catN) : null, n: catN, ifrPod: a + c ? r3(a / (a + c)) : null, ifrFar: a + b ? r3(b / (a + b)) : null },
      confusion: conf,
    });
  }
  return out.sort((x, y) => x.model.localeCompare(y.model) || x.leadDays - y.leadDays);
}

/** Full verification report for a station. */
export async function report(db: DB, station: string, days: number) {
  const all = await loadRows(db, station, days);
  const op = all.filter((r) => r.operative === 1);
  const byLead = LEAD_BUCKETS.map((b) => {
    const rs = all.filter((r) => r.lead_hours >= b.min && r.lead_hours < b.max);
    return {
      lead: b.key, n: rs.length,
      errors: elementErrors(rs),
      ifr: contingency(rs, 'IFR'), mvfr: contingency(rs, 'MVFR'), lifr: contingency(rs, 'LIFR'),
      confusion: confusion(rs).matrix,
    };
  });
  const span = all.length ? { from: all[0].hour_time, to: all[all.length - 1].hour_time } : null;
  const [bustsResult, amendments, nws, models, climatologyResult] = await Promise.all([
    busts(db, op, 40),
    amendmentStats(db, station, days),
    nwsVerification(db, station, days),
    modelVerification(db, station, days),
    climatology(db, station),
  ]);
  return {
    station, days, span, pairs: all.length, operativePairs: op.length,
    operative: { errors: elementErrors(op), ifr: contingency(op, 'IFR'), mvfr: contingency(op, 'MVFR'), lifr: contingency(op, 'LIFR'), confusion: confusion(op).matrix, histograms: errorHistograms(op), wx: wxVerification(op) },
    byLead,
    calibration: calibration(all),
    diurnal: diurnal(op),
    busts: bustsResult,
    amendments,
    nws,
    models,
    climatology: climatologyResult,
  };
}
