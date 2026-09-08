/**
 * Open-Meteo (free, public, no key; CC-BY 4.0). Multi-model NWP guidance (GFS, ECMWF IFS, ICON).
 * Used as supplementary model guidance — it is not an aviation product. https://open-meteo.com/en/docs
 */
import { fetchJson } from './http.js';

export const MODELS = ['gfs_seamless', 'ecmwf_ifs025', 'icon_seamless'] as const;
export type ModelName = (typeof MODELS)[number];

export const MODEL_LABEL: Record<ModelName, string> = {
  gfs_seamless: 'NOAA GFS/HRRR',
  ecmwf_ifs025: 'ECMWF IFS',
  icon_seamless: 'DWD ICON',
};

const VARS = [
  'temperature_2m', 'dew_point_2m', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
  'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'visibility', 'precipitation_probability', 'precipitation',
  'weather_code', 'cape', 'surface_pressure', 'boundary_layer_height',
];

export interface ModelHour {
  model: ModelName;
  validTime: number;
  tempC: number | null;
  dewpC: number | null;
  windDir: number | null;
  windKt: number | null;
  gustKt: number | null;
  cloudPct: number | null;
  cloudLowPct: number | null;
  cloudMidPct: number | null;
  visM: number | null;
  precipMm: number | null;
  pop: number | null;
  wxCode: number | null;
  cape: number | null;
  pressureHpa: number | null;
  blHeightM: number | null;
}

type Hourly = Record<string, Array<number | null> | string[]>;

function pick(h: Hourly, name: string, model: string, suffix = ''): Array<number | null> | null {
  const key = `${name}${suffix}_${model}`;
  const v = h[key];
  if (Array.isArray(v)) return v as Array<number | null>;
  return null;
}

function rowsFrom(h: Hourly, model: ModelName, suffix = ''): ModelHour[] {
  const times = h.time as string[];
  const get = (n: string) => pick(h, n, model, suffix);
  const cols = Object.fromEntries(VARS.map((v) => [v, get(v)])) as Record<string, Array<number | null> | null>;
  const out: ModelHour[] = [];
  for (let i = 0; i < times.length; i++) {
    const v = (n: string) => cols[n]?.[i] ?? null;
    if (v('temperature_2m') == null && v('cloud_cover_low') == null && v('wind_speed_10m') == null) continue;
    out.push({
      model,
      validTime: Date.parse(times[i] + 'Z'),
      tempC: v('temperature_2m'), dewpC: v('dew_point_2m'), windDir: v('wind_direction_10m'), windKt: v('wind_speed_10m'), gustKt: v('wind_gusts_10m'),
      cloudPct: v('cloud_cover'), cloudLowPct: v('cloud_cover_low'), cloudMidPct: v('cloud_cover_mid'), visM: v('visibility'), precipMm: v('precipitation'),
      pop: v('precipitation_probability'), wxCode: v('weather_code'), cape: v('cape'), pressureHpa: v('surface_pressure'), blHeightM: v('boundary_layer_height'),
    });
  }
  return out;
}

/** Current forecast run for all models, hourly, next `days` days. */
export async function fetchModelForecast(lat: number, lon: number, days = 7): Promise<ModelHour[]> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${VARS.join(',')}` +
    `&models=${MODELS.join(',')}&forecast_days=${days}&past_days=1&wind_speed_unit=kn&timezone=UTC`;
  const d = await fetchJson<{ hourly: Hourly }>(url, { timeoutMs: 45_000 });
  return MODELS.flatMap((m) => rowsFrom(d.hourly, m));
}

/**
 * Previous model runs: what each model forecast `leadDays` days ahead for hours in the past
 * `pastDays` days. Enables immediate model verification without waiting for history to accrue.
 */
export async function fetchPreviousRuns(lat: number, lon: number, pastDays = 7, leadDays: number[] = [1, 2, 3, 5]): Promise<Array<ModelHour & { leadDays: number }>> {
  const vars = ['temperature_2m', 'dew_point_2m', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'cloud_cover', 'cloud_cover_low', 'precipitation', 'weather_code'];
  const hourly = leadDays.flatMap((d) => vars.map((v) => `${v}_previous_day${d}`));
  const url =
    `https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${hourly.join(',')}` +
    `&models=${MODELS.join(',')}&past_days=${pastDays}&forecast_days=1&wind_speed_unit=kn&timezone=UTC`;
  const d = await fetchJson<{ hourly: Hourly }>(url, { timeoutMs: 60_000 });
  const out: Array<ModelHour & { leadDays: number }> = [];
  for (const m of MODELS) {
    for (const ld of leadDays) {
      for (const r of rowsFrom(d.hourly, m, `_previous_day${ld}`)) out.push({ ...r, leadDays: ld });
    }
  }
  return out;
}

/** WMO weather code -> short text + aviation-relevant flags. */
export function describeWmo(code: number | null): { text: string; precip: boolean; fog: boolean; thunder: boolean; freezing: boolean; snow: boolean } {
  const c = code ?? -1;
  const t: Record<number, string> = {
    0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    56: 'Freezing drizzle', 57: 'Heavy freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Severe thunderstorm w/ hail',
  };
  return {
    text: t[c] ?? '—',
    precip: c >= 51,
    fog: c === 45 || c === 48,
    thunder: c >= 95,
    freezing: [48, 56, 57, 66, 67].includes(c),
    snow: [71, 73, 75, 77, 85, 86].includes(c),
  };
}
