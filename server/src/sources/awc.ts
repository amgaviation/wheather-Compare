/**
 * aviationweather.gov Data API (free, public, no key). https://aviationweather.gov/data/api/
 */
import { fetchJson, fetchText, TtlCache } from './http.js';

const BASE = 'https://aviationweather.gov/api/data';

export interface AwcMetar {
  icaoId: string;
  obsTime: number; // epoch seconds
  reportTime?: string;
  receiptTime?: string;
  rawOb: string;
  metarType?: 'METAR' | 'SPECI';
  fltCat?: string;
  lat?: number;
  lon?: number;
  name?: string;
}

export interface AwcTaf {
  icaoId: string;
  issueTime: string;
  bulletinTime?: string;
  validTimeFrom: number;
  validTimeTo: number;
  rawTAF: string;
  mostRecent?: number;
  lat?: number;
  lon?: number;
  name?: string;
}

export interface AwcStation {
  icaoId: string;
  iataId?: string;
  faaId?: string;
  site: string;
  lat: number;
  lon: number;
  elev: number; // meters
  state?: string;
  country?: string;
  priority?: number;
  siteType?: string[];
}

export async function fetchMetars(ids: string[], hours = 3): Promise<AwcMetar[]> {
  if (!ids.length) return [];
  return fetchJson<AwcMetar[]>(`${BASE}/metar?ids=${ids.join(',')}&format=json&hours=${hours}`);
}

export async function fetchTafs(ids: string[]): Promise<AwcTaf[]> {
  if (!ids.length) return [];
  return fetchJson<AwcTaf[]>(`${BASE}/taf?ids=${ids.join(',')}&format=json`);
}

export async function fetchStationInfo(ids: string[]): Promise<AwcStation[]> {
  if (!ids.length) return [];
  return fetchJson<AwcStation[]>(`${BASE}/stationinfo?ids=${ids.join(',')}&format=json`);
}

export interface AwcPirep {
  receiptTime: string;
  obsTime: number;
  icaoId: string;
  acType?: string;
  lat: number;
  lon: number;
  fltLvl?: number;
  fltLvlType?: string;
  temp?: number | null;
  wdir?: number | null;
  wspd?: number | null;
  wxString?: string;
  icgBas1?: number | null; icgTop1?: number | null; icgInt1?: string; icgType1?: string;
  icgBas2?: number | null; icgTop2?: number | null; icgInt2?: string; icgType2?: string;
  tbBas1?: number | null; tbTop1?: number | null; tbInt1?: string; tbType1?: string; tbFreq1?: string;
  tbBas2?: number | null; tbTop2?: number | null; tbInt2?: string; tbType2?: string; tbFreq2?: string;
  clouds?: unknown;
  visib?: number | null;
  vertGust?: number | null;
  pirepType: string; // PIREP | Urgent PIREP | AIREP
  rawOb: string;
}

export interface AwcAirSigmet {
  icaoId: string;
  alphaChar?: string;
  seriesId?: string;
  receiptTime: string;
  creationTime: string;
  validTimeFrom: number;
  validTimeTo: number;
  airSigmetType: 'SIGMET' | 'AIRMET' | 'OUTLOOK';
  hazard: string; // CONVECTIVE, TURB, ICE, IFR, MTN OBSCN, ...
  severity?: string;
  altitudeHi1?: number | null; altitudeHi2?: number | null; altitudeLow1?: number | null; altitudeLow2?: number | null;
  movementDir?: number | null; movementSpd?: number | null;
  rawAirSigmet: string;
  coords?: Array<{ lat: number; lon: number }>;
}

export interface AwcGairmet {
  tag: string;
  forecastHour: number;
  validTime: string;
  hazard: string; // TURB-HI TURB-LO LLWS SFC_WND ICE FZLVL MT_OBSC IFR M_FZLVL
  geometryType: string;
  severity?: string | null;
  due_to?: string | null;
  status?: string;
  top?: string | null;
  base?: string | null;
  fzltop?: string | null;
  fzlbase?: string | null;
  level?: string | null;
  issueTime: number;
  expireTime: number;
  product: string; // SIERRA TANGO ZULU
  coords?: Array<{ lat: string | number; lon: string | number }>;
}

export interface AwcCwa {
  cwsu: string;
  name: string;
  receiptTime: string;
  validTimeFrom: number;
  validTimeTo: number;
  seriesId: string;
  hazard: string;
  qualifier?: string;
  base?: number | null;
  top?: number | null;
  coords?: Array<{ lat: string | number; lon: string | number }>;
  rawText: string;
}

const hazardCache = new TtlCache<unknown>(5 * 60_000);

