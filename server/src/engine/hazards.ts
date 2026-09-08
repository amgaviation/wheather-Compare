/**
 * Hazard products (SIGMET/AIRMET/G-AIRMET/CWA/PIREP/NWS alerts) relevant to a station.
 */
import * as awc from '../sources/awc.js';
import * as nws from '../sources/nws.js';
import { TtlCache } from '../sources/http.js';
import { bearingDeg, distanceToPolygonNm, haversineNm } from './geo.js';
import type { StationRow } from './store.js';

type LatLon = { lat: number; lon: number };
const toLL = (c: Array<{ lat: string | number; lon: string | number }> | undefined): LatLon[] => (c ?? []).map((p) => ({ lat: Number(p.lat), lon: Number(p.lon) }));

export interface HazardItem {
  kind: 'SIGMET' | 'AIRMET' | 'G-AIRMET' | 'CWA' | 'OUTLOOK';
  hazard: string;
  severity: string | null;
  id: string;
  validFrom: number;
  validTo: number;
  base: number | null;
  top: number | null;
  distanceNm: number;
  inside: boolean;
  raw: string;
  coords: LatLon[];
  extra?: Record<string, unknown>;
}

export interface StationHazards {
  station: string;
  fetchedAt: number;
  items: HazardItem[];
  pireps: Array<{ time: number; distanceNm: number; bearingDeg: number; fltLvl: number | null; acType: string | null; urgent: boolean; turb: string | null; ice: string | null; sky: string | null; wx: string | null; temp: number | null; wind: string | null; raw: string; lat: number; lon: number }>;
  alerts: nws.NwsAlert[];
}

const cache = new TtlCache<StationHazards>(4 * 60_000);

export async function stationHazards(st: StationRow, radiusNm = 200): Promise<StationHazards> {
  return cache.getOrLoad(`${st.icao}:${radiusNm}`, async () => {
    const [airsig, gair, cwas, pireps, alerts] = await Promise.all([
      awc.fetchAirSigmets().catch(() => [] as awc.AwcAirSigmet[]),
      awc.fetchGairmets().catch(() => [] as awc.AwcGairmet[]),
      awc.fetchCwas().catch(() => [] as awc.AwcCwa[]),
      awc.fetchPireps(st.icao, Math.min(radiusNm, 250), 3).catch(() => [] as awc.AwcPirep[]),
      st.country === 'US' || st.nws_grid_id ? nws.fetchAlerts(st.lat, st.lon).catch(() => [] as nws.NwsAlert[]) : Promise.resolve([] as nws.NwsAlert[]),
    ]);
    const now = Date.now();
    const items: HazardItem[] = [];
    for (const a of airsig) {
      const coords = toLL(a.coords);
      if (!coords.length) continue;
      const d = distanceToPolygonNm(st.lat, st.lon, coords);
      if (d > radiusNm) continue;
      if (a.validTimeTo * 1000 < now) continue;
      items.push({
        kind: a.airSigmetType === 'OUTLOOK' ? 'OUTLOOK' : a.airSigmetType, hazard: a.hazard, severity: a.severity ?? null, id: `${a.airSigmetType}-${a.seriesId ?? a.alphaChar ?? ''}-${a.validTimeFrom}`,
        validFrom: a.validTimeFrom * 1000, validTo: a.validTimeTo * 1000, base: a.altitudeLow1 ?? null, top: a.altitudeHi1 ?? a.altitudeHi2 ?? null,
        distanceNm: Math.round(d), inside: d === 0, raw: a.rawAirSigmet, coords, extra: { movementDir: a.movementDir, movementSpd: a.movementSpd },
      });
    }
    for (const g of gair) {
      const coords = toLL(g.coords);
      if (!coords.length) continue;
      const d = distanceToPolygonNm(st.lat, st.lon, coords);
      if (d > radiusNm) continue;
      const validTime = Date.parse(g.validTime);
      items.push({
        kind: 'G-AIRMET', hazard: g.hazard, severity: g.severity ?? null, id: `GAIRMET-${g.product}-${g.tag}-${g.forecastHour}-${g.validTime}`,
        validFrom: validTime, validTo: validTime + 3 * 3600_000, base: g.base ? parseInt(g.base, 10) * 100 : null, top: g.top ? parseInt(g.top, 10) * 100 : null,
        distanceNm: Math.round(d), inside: d === 0, raw: `G-AIRMET ${g.product} ${g.hazard}${g.severity ? ' ' + g.severity : ''} F${String(g.forecastHour).padStart(2, '0')} valid ${g.validTime}${g.due_to ? ' due to ' + g.due_to : ''} ${g.base ?? 'SFC'}-${g.top ?? ''}${g.fzlbase ? ` FZL ${g.fzlbase}-${g.fzltop}` : ''}`,
        coords, extra: { forecastHour: g.forecastHour, product: g.product, fzlBase: g.fzlbase, fzlTop: g.fzltop, dueTo: g.due_to },
      });
    }
    for (const c of cwas) {
      const coords = toLL(c.coords);
      if (!coords.length) continue;
      const d = distanceToPolygonNm(st.lat, st.lon, coords);
      if (d > radiusNm) continue;
      if (c.validTimeTo * 1000 < now) continue;
      items.push({ kind: 'CWA', hazard: c.hazard, severity: c.qualifier ?? null, id: `CWA-${c.cwsu}-${c.seriesId}-${c.validTimeFrom}`, validFrom: c.validTimeFrom * 1000, validTo: c.validTimeTo * 1000, base: c.base ?? null, top: c.top ?? null, distanceNm: Math.round(d), inside: d === 0, raw: c.rawText, coords, extra: { cwsu: c.cwsu, name: c.name } });
    }
    items.sort((a, b) => a.distanceNm - b.distanceNm || a.validFrom - b.validFrom);
    const ps = pireps
      .filter((p) => p.lat != null && p.lon != null)
      .map((p) => {
        const d = haversineNm(st.lat, st.lon, p.lat, p.lon);
        const turb = [p.tbInt1, p.tbType1, p.tbFreq1].filter(Boolean).join(' ') || null;
        const ice = [p.icgInt1, p.icgType1].filter(Boolean).join(' ') || null;
        return {
          time: p.obsTime * 1000, distanceNm: Math.round(d), bearingDeg: bearingDeg(st.lat, st.lon, p.lat, p.lon), fltLvl: p.fltLvl ?? null, acType: p.acType ?? null, urgent: /URGENT|UUA/i.test(p.pirepType) || /\bUUA\b/.test(p.rawOb),
          turb: turb ? `${turb}${p.tbBas1 != null || p.tbTop1 != null ? ` ${p.tbBas1 ?? ''}-${p.tbTop1 ?? ''}` : ''}` : null,
          ice: ice ? `${ice}${p.icgBas1 != null || p.icgTop1 != null ? ` ${p.icgBas1 ?? ''}-${p.icgTop1 ?? ''}` : ''}` : null,
          sky: typeof p.clouds === 'string' ? p.clouds : null, wx: p.wxString || null, temp: p.temp ?? null, wind: p.wdir != null && p.wspd != null ? `${p.wdir}/${p.wspd}` : null, raw: p.rawOb, lat: p.lat, lon: p.lon,
        };
      })
      .filter((p) => p.distanceNm <= radiusNm)
      .sort((a, b) => b.time - a.time);
    return { station: st.icao, fetchedAt: now, items, pireps: ps, alerts };
  });
}

