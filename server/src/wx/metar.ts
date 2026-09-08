import type { Metar, MetarRemarks } from './types.js';
import { parseElements } from './elements.js';
import { ceilingOf, flightCategory, visValue } from './flightcat.js';

const TIME_RE = /^(\d{2})(\d{2})(\d{2})Z$/;
const TEMP_RE = /^(M)?(\d{2})\/(M)?(\d{2})?$/;
const ALT_RE = /^A(\d{4})$/;
const QNH_RE = /^Q(\d{4})$/;

function decodeTempGroup(s: string): number {
  // "0222" -> 22.2, "1017" -> -1.7
  const sign = s[0] === '1' ? -1 : 1;
  return (sign * parseInt(s.slice(1), 10)) / 10;
}

/**
 * Resolve DDHHMMZ against a reference instant (product receipt time). Handles month rollover.
 */
export function resolveDayTime(day: number, hour: number, minute: number, reference: Date): number {
  const y = reference.getUTCFullYear();
  const mo = reference.getUTCMonth();
  const candidates = [
    Date.UTC(y, mo, day, hour, minute),
    Date.UTC(y, mo - 1, day, hour, minute),
    Date.UTC(y, mo + 1, day, hour, minute),
  ];
  const ref = reference.getTime();
  let best = candidates[0];
  let bestDist = Math.abs(candidates[0] - ref);
  for (const c of candidates) {
    const d = Math.abs(c - ref);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

function emptyRemarks(): MetarRemarks {
  return {
    automated: null, slpHpa: null, tempPreciseC: null, dewpPreciseC: null, peakWind: null, windShiftMin: null,
    frontalPassage: false, pressureTendency: null, pressureRisingRapidly: false, pressureFallingRapidly: false,
    precip1hrIn: null, precip3or6hrIn: null, precip24hrIn: null, maxTemp6hrC: null, minTemp6hrC: null,
    maxTemp24hrC: null, minTemp24hrC: null, snowDepthIn: null, variableCeiling: null, variableVis: null,
    towerVisSm: null, surfaceVisSm: null, lightning: null, thunderstormBeganEnded: null, sensorFlags: [],
    maintenanceNeeded: false, other: [],
  };
}

function parseFracVis(tokens: string[], i: number): { sm: number; consumed: number } | null {
  const t = tokens[i];
  const n = tokens[i + 1];
  if (/^\d{1,2}$/.test(t) && n && /^\d\/\d{1,2}$/.test(n)) {
    const [a, b] = n.split('/').map(Number);
    return { sm: parseInt(t, 10) + a / b, consumed: 2 };
  }
  if (/^\d\/\d{1,2}$/.test(t)) {
    const [a, b] = t.split('/').map(Number);
    return { sm: a / b, consumed: 1 };
  }
  if (/^\d{1,2}$/.test(t)) return { sm: parseInt(t, 10), consumed: 1 };
  return null;
}

export function parseRemarks(tokens: string[], slpAltimeterInHg: number | null): MetarRemarks {
  const r = emptyRemarks();
  let i = 0;
  const sensorFlags = ['TSNO', 'RVRNO', 'PWINO', 'FZRANO', 'PNO', 'SLPNO', 'VISNO', 'CHINO', 'TNO'];
  while (i < tokens.length) {
    const t = tokens[i];
    let m: RegExpExecArray | null;
    if (t === 'AO1' || t === 'AO2' || t === 'AO2A' || t === 'AO1A') {
      r.automated = t.startsWith('AO1') ? 'AO1' : 'AO2';
    } else if ((m = /^SLP(\d{3})$/.exec(t))) {
      const v = parseInt(m[1], 10) / 10;
      // SLP is given as last 3 digits of hPa: 1013.2 -> 132; 998.2 -> 982
      r.slpHpa = v >= 50 ? 900 + v : 1000 + v;
    } else if ((m = /^T([01]\d{3})([01]\d{3})?$/.exec(t))) {
      r.tempPreciseC = decodeTempGroup(m[1]);
      if (m[2]) r.dewpPreciseC = decodeTempGroup(m[2]);
    } else if (t === 'PK' && tokens[i + 1] === 'WND' && tokens[i + 2]) {
      const pm = /^(\d{3})(\d{2,3})\/(\d{2})?(\d{2})$/.exec(tokens[i + 2]);
      if (pm) {
        r.peakWind = { dirDeg: parseInt(pm[1], 10), speedKt: parseInt(pm[2], 10), hh: pm[3] ? parseInt(pm[3], 10) : null, mm: parseInt(pm[4], 10) };
        i += 2;
      }
    } else if (t === 'WSHFT' && tokens[i + 1]) {
      const wm = /^(\d{2})?(\d{2})$/.exec(tokens[i + 1]);
      if (wm) {
        r.windShiftMin = parseInt(wm[2], 10);
        i++;
        if (tokens[i + 1] === 'FROPA') {
          r.frontalPassage = true;
          i++;
        }
      }
    } else if (t === 'FROPA') {
      r.frontalPassage = true;
    } else if ((m = /^5(\d)(\d{3})$/.exec(t))) {
      const code = parseInt(m[1], 10);
      const change = parseInt(m[2], 10) / 10;
      r.pressureTendency = { code, changeHpa: code >= 5 ? -change : change };
    } else if (t === 'PRESRR') r.pressureRisingRapidly = true;
    else if (t === 'PRESFR') r.pressureFallingRapidly = true;
    else if ((m = /^P(\d{4})$/.exec(t))) r.precip1hrIn = parseInt(m[1], 10) / 100;
    else if ((m = /^6(\d{4})$/.exec(t))) r.precip3or6hrIn = parseInt(m[1], 10) / 100;
    else if ((m = /^7(\d{4})$/.exec(t))) r.precip24hrIn = parseInt(m[1], 10) / 100;
    else if ((m = /^1([01]\d{3})$/.exec(t))) r.maxTemp6hrC = decodeTempGroup(m[1]);
    else if ((m = /^2([01]\d{3})$/.exec(t))) r.minTemp6hrC = decodeTempGroup(m[1]);
    else if ((m = /^4([01]\d{3})([01]\d{3})$/.exec(t))) {
      r.maxTemp24hrC = decodeTempGroup(m[1]);
      r.minTemp24hrC = decodeTempGroup(m[2]);
    } else if ((m = /^4\/(\d{3})$/.exec(t))) r.snowDepthIn = parseInt(m[1], 10);
    else if (t === 'CIG' && tokens[i + 1] && /^(\d{3})V(\d{3})$/.test(tokens[i + 1])) {
      const cm = /^(\d{3})V(\d{3})$/.exec(tokens[i + 1])!;
      r.variableCeiling = { minFt: parseInt(cm[1], 10) * 100, maxFt: parseInt(cm[2], 10) * 100 };
      i++;
    } else if (t === 'VIS' && tokens[i + 1]) {
      // VIS 1/2V2, VIS 3/4V1 1/2
      const vm = /^(\d(?:\/\d)?)V(\d(?:\/\d)?)$/.exec(tokens[i + 1]);
      if (vm) {
        const f = (s: string) => (s.includes('/') ? s.split('/').map(Number).reduce((a, b) => a / b) : Number(s));
        r.variableVis = { minSm: f(vm[1]), maxSm: f(vm[2]) };
        i++;
      }
    } else if ((t === 'TWR' || t === 'SFC') && tokens[i + 1] === 'VIS') {
      const fv = parseFracVis(tokens, i + 2);
      if (fv) {
        if (t === 'TWR') r.towerVisSm = fv.sm;
        else r.surfaceVisSm = fv.sm;
        i += 1 + fv.consumed;
      }
    } else if (t === 'LTG' || t.startsWith('LTG') || t === 'FRQ' || t === 'OCNL' || t === 'CONS') {
      // collect a lightning phrase: e.g. "OCNL LTG IC CG DSNT NE"
      const phrase: string[] = [];
      let j = i;
      while (j < tokens.length && /^(FRQ|OCNL|CONS|LTG\w*|IC|CG|CC|CA|DSNT|VC|OHD|ALQDS|AND|N|NE|E|SE|S|SW|W|NW|[NESW]{1,3}-[NESW]{1,3})$/.test(tokens[j])) {
        phrase.push(tokens[j]);
        j++;
      }
      if (phrase.some((p) => p.startsWith('LTG'))) {
        r.lightning = phrase.join(' ');
        i = j - 1;
      } else r.other.push(t);
    } else if (/^TS[BE]\d{2,4}(E\d{2,4})?$/.test(t) || /^(RA|SN|DZ|SH|FZ|PL|GR)[BE]\d{2,4}/.test(t)) {
      r.thunderstormBeganEnded = (r.thunderstormBeganEnded ? r.thunderstormBeganEnded + ' ' : '') + t;
    } else if (sensorFlags.includes(t)) r.sensorFlags.push(t);
    else if (t === '$') r.maintenanceNeeded = true;
    else r.other.push(t);
    i++;
  }
  void slpAltimeterInHg;
  return r;
}

/**
 * Decode a raw METAR/SPECI. `reference` resolves the day-of-month to a full date
 * (defaults to now). Tolerant: never throws on odd input; collects warnings.
 */
export function parseMetar(raw: string, reference: Date = new Date()): Metar {
  const warnings: string[] = [];
  const cleaned = raw.replace(/\s+/g, ' ').replace(/=+$/, '').trim();
  const tokens = cleaned.split(' ');
  let i = 0;
  let type: 'METAR' | 'SPECI' = 'METAR';
  if (tokens[i] === 'METAR' || tokens[i] === 'SPECI') {
    type = tokens[i] as 'METAR' | 'SPECI';
    i++;
  }
  let corrected = false;
  if (tokens[i] === 'COR') {
    corrected = true;
    i++;
  }
  const station = tokens[i++] ?? '';
  let time = reference.getTime();
  const tm = TIME_RE.exec(tokens[i] ?? '');
  if (tm) {
    time = resolveDayTime(parseInt(tm[1], 10), parseInt(tm[2], 10), parseInt(tm[3], 10), reference);
    i++;
  } else warnings.push('missing observation time');
  let auto = false;
  let nil = false;
  while (tokens[i] === 'AUTO' || tokens[i] === 'COR' || tokens[i] === 'NIL' || tokens[i] === 'RTD') {
    if (tokens[i] === 'AUTO') auto = true;
    if (tokens[i] === 'COR') corrected = true;
    if (tokens[i] === 'NIL') nil = true;
    i++;
  }
  const rmkIdx = tokens.indexOf('RMK', i);
  const bodyTokens = tokens.slice(i, rmkIdx === -1 ? undefined : rmkIdx);
  const rmkTokens = rmkIdx === -1 ? [] : tokens.slice(rmkIdx + 1);

  const el = parseElements(bodyTokens);
  warnings.push(...el.warnings);
  let tempC: number | null = null;
  let dewpC: number | null = null;
  let altimeterInHg: number | null = null;
  let qnhHpa: number | null = null;
  const unknown: string[] = [];
  for (const t of el.rest) {
    let m: RegExpExecArray | null;
    if ((m = TEMP_RE.exec(t))) {
      tempC = (m[1] ? -1 : 1) * parseInt(m[2], 10);
      if (m[4] != null) dewpC = (m[3] ? -1 : 1) * parseInt(m[4], 10);
    } else if ((m = ALT_RE.exec(t))) altimeterInHg = parseInt(m[1], 10) / 100;
    else if ((m = QNH_RE.exec(t))) qnhHpa = parseInt(m[1], 10);
    else if (t === 'NOSIG' || t === 'TEMPO' || t === 'BECMG' || /^\$$/.test(t)) {
      /* trend groups / maintenance in body; ignore */
    } else unknown.push(t);
  }
  if (unknown.length) warnings.push(`unrecognised body tokens: ${unknown.join(' ')}`);
  if (altimeterInHg == null && qnhHpa != null) altimeterInHg = Math.round((qnhHpa * 0.02953) * 100) / 100;
  if (qnhHpa == null && altimeterInHg != null) qnhHpa = Math.round(altimeterInHg * 33.8639 * 10) / 10;

  const remarks = parseRemarks(rmkTokens, altimeterInHg);
  if (remarks.tempPreciseC != null) tempC = remarks.tempPreciseC;
  if (remarks.dewpPreciseC != null) dewpC = remarks.dewpPreciseC;

  const ceilingFt = ceilingOf(el.cond);
  const category = flightCategory(ceilingFt, visValue(el.cond.visibility));

  return {
    raw: cleaned, station, type, time, auto, corrected, nil, cond: el.cond, rvr: el.rvr,
    tempC, dewpC, altimeterInHg, qnhHpa, remarks, ceilingFt, category, parseWarnings: warnings,
  };
}