export async function fetchPireps(icao: string, distanceNm = 150, ageHours = 3): Promise<AwcPirep[]> {
  return hazardCache.getOrLoad(`pirep:${icao}:${distanceNm}:${ageHours}`, () =>
    fetchJson<AwcPirep[]>(`${BASE}/pirep?id=${icao}&distance=${distanceNm}&age=${ageHours}&format=json`),
  ) as Promise<AwcPirep[]>;
}

export async function fetchAirSigmets(): Promise<AwcAirSigmet[]> {
  return hazardCache.getOrLoad('airsigmet', () => fetchJson<AwcAirSigmet[]>(`${BASE}/airsigmet?format=json`)) as Promise<AwcAirSigmet[]>;
}

export async function fetchGairmets(): Promise<AwcGairmet[]> {
  return hazardCache.getOrLoad('gairmet', () => fetchJson<AwcGairmet[]>(`${BASE}/gairmet?format=json`)) as Promise<AwcGairmet[]>;
}

export async function fetchCwas(): Promise<AwcCwa[]> {
  return hazardCache.getOrLoad('cwa', () => fetchJson<AwcCwa[]>(`${BASE}/cwa?format=json`)) as Promise<AwcCwa[]>;
}

/** Winds/temps aloft (FB) text product. region: bos|mia|chi|dfw|slc|sfo|alaska|hawaii|other_pac; level low|high; fcst 06|12|24 */
export async function fetchWindsAloft(region: string, level: 'low' | 'high' = 'low', fcst: '06' | '12' | '24' = '06'): Promise<string> {
  return hazardCache.getOrLoad(`fb:${region}:${level}:${fcst}`, () => fetchText(`${BASE}/windtemp?region=${region}&level=${level}&fcst=${fcst}`)) as Promise<string>;
}

export interface WindsAloftRow {
  station: string;
  levels: Record<string, { dirDeg: number | null; speedKt: number | null; tempC: number | null; lightVariable: boolean }>;
}

/** Decode the FB (winds/temps aloft) product into rows. */
export function parseWindsAloft(text: string): { header: string; basedOn: string; validFor: string; levels: string[]; rows: WindsAloftRow[] } {
  const lines = text.split('\n');
  let levels: string[] = [];
  const rows: WindsAloftRow[] = [];
  let basedOn = '';
  let validFor = '';
  let header = '';
  for (const line of lines) {
    if (line.startsWith('DATA BASED ON')) basedOn = line.trim();
    if (line.startsWith('VALID')) validFor = line.trim();
    if (line.startsWith('FD')) header = line.trim();
    if (line.startsWith('FT ')) {
      levels = line.trim().split(/\s+/).slice(1);
      continue;
    }
    if (!levels.length) continue;
    const m = /^([A-Z0-9]{3})\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, stn, restStr] = m;
    // Column widths are fixed; tokens may be blank for low levels below station elevation.
    const cols: string[] = [];
    // Use fixed positions based on header alignment: values are separated by whitespace, but
    // missing low-level entries leave gaps. Handle by matching tokens right-to-left.
    const toks = restStr.trim().split(/\s+/);
    const missing = levels.length - toks.length;
    for (let i = 0; i < missing; i++) cols.push('');
    cols.push(...toks);
    const row: WindsAloftRow = { station: stn, levels: {} };
    levels.forEach((lvl, i) => {
      const tok = cols[i] ?? '';
      row.levels[lvl] = decodeFbToken(tok, parseInt(lvl, 10));
    });
    rows.push(row);
  }
  return { header, basedOn, validFor, levels, rows };
}

function decodeFbToken(tok: string, levelFt: number): { dirDeg: number | null; speedKt: number | null; tempC: number | null; lightVariable: boolean } {
  if (!tok) return { dirDeg: null, speedKt: null, tempC: null, lightVariable: false };
  const m = /^(\d{4})([+-]?\d{2})?$/.exec(tok);
  if (!m) return { dirDeg: null, speedKt: null, tempC: null, lightVariable: false };
  let dd = parseInt(m[1].slice(0, 2), 10);
  let ff = parseInt(m[1].slice(2), 10);
  let lightVariable = false;
  if (dd === 99 && ff === 0) {
    lightVariable = true;
    dd = 0;
    ff = 0;
  } else if (dd >= 51 && dd <= 86) {
    // speed >= 100 kt encoded by adding 50 to direction
    dd -= 50;
    ff += 100;
  }
  let temp: number | null = null;
  if (m[2] != null) {
    const t = parseInt(m[2].replace('+', ''), 10);
    // Above 24,000 ft temps are negative without sign
    temp = levelFt > 24000 && !m[2].startsWith('-') && !m[2].startsWith('+') ? -Math.abs(t) : t;
  }
  return { dirDeg: lightVariable ? null : dd * 10, speedKt: ff, tempC: temp, lightVariable };
}
