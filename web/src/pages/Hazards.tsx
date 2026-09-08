import React from 'react';
import L from 'leaflet';
import { api } from '../lib/api';
import type { Station, StationHazards, AllHazards, WindsAloft } from '../lib/api';
import { zulu, local, ago } from '../lib/format';
import { Card, Loading, ErrorBox, Pill, useAsync } from '../components/ui';

const RADII = [100, 200, 300, 500];
const GAIRMET_HOURS = [0, 3, 6, 9, 12];

type Group = 'convective' | 'sigmet' | 'sierra' | 'tango' | 'zulu' | 'cwa' | 'pirep';
const GROUPS: Array<{ key: Group; label: string; color: string }> = [
  { key: 'convective', label: 'Convective SIGMET', color: '#ef4444' },
  { key: 'sigmet', label: 'SIGMET', color: '#f97316' },
  { key: 'sierra', label: 'G-AIRMET Sierra (IFR / MT_OBSC)', color: '#d946ef' },
  { key: 'tango', label: 'G-AIRMET Tango (TURB / LLWS / SFC_WND)', color: '#eab308' },
  { key: 'zulu', label: 'G-AIRMET Zulu (ICE / FZLVL)', color: '#22d3ee' },
  { key: 'cwa', label: 'CWA', color: '#f472b6' },
  { key: 'pirep', label: 'PIREPs', color: '#3b82f6' },
];

const GAIRMET_STYLE: Record<string, { color: string; dashed?: boolean; thin?: boolean }> = {
  IFR: { color: '#d946ef' },
  MT_OBSC: { color: '#a855f7' },
  'TURB-LO': { color: '#eab308' },
  'TURB-HI': { color: '#facc15' },
  ICE: { color: '#22d3ee' },
  LLWS: { color: '#f97316' },
  SFC_WND: { color: '#84cc16' },
  FZLVL: { color: '#93c5fd', dashed: true, thin: true },
  M_FZLVL: { color: '#bfdbfe', dashed: true, thin: true },
};

function gairmetGroup(g: AllHazards['gairmets'][number]): Group {
  const h = g.hazard.toUpperCase();
  if (h === 'IFR' || h === 'MT_OBSC') return 'sierra';
  if (h.startsWith('TURB') || h === 'LLWS' || h === 'SFC_WND') return 'tango';
  if (h === 'ICE' || h.includes('FZLVL')) return 'zulu';
  const p = g.product.toUpperCase();
  return p === 'SIERRA' ? 'sierra' : p === 'TANGO' ? 'tango' : 'zulu';
}

function popupEl(title: string, body: string, extra?: string): HTMLElement {
  const el = document.createElement('div');
  el.style.minWidth = '220px';
  const h = document.createElement('div');
  h.style.fontWeight = '600';
  h.style.marginBottom = '4px';
  h.textContent = title;
  el.appendChild(h);
  if (extra) {
    const x = document.createElement('div');
    x.style.fontSize = '11px';
    x.style.opacity = '0.75';
    x.style.marginBottom = '4px';
    x.textContent = extra;
    el.appendChild(x);
  }
  const pre = document.createElement('pre');
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.fontSize = '11px';
  pre.style.maxHeight = '220px';
  pre.style.overflow = 'auto';
  pre.style.margin = '0';
  pre.textContent = body;
  el.appendChild(pre);
  return el;
}

function fmtAlt(v: number | string | null | undefined, nullText = '—'): string {
  if (v == null || v === '') return nullText;
  const n = typeof v === 'string' ? parseInt(v, 10) : v;
  if (!Number.isFinite(n)) return String(v);
  // G-AIRMET base/top strings are hundreds of feet (e.g. "170" = FL170); numbers are feet.
  const ft = typeof v === 'string' && n < 1000 ? n * 100 : n;
  if (ft >= 18000) return `FL${String(Math.round(ft / 100)).padStart(3, '0')}`;
  return `${ft.toLocaleString()} ft`;
}

