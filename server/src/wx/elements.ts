/**
 * Shared element tokenizer for METAR bodies and TAF groups:
 * wind, visibility, RVR, present weather, sky condition, vertical visibility, CAVOK, NSW, wind shear.
 */
import type { CloudLayer, Conditions, RunwayVisualRange, Visibility, Wind, WxPhenomenon } from './types.js';

const WIND_RE = /^(VRB|\d{3}|\/\/\/)(\d{2,3}|\/\/)(?:G(\d{2,3}))?(KT|MPS|KMH)$/;
const WIND_VAR_RE = /^(\d{3})V(\d{3})$/;
const VIS_SM_RE = /^(M|P)?(\d{1,2})?(?:\s?(\d)\/(\d{1,2}))?SM$/;
const VIS_M_RE = /^(\d{4})(NDV|N|S|E|W|NE|NW|SE|SW)?$/;
const RVR_RE = /^R(\d{2}[LRC]?)\/([MP])?(\d{4})(?:V([MP])?(\d{4}))?(FT)?(?:\/([UDN]))?$/;
const CLOUD_RE = /^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)(CB|TCU|\/\/\/)?$/;
const WS_RE = /^WS(\d{3})\/(\d{3})(\d{2,3})KT$/;

const DESCRIPTORS = ['MI', 'BC', 'PR', 'DR', 'BL', 'SH', 'TS', 'FZ'];
const PHENOMENA = [
  'DZ', 'RA', 'SN', 'SG', 'IC', 'PL', 'GR', 'GS', 'UP',
  'BR', 'FG', 'FU', 'VA', 'DU', 'SA', 'HZ', 'PY',
  'PO', 'SQ', 'FC', 'SS', 'DS',
];
const WX_RE = new RegExp(
  `^(\\+|-|VC)?(${DESCRIPTORS.join('|')})?((?:${PHENOMENA.join('|')})+)$`,
);
const WX_DESC_ONLY_RE = /^(\+|-|VC)?(TS|SH|FZ|BL|DR|MI|BC|PR)$/; // e.g. "TS", "VCTS", "VCSH"

export function parseWind(tok: string, unitHint?: string): Wind | null {
  const m = WIND_RE.exec(tok);
  if (!m) return null;
  const [, d, s, g, u] = m;
  if (d === '///' || s === '//') return null;
  let speed = parseInt(s, 10);
  let gust = g ? parseInt(g, 10) : null;
  const unit = (u as Wind['unit']) ?? (unitHint as Wind['unit']) ?? 'KT';
  if (unit === 'MPS') {
    speed = Math.round(speed * 1.9438);
    if (gust != null) gust = Math.round(gust * 1.9438);
  } else if (unit === 'KMH') {
    speed = Math.round(speed * 0.53996);
    if (gust != null) gust = Math.round(gust * 0.53996);
  }
  const variable = d === 'VRB';
  return {
    dirDeg: variable ? null : parseInt(d, 10),
    variable,
    speedKt: speed,
    gustKt: gust,
    unit,
  };
}

export function parseWeather(tok: string): WxPhenomenon | null {
  const m = WX_RE.exec(tok);
  if (m) {
    const [, inten, desc, ph] = m;
    const phenomena: string[] = [];
    for (let i = 0; i < ph.length; i += 2) phenomena.push(ph.slice(i, i + 2));
    return { raw: tok, intensity: (inten as WxPhenomenon['intensity']) ?? '', descriptor: desc ?? null, phenomena };
  }
  const d = WX_DESC_ONLY_RE.exec(tok);
  if (d) {
    return { raw: tok, intensity: (d[1] as WxPhenomenon['intensity']) ?? '', descriptor: d[2], phenomena: [] };
  }
  return null;
}

export function parseCloud(tok: string): CloudLayer | null {
  if (tok === 'CLR' || tok === 'SKC' || tok === 'NSC' || tok === 'NCD') return { cover: tok, baseFt: null };
  const m = CLOUD_RE.exec(tok);
  if (!m) return null;
  const [, cover, hhh, type] = m;
  const base = hhh === '///' ? null : parseInt(hhh, 10) * 100;
  const layer: CloudLayer = { cover: cover as CloudLayer['cover'], baseFt: base };
  if (type === 'CB' || type === 'TCU') layer.type = type;
  return layer;
}

function parseVisSm(tok: string, next?: string): { vis: Visibility; consumed: number } | null {
  // Forms: 10SM, 1/2SM, M1/4SM, P6SM, "1 1/2SM" (two tokens), "2 3/4SM"
  if (/^\d{1,2}$/.test(tok) && next && /^\d\/\d{1,2}SM$/.test(next)) {
    const whole = parseInt(tok, 10);
    const [n, dsm] = next.split('/');
    const d = parseInt(dsm, 10);
    return { vis: { sm: whole + parseInt(n, 10) / d, plus: false }, consumed: 2 };
  }
  const m = VIS_SM_RE.exec(tok);
  if (!m) return null;
  const [, qual, whole, n, d] = m;
  let sm = whole ? parseInt(whole, 10) : 0;
  if (n && d) sm += parseInt(n, 10) / parseInt(d, 10);
  const vis: Visibility = { sm, plus: qual === 'P' };
  if (qual === 'M') vis.less = true;
  return { vis, consumed: 1 };
}

function parseVisMeters(tok: string): Visibility | null {
  const m = VIS_M_RE.exec(tok);
  if (!m) return null;
  const meters = parseInt(m[1], 10);
  if (meters === 9999) return { sm: 6.5, plus: true, meters };
  return { sm: Math.round((meters / 1609.34) * 100) / 100, plus: false, meters };
}

