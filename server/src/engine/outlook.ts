/**
 * Multi-day outlook: blends the operative TAF, the NWS gridpoint forecast, multi-model NWP
 * guidance, persistence and station climatology into an hourly probabilistic flight-category
 * forecast. Every source is calibrated by how it has actually performed at this station
 * (conditional distributions from the verification history), then combined with skill-based
 * weights that vary with lead time.
 */
import type { DB } from '../db/index.js';
import { CATEGORY_ORDER, CATEGORY_RANK, type FlightCategory, type TafHour } from '../wx/types.js';
import { visValue } from '../wx/flightcat.js';
import { latestMetar, latestTaf, type MetarRow, type StationRow, type TafRow } from './store.js';
import { LEAD_BUCKETS, calibration, climatology, climoProbs, leadBucket, loadRows, modelCategoryProxy, modelVerification, nwsVerification, type Calibration, type LeadKey } from './stats.js';
import { MODELS, MODEL_LABEL, describeWmo, type ModelName } from '../sources/openmeteo.js';
import { isNight, sunTimes } from './solar.js';
import { hourlyObs } from './verify.js';

const HOUR = 3600_000;
const DAY = 86_400_000;
type Probs = Record<FlightCategory, number>;

const zero = (): Probs => ({ VFR: 0, MVFR: 0, IFR: 0, LIFR: 0 });
const oneHot = (c: FlightCategory): Probs => ({ ...zero(), [c]: 1 });
function normalize(p: Probs): Probs {
  const s = p.VFR + p.MVFR + p.IFR + p.LIFR;
  if (!s) return { VFR: 1, MVFR: 0, IFR: 0, LIFR: 0 };
  return { VFR: p.VFR / s, MVFR: p.MVFR / s, IFR: p.IFR / s, LIFR: p.LIFR / s };
}
function addWeighted(acc: Probs, p: Probs, w: number) {
  for (const c of CATEGORY_ORDER) acc[c] += p[c] * w;
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

/** Build P(obs | fcst) from a confusion matrix with a smoothing prior. */
function calibrateMatrix(matrix: number[][] | null, prior = 5): Record<FlightCategory, Probs> {
  const out = {} as Record<FlightCategory, Probs>;
  for (const f of CATEGORY_ORDER) {
    const row = matrix?.[CATEGORY_RANK[f]] ?? [0, 0, 0, 0];
    const n = row.reduce((a, b) => a + b, 0);
    const probs = zero();
    CATEGORY_ORDER.forEach((o, i) => {
      const d = Math.abs(CATEGORY_RANK[o] - CATEGORY_RANK[f]);
      const pri = d === 0 ? 0.82 : d === 1 ? 0.075 : 0.015;
      probs[o] = (row[i] + prior * pri) / (n + prior);
    });
    out[f] = normalize(probs);
  }
  return out;
}

export interface SourceTaf {
  cat: FlightCategory | null;
  ceilingFt: number | null;
  visSm: number | null;
  wind: { dirDeg: number | null; variable: boolean; speedKt: number; gustKt: number | null } | null;
  wx: string[];
  alternates: Array<{ kind: string; probability: number; cat: FlightCategory | null; ceilingFt: number | null; visSm: number | null; wx: string[] }>;
  worstCat: FlightCategory | null;
  leadBucket: LeadKey | null;
  calibrated: Probs;
  skill: number | null;
  groups: string[];
}
export interface SourceNws {
  cat: FlightCategory | null;
  ceilingFt: number | null;
  visSm: number | null;
  skyPct: number | null;
  pop: number | null;
  probThunder: number | null;
  wind: { dirDeg: number | null; speedKt: number | null; gustKt: number | null };
  tempC: number | null;
  dewpC: number | null;
  wx: string | null;
  shortForecast: string | null;
  leadDay: number;
  calibrated: Probs;
  skill: number | null;
}
export interface SourceModel {
  model: ModelName;
  label: string;
  cat: FlightCategory;
  ceilingGuessFt: number | null;
  visGuessSm: number | null;
  cloudLowPct: number | null;
  cloudPct: number | null;
  wind: { dirDeg: number | null; speedKt: number | null; gustKt: number | null };
  tempC: number | null;
  dewpC: number | null;
  precipMm: number | null;
  pop: number | null;
  cape: number | null;
  wx: string;
  calibrated: Probs;
  skill: number | null;
}

export interface OutlookHour {
  time: number;
  leadHours: number;
  night: boolean;
  probs: Probs;
  likely: FlightCategory;
  confidence: number;
  pIfrOrWorse: number;
  pMvfrOrWorse: number;
  ceilingFt: number | null;
  ceilingLowFt: number | null;
  visSm: number | null;
  visLowSm: number | null;
  wind: { dirDeg: number | null; speedKt: number | null; gustKt: number | null; source: string; adjustedKt: number | null } | null;
  tempC: number | null;
  dewpC: number | null;
  spreadC: number | null;
  pop: number | null;
  probThunder: number | null;
  wxSummary: string[];
  flags: string[];
  weights: { taf: number; nws: number; models: number; climo: number; persistence: number };
  sources: { taf: SourceTaf | null; nws: SourceNws | null; models: SourceModel[]; climo: Probs | null; persistence: { cat: FlightCategory; weight: number } | null };
}

export interface OutlookDay {
  date: string; // local date (station tz)
  label: string;
  sunrise: number | null;
  sunset: number | null;
  hours: number;
  worstLikely: FlightCategory;
  pAnyIfr: number;
  pAnyMvfr: number;
  concernWindows: Array<{ from: number; to: number; pIfr: number; likely: FlightCategory; drivers: string[] }>;
  maxGustKt: number | null;
  maxWindKt: number | null;
  maxPop: number | null;
  maxThunder: number | null;
  minTempC: number | null;
  maxTempC: number | null;
  confidence: number;
  modelAgreement: number | null;
  summary: string;
}

export interface Trends {
  pressure: { slp3hHpa: number | null; slp6hHpa: number | null; altim3hInHg: number | null; tendencyCode: number | null; rapid: 'rising' | 'falling' | null };
  spread: { nowC: number | null; change3hC: number | null };
  ceiling: { nowFt: number | null; change3hFt: number | null; change6hFt: number | null };
  vis: { nowSm: number | null; change3hSm: number | null };
  wind: { nowKt: number | null; change3hKt: number | null; dirChange3hDeg: number | null; gustKt: number | null };
  category: { now: FlightCategory | null; sequence6h: Array<FlightCategory | null> };
  tafDrift: { issuances: number; meanRankChange: number | null; verdict: 'worsening' | 'improving' | 'stable' | 'insufficient'; detail: string };
  modelAgreementNext24: number | null;
}

export interface Outlook {
  station: string;
  generatedAt: number;
  horizonHours: number;
  tz: string;
  sources: { taf: { issued: number; validFrom: number; validTo: number; raw: string; amended: boolean } | null; nws: { issued: number; office: string | null } | null; models: string[]; climoObsCount: number; verificationPairs: number; historyDays: number };
  hours: OutlookHour[];
  days: OutlookDay[];
  trends: Trends;
  insights: string[];
  skill: { tafByLead: Record<string, number | null>; nwsByLeadDay: Record<string, number | null>; modelByLeadDay: Record<string, Record<string, number | null>> };
}

interface NwsRow { issued: number; valid_time: number; temp_c: number | null; dewp_c: number | null; rh: number | null; wind_dir: number | null; wind_spd: number | null; wind_gust: number | null; sky_pct: number | null; pop: number | null; ceiling_ft: number | null; vis_sm: number | null; wx: string | null; qpf_mm: number | null; short_forecast: string | null; prob_thunder: number | null }
interface ModelRow { model: ModelName; run_time: number; valid_time: number; temp_c: number | null; dewp_c: number | null; wind_dir: number | null; wind_spd: number | null; wind_gust: number | null; cloud_pct: number | null; cloud_low_pct: number | null; vis_m: number | null; precip_mm: number | null; pop: number | null; wx_code: number | null; cape: number | null; pressure_hpa: number | null }

const outlookCache = new Map<string, { at: number; value: Outlook }>();

export function buildOutlook(db: DB, st: StationRow, horizonHours = 120, historyDays = 120): Outlook {
  const key = `${st.icao}:${horizonHours}`;
  const cached = outlookCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
  const now = Date.now();
  const start = Math.floor(now / HOUR) * HOUR;
  const tz = st.tz ?? 'UTC';

  // ---- history / calibration
  const vrows = loadRows(db, st.icao, historyDays);
  const cal: Calibration = calibration(vrows);
  const tafSkill: Record<string, number | null> = {};
  for (const b of LEAD_BUCKETS) {
    const rs = vrows.filter((r) => r.lead_hours >= b.min && r.lead_hours < b.max && r.cat_hit != null);
    tafSkill[b.key] = rs.length >= 30 ? rs.filter((r) => r.cat_hit === 1).length / rs.length : null;
  }
  const nwsStats = nwsVerification(db, st.icao, historyDays);
  const nwsCal: Record<number, Record<FlightCategory, Probs>> = {};
  const nwsSkill: Record<string, number | null> = {};
  for (let d = 0; d <= 7; d++) {
    const s = nwsStats.find((x) => x.leadDay === d);
    nwsCal[d] = calibrateMatrix(s && s.category.n >= 30 ? s.confusion : null);
    nwsSkill[String(d)] = s && s.category.n >= 30 ? s.category.hitRate : null;
  }
  const modelStats = modelVerification(db, st.icao, historyDays);
  const modelSkill: Record<string, Record<string, number | null>> = {};
  for (const m of MODELS) {
    modelSkill[m] = {};
    for (const ld of [1, 2, 3, 5]) {
      const s = modelStats.find((x) => x.model === m && x.leadDays === ld);
      modelSkill[m][String(ld)] = s && s.category.n >= 30 ? s.category.hitRate : null;
    }
  }
  const climo = climatology(db, st.icao);

  // ---- current sources
  const tafRow = latestTaf(db, st.icao);
  const tafHours: Map<number, TafHour> = new Map();
  let tafMeta: Outlook['sources']['taf'] = null;
  if (tafRow && tafRow.valid_to > start) {
    for (const h of JSON.parse(tafRow.hours) as TafHour[]) tafHours.set(h.time, h);
    tafMeta = { issued: tafRow.issued, validFrom: tafRow.valid_from, validTo: tafRow.valid_to, raw: tafRow.raw, amended: !!tafRow.amended };
  }
  const nwsLatest = db.prepare('SELECT max(issued) i FROM nws_hourly WHERE station=?').get(st.icao) as { i: number | null };
  const nwsRows = nwsLatest.i
    ? (db.prepare('SELECT * FROM nws_hourly WHERE station=? AND issued=? ORDER BY valid_time').all(st.icao, nwsLatest.i) as NwsRow[])
    : [];
  const nwsMap = new Map(nwsRows.map((r) => [r.valid_time, r]));
  const modelRows = db
    .prepare('SELECT * FROM model_hourly WHERE station=? AND lead_days=0 AND valid_time>=? AND run_time=(SELECT max(run_time) FROM model_hourly WHERE station=? AND lead_days=0) ORDER BY valid_time')
    .all(st.icao, start - DAY, st.icao) as ModelRow[];
  const modelMap = new Map<string, ModelRow>();
  for (const r of modelRows) modelMap.set(`${r.model}|${r.valid_time}`, r);
  const recent = db.prepare('SELECT * FROM metars WHERE station=? AND obs_time>=? ORDER BY obs_time').all(st.icao, now - 12 * HOUR) as MetarRow[];
  const current = latestMetar(db, st.icao);
  const currentCat = (current?.category as FlightCategory | null) ?? null;
  const currentAge = current ? (now - current.obs_time) / HOUR : 99;

  // TAF wind-speed bias by lead (for adjusted wind)
  const windBias: Record<string, number> = {};
  for (const b of LEAD_BUCKETS) {
    const xs = vrows.filter((r) => r.lead_hours >= b.min && r.lead_hours < b.max && r.wspd_err != null).map((r) => r.wspd_err!);
    windBias[b.key] = xs.length >= 50 ? xs.reduce((a, x) => a + x, 0) / xs.length : 0;
  }
  const nwsTempBias: Record<number, number> = {};
  for (const s of nwsStats) nwsTempBias[s.leadDay] = s.n >= 48 && s.temp.bias != null ? s.temp.bias : 0;

  const hours: OutlookHour[] = [];
  for (let i = 0; i < horizonHours; i++) {
    const t = start + i * HOUR;
    const lead = i;
    const leadDay = Math.floor(lead / 24);
    const d = new Date(t);
    const night = isNight(t, st.lat, st.lon);
    const acc = zero();
    const weights = { taf: 0, nws: 0, models: 0, climo: 0, persistence: 0 };
    const flags = new Set<string>();
    const wxSummary = new Set<string>();

    // --- TAF
    let sTaf: SourceTaf | null = null;
    const th = tafHours.get(t);
    if (th && tafMeta) {
      const tafLead = (t - tafMeta.issued) / HOUR;
      const lb = leadBucket(Math.max(0, tafLead));
      let probs = zero();
      const base = th.prevailingCategory ? cal[lb ?? '0-3'][th.prevailingCategory].probs : { VFR: 0.7, MVFR: 0.2, IFR: 0.07, LIFR: 0.03 };
      // mix alternates: p_alt * calibrated(alt) + (1 - sum p_alt) * calibrated(prevailing)
      let remaining = 1;
      for (const a of th.alternates) {
        if (!a.category) continue;
        const p = Math.min(0.6, a.probability) * remaining;
        addWeighted(probs, cal[lb ?? '0-3'][a.category].probs, p);
        remaining -= p;
      }
      addWeighted(probs, base, remaining);
      probs = normalize(probs);
      const skill = lb ? tafSkill[lb] : null;
      sTaf = {
        cat: th.prevailingCategory, ceilingFt: th.prevailingCeilingFt, visSm: visValue(th.prevailing.visibility),
        wind: th.prevailing.wind ? { dirDeg: th.prevailing.wind.dirDeg, variable: th.prevailing.wind.variable, speedKt: th.prevailing.wind.speedKt, gustKt: th.prevailing.wind.gustKt } : null,
        wx: th.prevailing.weather.map((w) => w.raw),
        alternates: th.alternates.map((a) => ({ kind: a.kind, probability: a.probability, cat: a.category, ceilingFt: a.ceilingFt, visSm: visValue(a.cond.visibility), wx: a.cond.weather.map((w) => w.raw) })),
        worstCat: th.worstCategory, leadBucket: lb, calibrated: probs, skill, groups: th.sourceGroups,
      };
      const w = 1.6 * (skill ?? 0.8) * (tafLead > 24 ? 0.85 : 1);
      addWeighted(acc, probs, w);
      weights.taf = w;
      for (const x of th.prevailing.weather) wxSummary.add(x.raw);
      for (const a of th.alternates) for (const x of a.cond.weather) wxSummary.add(`${a.kind}: ${x.raw}`);
      if (th.prevailing.windShear) flags.add('LLWS in TAF');
      if (th.alternates.some((a) => a.cond.weather.some((w) => w.descriptor === 'TS')) || th.prevailing.weather.some((w) => w.descriptor === 'TS')) flags.add('Thunderstorms in TAF');
    }

    // --- NWS
    let sNws: SourceNws | null = null;
    const nr = nwsMap.get(t);
    if (nr) {
      const nwsLead = Math.max(0, Math.floor((t - nr.issued) / DAY));
      const cat = catFromCeilVis(nr.ceiling_ft, nr.vis_sm);
      let probs = cat ? { ...nwsCal[Math.min(7, nwsLead)][cat] } : { VFR: 0.75, MVFR: 0.15, IFR: 0.07, LIFR: 0.03 };
      // sky cover / PoP nudges when the grid has no explicit ceiling
      if (nr.ceiling_ft == null && nr.sky_pct != null && nr.sky_pct >= 85) probs = normalize({ VFR: probs.VFR * 0.8, MVFR: probs.MVFR + probs.VFR * 0.15, IFR: probs.IFR + probs.VFR * 0.05, LIFR: probs.LIFR });
      if ((nr.pop ?? 0) >= 60) probs = normalize({ VFR: probs.VFR * 0.85, MVFR: probs.MVFR + probs.VFR * 0.1, IFR: probs.IFR + probs.VFR * 0.05, LIFR: probs.LIFR });
      const skill = nwsSkill[String(Math.min(7, nwsLead))];
      sNws = {
        cat, ceilingFt: nr.ceiling_ft, visSm: nr.vis_sm, skyPct: nr.sky_pct, pop: nr.pop, probThunder: nr.prob_thunder,
        wind: { dirDeg: nr.wind_dir, speedKt: nr.wind_spd, gustKt: nr.wind_gust }, tempC: nr.temp_c, dewpC: nr.dewp_c, wx: nr.wx, shortForecast: nr.short_forecast,
        leadDay: nwsLead, calibrated: probs, skill,
      };
      const w = 1.0 * (skill ?? 0.65) * (lead < 6 ? 0.7 : 1);
      addWeighted(acc, probs, w);
      weights.nws = w;
      if (nr.wx) wxSummary.add(`NWS: ${nr.wx}`);
      if ((nr.prob_thunder ?? 0) >= 30) flags.add('Thunder risk (NWS)');
      if ((nr.wind_gust ?? 0) >= 25) flags.add('Gusts ≥25 kt (NWS)');
    }

    // --- Models
    const sModels: SourceModel[] = [];
    for (const m of MODELS) {
      const r = modelMap.get(`${m}|${t}`);
      if (!r) continue;
      const proxy = modelCategoryProxy({ cloudLowPct: r.cloud_low_pct, cloudPct: r.cloud_pct, visM: r.vis_m, dewpC: r.dewp_c, tempC: r.temp_c, wxCode: r.wx_code, windKt: r.wind_spd, precipMm: r.precip_mm });
      const ldKey = String(leadDay <= 1 ? 1 : leadDay <= 2 ? 2 : leadDay <= 3 ? 3 : 5);
      const ms = modelStats.find((x) => x.model === m && String(x.leadDays) === ldKey);
      const probs = calibrateMatrix(ms && ms.category.n >= 30 ? ms.confusion : null, 6)[proxy.cat];
      const skill = ms && ms.category.n >= 30 ? ms.category.hitRate : null;
      const desc = describeWmo(r.wx_code);
      sModels.push({
        model: m, label: MODEL_LABEL[m], cat: proxy.cat, ceilingGuessFt: proxy.ceilingGuessFt, visGuessSm: proxy.visGuessSm, cloudLowPct: r.cloud_low_pct, cloudPct: r.cloud_pct,
        wind: { dirDeg: r.wind_dir, speedKt: r.wind_spd == null ? null : Math.round(r.wind_spd), gustKt: r.wind_gust == null ? null : Math.round(r.wind_gust) }, tempC: r.temp_c, dewpC: r.dewp_c,
        precipMm: r.precip_mm, pop: r.pop, cape: r.cape, wx: desc.text, calibrated: probs, skill,
      });
      const w = 0.55 * (skill ?? 0.6);
      addWeighted(acc, probs, w);
      weights.models += w;
      if (desc.fog) flags.add(`Fog (${MODEL_LABEL[m]})`);
      if (desc.thunder || (r.cape ?? 0) >= 1500) flags.add(`Convective (${MODEL_LABEL[m]})`);
      if (desc.freezing) flags.add(`Freezing precip (${MODEL_LABEL[m]})`);
    }

    // --- Climatology
    const cp = climoProbs(climo.byMonthHour, d.getUTCMonth() + 1, d.getUTCHours(), 20) ?? climoProbs(climo.byHour, 0, d.getUTCHours(), 20);
    if (cp) {
      const w = 0.12 + 0.06 * leadDay;
      addWeighted(acc, cp, w);
      weights.climo = w;
    }

    // --- Persistence
    let persistence: OutlookHour['sources']['persistence'] = null;
    if (currentCat && currentAge < 3) {
      const w = 1.3 * Math.exp(-(lead + currentAge) / 4);
      if (w > 0.02) {
        addWeighted(acc, oneHot(currentCat), w);
        weights.persistence = w;
        persistence = { cat: currentCat, weight: w };
      }
    }

    const probs = normalize(acc);
    let likely: FlightCategory = 'VFR';
    for (const c of CATEGORY_ORDER) if (probs[c] > probs[likely]) likely = c;
    const pIfr = probs.IFR + probs.LIFR;
    const pMvfr = pIfr + probs.MVFR;
    const confidence = Math.round(probs[likely] * 100) / 100;

    // --- deterministic elements
    const ceilCands = [sTaf?.ceilingFt, sNws?.ceilingFt, ...sModels.map((m) => m.ceilingGuessFt)].filter((x): x is number => x != null);
    const ceilingFt = sTaf ? sTaf.ceilingFt : sNws?.ceilingFt ?? (ceilCands.length ? Math.round(ceilCands.reduce((a, b) => a + b, 0) / ceilCands.length) : null);
    const lowCands = [...ceilCands, ...(sTaf?.alternates.map((a) => a.ceilingFt).filter((x): x is number => x != null) ?? [])];
    const ceilingLowFt = lowCands.length ? Math.min(...lowCands) : null;
    const visCands = [sTaf?.visSm, sNws?.visSm, ...sModels.map((m) => m.visGuessSm)].filter((x): x is number => x != null);
    const visSm = sTaf ? sTaf.visSm : sNws?.visSm ?? (visCands.length ? Math.round((visCands.reduce((a, b) => a + b, 0) / visCands.length) * 4) / 4 : null);
    const visLowSm = visCands.length ? Math.min(...visCands, ...(sTaf?.alternates.map((a) => a.visSm).filter((x): x is number => x != null) ?? [])) : null;
    let wind: OutlookHour['wind'] = null;
    if (sTaf?.wind) {
      const bias = sTaf.leadBucket ? windBias[sTaf.leadBucket] : 0;
      wind = { dirDeg: sTaf.wind.dirDeg, speedKt: sTaf.wind.speedKt, gustKt: sTaf.wind.gustKt, source: 'TAF', adjustedKt: Math.max(0, Math.round(sTaf.wind.speedKt - bias)) };
    } else if (sNws) wind = { dirDeg: sNws.wind.dirDeg, speedKt: sNws.wind.speedKt, gustKt: sNws.wind.gustKt, source: 'NWS', adjustedKt: sNws.wind.speedKt };
    else if (sModels.length) {
      const sp = sModels.map((m) => m.wind.speedKt).filter((x): x is number => x != null);
      const gs = sModels.map((m) => m.wind.gustKt).filter((x): x is number => x != null);
      const dirs = sModels.map((m) => m.wind.dirDeg).filter((x): x is number => x != null);
      const dir = dirs.length ? Math.round((Math.atan2(dirs.reduce((s, x) => s + Math.sin((x * Math.PI) / 180), 0), dirs.reduce((s, x) => s + Math.cos((x * Math.PI) / 180), 0)) * 180) / Math.PI + 360) % 360 : null;
      wind = { dirDeg: dir, speedKt: sp.length ? Math.round(sp.reduce((a, b) => a + b, 0) / sp.length) : null, gustKt: gs.length ? Math.round(Math.max(...gs)) : null, source: 'Models', adjustedKt: null };
    }
    const tempCands = [sNws?.tempC != null ? sNws.tempC - (nwsTempBias[sNws.leadDay] ?? 0) : null, ...sModels.map((m) => m.tempC)].filter((x): x is number => x != null);
    const dewpCands = [sNws?.dewpC, ...sModels.map((m) => m.dewpC)].filter((x): x is number => x != null);
    const tempC = tempCands.length ? Math.round((tempCands.reduce((a, b) => a + b, 0) / tempCands.length) * 10) / 10 : null;
    const dewpC = dewpCands.length ? Math.round((dewpCands.reduce((a, b) => a + b, 0) / dewpCands.length) * 10) / 10 : null;
    const spreadC = tempC != null && dewpC != null ? Math.round((tempC - dewpC) * 10) / 10 : null;
    const popCands = [sNws?.pop, ...sModels.map((m) => m.pop)].filter((x): x is number => x != null);
    const pop = popCands.length ? Math.round(Math.max(...popCands)) : null;
    const probThunder = sNws?.probThunder ?? null;

    // --- flags from physics/consistency
    if (spreadC != null && spreadC <= 2 && night && (wind?.speedKt ?? 0) <= 6) flags.add('Radiation fog/stratus setup (low spread, light wind, night)');
    if (spreadC != null && spreadC <= 1 && (pop ?? 0) >= 40) flags.add('Saturated air with precip: low ceilings likely');
    if (sModels.length >= 2) {
      const cats = new Set(sModels.map((m) => m.cat));
      if (cats.size >= 2 && sModels.some((m) => CATEGORY_RANK[m.cat] >= 2)) flags.add('Model disagreement on IFR');
    }
    if (sTaf && sNws?.cat && sTaf.cat && Math.abs(CATEGORY_RANK[sTaf.cat] - CATEGORY_RANK[sNws.cat]) >= 2) flags.add('TAF and NWS grid disagree by 2+ categories');
    if ((wind?.gustKt ?? 0) >= 30) flags.add('Strong gusts');
    if (wind?.dirDeg != null && wind.speedKt != null && wind.speedKt >= 15 && sTaf?.wind?.dirDeg != null && wind.source !== 'TAF') flags.add('Wind from non-TAF source');

    hours.push({
      time: t, leadHours: lead, night, probs, likely, confidence, pIfrOrWorse: Math.round(pIfr * 1000) / 1000, pMvfrOrWorse: Math.round(pMvfr * 1000) / 1000,
      ceilingFt, ceilingLowFt, visSm, visLowSm, wind, tempC, dewpC, spreadC, pop, probThunder,
      wxSummary: [...wxSummary], flags: [...flags], weights,
      sources: { taf: sTaf, nws: sNws, models: sModels, climo: cp, persistence },
    });
  }

  // ---- day summaries (station local time)
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const fmtLabel = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
  const byDay = new Map<string, OutlookHour[]>();
  for (const h of hours) {
    const k = fmt.format(new Date(h.time));
    const arr = byDay.get(k) ?? [];
    arr.push(h);
    byDay.set(k, arr);
  }
  const days: OutlookDay[] = [];
  for (const [k, hs] of byDay) {
    const noon = hs[Math.floor(hs.length / 2)].time;
    const sun = sunTimes(noon, st.lat, st.lon);
    let worst: FlightCategory = 'VFR';
    for (const h of hs) if (CATEGORY_RANK[h.likely] > CATEGORY_RANK[worst]) worst = h.likely;
    // Hours within a day are strongly correlated; treat 6-hour blocks as quasi-independent episodes.
    const pAny = (sel: (h: OutlookHour) => number) => {
      let p = 1;
      for (let b = 0; b < hs.length; b += 6) p *= 1 - Math.max(...hs.slice(b, b + 6).map(sel));
      return 1 - p;
    };
    const pAnyIfr = pAny((h) => h.pIfrOrWorse);
    const pAnyMvfr = pAny((h) => h.pMvfrOrWorse);
    const windows: OutlookDay['concernWindows'] = [];
    let cur: { from: number; to: number; ps: number[]; likely: FlightCategory; drivers: Set<string> } | null = null;
    for (const h of hs) {
      const concern = h.pIfrOrWorse >= 0.3 || CATEGORY_RANK[h.likely] >= 1;
      if (concern) {
        if (!cur) cur = { from: h.time, to: h.time + HOUR, ps: [], likely: h.likely, drivers: new Set() };
        cur.to = h.time + HOUR;
        cur.ps.push(h.pIfrOrWorse);
        if (CATEGORY_RANK[h.likely] > CATEGORY_RANK[cur.likely]) cur.likely = h.likely;
        for (const f of h.flags) cur.drivers.add(f);
        for (const w of h.wxSummary) cur.drivers.add(w);
      } else if (cur) {
        windows.push({ from: cur.from, to: cur.to, pIfr: Math.round(Math.max(...cur.ps) * 100) / 100, likely: cur.likely, drivers: [...cur.drivers].slice(0, 6) });
        cur = null;
      }
    }
    if (cur) windows.push({ from: cur.from, to: cur.to, pIfr: Math.round(Math.max(...cur.ps) * 100) / 100, likely: cur.likely, drivers: [...cur.drivers].slice(0, 6) });
    const gusts = hs.map((h) => h.wind?.gustKt ?? null).filter((x): x is number => x != null);
    const winds = hs.map((h) => h.wind?.speedKt ?? null).filter((x): x is number => x != null);
    const temps = hs.map((h) => h.tempC).filter((x): x is number => x != null);
    const pops = hs.map((h) => h.pop).filter((x): x is number => x != null);
    const th = hs.map((h) => h.probThunder).filter((x): x is number => x != null);
    const agreeVals = hs.map((h): number | null => (h.sources.models.length >= 2 ? (new Set(h.sources.models.map((m) => m.cat)).size === 1 ? 1 : 0) : null)).filter((x): x is number => x != null);
    const conf = hs.reduce((s, h) => s + h.confidence, 0) / hs.length;
    const label = fmtLabel.format(new Date(noon));
    const wTxt = windows.length ? windows.map((w) => `${fmtHm(w.from, tz)}–${fmtHm(w.to, tz)} ${w.likely}${w.pIfr >= 0.3 ? ` (P(IFR+) ${Math.round(w.pIfr * 100)}%)` : ''}`).join('; ') : 'no MVFR-or-worse periods expected';
    days.push({
      date: k, label, sunrise: sun.sunrise, sunset: sun.sunset, hours: hs.length, worstLikely: worst, pAnyIfr: Math.round(pAnyIfr * 100) / 100, pAnyMvfr: Math.round(pAnyMvfr * 100) / 100,
      concernWindows: windows, maxGustKt: gusts.length ? Math.max(...gusts) : null, maxWindKt: winds.length ? Math.max(...winds) : null, maxPop: pops.length ? Math.max(...pops) : null,
      maxThunder: th.length ? Math.max(...th) : null, minTempC: temps.length ? Math.min(...temps) : null, maxTempC: temps.length ? Math.max(...temps) : null,
      confidence: Math.round(conf * 100) / 100, modelAgreement: agreeVals.length ? Math.round((agreeVals.reduce((a, b) => a + b, 0) / agreeVals.length) * 100) / 100 : null,
      summary: `${label}: worst likely ${worst}; ${wTxt}. P(any IFR+) ${Math.round(pAnyIfr * 100)}%, confidence ${Math.round(conf * 100)}%.`,
    });
  }

  const trends = computeTrends(db, st, recent, current, hours);
  const insights = buildInsights(st, hours, days, trends, vrows.length, tafSkill, nwsSkill, historyDays, cal);

  const out: Outlook = {
    station: st.icao, generatedAt: now, horizonHours, tz,
    sources: { taf: tafMeta, nws: nwsLatest.i ? { issued: nwsLatest.i, office: st.nws_office } : null, models: modelRows.length ? MODELS.map((m) => MODEL_LABEL[m]) : [], climoObsCount: climo.span?.n ?? 0, verificationPairs: vrows.length, historyDays },
    hours, days, trends, insights, skill: { tafByLead: tafSkill, nwsByLeadDay: nwsSkill, modelByLeadDay: modelSkill },
  };
  outlookCache.set(key, { at: now, value: out });
  return out;
}

export function invalidateOutlook(icao?: string) {
  if (!icao) outlookCache.clear();
  else for (const k of [...outlookCache.keys()]) if (k.startsWith(icao + ':')) outlookCache.delete(k);
}

function fmtHm(t: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t));
}