function pirepColor(p: StationHazards['pireps'][number]): string {
  if (p.urgent) return '#ef4444';
  const t = `${p.turb ?? ''} ${p.ice ?? ''}`.toUpperCase();
  if (/\bMOD\b|MDT|SEV|EXTRM|EXTREME/.test(t)) return '#f97316';
  return '#3b82f6';
}

function sevPill(sev: string | null): React.ReactNode {
  if (sev == null) return <span className="muted">—</span>;
  const s = String(sev).toUpperCase();
  const kind = /SEV|EXTREME|5|4/.test(s) ? 'bad' : /MOD|3/.test(s) ? 'warn' : '';
  return <Pill kind={kind}>{s}</Pill>;
}

function windCell(l: { dirDeg: number | null; speedKt: number | null; tempC: number | null; lightVariable: boolean } | undefined): string {
  if (!l) return '—';
  const t = l.tempC == null ? '' : ` ${l.tempC >= 0 ? '+' : '-'}${String(Math.abs(l.tempC)).padStart(2, '0')}°C`;
  if (l.lightVariable) return `L/V${t}`;
  if (l.dirDeg == null && l.speedKt == null) return t ? `—${t}` : '—';
  return `${l.dirDeg == null ? '—' : String(l.dirDeg).padStart(3, '0') + '°'}/${l.speedKt == null ? '—' : `${l.speedKt} kt`}${t}`;
}

