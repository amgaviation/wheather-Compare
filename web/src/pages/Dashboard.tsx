import React from 'react';
import { Area, Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, CAT_COLOR, type Conditions, type FlightCategory, type HistoryResponse, type LightMetar, type Station, type TafHour, type CurrentResponse } from '../lib/api';
import { ago, cToF, COVER_TEXT, fmtCeiling, fmtVis, fmtWind, local, num, pct, signed, wxText, zulu } from '../lib/format';
import { Card, CatBadge, ErrorBox, Loading, Pill, Stat, useAsync } from '../components/ui';

const HOUR = 3600_000;

function condSummary(c: Conditions): string {
  const parts: string[] = [];
  if (c.wind) parts.push(fmtWind(c.wind));
  if (c.cavok) parts.push('CAVOK');
  else {
    if (c.visibility) parts.push(fmtVis(c.visibility.sm, c.visibility.plus));
    if (c.weather.length) parts.push(c.weather.map((w) => wxText(w.raw)).join(', '));
    if (c.nsw) parts.push('no significant wx');
    if (c.clouds.length) parts.push(c.clouds.map((l) => `${COVER_TEXT[l.cover] ?? l.cover}${l.baseFt != null ? ` ${l.baseFt.toLocaleString()} ft` : ''}${l.type ? ' ' + l.type : ''}`).join(', '));
  }
  if (c.windShear) parts.push(`WS ${c.windShear.heightFt} ft ${c.windShear.dirDeg}°/${c.windShear.speedKt} kt`);
  return parts.join(' · ');
}

function MetarCard({ data }: { data: CurrentResponse }) {
  const m = data.metar;
  const st = data.station;
  if (!m) return <Card title="Current observation"><div className="muted">No METAR stored yet.</div></Card>;
  const r = m.remarks as Record<string, any>;
  const spread = m.tempC != null && m.dewpC != null ? m.tempC - m.dewpC : null;
  const stale = m.ageMin > 75;
  return (
    <Card title={`Current observation · ${m.type}`} sub={`${zulu(m.time, true)} · ${local(m.time, st.tz)} local · ${ago(m.time)}`} right={stale ? <Pill kind="warn">STALE</Pill> : undefined}>
      <div className="row" style={{ marginBottom: 10 }}>
        <CatBadge cat={m.category} big />
        <div className="raw" style={{ flex: 1 }}>{m.raw}</div>
      </div>
      <div className="stats">
        <Stat label="Wind" value={fmtWind(m.wind)} hint={m.wind?.varFromDeg != null ? `variable ${m.wind.varFromDeg}°–${m.wind.varToDeg}°` : undefined} small />
        <Stat label="Visibility" value={fmtVis(m.visSm, m.visSm != null && m.visSm >= 6.5)} hint={m.rvr.length ? m.rvr.map((x) => `RVR ${x.runway} ${x.qualifier === 'P' ? '>' : x.qualifier === 'M' ? '<' : ''}${x.minFt}${x.maxFt ? `–${x.maxFt}` : ''} ft`).join(', ') : undefined} small />
        <Stat label="Ceiling" value={fmtCeiling(m.ceilingFt)} hint={m.clouds.length ? m.clouds.map((l) => `${l.cover}${l.baseFt != null ? ' ' + l.baseFt.toLocaleString() : ''}${l.type ? ' ' + l.type : ''}`).join(' · ') : 'no layers'} small />
        <Stat label="Weather" value={m.wx.length ? m.wx.map((w) => wxText(w)).join(', ') : 'None'} small />
        <Stat label="Temp / Dew point" value={`${num(m.tempC, 1)}° / ${num(m.dewpC, 1)}°C`} hint={`${cToF(m.tempC)} / ${cToF(m.dewpC)} · spread ${num(spread, 1)}°C`} small />
        <Stat label="Altimeter" value={m.altimInHg != null ? `${m.altimInHg.toFixed(2)} inHg` : '—'} hint={m.slpHpa != null ? `SLP ${m.slpHpa.toFixed(1)} hPa` : undefined} small />
      </div>
      <div className="row small muted" style={{ marginTop: 10, gap: 14 }}>
        {r.automated && <span>{r.automated}{m.auto ? ' AUTO' : ''}</span>}
        {r.peakWind && <span>Peak wind {String(r.peakWind.dirDeg).padStart(3, '0')}°/{r.peakWind.speedKt} kt at {r.peakWind.hh != null ? String(r.peakWind.hh).padStart(2, '0') : ''}{String(r.peakWind.mm).padStart(2, '0')}Z</span>}
        {r.windShiftMin != null && <span>Wind shift :{String(r.windShiftMin).padStart(2, '0')}{r.frontalPassage ? ' (FROPA)' : ''}</span>}
        {r.pressureTendency && <span>3-h pressure {signed(r.pressureTendency.changeHpa, 1, ' hPa')} (code {r.pressureTendency.code})</span>}
        {r.pressureRisingRapidly && <span className="pill warn">PRESRR</span>}
        {r.pressureFallingRapidly && <span className="pill warn">PRESFR</span>}
        {r.precip1hrIn != null && <span>Precip 1 h {r.precip1hrIn.toFixed(2)} in</span>}
        {r.precip3or6hrIn != null && <span>Precip 3/6 h {r.precip3or6hrIn.toFixed(2)} in</span>}
        {r.variableCeiling && <span>Ceiling variable {r.variableCeiling.minFt}–{r.variableCeiling.maxFt} ft</span>}
        {r.variableVis && <span>Vis variable {r.variableVis.minSm}–{r.variableVis.maxSm} SM</span>}
        {r.towerVisSm != null && <span>Tower vis {r.towerVisSm} SM</span>}
        {r.lightning && <span>{r.lightning}</span>}
        {r.thunderstormBeganEnded && <span>{r.thunderstormBeganEnded}</span>}
        {r.maxTemp6hrC != null && <span>6-h max/min {r.maxTemp6hrC}/{r.minTemp6hrC}°C</span>}
        {Array.isArray(r.sensorFlags) && r.sensorFlags.length > 0 && <span className="pill warn">{r.sensorFlags.join(' ')}</span>}
        {r.maintenanceNeeded && <span className="pill" title="Maintenance check indicator ($)">$ maint</span>}
        {Array.isArray(r.other) && r.other.length > 0 && <span title="Un-decoded remark tokens">RMK: {r.other.join(' ')}</span>}
      </div>
      <div className="row small muted" style={{ marginTop: 8 }}>
        <span>Sunrise {local(data.sun.sunrise, st.tz)} / sunset {local(data.sun.sunset, st.tz)} local ({zulu(data.sun.sunrise)}–{zulu(data.sun.sunset)})</span>
        <span>· Elev {st.elev_ft ?? '—'} ft · {st.lat.toFixed(3)}, {st.lon.toFixed(3)} · {st.tz}</span>
      </div>
    </Card>
  );
}