/** All current hazard polygons (for a map). */
export async function allHazards() {
  const [airsig, gair, cwas] = await Promise.all([awc.fetchAirSigmets().catch(() => []), awc.fetchGairmets().catch(() => []), awc.fetchCwas().catch(() => [])]);
  const now = Date.now();
  return {
    sigmets: airsig.filter((a) => a.validTimeTo * 1000 >= now).map((a) => ({ type: a.airSigmetType, hazard: a.hazard, severity: a.severity ?? null, validFrom: a.validTimeFrom * 1000, validTo: a.validTimeTo * 1000, top: a.altitudeHi1 ?? null, base: a.altitudeLow1 ?? null, raw: a.rawAirSigmet, coords: toLL(a.coords) })),
    gairmets: gair.map((g) => ({ product: g.product, hazard: g.hazard, severity: g.severity ?? null, forecastHour: g.forecastHour, validTime: Date.parse(g.validTime), base: g.base, top: g.top, coords: toLL(g.coords) })),
    cwas: cwas.filter((c) => c.validTimeTo * 1000 >= now).map((c) => ({ cwsu: c.cwsu, hazard: c.hazard, validFrom: c.validTimeFrom * 1000, validTo: c.validTimeTo * 1000, raw: c.rawText, coords: toLL(c.coords) })),
  };
}

/** Winds/temps aloft region for a US station. */
export function fbRegion(lat: number, lon: number): string {
  if (lat > 50 && lon < -130) return 'alaska';
  if (lat < 25 && lon < -150) return 'hawaii';
  if (lon < -113) return lat >= 40 ? 'slc' : 'sfo';
  if (lon < -100) return lat >= 40 ? 'slc' : 'dfw';
  if (lon < -85) return lat >= 37.5 ? 'chi' : 'dfw';
  return lat >= 37 ? 'bos' : 'mia';
}

const fbStationCache = new TtlCache<Map<string, { lat: number; lon: number; name: string }>>(24 * 3600_000);

export async function windsAloftFor(st: StationRow) {
  const region = fbRegion(st.lat, st.lon);
  const products = await Promise.all((['06', '12', '24'] as const).map(async (f) => ({ fcst: f, ...awc.parseWindsAloft(await awc.fetchWindsAloft(region, 'low', f)) })));
  const high = await awc.fetchWindsAloft(region, 'high', '06').then(awc.parseWindsAloft).catch(() => null);
  const ids = [...new Set(products.flatMap((p) => p.rows.map((r) => r.station)))];
  const coords = await fbStationCache.getOrLoad(region, async () => {
    const infos = await awc.fetchStationInfo(ids.map((i) => (i.length === 3 ? 'K' + i : i))).catch(() => [] as awc.AwcStation[]);
    const m = new Map<string, { lat: number; lon: number; name: string }>();
    for (const i of infos) m.set(i.icaoId.replace(/^K/, ''), { lat: i.lat, lon: i.lon, name: i.site });
    return m;
  });
  const ranked = ids
    .map((id) => ({ id, c: coords.get(id) }))
    .filter((x) => x.c)
    .map((x) => ({ id: x.id, name: x.c!.name, distanceNm: Math.round(haversineNm(st.lat, st.lon, x.c!.lat, x.c!.lon)) }))
    .sort((a, b) => a.distanceNm - b.distanceNm)
    .slice(0, 3);
  return {
    region,
    nearest: ranked,
    forecasts: products.map((p) => ({ fcst: p.fcst, header: p.header, basedOn: p.basedOn, validFor: p.validFor, levels: p.levels, rows: p.rows.filter((r) => ranked.some((n) => n.id === r.station)) })),
    high: high ? { header: high.header, basedOn: high.basedOn, validFor: high.validFor, levels: high.levels, rows: high.rows.filter((r) => ranked.some((n) => n.id === r.station)) } : null,
  };
}