function computeTrends(db: DB, st: StationRow, recent: MetarRow[], current: MetarRow | undefined, hours: OutlookHour[]): Trends {
  const now = current?.obs_time ?? Date.now();
  const at = (hAgo: number) => {
    const target = now - hAgo * HOUR;
    let best: MetarRow | null = null;
    for (const r of recent) if (r.type === 'METAR' && (!best || Math.abs(r.obs_time - target) < Math.abs(best.obs_time - target))) best = r;
    return best && Math.abs(best.obs_time - target) <= 1.5 * HOUR ? best : null;
  };
  const m3 = at(3), m6 = at(6);
  const dec = current ? (JSON.parse(current.decoded) as { remarks: { pressureTendency: { code: number; changeHpa: number } | null; pressureRisingRapidly: boolean; pressureFallingRapidly: boolean } }) : null;
  const diff = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null ? Math.round((a - b) * 100) / 100 : null);
  const spreadNow = current && current.temp_c != null && current.dewp_c != null ? Math.round((current.temp_c - current.dewp_c) * 10) / 10 : null;
  const spread3 = m3 && m3.temp_c != null && m3.dewp_c != null ? m3.temp_c - m3.dewp_c : null;
  const seq = hourlyObs(recent).slice(-6).map((r) => (r.category as FlightCategory | null) ?? null);

  // TAF drift across the last 3 issuances for hours in the next 24h
  const tafs = db.prepare('SELECT id, issued, hours FROM tafs WHERE station=? ORDER BY issued DESC LIMIT 3').all(st.icao) as Array<{ id: number; issued: number; hours: string }>;
  let drift: Trends['tafDrift'] = { issuances: tafs.length, meanRankChange: null, verdict: 'insufficient', detail: 'Fewer than two TAF issuances available.' };
  if (tafs.length >= 2) {
    const maps = tafs.map((t) => new Map((JSON.parse(t.hours) as TafHour[]).map((h) => [h.time, h])));
    const deltas: number[] = [];
    const start = Math.floor(Date.now() / HOUR) * HOUR;
    for (let t = start; t < start + 24 * HOUR; t += HOUR) {
      const a = maps[0].get(t)?.worstCategory;
      const b = maps[maps.length - 1].get(t)?.worstCategory;
      if (a && b) deltas.push(CATEGORY_RANK[a] - CATEGORY_RANK[b]);
    }
    if (deltas.length >= 6) {
      const mean = deltas.reduce((x, y) => x + y, 0) / deltas.length;
      const worse = deltas.filter((d) => d > 0).length;
      const better = deltas.filter((d) => d < 0).length;
      drift = {
        issuances: tafs.length, meanRankChange: Math.round(mean * 100) / 100,
        verdict: mean > 0.1 ? 'worsening' : mean < -0.1 ? 'improving' : 'stable',
        detail: `Latest TAF vs ${tafs.length - 1} issuance(s) earlier (${Math.round((tafs[0].issued - tafs[tafs.length - 1].issued) / HOUR)} h): ${worse} of ${deltas.length} next-24h hours now worse, ${better} better.`,
      };
    }
  }
  const agree = hours.slice(0, 24).map((h): number | null => (h.sources.models.length >= 2 ? (new Set(h.sources.models.map((m) => m.cat)).size === 1 ? 1 : 0) : null)).filter((x): x is number => x != null);
  return {
    pressure: {
      slp3hHpa: diff(current?.slp_hpa, m3?.slp_hpa), slp6hHpa: diff(current?.slp_hpa, m6?.slp_hpa), altim3hInHg: diff(current?.altim_inhg, m3?.altim_inhg),
      tendencyCode: dec?.remarks.pressureTendency?.code ?? null, rapid: dec?.remarks.pressureRisingRapidly ? 'rising' : dec?.remarks.pressureFallingRapidly ? 'falling' : null,
    },
    spread: { nowC: spreadNow, change3hC: spreadNow != null && spread3 != null ? Math.round((spreadNow - spread3) * 10) / 10 : null },
    ceiling: { nowFt: current?.ceiling_ft ?? null, change3hFt: diff(current?.ceiling_ft ?? 12000, m3 ? m3.ceiling_ft ?? 12000 : null), change6hFt: diff(current?.ceiling_ft ?? 12000, m6 ? m6.ceiling_ft ?? 12000 : null) },
    vis: { nowSm: current?.vis_sm ?? null, change3hSm: diff(current?.vis_sm, m3?.vis_sm) },
    wind: { nowKt: current?.wind_spd ?? null, change3hKt: diff(current?.wind_spd, m3?.wind_spd), dirChange3hDeg: current?.wind_dir != null && m3?.wind_dir != null ? Math.round(((current.wind_dir - m3.wind_dir + 540) % 360) - 180) : null, gustKt: current?.wind_gust ?? null },
    category: { now: (current?.category as FlightCategory | null) ?? null, sequence6h: seq },
    tafDrift: drift,
    modelAgreementNext24: agree.length ? Math.round((agree.reduce((a, b) => a + b, 0) / agree.length) * 100) / 100 : null,
  };
}