const KIND_COLOR: Record<string, string> = { BASE: '#93c5fd', FM: '#93c5fd', TEMPO: '#fbbf24', BECMG: '#a78bfa', PROB30: '#f472b6', PROB40: '#f472b6', 'PROB30 TEMPO': '#f472b6', 'PROB40 TEMPO': '#f472b6' };

function TafStrip({ hours, tz, now }: { hours: TafHour[]; tz: string | null; now: number }) {
  const [sel, setSel] = React.useState<TafHour | null>(null);
  return (
    <div>
      <div className="tafhour">
        {hours.map((h) => {
          const isNow = now >= h.time && now < h.time + HOUR;
          return (
            <div key={h.time} className="h" onMouseEnter={() => setSel(h)} onClick={() => setSel(h)} title={`${zulu(h.time)} ${h.prevailingCategory ?? ''}`}>
              <div className="lbl" style={{ color: isNow ? 'var(--text)' : undefined }}>{String(new Date(h.time).getUTCHours()).padStart(2, '0')}</div>
              <div className="blk" style={{ background: h.prevailingCategory ? CAT_COLOR[h.prevailingCategory] : 'var(--border)', outline: isNow ? '2px solid #fff' : undefined }} />
              <div className="blk alt" style={{ background: h.alternates.length ? CAT_COLOR[h.worstCategory ?? 'VFR'] : 'transparent', border: h.alternates.length ? '1px dashed rgba(255,255,255,0.4)' : undefined }} />
            </div>
          );
        })}
      </div>
      <div className="legend" style={{ marginTop: 6 }}>
        <span style={{ ['--c' as string]: CAT_COLOR.VFR }}>VFR</span><span style={{ ['--c' as string]: CAT_COLOR.MVFR }}>MVFR</span><span style={{ ['--c' as string]: CAT_COLOR.IFR }}>IFR</span><span style={{ ['--c' as string]: CAT_COLOR.LIFR }}>LIFR</span>
        <span className="muted">top bar = prevailing; thin bar = worst TEMPO/PROB/BECMG alternate</span>
      </div>
      {sel && (
        <div className="small" style={{ marginTop: 8, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
          <div className="row">
            <strong>{zulu(sel.time, true)}</strong><span className="muted">{local(sel.time, tz)} local</span>
            <CatBadge cat={sel.prevailingCategory} /> <span className="muted">ceiling {fmtCeiling(sel.prevailingCeilingFt)} · from {sel.sourceGroups.join(' + ')}</span>
          </div>
          <div style={{ marginTop: 4 }}>Prevailing: {condSummary(sel.prevailing)}</div>
          {sel.alternates.map((a, i) => (
            <div key={i} style={{ marginTop: 2 }}>
              <span style={{ color: KIND_COLOR[a.kind] }}>{a.kind}</span> (assumed {pct(a.probability)}): <CatBadge cat={a.category} /> {condSummary(a.cond)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TafCard({ data }: { data: CurrentResponse }) {
  const [idx, setIdx] = React.useState(0);
  const t = data.tafs[idx];
  const now = Date.now();
  if (!t) return <Card title="Terminal Aerodrome Forecast"><div className="muted">No TAF stored yet{data.station.has_taf ? '' : ' (station has no TAF)'}.</div></Card>;
  const expired = t.validTo < now;
  return (
    <Card title="TAF" sub={`issued ${zulu(t.issued, true)} (${ago(t.issued)}) · valid ${zulu(t.validFrom, true)} – ${zulu(t.validTo, true)}`} right={<span className="row" style={{ gap: 4 }}>{t.amended && <Pill kind="warn">AMD</Pill>}{expired && <Pill kind="bad">EXPIRED</Pill>}{t.taf.parseWarnings.length > 0 && <Pill kind="warn" title={t.taf.parseWarnings.join('\n')}>parse warnings</Pill>}</span>}>
      <div className="raw" style={{ marginBottom: 10 }}>
        {t.taf.groups.map((g, i) => (
          <span key={i} style={{ color: i === 0 ? '#c7d2fe' : KIND_COLOR[g.kind] }}>{i === 0 ? t.raw.slice(0, t.raw.indexOf(g.raw) + g.raw.length) : ' ' + g.raw}</span>
        ))}
        {t.taf.maxTemp && <span className="muted"> TX{t.taf.maxTemp.c}/{zulu(t.taf.maxTemp.time)}</span>}
        {t.taf.minTemp && <span className="muted"> TN{t.taf.minTemp.c}/{zulu(t.taf.minTemp.time)}</span>}
      </div>
      <TafStrip hours={t.hours} tz={data.station.tz} now={now} />
      <div className="scroll-x" style={{ marginTop: 10 }}>
        <table className="tbl">
          <thead><tr><th>Group</th><th>From</th><th>To</th><th>Cat</th><th>Decoded</th></tr></thead>
          <tbody>
            {t.taf.groups.map((g, i) => {
              const h = t.hours.find((x) => x.time >= g.from && x.time < g.to);
              const cat = g.kind === 'BASE' || g.kind === 'FM' ? h?.prevailingCategory : h?.alternates.find((a) => a.kind === g.kind)?.category ?? null;
              return (
                <tr key={i}>
                  <td style={{ color: KIND_COLOR[g.kind], fontFamily: 'var(--mono)' }}>{g.kind}{g.probability ? '' : ''}</td>
                  <td className="mono">{zulu(g.from, true)}</td>
                  <td className="mono">{zulu(g.to, true)}</td>
                  <td><CatBadge cat={cat ?? null} /></td>
                  <td>{condSummary(g.cond) || <span className="muted">no change to listed elements</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.tafs.length > 1 && (
        <div className="tabs" style={{ marginTop: 10 }}>
          {data.tafs.map((x, i) => (
            <button key={x.id} className={i === idx ? 'active' : ''} onClick={() => setIdx(i)}>{zulu(x.issued, true)}{x.amended ? ' AMD' : ''}{i === 0 ? ' (latest)' : ''}</button>
          ))}
        </div>
      )}
    </Card>
  );
}

interface Pt { t: number; obsCeil: number | null; fcstCeil: number | null; worstCeil: number | null; obsVis: number | null; fcstVis: number | null; obsWind: number | null; obsGust: number | null; fcstWind: number | null; fcstGust: number | null; obsCat: FlightCategory | null; fcstCat: FlightCategory | null; worstCat: FlightCategory | null; nwsCeil: number | null; nwsVis: number | null; nwsWind: number | null; hit: number | null; label: string }

function buildSeries(h: HistoryResponse, tz: string | null): Pt[] {
  const start = Math.floor(h.start / HOUR) * HOUR;
  const end = Math.ceil(h.end / HOUR) * HOUR;
  const obsByHour = new Map<number, LightMetar>();
  for (const m of h.metars) {
    const cur = obsByHour.get(m.hourTime);
    if (!cur || (m.type === 'METAR' && cur.type !== 'METAR')) obsByHour.set(m.hourTime, m);
  }
  const ver = new Map(h.verification.map((v) => [v.hour_time, v]));
  const tafById = new Map(h.tafs.map((t) => [t.id, t]));
  const nws = h.nws[0] ? new Map(h.nws[0].hours.map((x) => [x.valid_time, x])) : new Map();
  const cap = (c: number | null | undefined) => (c == null ? 12000 : Math.min(c, 12000));
  const out: Pt[] = [];
  for (let t = start; t <= end; t += HOUR) {
    const o = obsByHour.get(t);
    const v = ver.get(t);
    // forecast for this hour: operative verification row if available, else latest TAF issued before t covering t
    let fh: HistoryResponse['tafs'][number]['hours'][number] | undefined;
    if (v) fh = tafById.get(v.taf_id)?.hours.find((x) => x.time === t);
    if (!fh) {
      const cands = h.tafs.filter((x) => x.issued <= t && x.validFrom <= t && t < x.validTo).sort((a, b) => b.issued - a.issued);
      fh = cands[0]?.hours.find((x) => x.time === t);
    }
    const n = nws.get(t);
    out.push({
      t, label: `${String(new Date(t).getUTCHours()).padStart(2, '0')}Z`,
      obsCeil: o ? cap(o.ceilingFt) : null, fcstCeil: fh ? cap(fh.ceilingFt) : null, worstCeil: fh ? cap(fh.worstCeilingFt) : null,
      obsVis: o ? (o.visSm == null ? null : Math.min(o.visSm, 10)) : null, fcstVis: fh ? (fh.visSm == null ? null : Math.min(fh.visSm, 10)) : null,
      obsWind: o?.wind?.speedKt ?? null, obsGust: o?.wind?.gustKt ?? null, fcstWind: fh?.wind?.speedKt ?? null, fcstGust: fh?.wind?.gustKt ?? null,
      obsCat: o?.category ?? null, fcstCat: fh?.cat ?? null, worstCat: fh?.worstCat ?? null,
      nwsCeil: n ? cap(n.ceiling_ft) : null, nwsVis: n?.vis_sm == null ? null : Math.min(n.vis_sm, 10), nwsWind: n?.wind_spd ?? null,
      hit: v?.cat_hit ?? null,
    });
  }
  void tz;
  return out;
}

function CatRows({ pts, tz }: { pts: Pt[]; tz: string | null }) {
  const rows: Array<{ label: string; key: keyof Pt }> = [{ label: 'Observed', key: 'obsCat' }, { label: 'TAF prevailing', key: 'fcstCat' }, { label: 'TAF worst (TEMPO/PROB)', key: 'worstCat' }];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '3px 8px', alignItems: 'center', fontSize: 11 }}>
      {rows.map((r) => (
        <React.Fragment key={r.key}>
          <div className="muted">{r.label}</div>
          <div style={{ display: 'grid', gridAutoFlow: 'column', gridAutoColumns: '1fr', gap: 1 }}>
            {pts.map((p) => {
              const c = p[r.key] as FlightCategory | null;
              return <div key={p.t} title={`${zulu(p.t, true)} ${local(p.t, tz)} local: ${c ?? '—'}`} style={{ height: 14, background: c ? CAT_COLOR[c] : 'transparent', borderRadius: 2, outline: r.key === 'obsCat' && p.hit === 0 ? '1px solid #fff' : undefined }} />;
            })}
          </div>
        </React.Fragment>
      ))}
      <div className="muted">Hour (Z)</div>
      <div style={{ display: 'grid', gridAutoFlow: 'column', gridAutoColumns: '1fr', gap: 1, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
        {pts.map((p) => <div key={p.t} style={{ textAlign: 'center', fontSize: 9 }}>{new Date(p.t).getUTCHours() % 3 === 0 ? String(new Date(p.t).getUTCHours()).padStart(2, '0') : ''}</div>)}
      </div>
    </div>
  );
}

const tip = { contentStyle: { background: '#1b2544', border: '1px solid #26325a', fontSize: 12 }, labelStyle: { color: '#8f9bc4' } };

function TimelineCard({ station }: { station: Station }) {
  const [hours, setHours] = React.useState(48);
  const { data, error, loading } = useAsync(() => api.history(station.icao, hours), [station.icao, hours], 5 * 60_000);
  const pts = React.useMemo(() => (data ? buildSeries(data, station.tz) : []), [data, station.tz]);
  const hitStats = React.useMemo(() => {
    const v = data?.verification ?? [];
    const n = v.filter((x) => x.cat_hit != null).length;
    const hit = v.filter((x) => x.cat_hit === 1).length;
    const cov = v.filter((x) => x.tempo_covered === 1).length;
    return { n, hit, cov };
  }, [data]);
  const nowLabel = pts.find((p) => Date.now() >= p.t && Date.now() < p.t + HOUR)?.label;
  return (
    <Card title="Forecast vs actual" sub={`operative TAF at each hour vs the routine observation · last ${hours} h`} right={<div className="tabs" style={{ margin: 0 }}>{[24, 48, 96, 168].map((h) => <button key={h} className={h === hours ? 'active' : ''} onClick={() => setHours(h)}>{h} h</button>)}</div>}>
      {error ? <ErrorBox error={error} /> : null}
      {loading && !data ? <Loading /> : null}
      {data && (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <Stat label="Category hits" value={hitStats.n ? pct(hitStats.hit / hitStats.n) : '—'} hint={`${hitStats.hit}/${hitStats.n} hours`} small />
            <Stat label="Covered incl. TEMPO/PROB" value={hitStats.n ? pct(hitStats.cov / hitStats.n) : '—'} small />
            <Stat label="TAF issuances in window" value={data.tafs.length} hint={`${data.tafs.filter((t) => t.amended).length} amendments`} small />
            <Stat label="Observations" value={data.metars.length} hint={`${data.metars.filter((m) => m.type === 'SPECI').length} SPECI`} small />
          </div>
          <CatRows pts={pts} tz={station.tz} />
          <div className="muted tiny" style={{ margin: '4px 0 8px' }}>White outline on an observed cell = operative TAF category miss.</div>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={pts} syncId="tl">
              <CartesianGrid stroke="#26325a" />
              <XAxis dataKey="label" stroke="#8f9bc4" tick={{ fontSize: 10 }} interval={Math.max(0, Math.floor(pts.length / 24) - 1)} />
              <YAxis stroke="#8f9bc4" tick={{ fontSize: 10 }} domain={[0, 12000]} ticks={[0, 500, 1000, 3000, 6000, 12000]} width={44} />
              <Tooltip {...tip} labelFormatter={(l: unknown, p: unknown) => { const arr = p as Array<{ payload?: Pt }> | undefined; return arr?.[0]?.payload ? `${zulu(arr[0].payload.t, true)} · ${local(arr[0].payload.t, station.tz)} local` : String(l); }} formatter={(v: unknown, name: unknown) => [Number(v) >= 12000 ? 'unlimited' : `${v} ft`, String(name)]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={1000} stroke={CAT_COLOR.IFR} strokeDasharray="3 3" />
              <ReferenceLine y={3000} stroke={CAT_COLOR.MVFR} strokeDasharray="3 3" />
              {nowLabel && <ReferenceLine x={nowLabel} stroke="#fff" strokeDasharray="2 2" />}
              <Area type="stepAfter" dataKey={(d: Pt) => (d.worstCeil != null && d.fcstCeil != null ? [d.worstCeil, d.fcstCeil] : null)} name="TAF worst-case range" stroke="none" fill="#f59e0b" fillOpacity={0.35} isAnimationActive={false} />
              <Line type="stepAfter" dataKey="fcstCeil" name="TAF ceiling" stroke="#60a5fa" dot={false} strokeWidth={2} connectNulls />
              <Line type="stepAfter" dataKey="nwsCeil" name="NWS grid ceiling" stroke="#a78bfa" dot={false} strokeDasharray="4 2" connectNulls />
              <Line type="monotone" dataKey="obsCeil" name="Observed ceiling" stroke="#f8fafc" dot={{ r: 2 }} strokeWidth={1.5} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="grid cols-2" style={{ marginTop: 6 }}>
            <ResponsiveContainer width="100%" height={160}>
              <ComposedChart data={pts} syncId="tl">
                <CartesianGrid stroke="#26325a" />
                <XAxis dataKey="label" stroke="#8f9bc4" tick={{ fontSize: 10 }} interval={Math.max(0, Math.floor(pts.length / 12) - 1)} />
                <YAxis stroke="#8f9bc4" tick={{ fontSize: 10 }} domain={[0, 10]} width={30} />
                <Tooltip {...tip} formatter={(v: unknown, name: unknown) => [`${v} SM`, String(name)]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine y={3} stroke={CAT_COLOR.IFR} strokeDasharray="3 3" />
                <ReferenceLine y={5} stroke={CAT_COLOR.MVFR} strokeDasharray="3 3" />
                <Line type="stepAfter" dataKey="fcstVis" name="TAF vis (P6SM=6)" stroke="#60a5fa" dot={false} strokeWidth={2} connectNulls />
                <Line type="monotone" dataKey="obsVis" name="Observed vis" stroke="#f8fafc" dot={{ r: 2 }} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
            <ResponsiveContainer width="100%" height={160}>
              <ComposedChart data={pts} syncId="tl">
                <CartesianGrid stroke="#26325a" />
                <XAxis dataKey="label" stroke="#8f9bc4" tick={{ fontSize: 10 }} interval={Math.max(0, Math.floor(pts.length / 12) - 1)} />
                <YAxis stroke="#8f9bc4" tick={{ fontSize: 10 }} width={30} />
                <Tooltip {...tip} formatter={(v: unknown, name: unknown) => [`${v} kt`, String(name)]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="obsGust" name="Observed gust" fill="#f59e0b" fillOpacity={0.5} />
                <Line type="stepAfter" dataKey="fcstWind" name="TAF wind" stroke="#60a5fa" dot={false} strokeWidth={2} connectNulls />
                <Line type="stepAfter" dataKey="fcstGust" name="TAF gust" stroke="#60a5fa" dot={false} strokeDasharray="3 3" connectNulls />
                <Line type="monotone" dataKey="obsWind" name="Observed wind" stroke="#f8fafc" dot={{ r: 2 }} connectNulls />
                <Line type="stepAfter" dataKey="nwsWind" name="NWS wind" stroke="#a78bfa" dot={false} strokeDasharray="4 2" connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </Card>
  );
}

function RecentVerificationCard({ station }: { station: Station }) {
  const { data, error } = useAsync(() => api.history(station.icao, 24), [station.icao], 5 * 60_000);
  if (error) return <Card title="Last 24 h scorecard"><ErrorBox error={error} /></Card>;
  const rows = [...(data?.verification ?? [])].reverse();
  const tafs = new Map((data?.tafs ?? []).map((t) => [t.id, t]));
  return (
    <Card title="Last 24 h scorecard" sub="hour by hour, operative TAF vs observation">
      <div className="scroll-x">
        <table className="tbl">
          <thead><tr><th>Hour</th><th>Obs</th><th>TAF</th><th>Worst</th><th className="num">Lead</th><th className="num">Ceil obs/fcst</th><th className="num">Vis obs/fcst</th><th className="num">Wind obs/fcst</th><th>Result</th></tr></thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.hour_time}>
                <td className="mono">{zulu(v.hour_time)} <span className="muted">{local(v.hour_time, station.tz)}</span></td>
                <td><CatBadge cat={v.obs_cat} /></td>
                <td><CatBadge cat={v.fcst_cat} /></td>
                <td>{v.worst_cat !== v.fcst_cat ? <CatBadge cat={v.worst_cat} /> : <span className="muted">—</span>}</td>
                <td className="num" title={`TAF issued ${zulu(tafs.get(v.taf_id)?.issued ?? null, true)}`}>{v.lead_hours.toFixed(0)} h</td>
                <td className="num">{v.obs_ceiling ?? '—'} / {v.fcst_ceiling ?? '—'}</td>
                <td className="num">{v.obs_vis ?? '—'} / {v.fcst_vis ?? '—'}</td>
                <td className="num">{v.obs_wspd ?? '—'} / {v.fcst_wspd ?? '—'} kt</td>
                <td>{v.cat_hit === 1 ? <Pill kind="good">hit</Pill> : v.tempo_covered ? <Pill kind="info">covered by TEMPO/PROB</Pill> : (v.cat_err ?? 0) > 0 ? <Pill kind="bad">worse than forecast</Pill> : <Pill kind="warn">better than forecast</Pill>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={9} className="muted">No verified hours yet in this window.</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function NwsCard({ station }: { station: Station }) {
  const { data, error } = useAsync(() => api.outlook(station.icao, 24), [station.icao], 10 * 60_000);
  if (error) return <Card title="Next 12 h: NWS grid vs TAF"><ErrorBox error={error} /></Card>;
  const hours = (data?.hours ?? []).slice(0, 12);
  return (
    <Card title="Next 12 h: NWS grid vs TAF" sub={data?.sources.nws ? `${station.nws_office ?? ''} grid issued ${zulu(data.sources.nws.issued, true)}` : 'NWS forecast not yet fetched'}>
      <div className="scroll-x">
        <table className="tbl">
          <thead><tr><th>Hour</th><th>TAF</th><th>NWS</th><th>Blend</th><th className="num">P(IFR+)</th><th className="num">Ceil</th><th className="num">Vis</th><th className="num">Sky</th><th className="num">PoP</th><th>Wind</th><th className="num">T/Td</th><th>NWS wording</th></tr></thead>
          <tbody>
            {hours.map((h) => {
              const n = h.sources.nws;
              return (
                <tr key={h.time}>
                  <td className="mono">{zulu(h.time)} <span className="muted">{local(h.time, station.tz)}</span></td>
                  <td>{h.sources.taf ? <CatBadge cat={h.sources.taf.cat} /> : <span className="muted">—</span>}</td>
                  <td>{n ? <CatBadge cat={n.cat} /> : <span className="muted">—</span>}</td>
                  <td><CatBadge cat={h.likely} /></td>
                  <td className="num" style={{ color: h.pIfrOrWorse >= 0.3 ? 'var(--ifr)' : undefined }}>{pct(h.pIfrOrWorse)}</td>
                  <td className="num">{n?.ceilingFt != null ? n.ceilingFt.toLocaleString() : '—'}</td>
                  <td className="num">{n?.visSm != null ? n.visSm : '—'}</td>
                  <td className="num">{n?.skyPct != null ? `${n.skyPct}%` : '—'}</td>
                  <td className="num">{n?.pop != null ? `${n.pop}%` : '—'}</td>
                  <td className="mono">{n ? fmtWind(n.wind) : '—'}</td>
                  <td className="num">{n ? `${num(n.tempC, 0)}/${num(n.dewpC, 0)}` : '—'}</td>
                  <td className="small">{n?.shortForecast ?? ''}{n?.wx ? ` · ${n.wx}` : ''}</td>
                </tr>
              );
            })}
            {!hours.length && <tr><td colSpan={12} className="muted">Outlook not available yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="muted tiny" style={{ marginTop: 6 }}>Blend and P(IFR+) come from the Outlook engine (TAF, NWS grid, models, climatology, persistence, each calibrated on this station's history).</div>
    </Card>
  );
}

export default function Dashboard({ station }: { station: Station }) {
  const { data, error, loading } = useAsync(() => api.current(station.icao), [station.icao], 60_000);
  if (error) return <ErrorBox error={error} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
      {station.backfill_status !== 'done' && (
        <div className="card small">
          <Pill kind={station.backfill_status === 'error' ? 'bad' : 'info'}>{station.backfill_status}</Pill> <span className="muted">{station.backfill_message ?? 'History backfill in progress; verification statistics will fill in shortly.'}</span>
        </div>
      )}
      <div className="grid cols-2">
        <MetarCard data={data} />
        <TafCard data={data} />
      </div>
      <TimelineCard station={station} />
      <NwsCard station={station} />
      <RecentVerificationCard station={station} />
    </div>
  );
}
