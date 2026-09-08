import type { FlightCategory, Wind } from './api';

export function zulu(t: number | null | undefined, withDate = false): string {
  if (t == null) return '—';
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  if (!withDate) return `${hh}${mm}Z`;
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
  return `${dd} ${mon} ${hh}${mm}Z`;
}

export function local(t: number | null | undefined, tz: string | null | undefined, opts: Intl.DateTimeFormatOptions = {}): string {
  if (t == null) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz ?? 'UTC', hour: '2-digit', minute: '2-digit', hour12: false, ...opts }).format(new Date(t));
  } catch {
    return zulu(t);
  }
}

export function dayLabel(t: number, tz: string | null | undefined): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz ?? 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(t));
}

export function ago(t: number | null | undefined): string {
  if (t == null) return '—';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function fmtWind(w: Wind | { dirDeg: number | null; speedKt: number | null; gustKt: number | null; variable?: boolean } | null | undefined): string {
  if (!w || w.speedKt == null) return '—';
  if (w.speedKt === 0) return 'Calm';
  const dir = 'variable' in w && w.variable ? 'VRB' : w.dirDeg == null ? 'VRB' : String(w.dirDeg).padStart(3, '0') + '°';
  return `${dir} ${w.speedKt} kt${w.gustKt ? ` G${w.gustKt}` : ''}`;
}

export function fmtVis(v: number | null | undefined, plus?: boolean): string {
  if (v == null) return '—';
  if (plus || v >= 6.5) return v >= 6.5 && v < 10 ? '6+ SM' : `${Math.round(v)} SM`;
  const fr: Record<number, string> = { 0.25: '1/4', 0.5: '1/2', 0.75: '3/4', 0.125: '1/8', 0.375: '3/8', 0.625: '5/8', 0.875: '7/8' };
  const whole = Math.floor(v);
  const frac = Math.round((v - whole) * 1000) / 1000;
  const f = fr[frac];
  return `${f ? (whole ? `${whole} ${f}` : f) : String(Math.round(v * 100) / 100)} SM`;
}

export function fmtCeiling(c: number | null | undefined): string {
  if (c == null) return 'None';
  return `${c.toLocaleString()} ft`;
}

export function pct(x: number | null | undefined, digits = 0): string {
  if (x == null || Number.isNaN(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

export function num(x: number | null | undefined, digits = 1, unit = ''): string {
  if (x == null || Number.isNaN(x)) return '—';
  return `${x.toFixed(digits)}${unit}`;
}

export function signed(x: number | null | undefined, digits = 1, unit = ''): string {
  if (x == null || Number.isNaN(x)) return '—';
  return `${x > 0 ? '+' : ''}${x.toFixed(digits)}${unit}`;
}

export function cToF(c: number | null | undefined): string {
  if (c == null) return '—';
  return `${Math.round((c * 9) / 5 + 32)}°F`;
}

export const CAT_DESC: Record<FlightCategory, string> = {
  VFR: 'Ceiling > 3,000 ft and vis > 5 SM',
  MVFR: 'Ceiling 1,000–3,000 ft and/or vis 3–5 SM',
  IFR: 'Ceiling 500–<1,000 ft and/or vis 1–<3 SM',
  LIFR: 'Ceiling < 500 ft and/or vis < 1 SM',
};

export const COVER_TEXT: Record<string, string> = { CLR: 'Clear', SKC: 'Sky clear', NSC: 'No significant cloud', NCD: 'No cloud detected', FEW: 'Few', SCT: 'Scattered', BKN: 'Broken', OVC: 'Overcast', VV: 'Vertical visibility' };

const WX_WORDS: Record<string, string> = {
  DZ: 'drizzle', RA: 'rain', SN: 'snow', SG: 'snow grains', IC: 'ice crystals', PL: 'ice pellets', GR: 'hail', GS: 'small hail/snow pellets', UP: 'unknown precipitation',
  BR: 'mist', FG: 'fog', FU: 'smoke', VA: 'volcanic ash', DU: 'dust', SA: 'sand', HZ: 'haze', PY: 'spray', PO: 'dust whirls', SQ: 'squalls', FC: 'funnel cloud', SS: 'sandstorm', DS: 'duststorm',
  MI: 'shallow', BC: 'patches of', PR: 'partial', DR: 'drifting', BL: 'blowing', SH: 'showers of', TS: 'thunderstorm with', FZ: 'freezing',
};
export function wxText(raw: string): string {
  const m = /^(\+|-|VC)?([A-Z]{2})?((?:[A-Z]{2})+)?$/.exec(raw);
  if (!m) return raw;
  const parts: string[] = [];
  if (m[1] === '+') parts.push('heavy');
  if (m[1] === '-') parts.push('light');
  if (m[1] === 'VC') parts.push('in the vicinity:');
  let desc: string | undefined = m[2];
  let ph = m[3] ?? '';
  if (desc && !WX_WORDS[desc]) { ph = desc + ph; desc = undefined; }
  if (desc && !ph && desc === 'TS') return `${parts.join(' ')} thunderstorm`.trim();
  if (desc && !ph && desc === 'SH') return `${parts.join(' ')} showers`.trim();
  if (desc) parts.push(WX_WORDS[desc]);
  for (let i = 0; i < ph.length; i += 2) parts.push(WX_WORDS[ph.slice(i, i + 2)] ?? ph.slice(i, i + 2));
  return parts.join(' ');
}