export function parseRvr(tok: string): RunwayVisualRange | null {
  const m = RVR_RE.exec(tok);
  if (!m) return null;
  const [, rwy, q1, v1, , v2, ft, trend] = m;
  const toFt = (v: string) => (ft ? parseInt(v, 10) : Math.round(parseInt(v, 10) * 3.28084));
  return {
    runway: rwy,
    minFt: toFt(v1),
    maxFt: v2 ? toFt(v2) : null,
    qualifier: (q1 as 'P' | 'M') ?? null,
    trend: (trend as 'U' | 'D' | 'N') ?? null,
  };
}

export interface ElementParse {
  cond: Conditions;
  rvr: RunwayVisualRange[];
  has: { wind: boolean; visibility: boolean; weather: boolean; clouds: boolean };
  /** Tokens not recognised as elements (returned for the caller). */
  rest: string[];
  warnings: string[];
}

/**
 * Parse a sequence of body tokens. Stops consuming at the first token that clearly
 * belongs to a later section only if `stopAt` says so; otherwise unknown tokens are
 * collected into `rest` and parsing continues.
 */
export function parseElements(tokens: string[], opts: { stopAt?: (t: string, i: number) => boolean } = {}): ElementParse {
  const cond: Conditions = { wind: null, visibility: null, weather: [], clouds: [], verticalVisFt: null, cavok: false };
  const rvr: RunwayVisualRange[] = [];
  const has = { wind: false, visibility: false, weather: false, clouds: false };
  const rest: string[] = [];
  const warnings: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (opts.stopAt && opts.stopAt(t, i)) {
      rest.push(...tokens.slice(i));
      break;
    }
    // Wind
    if (!has.wind && WIND_RE.test(t)) {
      const w = parseWind(t);
      if (w) {
        cond.wind = w;
        const v = tokens[i + 1] && WIND_VAR_RE.exec(tokens[i + 1]);
        if (v) {
          w.varFromDeg = parseInt(v[1], 10);
          w.varToDeg = parseInt(v[2], 10);
          i++;
        }
      } else warnings.push(`wind missing: ${t}`);
      has.wind = true;
      i++;
      continue;
    }
    if (t === 'CAVOK') {
      cond.cavok = true;
      cond.visibility = { sm: 6.5, plus: true, meters: 9999 };
      has.visibility = true;
      has.clouds = true;
      has.weather = true;
      i++;
      continue;
    }
    if (t === 'NSW') {
      cond.nsw = true;
      has.weather = true;
      i++;
      continue;
    }
    // Visibility (SM)
    if (!has.visibility) {
      const vs = parseVisSm(t, tokens[i + 1]);
      if (vs) {
        cond.visibility = vs.vis;
        has.visibility = true;
        i += vs.consumed;
        continue;
      }
      if (t === '////SM' || t === '////') {
        has.visibility = true;
        i++;
        continue;
      }
      // Visibility (meters) — only when the token is exactly 4 digits and no SM vis was seen
      // and it doesn't look like a time group. TAF/METAR ICAO format.
      if (has.wind && /^\d{4}(NDV|[NSEW]{1,2})?$/.test(t)) {
        const vm = parseVisMeters(t);
        if (vm) {
          cond.visibility = vm;
          has.visibility = true;
          i++;
          continue;
        }
      }
    }
    // RVR
    if (RVR_RE.test(t)) {
      const r = parseRvr(t);
      if (r) rvr.push(r);
      i++;
      continue;
    }
    // Sky
    const cl = parseCloud(t);
    if (cl) {
      if (cl.cover === 'VV') {
        cond.verticalVisFt = cl.baseFt;
        cond.clouds.push(cl);
      } else if (cl.cover === 'CLR' || cl.cover === 'SKC' || cl.cover === 'NSC' || cl.cover === 'NCD') {
        cond.clouds.push(cl);
      } else cond.clouds.push(cl);
      has.clouds = true;
      i++;
      continue;
    }
    // Weather
    const wx = parseWeather(t);
    if (wx) {
      cond.weather.push(wx);
      has.weather = true;
      i++;
      continue;
    }
    if (WS_RE.test(t)) {
      const m = WS_RE.exec(t)!;
      cond.windShear = { heightFt: parseInt(m[1], 10) * 100, dirDeg: parseInt(m[2], 10), speedKt: parseInt(m[3], 10) };
      i++;
      continue;
    }
    rest.push(t);
    i++;
  }
  return { cond, rvr, has, rest, warnings };
}

export function formatWind(w: Wind | null): string {
  if (!w) return '—';
  if (w.speedKt === 0 && !w.variable) return 'Calm';
  const dir = w.variable ? 'VRB' : String(w.dirDeg).padStart(3, '0') + '°';
  return `${dir} ${w.speedKt} kt${w.gustKt ? ` G${w.gustKt}` : ''}`;
}

export function formatVis(v: Visibility | null): string {
  if (!v) return '—';
  if (v.plus) return `${v.sm >= 6.5 ? '6+' : v.sm + '+'} SM`;
  const whole = Math.floor(v.sm);
  const frac = v.sm - whole;
  const fracs: Record<string, string> = { '0.25': '1/4', '0.5': '1/2', '0.75': '3/4', '0.125': '1/8', '0.375': '3/8', '0.625': '5/8', '0.875': '7/8' };
  const f = fracs[String(frac)];
  const s = f ? (whole ? `${whole} ${f}` : f) : String(Math.round(v.sm * 100) / 100);
  return `${v.less ? '<' : ''}${s} SM`;
}
