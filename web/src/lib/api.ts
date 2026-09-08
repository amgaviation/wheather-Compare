export type FlightCategory = 'VFR' | 'MVFR' | 'IFR' | 'LIFR';
export const CATS: FlightCategory[] = ['VFR', 'MVFR', 'IFR', 'LIFR'];
export const CAT_COLOR: Record<FlightCategory, string> = { VFR: '#22c55e', MVFR: '#3b82f6', IFR: '#ef4444', LIFR: '#d946ef' };

export interface Station {
  icao: string; name: string | null; lat: number; lon: number; elev_ft: number | null; state: string | null; country: string | null; tz: string | null;
  iata: string | null; faa: string | null; has_taf: number; nws_office: string | null; nws_grid_id: string | null; nws_radar: string | null;
  added_at: number; backfill_days: number | null; backfill_status: string; backfill_message: string | null; backfill_done_at: number | null; enabled: number;
  latest?: { time: number; category: FlightCategory | null; raw: string; ceilingFt: number | null; visSm: number | null; windDir: number | null; windSpd: number | null; windGust: number | null; tempC: number | null; dewpC: number | null; altimInHg: number | null } | null;
  latestTaf?: { issued: number; validFrom: number; validTo: number; amended: boolean } | null;
  counts?: { m: number; t: number; v: number };
}

export interface Wind { dirDeg: number | null; variable: boolean; speedKt: number; gustKt: number | null; varFromDeg?: number; varToDeg?: number }
export interface CloudLayer { cover: string; baseFt: number | null; type?: string }
export interface WxPhenomenon { raw: string; intensity: string; descriptor: string | null; phenomena: string[] }
export interface Conditions { wind: Wind | null; visibility: { sm: number; plus: boolean; meters?: number; less?: boolean } | null; weather: WxPhenomenon[]; clouds: CloudLayer[]; verticalVisFt: number | null; cavok: boolean; nsw?: boolean; windShear?: { heightFt: number; dirDeg: number; speedKt: number } | null }

export interface LightMetar {
  id: number; time: number; hourTime: number; type: string; raw: string; category: FlightCategory | null; ceilingFt: number | null; visSm: number | null; wind: Wind | null;
  tempC: number | null; dewpC: number | null; altimInHg: number | null; slpHpa: number | null; wx: string[]; clouds: CloudLayer[]; rvr: Array<{ runway: string; minFt: number; maxFt: number | null; qualifier: string | null; trend: string | null }>;
  remarks: Record<string, unknown>; verticalVisFt: number | null; auto: boolean;
}

export interface TafGroup { kind: string; raw: string; from: number; to: number; probability: number | null; cond: Conditions }
export interface Taf { raw: string; station: string; amended: boolean; corrected: boolean; cancelled: boolean; nil: boolean; issued: number; validFrom: number; validTo: number; groups: TafGroup[]; maxTemp: { c: number; time: number } | null; minTemp: { c: number; time: number } | null; parseWarnings: string[] }
export interface TafHour { time: number; prevailing: Conditions; prevailingCeilingFt: number | null; prevailingCategory: FlightCategory | null; alternates: Array<{ kind: string; probability: number; cond: Conditions; ceilingFt: number | null; category: FlightCategory | null }>; worstCategory: FlightCategory | null; worstCeilingFt: number | null; worstVisSm: number | null; sourceGroups: string[] }

export interface CurrentResponse {
  station: Station;
  metar: (LightMetar & { decoded: unknown; ageMin: number }) | null;
  tafs: Array<{ id: number; issued: number; validFrom: number; validTo: number; amended: boolean; raw: string; taf: Taf; hours: TafHour[]; current: boolean }>;
  sun: { sunrise: number | null; sunset: number | null; civilDawn: number | null; civilDusk: number | null };
}

