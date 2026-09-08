import type { Conditions, FlightCategory, Taf, TafChangeKind, TafGroup, TafHour } from './types.js';
import { parseElements } from './elements.js';
import { categoryOf, ceilingOf, visValue, worseCategory } from './flightcat.js';
import { resolveDayTime } from './metar.js';

const ISSUE_RE = /^(\d{2})(\d{2})(\d{2})Z$/;
const VALID_RE = /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/;
const FM_RE = /^FM(\d{2})(\d{2})(\d{2})$/;
const TX_RE = /^T([XN])(M?\d{1,2})\/(\d{2})(\d{2})Z$/;
const HOUR = 3600_000;

function resolveDayHour(day: number, hour: number, reference: Date): number {
  // hour 24 => next day 00
  if (hour === 24) return resolveDayTime(day, 0, 0, reference) + 24 * HOUR;
  return resolveDayTime(day, hour, 0, reference);
}

/** Split TAF text into groups at change indicators. */
function splitGroups(tokens: string[]): string[][] {
  const groups: string[][] = [];
  let cur: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const isStart =
      FM_RE.test(t) ||
      t === 'TEMPO' ||
      t === 'BECMG' ||
      t === 'PROB30' ||
      t === 'PROB40';
    if (isStart && cur.length) {
      groups.push(cur);
      cur = [];
    }
    cur.push(t);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * Decode a TAF (2008+ format with DDHH/DDHH validity). `reference` is the product
 * receipt time used to resolve day-of-month to full dates.
 */
export function parseTaf(raw: string, reference: Date = new Date()): Taf {
  const warnings: string[] = [];
  const cleaned = raw.replace(/\s+/g, ' ').replace(/=+$/, '').trim();
  const tokens = cleaned.split(' ');
  let i = 0;
  if (tokens[i] === 'TAF') i++;
  let amended = false;
  let corrected = false;
  while (tokens[i] === 'AMD' || tokens[i] === 'COR') {
    if (tokens[i] === 'AMD') amended = true;
    else corrected = true;
    i++;
  }
  const station = tokens[i++] ?? '';
  let issued = reference.getTime();
  const im = ISSUE_RE.exec(tokens[i] ?? '');
  if (im) {
    issued = resolveDayTime(parseInt(im[1], 10), parseInt(im[2], 10), parseInt(im[3], 10), reference);
    i++;
  } else warnings.push('missing issue time');
  const issuedDate = new Date(issued);
  let nil = false;
  let cancelled = false;
  if (tokens[i] === 'NIL') {
    nil = true;
    i++;
  }
  let validFrom = issued;
  let validTo = issued + 30 * HOUR;
  const vm = VALID_RE.exec(tokens[i] ?? '');
  if (vm) {
    validFrom = resolveDayHour(parseInt(vm[1], 10), parseInt(vm[2], 10), issuedDate);
    validTo = resolveDayHour(parseInt(vm[3], 10), parseInt(vm[4], 10), issuedDate);
    if (validTo <= validFrom) validTo += 24 * HOUR;
    i++;
  } else if (!nil) warnings.push('missing validity period');
  if (tokens[i] === 'CNL') {
    cancelled = true;
    i++;
  }
  const rest = tokens.slice(i);
  // Pull out TX/TN groups anywhere
  let maxTemp: Taf['maxTemp'] = null;
  let minTemp: Taf['minTemp'] = null;
  const bodyTokens: string[] = [];
  for (const t of rest) {
    const tm = TX_RE.exec(t);
    if (tm) {
      const c = parseInt(tm[2].replace('M', '-'), 10);
      const time = resolveDayHour(parseInt(tm[3], 10), parseInt(tm[4], 10), issuedDate);
      if (tm[1] === 'X') maxTemp = { c, time };
      else minTemp = { c, time };
    } else bodyTokens.push(t);
  }

  const groups: TafGroup[] = [];
  const rawGroups = splitGroups(bodyTokens);
  for (let g = 0; g < rawGroups.length; g++) {
    const gt = rawGroups[g];
    let kind: TafChangeKind = 'BASE';
    let from = validFrom;
    let to = validTo;
    let probability: number | null = null;
    let k = 0;
    const fm = FM_RE.exec(gt[0]);
    if (fm) {
      kind = 'FM';
      from = resolveDayTime(parseInt(fm[1], 10), parseInt(fm[2], 10), parseInt(fm[3], 10), new Date(validFrom + 12 * HOUR));
      k = 1;
    } else if (gt[0] === 'PROB30' || gt[0] === 'PROB40') {
      probability = gt[0] === 'PROB30' ? 30 : 40;
      k = 1;
      if (gt[1] === 'TEMPO') {
        kind = probability === 30 ? 'PROB30 TEMPO' : 'PROB40 TEMPO';
        k = 2;
      } else kind = gt[0] as TafChangeKind;
      const pm = VALID_RE.exec(gt[k] ?? '');
      if (pm) {
        from = resolveDayHour(parseInt(pm[1], 10), parseInt(pm[2], 10), issuedDate);
        to = resolveDayHour(parseInt(pm[3], 10), parseInt(pm[4], 10), issuedDate);
        if (to <= from) to += 24 * HOUR;
        k++;
      } else warnings.push(`${gt[0]} group without period`);
    } else if (gt[0] === 'TEMPO' || gt[0] === 'BECMG') {
      kind = gt[0];
      k = 1;
      const pm = VALID_RE.exec(gt[k] ?? '');
      if (pm) {
        from = resolveDayHour(parseInt(pm[1], 10), parseInt(pm[2], 10), issuedDate);
        to = resolveDayHour(parseInt(pm[3], 10), parseInt(pm[4], 10), issuedDate);
        if (to <= from) to += 24 * HOUR;
        k++;
      } else warnings.push(`${gt[0]} group without period`);
    } else if (g > 0) {
      warnings.push(`unexpected group start: ${gt[0]}`);
    }
    const el = parseElements(gt.slice(k));
    if (el.rest.length) warnings.push(`unrecognised TAF tokens: ${el.rest.join(' ')}`);
    groups.push({ kind, raw: gt.join(' '), from, to, probability, cond: el.cond, has: el.has, parseWarnings: el.warnings });
  }
  // FM groups end at the next FM (or TAF end); BASE ends at first FM
  const fmLike = groups.filter((g) => g.kind === 'FM' || g.kind === 'BASE');
  for (let a = 0; a < fmLike.length; a++) {
    const next = fmLike[a + 1];
    fmLike[a].to = next ? next.from : validTo;
  }
  return { raw: cleaned, station, amended, corrected, cancelled, nil, issued, validFrom, validTo, groups, maxTemp, minTemp, parseWarnings: warnings };
}

function cloneCond(c: Conditions): Conditions {
  return JSON.parse(JSON.stringify(c));
}

/** Overlay a change group's explicitly given elements on a prevailing state. */
export function applyGroup(base: Conditions, g: TafGroup): Conditions {
  const out = cloneCond(base);
  if (g.has.wind) out.wind = g.cond.wind ? { ...g.cond.wind } : null;
  if (g.cond.cavok) {
    out.cavok = true;
    out.visibility = g.cond.visibility;
    out.clouds = [];
    out.weather = [];
    out.verticalVisFt = null;
    return out;
  }
  if (g.has.visibility) {
    out.visibility = g.cond.visibility ? { ...g.cond.visibility } : null;
    out.cavok = false;
  }
  if (g.has.weather) {
    out.weather = g.cond.nsw ? [] : g.cond.weather.map((w) => ({ ...w }));
    out.nsw = g.cond.nsw;
  }
  if (g.has.clouds) {
    out.clouds = g.cond.clouds.map((c) => ({ ...c }));
    out.verticalVisFt = g.cond.verticalVisFt;
    out.cavok = false;
  }
  if (g.cond.windShear !== undefined) out.windShear = g.cond.windShear;
  return out;
}

/** Assumed likelihood of an alternate state materialising in any given hour. */
export function alternateProbability(kind: TafChangeKind): number {
  switch (kind) {
    case 'TEMPO':
      return 0.5; // TEMPO: expected < half the period
    case 'PROB30':
      return 0.3;
    case 'PROB40':
      return 0.4;
    case 'PROB30 TEMPO':
      return 0.3 * 0.5;
    case 'PROB40 TEMPO':
      return 0.4 * 0.5;
    case 'BECMG':
      return 0.5; // transition underway
    default:
      return 1;
  }
}

/**
 * Expand a TAF into hourly prevailing + alternate states.
 * BECMG: prevailing switches to the new state at the END of the BECMG window; during the
 * window the new state is listed as an alternate (p=0.5 ramping). FM replaces everything.
 */
export function expandTaf(taf: Taf): TafHour[] {
  const hours: TafHour[] = [];
  if (taf.nil || taf.cancelled) return hours;
  const start = Math.floor(taf.validFrom / HOUR) * HOUR;
  for (let t = start; t < taf.validTo; t += HOUR) {
    // Prevailing: last BASE/FM whose from <= t, then BECMG groups whose window ended by t (in order).
    let prevailing: Conditions | null = null;
    const src: string[] = [];
    for (const g of taf.groups) {
      if ((g.kind === 'BASE' || g.kind === 'FM') && g.from <= t) {
        prevailing = cloneCond(g.cond);
        src.length = 0;
        src.push(g.kind === 'BASE' ? 'BASE' : g.raw.split(' ')[0]);
      }
    }
    if (!prevailing) {
      // before first FM but base missing: use first group anyway
      prevailing = cloneCond(taf.groups[0]?.cond ?? { wind: null, visibility: null, weather: [], clouds: [], verticalVisFt: null, cavok: false });
    }
    const alternates: TafHour['alternates'] = [];
    for (const g of taf.groups) {
      if (g.kind === 'BECMG') {
        if (g.to <= t) {
          // Completed transition — but only if no FM after the BECMG start reset the state
          const laterFm = taf.groups.some((x) => x.kind === 'FM' && x.from > g.from && x.from <= t);
          if (!laterFm) {
            prevailing = applyGroup(prevailing, g);
            src.push(g.raw.split(' ').slice(0, 2).join(' '));
          }
        } else if (g.from <= t && t < g.to) {
          const cond = applyGroup(prevailing, g);
          const frac = (t + HOUR - g.from) / (g.to - g.from);
          alternates.push({ kind: 'BECMG', probability: Math.min(0.9, Math.max(0.2, frac)), cond, ceilingFt: ceilingOf(cond), category: categoryOf(cond) });
        }
      }
    }
    for (const g of taf.groups) {
      if (g.kind === 'TEMPO' || g.kind.startsWith('PROB')) {
        if (g.from <= t && t < g.to) {
          const cond = applyGroup(prevailing, g);
          alternates.push({ kind: g.kind, probability: alternateProbability(g.kind), cond, ceilingFt: ceilingOf(cond), category: categoryOf(cond) });
        }
      }
    }
    const prevailingCeilingFt = ceilingOf(prevailing);
    const prevailingCategory = categoryOf(prevailing);
    let worstCategory: FlightCategory | null = prevailingCategory;
    let worstCeilingFt = prevailingCeilingFt;
    let worstVisSm = visValue(prevailing.visibility);
    for (const a of alternates) {
      worstCategory = worseCategory(worstCategory, a.category);
      if (a.ceilingFt != null && (worstCeilingFt == null || a.ceilingFt < worstCeilingFt)) worstCeilingFt = a.ceilingFt;
      const v = visValue(a.cond.visibility);
      if (v != null && (worstVisSm == null || v < worstVisSm)) worstVisSm = v;
    }
    hours.push({ time: t, prevailing, prevailingCeilingFt, prevailingCategory, alternates, worstCategory, worstCeilingFt, worstVisSm, sourceGroups: src });
  }
  return hours;
}

/** Find the hour slice covering a given instant. */
export function tafHourAt(hours: TafHour[], time: number): TafHour | null {
  const h = Math.floor(time / HOUR) * HOUR;
  return hours.find((x) => x.time === h) ?? null;
}