export default function Hazards({ station }: { station: Station }) {
  const [radius, setRadius] = React.useState(200);
  const [enabled, setEnabled] = React.useState<Record<Group, boolean>>({ convective: true, sigmet: true, sierra: true, tango: true, zulu: true, cwa: true, pirep: true });
  const [gHours, setGHours] = React.useState<number[]>([0, 3]);

  const hz = useAsync(() => api.hazards(station.icao, radius), [station.icao, radius], 5 * 60_000);
  const all = useAsync(() => api.allHazards(), [], 5 * 60_000);
  const winds = useAsync(() => api.windsAloft(station.icao), [station.icao]);

  const mapDiv = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<L.Map | null>(null);
  const markerRef = React.useRef<L.Marker | null>(null);
  const circleRef = React.useRef<L.Circle | null>(null);
  const layersRef = React.useRef<Record<Group, L.LayerGroup> | null>(null);

  // init map once
  React.useEffect(() => {
    if (!mapDiv.current || mapRef.current) return;
    const map = L.map(mapDiv.current, { center: [station.lat, station.lon], zoom: 6, zoomControl: true, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 18 }).addTo(map);
    const groups = {} as Record<Group, L.LayerGroup>;
    for (const g of GROUPS) groups[g.key] = L.layerGroup().addTo(map);
    layersRef.current = groups;
    markerRef.current = L.marker([station.lat, station.lon]).addTo(map).bindPopup(`${station.icao} ${station.name ?? ''}`);
    circleRef.current = L.circle([station.lat, station.lon], { radius: radius * 1852, color: '#8f9bc4', weight: 1, dashArray: '4 4', fill: false }).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layersRef.current = null;
      markerRef.current = null;
      circleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // station / radius changes
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setView([station.lat, station.lon]);
    markerRef.current?.setLatLng([station.lat, station.lon]).bindPopup(`${station.icao} ${station.name ?? ''}`);
    circleRef.current?.setLatLng([station.lat, station.lon]).setRadius(radius * 1852);
  }, [station.lat, station.lon, station.icao, station.name, radius]);

  // available G-AIRMET forecast hours; if the default 0/3 snapshots are absent, fall back to the earliest available
  const availableHours = React.useMemo(() => {
    const s = new Set<number>();
    for (const g of all.data?.gairmets ?? []) s.add(g.forecastHour);
    return GAIRMET_HOURS.filter((h) => s.has(h)).concat([...s].filter((h) => !GAIRMET_HOURS.includes(h)).sort((a, b) => a - b));
  }, [all.data]);
  React.useEffect(() => {
    if (!availableHours.length) return;
    if (!gHours.some((h) => availableHours.includes(h))) setGHours([availableHours[0]]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableHours]);

  // (re)draw layers
  React.useEffect(() => {
    const groups = layersRef.current;
    if (!groups) return;
    for (const g of GROUPS) groups[g.key].clearLayers();
    const a = all.data;
    if (a) {
      for (const s of a.sigmets) {
        if (!s.coords?.length) continue;
        const conv = s.hazard?.toUpperCase() === 'CONVECTIVE' || /CONVECTIVE/i.test(s.type ?? '');
        const color = conv ? '#ef4444' : '#f97316';
        L.polygon(s.coords.map((c) => [c.lat, c.lon] as [number, number]), { color, weight: 2, fillOpacity: 0.12 })
          .bindPopup(popupEl(`${conv ? 'Convective ' : ''}SIGMET · ${s.hazard}`, s.raw ?? '', `Valid ${zulu(s.validFrom, true)} – ${zulu(s.validTo)} · ${fmtAlt(s.base, 'SFC')} – ${fmtAlt(s.top)}${s.severity != null ? ` · sev ${s.severity}` : ''}`))
          .addTo(groups[conv ? 'convective' : 'sigmet']);
      }
      for (const g of a.gairmets) {
        if (!g.coords?.length || !gHours.includes(g.forecastHour)) continue;
        const st = GAIRMET_STYLE[g.hazard.toUpperCase()] ?? { color: '#a3a3a3' };
        L.polygon(g.coords.map((c) => [c.lat, c.lon] as [number, number]), { color: st.color, weight: st.thin ? 1 : 1.5, dashArray: st.dashed ? '4 4' : undefined, fillOpacity: st.dashed ? 0.03 : 0.10 })
          .bindPopup(popupEl(`G-AIRMET ${g.product} · ${g.hazard}${g.severity ? ` (${g.severity})` : ''}`, `Forecast hour +${g.forecastHour} · valid ${zulu(g.validTime, true)}\n${fmtAlt(g.base, 'SFC')} – ${fmtAlt(g.top)}`))
          .addTo(groups[gairmetGroup(g)]);
      }
      for (const c of a.cwas) {
        if (!c.coords?.length) continue;
        L.polygon(c.coords.map((p) => [p.lat, p.lon] as [number, number]), { color: '#f472b6', weight: 2, fillOpacity: 0.12 })
          .bindPopup(popupEl(`CWA ${c.cwsu} · ${c.hazard}`, c.raw ?? '', `Valid ${zulu(c.validFrom, true)} – ${zulu(c.validTo)}`))
          .addTo(groups.cwa);
      }
    }
    for (const p of hz.data?.pireps ?? []) {
      if (p.lat == null || p.lon == null) continue;
      const color = pirepColor(p);
      L.circleMarker([p.lat, p.lon], { radius: p.urgent ? 7 : 5, color, fillColor: color, fillOpacity: 0.85, weight: 1 })
        .bindPopup(popupEl(`PIREP${p.urgent ? ' (URGENT)' : ''} · ${zulu(p.time)}${p.fltLvl != null ? ` · FL${String(p.fltLvl).padStart(3, '0')}` : ''}`, p.raw, `${p.distanceNm} nm / ${String(p.bearingDeg).padStart(3, '0')}° from ${station.icao}${p.acType ? ` · ${p.acType}` : ''}`))
        .addTo(groups.pirep);
    }
  }, [all.data, hz.data, gHours, station.icao]);

  // toggles
  React.useEffect(() => {
    const map = mapRef.current; const groups = layersRef.current;
    if (!map || !groups) return;
    for (const g of GROUPS) {
      const has = map.hasLayer(groups[g.key]);
      if (enabled[g.key] && !has) groups[g.key].addTo(map);
      if (!enabled[g.key] && has) map.removeLayer(groups[g.key]);
    }
  }, [enabled]);

  const counts = React.useMemo(() => {
    const c: Record<Group, number> = { convective: 0, sigmet: 0, sierra: 0, tango: 0, zulu: 0, cwa: 0, pirep: hz.data?.pireps.length ?? 0 };
    for (const s of all.data?.sigmets ?? []) c[s.hazard?.toUpperCase() === 'CONVECTIVE' ? 'convective' : 'sigmet']++;
    for (const g of all.data?.gairmets ?? []) if (gHours.includes(g.forecastHour)) c[gairmetGroup(g)]++;
    c.cwa = all.data?.cwas.length ?? 0;
    return c;
  }, [all.data, hz.data, gHours]);

  const tz = station.tz;
  const d = hz.data;
  const w = winds.data;

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="row spread">
        <div>
          <h2 style={{ margin: 0 }}>Hazards · {station.icao} <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>{station.name ?? ''}</span></h2>
          <div className="muted small">SIGMET / AIRMET / G-AIRMET / CWA / PIREP / NWS alerts within {radius} nm{d ? ` · fetched ${ago(d.fetchedAt)}` : ''}{hz.loading && d ? ' · refreshing…' : ''}</div>
        </div>
        <div className="tabs" style={{ marginBottom: 0 }}>
          {RADII.map((r) => <button key={r} className={r === radius ? 'active' : ''} onClick={() => setRadius(r)}>{r} nm</button>)}
        </div>
      </div>
      {hz.error && <ErrorBox error={hz.error} />}
      {all.error && <ErrorBox error={all.error} />}

      {/* a. Map */}
      <Card title="Hazard map" sub="all current CONUS products; click a shape for the raw text" right={all.loading ? <span className="muted small">loading hazards…</span> : undefined}>
        <div className="row" style={{ marginBottom: 8, gap: 14 }}>
          {GROUPS.map((g) => (
            <label key={g.key} className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={enabled[g.key]} onChange={(e) => setEnabled((s) => ({ ...s, [g.key]: e.target.checked }))} />
              <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: g.color }} />
              {g.label} <span className="muted tiny">({counts[g.key]})</span>
            </label>
          ))}
          <span className="small muted" style={{ marginLeft: 'auto' }}>G-AIRMET snapshot:</span>
          <div className="tabs" style={{ marginBottom: 0 }}>
            {(availableHours.length ? availableHours : GAIRMET_HOURS).map((h) => (
              <button key={h} className={gHours.includes(h) ? 'active' : ''} disabled={!availableHours.includes(h)} title={availableHours.includes(h) ? `Forecast hour +${h}` : 'not in current data'} onClick={() => setGHours((s) => (s.includes(h) ? s.filter((x) => x !== h) : [...s, h].sort((a, b) => a - b)))}>+{h} h</button>
            ))}
          </div>
        </div>
        <div className="map" ref={mapDiv} />
        <div className="legend" style={{ marginTop: 8 }}>
          <span style={{ '--c': '#ef4444' } as React.CSSProperties}>Convective SIGMET</span>
          <span style={{ '--c': '#f97316' } as React.CSSProperties}>SIGMET / LLWS</span>
          <span style={{ '--c': '#d946ef' } as React.CSSProperties}>IFR</span>
          <span style={{ '--c': '#a855f7' } as React.CSSProperties}>Mountain obscuration</span>
          <span style={{ '--c': '#eab308' } as React.CSSProperties}>Turbulence</span>
          <span style={{ '--c': '#22d3ee' } as React.CSSProperties}>Icing</span>
          <span style={{ '--c': '#84cc16' } as React.CSSProperties}>Surface wind</span>
          <span style={{ '--c': '#93c5fd' } as React.CSSProperties}>Freezing level (dashed)</span>
          <span style={{ '--c': '#f472b6' } as React.CSSProperties}>CWA</span>
          <span style={{ '--c': '#3b82f6' } as React.CSSProperties}>PIREP (red = urgent, orange = MOD/SEV)</span>
          <span style={{ '--c': '#8f9bc4' } as React.CSSProperties}>{radius} nm ring</span>
        </div>
      </Card>

      {/* b. Hazards affecting station */}
      <Card title={`Hazards affecting ${station.icao}`} sub={`products whose area is within ${radius} nm`}>
        {!d ? <Loading /> : d.items.length === 0 ? <div className="muted">No SIGMET / G-AIRMET / CWA within {radius} nm right now.</div> : (
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr><th>Kind</th><th>Hazard</th><th>Severity</th><th>Valid</th><th>Base – top</th><th className="num">Distance</th><th>Raw</th></tr>
              </thead>
              <tbody>
                {d.items.map((it) => {
                  const fh = it.extra && typeof it.extra.forecastHour === 'number' ? it.extra.forecastHour : null;
                  return (
                    <tr key={it.id}>
                      <td>{it.kind}{fh != null && <span className="muted tiny"> +{fh} h</span>}</td>
                      <td className="mono">{it.hazard}</td>
                      <td>{sevPill(it.severity)}</td>
                      <td className="mono small">{zulu(it.validFrom, true)} – {zulu(it.validTo)}<div className="muted tiny">{local(it.validFrom, tz)} – {local(it.validTo, tz)} local</div></td>
                      <td className="mono">{fmtAlt(it.base, 'SFC')} – {fmtAlt(it.top)}</td>
                      <td className="num">{it.inside || it.distanceNm === 0 ? <Pill kind="bad">INSIDE</Pill> : `${Math.round(it.distanceNm)} nm`}</td>
                      <td><details><summary>text</summary><div className="raw" style={{ marginTop: 4, maxWidth: 520 }}><pre>{it.raw}</pre></div></details></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid cols-2">
        {/* c. NWS alerts */}
        <Card title="NWS alerts" sub="api.weather.gov active alerts for the station point">
          {!d ? <Loading /> : d.alerts.length === 0 ? <div className="muted">No active NWS alerts.</div> : (
            <table className="tbl">
              <thead><tr><th>Event</th><th>Severity</th><th>Headline</th><th>Expires</th></tr></thead>
              <tbody>
                {d.alerts.map((a) => {
                  const exp = Date.parse(a.expires);
                  const sk = /extreme|severe/i.test(a.severity) ? 'bad' : /moderate/i.test(a.severity) ? 'warn' : '';
                  return (
                    <React.Fragment key={a.id}>
                      <tr>
                        <td><b>{a.event}</b><div className="muted tiny">{a.senderName}</div></td>
                        <td><Pill kind={sk}>{a.severity}</Pill><div className="muted tiny">{a.urgency}</div></td>
                        <td>{a.headline}</td>
                        <td className="mono small">{Number.isFinite(exp) ? zulu(exp, true) : a.expires}{Number.isFinite(exp) && <div className="muted tiny">{local(exp, tz, { month: 'short', day: 'numeric' })} local</div>}</td>
                      </tr>
                      <tr><td colSpan={4} style={{ paddingTop: 0 }}><details><summary>description · {a.areaDesc}</summary><div className="raw" style={{ marginTop: 4 }}><pre>{a.description}</pre></div></details></td></tr>
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        {/* d. PIREPs */}
        <Card title="PIREPs" sub={`pilot reports within ${radius} nm, newest first`}>
          {!d ? <Loading /> : d.pireps.length === 0 ? <div className="muted">No PIREPs within {radius} nm.</div> : (
            <div className="scroll-x">
              <table className="tbl">
                <thead>
                  <tr><th>Time</th><th>Dist / brg</th><th className="num">FL</th><th>Type</th><th>Turb</th><th>Icing</th><th>Sky</th><th>Wx</th><th className="num">Temp</th><th>Wind</th><th></th></tr>
                </thead>
                <tbody>
                  {d.pireps.slice().sort((a, b) => b.time - a.time).map((p, i) => (
                    <React.Fragment key={i}>
                      <tr>
                        <td className="mono">{zulu(p.time)}<div className="muted tiny">{ago(p.time)}</div></td>
                        <td className="mono">{p.distanceNm} nm / {String(p.bearingDeg).padStart(3, '0')}°</td>
                        <td className="num">{p.fltLvl != null ? String(p.fltLvl).padStart(3, '0') : '—'}</td>
                        <td className="mono">{p.acType ?? '—'}</td>
                        <td style={{ color: p.turb && /MOD|SEV|EXTRM/i.test(p.turb) ? '#fdba74' : undefined }}>{p.turb ?? '—'}</td>
                        <td style={{ color: p.ice && /MOD|SEV/i.test(p.ice) ? '#fdba74' : undefined }}>{p.ice ?? '—'}</td>
                        <td>{p.sky ?? '—'}</td>
                        <td>{p.wx ?? '—'}</td>
                        <td className="num">{p.temp != null ? `${p.temp}°C` : '—'}</td>
                        <td className="mono">{p.wind ?? '—'}</td>
                        <td>{p.urgent && <Pill kind="bad">URGENT</Pill>}</td>
                      </tr>
                      <tr><td colSpan={11} style={{ paddingTop: 0 }}><details><summary>raw</summary><div className="raw" style={{ marginTop: 4 }}>{p.raw}</div></details></td></tr>
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* e. Winds aloft */}
      <Card title="Winds and temperatures aloft" sub="FB forecast, nearest FB stations">
        {winds.loading && !w ? <Loading text="Loading winds aloft…" /> : winds.error ? <ErrorBox error={winds.error} /> : !w ? null : w.unsupported ? (
          <div className="muted">Winds aloft not available: {w.reason ?? 'unsupported for this station'}</div>
        ) : (
          <>
            <div className="muted small" style={{ marginBottom: 8 }}>
              Region {w.region.toUpperCase()} · columns are the 06 / 12 / 24 h FB products · direction/speed temp · "L/V" = light and variable (&lt;5 kt) · temperatures negative above 24,000 ft · speeds ≥100 kt are decoded.
            </div>
            <div className="grid cols-3">
              {w.nearest.map((st) => {
                const levels = Array.from(new Set(w.forecasts.flatMap((f) => f.levels)));
                const highRow = w.high?.rows.find((r) => r.station === st.id);
                const highLevels = highRow ? w.high!.levels : [];
                const highCol = w.high ? Math.max(0, w.forecasts.findIndex((f) => f.validFor === w.high!.validFor)) : -1;
                return (
                  <div key={st.id}>
                    <div style={{ fontWeight: 600 }}>{st.id} <span className="muted" style={{ fontWeight: 400 }}>{st.name} · {st.distanceNm} nm</span></div>
                    <table className="tbl" style={{ marginTop: 4 }}>
                      <thead>
                        <tr><th className="num">Level</th>{w.forecasts.map((f) => <th key={f.fcst}>{f.fcst} h</th>)}</tr>
                      </thead>
                      <tbody>
                        {levels.map((lv) => (
                          <tr key={lv}>
                            <td className="num">{Number(lv).toLocaleString()}</td>
                            {w.forecasts.map((f) => {
                              const row = f.rows.find((r) => r.station === st.id);
                              return <td key={f.fcst} className="mono small">{windCell(row?.levels[lv])}</td>;
                            })}
                          </tr>
                        ))}
                        {highLevels.map((lv) => (
                          <tr key={lv} className="muted">
                            <td className="num">{Number(lv).toLocaleString()}</td>
                            {w.forecasts.map((f, i) => <td key={f.fcst} className="mono small">{i === highCol ? windCell(highRow?.levels[lv]) : '—'}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
            <div className="muted tiny" style={{ marginTop: 8 }}>
              {w.forecasts.map((f) => <div key={f.fcst}><b>{f.fcst} h</b> ({f.header}): {f.basedOn} · {f.validFor.replace(/\s+/g, ' ')}</div>)}
              {w.high && <div><b>High levels</b> ({w.high.header}): {w.high.basedOn} · {w.high.validFor.replace(/\s+/g, ' ')}</div>}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