export interface HistoryResponse {
  station: string; start: number; end: number; metars: LightMetar[];
  tafs: Array<{ id: number; issued: number; validFrom: number; validTo: number; amended: boolean; raw: string; hours: Array<{ time: number; cat: FlightCategory | null; ceilingFt: number | null; visSm: number | null; wind: Wind | null; worstCat: FlightCategory | null; worstCeilingFt: number | null; worstVisSm: number | null; wx: string[]; alternates: Array<{ kind: string; cat: FlightCategory | null; ceilingFt: number | null; wx: string[] }> }> }>;
  verification: Array<{ hour_time: number; taf_id: number; lead_hours: number; fcst_cat: FlightCategory | null; obs_cat: FlightCategory | null; worst_cat: FlightCategory | null; cat_hit: number | null; cat_err: number | null; tempo_covered: number | null; fcst_ceiling: number | null; obs_ceiling: number | null; fcst_vis: number | null; obs_vis: number | null; fcst_wspd: number | null; obs_wspd: number | null; fcst_wdir: number | null; obs_wdir: number | null; wspd_err: number | null; wdir_err: number | null }>;
  nws: Array<{ issued: number; hours: Array<{ valid_time: number; temp_c: number | null; dewp_c: number | null; wind_dir: number | null; wind_spd: number | null; wind_gust: number | null; sky_pct: number | null; pop: number | null; ceiling_ft: number | null; vis_sm: number | null; wx: string | null; short_forecast: string | null }> }>;
}

export type Probs = Record<FlightCategory, number>;
export interface OutlookHour {
  time: number; leadHours: number; night: boolean; probs: Probs; likely: FlightCategory; confidence: number; pIfrOrWorse: number; pMvfrOrWorse: number;
  ceilingFt: number | null; ceilingLowFt: number | null; visSm: number | null; visLowSm: number | null;
  wind: { dirDeg: number | null; speedKt: number | null; gustKt: number | null; source: string; adjustedKt: number | null } | null;
  tempC: number | null; dewpC: number | null; spreadC: number | null; pop: number | null; probThunder: number | null; wxSummary: string[]; flags: string[];
  weights: { taf: number; nws: number; models: number; climo: number; persistence: number };
  sources: {
    taf: { cat: FlightCategory | null; ceilingFt: number | null; visSm: number | null; wind: Wind | null; wx: string[]; alternates: Array<{ kind: string; probability: number; cat: FlightCategory | null; ceilingFt: number | null; visSm: number | null; wx: string[] }>; worstCat: FlightCategory | null; leadBucket: string | null; calibrated: Probs; skill: number | null; groups: string[] } | null;
    nws: { cat: FlightCategory | null; ceilingFt: number | null; visSm: number | null; skyPct: number | null; pop: number | null; probThunder: number | null; wind: { dirDeg: number | null; speedKt: number | null; gustKt: number | null }; tempC: number | null; dewpC: number | null; wx: string | null; shortForecast: string | null; leadDay: number; calibrated: Probs; skill: number | null } | null;
    models: Array<{ model: string; label: string; cat: FlightCategory; ceilingGuessFt: number | null; visGuessSm: number | null; cloudLowPct: number | null; cloudPct: number | null; wind: { dirDeg: number | null; speedKt: number | null; gustKt: number | null }; tempC: number | null; dewpC: number | null; precipMm: number | null; pop: number | null; cape: number | null; wx: string; calibrated: Probs; skill: number | null }>;
    climo: Probs | null; persistence: { cat: FlightCategory; weight: number } | null;
  };
}
export interface OutlookDay { date: string; label: string; sunrise: number | null; sunset: number | null; hours: number; worstLikely: FlightCategory; pAnyIfr: number; pAnyMvfr: number; concernWindows: Array<{ from: number; to: number; pIfr: number; likely: FlightCategory; drivers: string[] }>; maxGustKt: number | null; maxWindKt: number | null; maxPop: number | null; maxThunder: number | null; minTempC: number | null; maxTempC: number | null; confidence: number; modelAgreement: number | null; summary: string }
export interface Outlook {
  station: string; generatedAt: number; horizonHours: number; tz: string;
  sources: { taf: { issued: number; validFrom: number; validTo: number; raw: string; amended: boolean } | null; nws: { issued: number; office: string | null } | null; models: string[]; climoObsCount: number; verificationPairs: number; historyDays: number };
  hours: OutlookHour[]; days: OutlookDay[];
  trends: {
    pressure: { slp3hHpa: number | null; slp6hHpa: number | null; altim3hInHg: number | null; tendencyCode: number | null; rapid: string | null };
    spread: { nowC: number | null; change3hC: number | null }; ceiling: { nowFt: number | null; change3hFt: number | null; change6hFt: number | null }; vis: { nowSm: number | null; change3hSm: number | null };
    wind: { nowKt: number | null; change3hKt: number | null; dirChange3hDeg: number | null; gustKt: number | null }; category: { now: FlightCategory | null; sequence6h: Array<FlightCategory | null> };
    tafDrift: { issuances: number; meanRankChange: number | null; verdict: string; detail: string }; modelAgreementNext24: number | null;
  };
  insights: string[];
  skill: { tafByLead: Record<string, number | null>; nwsByLeadDay: Record<string, number | null>; modelByLeadDay: Record<string, Record<string, number | null>> };
}

