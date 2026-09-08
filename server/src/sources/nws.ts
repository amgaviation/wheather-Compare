/**
 * NWS API (api.weather.gov) — free, public; requires a User-Agent. https://www.weather.gov/documentation/services-web-api
 */
import { fetchJson, TtlCache } from './http.js';

const BASE = 'https://api.weather.gov';

export interface NwsPoint {
  gridId: string;
  gridX: number;
  gridY: number;
  forecastOffice: string;
  timeZone: string;
  radarStation?: string;
}

export async function fetchPoint(lat: number, lon: number): Promise<NwsPoint> {
  const d = await fetchJson<{ properties: { gridId: string; gridX: number; gridY: number; forecastOffice: string; timeZone: string; radarStation?: string } }>(
    `${BASE}/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
  );
  const p = d.properties;
  return { gridId: p.gridId, gridX: p.gridX, gridY: p.gridY, forecastOffice: p.forecastOffice.split('/').pop() ?? '', timeZone: p.timeZone, radarStation: p.radarStation };
}

export interface NwsHourlyPeriod {
  startTime: string;
  endTime: string;
  temperature: number;
  temperatureUnit: string;
  probabilityOfPrecipitation: { value: number | null };
  dewpoint: { value: number | null; unitCode: string };
  relativeHumidity: { value: number | null };
  windSpeed: string;
  windDirection: string;
  shortForecast: string;
  isDaytime: boolean;
}

export interface NwsHourlyForecast {
  updateTime: string;
  generatedAt: string;
  periods: NwsHourlyPeriod[];
}

export async function fetchHourly(gridId: string, x: number, y: number): Promise<NwsHourlyForecast> {
  const d = await fetchJson<{ properties: NwsHourlyForecast }>(`${BASE}/gridpoints/${gridId}/${x},${y}/forecast/hourly?units=si`, { timeoutMs: 45_000 });
  return d.properties;
}

export interface NwsGridValue {
  validTime: string; // ISO8601 interval "2026-09-07T12:00:00+00:00/PT1H"
  value: number | null;
}
export interface NwsGridSeries {
  uom?: string;
  values: NwsGridValue[];
}
export interface NwsGrid {
  updateTime: string;
  validTimes: string;
  temperature: NwsGridSeries;
  dewpoint: NwsGridSeries;
  relativeHumidity: NwsGridSeries;
  skyCover: NwsGridSeries;
  windDirection: NwsGridSeries;
  windSpeed: NwsGridSeries;
  windGust: NwsGridSeries;
  probabilityOfPrecipitation: NwsGridSeries;
  quantitativePrecipitation: NwsGridSeries;
  ceilingHeight: NwsGridSeries;
  visibility: NwsGridSeries;
  probabilityOfThunder?: NwsGridSeries;
  lowVisibilityOccurrenceRiskIndex?: NwsGridSeries;
  weather?: { values: Array<{ validTime: string; value: Array<{ coverage: string | null; weather: string | null; intensity: string | null; attributes?: string[] }> }> };
  hazards?: { values: Array<{ validTime: string; value: Array<{ phenomenon: string; significance: string; event_number?: number }> }> };
  pressure?: NwsGridSeries;
  mixingHeight?: NwsGridSeries;
}

export async function fetchGrid(gridId: string, x: number, y: number): Promise<NwsGrid> {
  const d = await fetchJson<{ properties: NwsGrid }>(`${BASE}/gridpoints/${gridId}/${x},${y}`, { timeoutMs: 45_000 });
  return d.properties;
}

export interface NwsAlert {
  id: string;
  event: string;
  severity: string;
  urgency: string;
  headline: string;
  description: string;
  onset: string | null;
  ends: string | null;
  expires: string;
  senderName: string;
  areaDesc: string;
}

const alertCache = new TtlCache<NwsAlert[]>(5 * 60_000);
export async function fetchAlerts(lat: number, lon: number): Promise<NwsAlert[]> {
  return alertCache.getOrLoad(`${lat.toFixed(3)},${lon.toFixed(3)}`, async () => {
    const d = await fetchJson<{ features: Array<{ properties: NwsAlert }> }>(`${BASE}/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`);
    return d.features.map((f) => f.properties);
  });
}

/** Parse ISO8601 duration like PT1H, P1DT6H into ms */
export function parseIsoDuration(s: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(s);
  if (!m) return 3600_000;
  const d = parseInt(m[1] ?? '0', 10);
  const h = parseInt(m[2] ?? '0', 10);
  const mi = parseInt(m[3] ?? '0', 10);
  return ((d * 24 + h) * 60 + mi) * 60_000;
}

/** Expand an NWS grid series into an hourly map (hourStartMs -> value). */
export function expandSeries(series: NwsGridSeries | undefined, hourStart: number, hourEnd: number): Map<number, number | null> {
  const out = new Map<number, number | null>();
  if (!series) return out;
  for (const v of series.values) {
    const [startStr, durStr] = v.validTime.split('/');
    const start = Date.parse(startStr);
    const dur = parseIsoDuration(durStr);
    for (let t = Math.floor(start / 3600_000) * 3600_000; t < start + dur; t += 3600_000) {
      if (t >= hourStart && t < hourEnd) out.set(t, v.value);
    }
  }
  return out;
}

const COMPASS: Record<string, number> = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};
export function compassToDeg(s: string): number | null {
  return COMPASS[s] ?? null;
}
