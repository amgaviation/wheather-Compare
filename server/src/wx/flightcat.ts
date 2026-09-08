import type { CloudLayer, Conditions, FlightCategory, Visibility } from './types.js';
import { CATEGORY_RANK } from './types.js';

/** Ceiling = lowest BKN/OVC layer or vertical visibility, in feet AGL. */
export function ceilingFromLayers(layers: CloudLayer[], verticalVisFt: number | null): number | null {
  let ceiling: number | null = null;
  for (const l of layers) {
    if ((l.cover === 'BKN' || l.cover === 'OVC' || l.cover === 'VV') && l.baseFt != null) {
      if (ceiling == null || l.baseFt < ceiling) ceiling = l.baseFt;
    }
  }
  if (verticalVisFt != null && (ceiling == null || verticalVisFt < ceiling)) ceiling = verticalVisFt;
  return ceiling;
}

export function ceilingOf(cond: Conditions): number | null {
  if (cond.cavok) return null;
  return ceilingFromLayers(cond.clouds, cond.verticalVisFt);
}

/** Numeric visibility for comparisons: P6SM -> 6, "10+" -> 10, M1/4 -> 0.25 */
export function visValue(v: Visibility | null): number | null {
  if (!v) return null;
  return v.sm;
}

/**
 * FAA / AWC flight category thresholds:
 *  LIFR  ceiling < 500 ft  and/or vis < 1 SM
 *  IFR   ceiling 500 to < 1000 ft and/or vis 1 to < 3 SM
 *  MVFR  ceiling 1000 to 3000 ft and/or vis 3 to 5 SM
 *  VFR   ceiling > 3000 ft and vis > 5 SM
 * Returns null only when both ceiling and visibility are unknown.
 */
export function flightCategory(ceilingFt: number | null, visSm: number | null): FlightCategory | null {
  if (ceilingFt == null && visSm == null) return null;
  const c = ceilingFt ?? Infinity;
  const v = visSm ?? Infinity;
  if (c < 500 || v < 1) return 'LIFR';
  if (c < 1000 || v < 3) return 'IFR';
  if (c <= 3000 || v <= 5) return 'MVFR';
  return 'VFR';
}

export function categoryOf(cond: Conditions): FlightCategory | null {
  if (cond.cavok) return 'VFR';
  const ceiling = ceilingOf(cond);
  const vis = visValue(cond.visibility);
  return flightCategory(ceiling, vis);
}

export function worseCategory(a: FlightCategory | null, b: FlightCategory | null): FlightCategory | null {
  if (a == null) return b;
  if (b == null) return a;
  return CATEGORY_RANK[a] >= CATEGORY_RANK[b] ? a : b;
}

/** Ceiling-only category (for attribution of misses). */
export function ceilingCategory(ceilingFt: number | null): FlightCategory {
  if (ceilingFt == null) return 'VFR';
  if (ceilingFt < 500) return 'LIFR';
  if (ceilingFt < 1000) return 'IFR';
  if (ceilingFt <= 3000) return 'MVFR';
  return 'VFR';
}

export function visCategory(visSm: number | null): FlightCategory {
  if (visSm == null) return 'VFR';
  if (visSm < 1) return 'LIFR';
  if (visSm < 3) return 'IFR';
  if (visSm <= 5) return 'MVFR';
  return 'VFR';
}