export interface Contingency { threshold: FlightCategory; hits: number; misses: number; falseAlarms: number; correctNegatives: number; n: number; pod: number | null; far: number | null; csi: number | null; bias: number | null; hss: number | null; pss: number | null; baseRate: number | null; withTempo: { hits: number; misses: number; falseAlarms: number; correctNegatives: number; pod: number | null; far: number | null; csi: number | null; bias: number | null } }
export interface ElementErrors { n: number; ceiling: { mae: number | null; bias: number | null; medianErr: number | null; n: number; withinOneCat: number | null; logMae: number | null }; visibility: { mae: number | null; bias: number | null; n: number }; windSpeed: { mae: number | null; bias: number | null; rmse: number | null; n: number; gustMissed: number | null; gustFalse: number | null }; windDir: { mae: number | null; bias: number | null; within30: number | null; n: number }; category: { hitRate: number | null; tempoCoveredRate: number | null; meanErr: number | null; tooOptimistic: number | null; tooPessimistic: number | null; n: number } }
export interface Hist { from: number; to: number; n: number }
export interface VerificationReport {
  station: string; days: number; span: { from: number; to: number } | null; pairs: number; operativePairs: number;
  operative: { errors: ElementErrors; ifr: Contingency; mvfr: Contingency; lifr: Contingency; confusion: number[][]; histograms: { ceiling: Hist[]; visibility: Hist[]; windSpeed: Hist[]; windDir: Hist[] }; wx: Array<{ phenomenon: string; hits: number; misses: number; falseAlarms: number; pod: number | null; far: number | null; csi: number | null; obsHours: number }> };
  byLead: Array<{ lead: string; n: number; errors: ElementErrors; ifr: Contingency; mvfr: Contingency; lifr: Contingency; confusion: number[][] }>;
  calibration: Record<string, Record<FlightCategory, { probs: Probs; n: number }>>;
  diurnal: Array<{ hourUtc: number; n: number; hitRate: number | null; obsIfrRate: number | null; fcstIfrRate: number | null; obsMvfrRate: number | null; fcstMvfrRate: number | null; meanCatErr: number | null; ceilingBias: number | null; windSpdBias: number | null }>;
  busts: Array<{ hourTime: number; leadHours: number; fcstCat: FlightCategory; obsCat: FlightCategory; worstCat: FlightCategory | null; fcstCeiling: number | null; obsCeiling: number | null; fcstVis: number | null; obsVis: number | null; metarRaw: string; tafRaw: string; tafIssued: number; kind: string }>;
  amendments: { total: number; amended: number; amendmentRate: number | null; perDay: number | null; amendmentsPerDay: number | null; medianGapHours: number | null; amendmentsByHourUtc: number[]; days: number };
  nws: Array<{ leadDay: number; n: number; temp: { mae: number | null; bias: number | null }; dewp: { mae: number | null; bias: number | null }; windSpd: { mae: number | null; bias: number | null }; windDir: { mae: number | null; within30: number | null; n: number }; sky: { mae: number | null; bias: number | null; n: number }; category: { hitRate: number | null; n: number; ifr: Contingency | null; mvfr: Contingency | null }; confusion: number[][] }>;
  models: Array<{ model: string; leadDays: number; n: number; temp: { mae: number | null; bias: number | null }; dewp: { mae: number | null; bias: number | null }; windSpd: { mae: number | null; bias: number | null }; windDir: { mae: number | null; within30: number | null; n: number }; lowCloud: { mae: number | null; bias: number | null; n: number }; category: { hitRate: number | null; n: number; ifrPod: number | null; ifrFar: number | null }; confusion: number[][] }>;
  climatology: { byMonthHour: Record<string, Record<string, Record<FlightCategory, number>>>; byHour: Record<string, Record<string, Record<FlightCategory, number>>>; overall: Record<string, number>; span: { a: number; b: number; n: number } };
}

