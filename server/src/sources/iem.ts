/**
 * Iowa Environmental Mesonet (Iowa State University) public archives of NWS/FAA products.
 * ASOS/METAR archive: https://mesonet.agron.iastate.edu/request/download.phtml
 * TAF archive:        https://mesonet.agron.iastate.edu/request/taf.php
 */
import { fetchJson, fetchText } from './http.js';

const BASE = 'https://mesonet.agron.iastate.edu';

export interface IemMetarRow {
  validUtc: number;
  raw: string;
}

function fmtDate(d: Date) {
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/** Full-archive METAR download for a station. `station` is ICAO (K prefix stripped automatically for US). */
export async function fetchMetarArchive(icao: string, start: Date, end: Date): Promise<IemMetarRow[]> {
  const stn = icao.length === 4 && icao.startsWith('K') ? icao.slice(1) : icao;
  const s = fmtDate(start);
  const e = fmtDate(end);
  const url =
    `${BASE}/cgi-bin/request/asos.py?station=${encodeURIComponent(stn)}&data=metar` +
    `&year1=${s.y}&month1=${s.m}&day1=${s.d}&year2=${e.y}&month2=${e.m}&day2=${e.d}` +
    `&tz=Etc/UTC&format=onlycomma&latlon=no&elev=no&missing=M&trace=T&direct=no&report_type=3&report_type=4`;
  const txt = await fetchText(url, { timeoutMs: 240_000, retries: 2 });
  const out: IemMetarRow[] = [];
  const lines = txt.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const idx1 = line.indexOf(',');
    const idx2 = line.indexOf(',', idx1 + 1);
    if (idx1 < 0 || idx2 < 0) continue;
    const valid = line.slice(idx1 + 1, idx2);
    let raw = line.slice(idx2 + 1);
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    const t = Date.parse(valid.replace(' ', 'T') + ':00Z');
    if (Number.isNaN(t)) continue;
    out.push({ validUtc: t, raw });
  }
  return out;
}

export interface IemTafProduct {
  productId: string;
  issued: number;
  validFrom: number;
  validTo: number;
  amendment: boolean;
  raw: string;
}

interface OverviewRow {
  station: string;
  product_id: string;
  is_amendment: boolean;
  utc_issue: string;
  utc_expire: string;
  utc_issued: string;
}

/** Parse a CSV line respecting double quotes. */
function csvSplit(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Reconstruct raw TAF products for a station from the IEM archive (group lines + overview metadata).
 */
export async function fetchTafArchive(icao: string, start: Date, end: Date): Promise<IemTafProduct[]> {
  const sts = start.toISOString().slice(0, 16) + 'Z';
  const ets = end.toISOString().slice(0, 16) + 'Z';
  const [overview, csv] = await Promise.all([
    fetchJson<{ data: OverviewRow[] }>(`${BASE}/api/1/nws/taf_overview.json?station=${icao}&sts=${sts}&ets=${ets}`, { timeoutMs: 120_000, retries: 2 }),
    fetchText(`${BASE}/cgi-bin/request/taf.py?station=${icao}&sts=${sts}&ets=${ets}&fmt=csv`, { timeoutMs: 240_000, retries: 2 }),
  ]);
  const meta = new Map<string, OverviewRow>();
  for (const r of overview.data) meta.set(r.product_id, r);
  const lines = csv.split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const header = csvSplit(lines[0]);
  const col = (name: string) => header.indexOf(name);
  const cRaw = col('raw');
  const cFx = col('fx_valid');
  const cPid = col('product_id');
  const cType = col('ftype');
  const groups = new Map<string, Array<{ fx: string; type: string; raw: string; order: number }>>();
  for (let i = 1; i < lines.length; i++) {
    const f = csvSplit(lines[i]);
    const pid = f[cPid];
    if (!pid) continue;
    const arr = groups.get(pid) ?? [];
    arr.push({ fx: f[cFx], type: f[cType], raw: f[cRaw], order: i });
    groups.set(pid, arr);
  }
  const out: IemTafProduct[] = [];
  for (const [pid, rows] of groups) {
    const m = meta.get(pid);
    if (!m) continue;
    const issued = Date.parse(m.utc_issued);
    const validFrom = Date.parse(m.utc_issue);
    const validTo = Date.parse(m.utc_expire);
    if ([issued, validFrom, validTo].some(Number.isNaN)) continue;
    rows.sort((a, b) => (a.type === 'Observation' ? -1 : b.type === 'Observation' ? 1 : a.fx.localeCompare(b.fx) || a.order - b.order));
    const d = new Date(issued);
    const hh = (n: number) => String(n).padStart(2, '0');
    const dhm = `${hh(d.getUTCDate())}${hh(d.getUTCHours())}${hh(d.getUTCMinutes())}Z`;
    const vf = new Date(validFrom);
    const vt = new Date(validTo);
    // validity end hour 00 next day encoded as 24 of previous day? IEM stores exact expire; encode as DDHH with hour 24 when 00Z
    let vtDay = vt.getUTCDate();
    let vtHour = vt.getUTCHours();
    if (vtHour === 0) {
      const prev = new Date(validTo - 3600_000);
      vtDay = prev.getUTCDate();
      vtHour = 24;
    }
    const validity = `${hh(vf.getUTCDate())}${hh(vf.getUTCHours())}/${hh(vtDay)}${hh(vtHour)}`;
    const raw = `TAF ${m.is_amendment ? 'AMD ' : ''}${icao} ${dhm} ${validity} ${rows.map((r) => r.raw.trim()).join(' ')}`.replace(/\s+/g, ' ');
    out.push({ productId: pid, issued, validFrom, validTo, amendment: !!m.is_amendment, raw });
  }
  out.sort((a, b) => a.issued - b.issued);
  return out;
}