function buildInsights(st: StationRow, hours: OutlookHour[], days: OutlookDay[], tr: Trends, pairs: number, tafSkill: Record<string, number | null>, nwsSkill: Record<string, number | null>, historyDays: number, cal: Calibration): string[] {
  const out: string[] = [];
  const tz = st.tz ?? 'UTC';
  const pct = (x: number | null | undefined) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`);
  // Next 24 h headline
  const next24 = hours.slice(0, 24);
  const worst24 = next24.reduce<OutlookHour | null>((w, h) => (!w || CATEGORY_RANK[h.likely] > CATEGORY_RANK[w.likely] || (h.likely === w.likely && h.pIfrOrWorse > w.pIfrOrWorse) ? h : w), null);
  if (worst24) {
    const maxIfr = Math.max(...next24.map((h) => h.pIfrOrWorse));
    const peak = next24.find((h) => h.pIfrOrWorse === maxIfr)!;
    out.push(`Next 24 h: worst likely category ${worst24.likely}; peak P(IFR or worse) ${pct(maxIfr)} at ${fmtHm(peak.time, tz)} local (${new Date(peak.time).getUTCHours().toString().padStart(2, '0')}Z).`);
  }
  // Trend statements
  if (tr.pressure.slp3hHpa != null) {
    const p = tr.pressure.slp3hHpa;
    if (p <= -2) out.push(`Pressure falling ${Math.abs(p).toFixed(1)} hPa over 3 h: approaching system or deepening low; expect deteriorating trend to carry into the TAF period.`);
    else if (p >= 2) out.push(`Pressure rising ${p.toFixed(1)} hPa over 3 h: post-frontal improvement/clearing trend likely.`);
  }
  if (tr.spread.nowC != null && tr.spread.nowC <= 3 && tr.spread.change3hC != null && tr.spread.change3hC < 0) out.push(`Temperature/dew point spread has narrowed to ${tr.spread.nowC}°C (down ${Math.abs(tr.spread.change3hC)}°C in 3 h): saturation trend favours fog/low stratus, especially near sunrise.`);
  if (tr.ceiling.change3hFt != null && tr.ceiling.change3hFt <= -1000 && tr.ceiling.nowFt != null) out.push(`Ceiling has lowered ${Math.abs(tr.ceiling.change3hFt)} ft in the last 3 h (now ${tr.ceiling.nowFt} ft).`);
  if (tr.ceiling.change3hFt != null && tr.ceiling.change3hFt >= 1000) out.push(`Ceiling has lifted ${tr.ceiling.change3hFt} ft in the last 3 h.`);
  if (tr.tafDrift.verdict === 'worsening') out.push(`Successive TAFs are trending worse (${tr.tafDrift.detail}) — forecasters are gaining confidence in a deterioration; plan for the pessimistic side.`);
  if (tr.tafDrift.verdict === 'improving') out.push(`Successive TAFs are trending better (${tr.tafDrift.detail}).`);
  if (tr.modelAgreementNext24 != null && tr.modelAgreementNext24 < 0.6) out.push(`Model agreement on flight category for the next 24 h is only ${pct(tr.modelAgreementNext24)}: low predictability; weight the TAF and persistence more heavily and re-check before departure.`);
  // Station calibration facts
  const c12 = cal['12-18'];
  const ifrGivenIfr = c12.IFR.n >= 20 ? c12.IFR.probs.IFR + c12.IFR.probs.LIFR : null;
  const ifrGivenVfr = c12.VFR.n >= 50 ? c12.VFR.probs.IFR + c12.VFR.probs.LIFR : null;
  if (ifrGivenIfr != null) out.push(`Station calibration (last ${historyDays} d, ${pairs} pairs): when the TAF calls IFR at 12–18 h lead, IFR-or-worse actually occurs ${pct(ifrGivenIfr)} of the time here (${c12.IFR.n} cases).`);
  if (ifrGivenVfr != null && ifrGivenVfr >= 0.03) out.push(`Unforecast IFR: even when the TAF calls VFR at 12–18 h lead, IFR-or-worse occurred ${pct(ifrGivenVfr)} of the time (${c12.VFR.n} cases). Keep an alternate in mind on VFR TAFs.`);
  const s6 = tafSkill['0-3'], s24 = tafSkill['24-30'];
  if (s6 != null && s24 != null) out.push(`TAF category accuracy at this station drops from ${pct(s6)} (0–3 h lead) to ${pct(s24)} (24–30 h lead).`);
  const n1 = nwsSkill['1'];
  if (n1 != null) out.push(`NWS gridpoint ceiling/visibility category hits ${pct(n1)} of hours at day-2 lead here; it drives the outlook beyond the TAF window.`);
  // Day-level concerns
  for (const d of days.slice(0, 4)) {
    if (d.concernWindows.length) {
      const w = d.concernWindows.reduce((a, b) => (b.pIfr > a.pIfr ? b : a));
      out.push(`${d.label}: ${d.concernWindows.length} window(s) of concern; highest P(IFR+) ${pct(w.pIfr)} ${fmtHm(w.from, tz)}–${fmtHm(w.to, tz)} local${w.drivers.length ? ` — ${w.drivers.slice(0, 3).join(', ')}` : ''}.`);
    }
  }
  return out;
}