export interface HazardItem { kind: string; hazard: string; severity: string | null; id: string; validFrom: number; validTo: number; base: number | null; top: number | null; distanceNm: number; inside: boolean; raw: string; coords: Array<{ lat: number; lon: number }>; extra?: Record<string, unknown> }
export interface StationHazards { station: string; fetchedAt: number; items: HazardItem[]; pireps: Array<{ time: number; distanceNm: number; bearingDeg: number; fltLvl: number | null; acType: string | null; urgent: boolean; turb: string | null; ice: string | null; sky: string | null; wx: string | null; temp: number | null; wind: string | null; raw: string; lat: number; lon: number }>; alerts: Array<{ id: string; event: string; severity: string; urgency: string; headline: string; description: string; onset: string | null; ends: string | null; expires: string; senderName: string; areaDesc: string }> }
export interface AllHazards { sigmets: Array<{ type: string; hazard: string; severity: string | null; validFrom: number; validTo: number; top: number | null; base: number | null; raw: string; coords: Array<{ lat: number; lon: number }> }>; gairmets: Array<{ product: string; hazard: string; severity: string | null; forecastHour: number; validTime: number; base: string | null; top: string | null; coords: Array<{ lat: number; lon: number }> }>; cwas: Array<{ cwsu: string; hazard: string; validFrom: number; validTo: number; raw: string; coords: Array<{ lat: number; lon: number }> }> }
export interface WindsAloft { unsupported?: boolean; reason?: string; region: string; nearest: Array<{ id: string; name: string; distanceNm: number }>; forecasts: Array<{ fcst: string; header: string; basedOn: string; validFor: string; levels: string[]; rows: Array<{ station: string; levels: Record<string, { dirDeg: number | null; speedKt: number | null; tempC: number | null; lightVariable: boolean }> }> }>; high: { header: string; basedOn: string; validFor: string; levels: string[]; rows: Array<{ station: string; levels: Record<string, { dirDeg: number | null; speedKt: number | null; tempC: number | null; lightVariable: boolean }> }> } | null }
export interface Status { now: number; config: { backfillDays: number; useOpenMeteo: boolean; intervals: Record<string, number>; defaultStations: string[] }; counts: Record<string, number>; lastOk: Array<{ source: string; at: number }>; log: Array<{ id: number; at: number; source: string; station: string | null; ok: number; message: string; count: number | null }> }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  stations: () => req<Station[]>('/api/stations'),
  addStation: (icao: string, days?: number) => req<Station>('/api/stations', { method: 'POST', body: JSON.stringify({ icao, days }) }),
  removeStation: (icao: string) => req<{ ok: boolean }>(`/api/stations/${icao}`, { method: 'DELETE' }),
  backfill: (icao: string, days?: number) => req<{ started: boolean }>(`/api/stations/${icao}/backfill`, { method: 'POST', body: JSON.stringify({ days }) }),
  refresh: () => req<{ ok: boolean }>('/api/refresh', { method: 'POST' }),
  current: (icao: string) => req<CurrentResponse>(`/api/stations/${icao}/current`),
  history: (icao: string, hours: number) => req<HistoryResponse>(`/api/stations/${icao}/history?hours=${hours}`),
  verification: (icao: string, days: number) => req<VerificationReport>(`/api/stations/${icao}/verification?days=${days}`),
  outlook: (icao: string, hours = 120) => req<Outlook>(`/api/stations/${icao}/outlook?hours=${hours}`),
  hazards: (icao: string, radius = 200) => req<StationHazards>(`/api/stations/${icao}/hazards?radius=${radius}`),
  allHazards: () => req<AllHazards>('/api/hazards'),
  windsAloft: (icao: string) => req<WindsAloft>(`/api/stations/${icao}/winds-aloft`),
  decode: (text: string) => req<{ kind: 'TAF'; taf: Taf; hours: TafHour[] } | { kind: 'METAR'; metar: unknown }>('/api/decode', { method: 'POST', body: JSON.stringify({ text }) }),
  status: () => req<Status>('/api/status'),
};
