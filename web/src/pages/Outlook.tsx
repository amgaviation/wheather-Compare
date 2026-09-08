import React from 'react';
import { Area, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, CAT_COLOR, CATS, type FlightCategory, type Outlook as OutlookT, type OutlookHour, type Probs, type Station } from '../lib/api';
import { fmtCeiling, fmtVis, fmtWind, local, num, pct, signed, zulu, dayLabel } from '../lib/format';
import { Card, CatBadge, ErrorBox, Loading, Pill, Stat, useAsync } from '../components/ui';

const HOUR = 3600_000;
const tip = { contentStyle: { background: '#1b2544', border: '1px solid #26325a', fontSize: 12 }, labelStyle: { color: '#8f9bc4' } };

function ProbBar({ p, height = 26 }: { p: Probs; height?: number }) {
  return (
    <div className="bar" style={{ height }}>
      {CATS.map((c) => (
        <div key={c} style={{ height: `${p[c] * 100}%`, background: CAT_COLOR[c] }} />
      ))}
    </div>
  );
}

function ProbStrip({ hours, tz, onSelect, selected }: { hours: OutlookHour[]; tz: string; onSelect: (h: OutlookHour) => void; selected: OutlookHour | null }) {
  let lastDay = '';
  return (
    <div className="hourstrip">
      {hours.map((h) => {
        const d = new Date(h.time);
        const day = dayLabel(h.time, tz);
        const showDay = day !== lastDay;
        lastDay = day;
        const lh = local(h.time, tz, { hour: '2-digit', minute: undefined }).replace(/:00$/, '');
        return (
          <div key={h.time} className={`cell ${h.night ? 'night' : ''}`} onClick={() => onSelect(h)} title={`${zulu(h.time, true)} · ${local(h.time, tz)} local\nP(VFR) ${pct(h.probs.VFR)} P(MVFR) ${pct(h.probs.MVFR)} P(IFR) ${pct(h.probs.IFR)} P(LIFR) ${pct(h.probs.LIFR)}\n${h.flags.join('\n')}`}>
            <div className="lbl" style={{ color: showDay ? 'var(--text)' : undefined, fontWeight: showDay ? 700 : 400, whiteSpace: 'nowrap' }}>{showDay ? day.split(',')[0] : ''}</div>
            <div style={{ width: '100%', outline: selected?.time === h.time ? '2px solid #fff' : undefined, borderRadius: 3, opacity: h.night ? 0.8 : 1 }}>
              <ProbBar p={h.probs} />
            </div>
            <div className="lbl">{String(d.getUTCHours()).padStart(2, '0')}</div>
            <div className="lbl" style={{ color: '#5b6590' }}>{lh}</div>
            <div style={{ height: 4, width: '100%', background: h.flags.length ? 'var(--warn)' : 'transparent', borderRadius: 2 }} />
          </div>
        );
      })}
    </div>
  );
}

function DayCards({ o }: { o: OutlookT }) {
  return (
    <div className="grid cols-4">
      {o.days.map((d) => (
        <div key={d.date} className="daycard">
          <div className="title">
            <span>{d.label}</span>
            <CatBadge cat={d.worstLikely} title="Worst most-likely category during the day" />
          </div>
          <div className="row small" style={{ gap: 12 }}>
            <span title="Probability of at least one IFR-or-worse period (6-h episodes)">IFR+ <strong style={{ color: d.pAnyIfr >= 0.5 ? 'var(--ifr)' : d.pAnyIfr >= 0.25 ? 'var(--warn)' : undefined }}>{pct(d.pAnyIfr)}</strong></span>
            <span title="Probability of at least one MVFR-or-worse period">MVFR+ <strong>{pct(d.pAnyMvfr)}</strong></span>
            <span title="Mean probability of the most likely category">conf <strong>{pct(d.confidence)}</strong></span>
            {d.modelAgreement != null && <span title="Share of hours where all models agree on the category proxy">models agree <strong>{pct(d.modelAgreement)}</strong></span>}
          </div>
          <div className="row small muted" style={{ gap: 12 }}>
            <span>wind ≤{d.maxWindKt ?? '—'} kt{d.maxGustKt ? ` G${d.maxGustKt}` : ''}</span>
            <span>PoP {d.maxPop != null ? `${d.maxPop}%` : '—'}</span>
            {d.maxThunder != null && d.maxThunder > 0 && <span>TS {d.maxThunder}%</span>}
            <span>{num(d.minTempC, 0)}–{num(d.maxTempC, 0)}°C</span>
            <span>☀ {local(d.sunrise, o.tz)}–{local(d.sunset, o.tz)}</span>
          </div>
          {d.concernWindows.length ? (
            <ul className="clean small">
              {d.concernWindows.map((w, i) => (
                <li key={i}>
                  <span className="mono">{local(w.from, o.tz)}–{local(w.to, o.tz)}</span> <CatBadge cat={w.likely} /> {w.pIfr >= 0.2 && <span className="muted">P(IFR+) {pct(w.pIfr)}</span>}
                  {w.drivers.length > 0 && <div className="tiny muted">{w.drivers.slice(0, 3).join(' · ')}</div>}
                </li>
              ))}
            </ul>
          ) : (
            <div className="small muted">No MVFR-or-worse periods expected.</div>
          )}
        </div>
      ))}
    </div>
  );
}

function TrendsCard({ o }: { o: OutlookT }) {
  const t = o.trends;
  const arrow = (x: number | null, invert = false) => (x == null ? '' : x > 0 !== invert ? '↑' : x < 0 !== invert ? '↓' : '→');
  return (
    <Card title="Observed trends" sub="from the last 6–12 h of METARs and successive TAFs">
      <div className="stats">
        <Stat label="Pressure 3 h" value={t.pressure.slp3hHpa != null ? `${signed(t.pressure.slp3hHpa, 1)} hPa` : t.pressure.altim3hInHg != null ? `${signed(t.pressure.altim3hInHg, 2)} inHg` : '—'} hint={`${t.pressure.slp6hHpa != null ? `6 h ${signed(t.pressure.slp6hHpa, 1)} hPa · ` : ''}${t.pressure.rapid ? `${t.pressure.rapid} rapidly` : t.pressure.tendencyCode != null ? `tendency code ${t.pressure.tendencyCode}` : ''}`} small />
        <Stat label="T–Td spread" value={`${num(t.spread.nowC, 1)}°C ${arrow(t.spread.change3hC)}`} hint={t.spread.change3hC != null ? `${signed(t.spread.change3hC, 1)}°C in 3 h` : undefined} small />
        <Stat label="Ceiling" value={`${fmtCeiling(t.ceiling.nowFt)} ${arrow(t.ceiling.change3hFt)}`} hint={t.ceiling.change3hFt != null ? `${signed(t.ceiling.change3hFt, 0)} ft / 3 h · ${signed(t.ceiling.change6hFt, 0)} ft / 6 h` : undefined} small />
        <Stat label="Visibility" value={`${fmtVis(t.vis.nowSm)} ${arrow(t.vis.change3hSm)}`} hint={t.vis.change3hSm != null ? `${signed(t.vis.change3hSm, 1)} SM / 3 h` : undefined} small />
        <Stat label="Wind" value={`${t.wind.nowKt ?? '—'} kt${t.wind.gustKt ? ` G${t.wind.gustKt}` : ''} ${arrow(t.wind.change3hKt)}`} hint={t.wind.dirChange3hDeg != null ? `dir ${signed(t.wind.dirChange3hDeg, 0)}° / 3 h` : undefined} small />
        <Stat label="Category last 6 h" value={<span className="row" style={{ gap: 3 }}>{t.category.sequence6h.map((c, i) => <span key={i} className={`cat ${c ?? 'none'}`} style={{ fontSize: 10, padding: '1px 4px' }}>{c ?? '?'}</span>)}</span>} small />
      </div>
      <div className="row small" style={{ marginTop: 10, gap: 16 }}>
        <div>
          <span className="muted">TAF drift: </span>
          <Pill kind={t.tafDrift.verdict === 'worsening' ? 'bad' : t.tafDrift.verdict === 'improving' ? 'good' : ''}>{t.tafDrift.verdict}</Pill> <span className="muted">{t.tafDrift.detail}</span>
        </div>
        <div><span className="muted">Model agreement next 24 h: </span><strong>{pct(t.modelAgreementNext24)}</strong></div>
      </div>
    </Card>
  );
}

function HourDetail({ h, tz }: { h: OutlookHour; tz: string }) {
  const s = h.sources;
  const wsum = h.weights.taf + h.weights.nws + h.weights.models + h.weights.climo + h.weights.persistence || 1;
  const P = ({ p }: { p: Probs }) => <span className="mono tiny">{CATS.map((c) => `${c[0]}${Math.round(p[c] * 100)}`).join(' ')}</span>;
  return (
    <Card title={`Hour detail · ${zulu(h.time, true)}`} sub={`${local(h.time, tz, { weekday: 'short', hour: '2-digit', minute: '2-digit' })} local · lead +${h.leadHours} h · ${h.night ? 'night' : 'day'}`}>
      <div className="row" style={{ marginBottom: 8 }}>
        <CatBadge cat={h.likely} big />
        <div style={{ width: 120 }}><ProbBar p={h.probs} height={34} /></div>
        <div className="small">
          {CATS.map((c) => <div key={c}><span style={{ color: CAT_COLOR[c] }}>■</span> {c} {pct(h.probs[c])}</div>)}
        </div>
        <div className="stats" style={{ flex: 1 }}>
          <Stat label="Ceiling" value={fmtCeiling(h.ceilingFt)} hint={h.ceilingLowFt != null && h.ceilingLowFt !== h.ceilingFt ? `pessimistic ${fmtCeiling(h.ceilingLowFt)}` : undefined} small />
          <Stat label="Visibility" value={fmtVis(h.visSm, h.visSm != null && h.visSm >= 6)} hint={h.visLowSm != null && h.visLowSm !== h.visSm ? `pessimistic ${fmtVis(h.visLowSm)}` : undefined} small />
          <Stat label="Wind" value={fmtWind(h.wind)} hint={h.wind ? `${h.wind.source}${h.wind.adjustedKt != null && h.wind.adjustedKt !== h.wind.speedKt ? ` · bias-adjusted ${h.wind.adjustedKt} kt` : ''}` : undefined} small />
          <Stat label="Temp / Td" value={`${num(h.tempC, 0)}° / ${num(h.dewpC, 0)}°C`} hint={`spread ${num(h.spreadC, 1)}°C`} small />
          <Stat label="PoP / TS" value={`${h.pop ?? '—'}% / ${h.probThunder ?? '—'}%`} small />
        </div>
      </div>
      {h.flags.length > 0 && <div style={{ marginBottom: 8 }}>{h.flags.map((f) => <span key={f} className="flag">{f}</span>)}</div>}
      {h.wxSummary.length > 0 && <div className="small" style={{ marginBottom: 8 }}><span className="muted">Weather mentioned: </span>{h.wxSummary.join(' · ')}</div>}
      <div className="scroll-x">
        <table className="tbl">
          <thead><tr><th>Source</th><th>Says</th><th>Calibrated P(obs)</th><th className="num">Skill</th><th className="num">Weight</th><th>Detail</th></tr></thead>
          <tbody>
            <tr>
              <td>TAF</td>
              <td>{s.taf ? <span className="row" style={{ gap: 4 }}><CatBadge cat={s.taf.cat} />{s.taf.alternates.map((a, i) => <span key={i} className="tiny">{a.kind} <CatBadge cat={a.cat} /></span>)}</span> : <span className="muted">beyond TAF validity</span>}</td>
              <td>{s.taf ? <P p={s.taf.calibrated} /> : ''}</td>
              <td className="num">{pct(s.taf?.skill)}</td>
              <td className="num">{pct(h.weights.taf / wsum)}</td>
              <td className="small">{s.taf ? `${fmtCeiling(s.taf.ceilingFt)} · ${fmtVis(s.taf.visSm, s.taf.visSm != null && s.taf.visSm >= 6)} · ${fmtWind(s.taf.wind)} ${s.taf.wx.join(' ')} · lead ${s.taf.leadBucket} h · ${s.taf.groups.join('+')}` : ''}</td>
            </tr>
            <tr>
              <td>NWS grid</td>
              <td>{s.nws ? <CatBadge cat={s.nws.cat} /> : <span className="muted">n/a</span>}</td>
              <td>{s.nws ? <P p={s.nws.calibrated} /> : ''}</td>
              <td className="num">{pct(s.nws?.skill)}</td>
              <td className="num">{pct(h.weights.nws / wsum)}</td>
              <td className="small">{s.nws ? `${fmtCeiling(s.nws.ceilingFt)} · ${fmtVis(s.nws.visSm)} · sky ${s.nws.skyPct ?? '—'}% · PoP ${s.nws.pop ?? '—'}% · ${fmtWind(s.nws.wind)} · ${num(s.nws.tempC, 0)}/${num(s.nws.dewpC, 0)}°C · ${s.nws.shortForecast ?? ''} ${s.nws.wx ? '· ' + s.nws.wx : ''} · day ${s.nws.leadDay}` : ''}</td>
            </tr>
            {s.models.map((m) => (
              <tr key={m.model}>
                <td>{m.label}</td>
                <td><CatBadge cat={m.cat} title="Proxy from low cloud, dew-point depression, visibility and wx code" /></td>
                <td><P p={m.calibrated} /></td>
                <td className="num">{pct(m.skill)}</td>
                <td className="num">{pct(h.weights.models / wsum / Math.max(1, s.models.length))}</td>
                <td className="small">{`low cld ${m.cloudLowPct ?? '—'}% · total ${m.cloudPct ?? '—'}% · est. base ${m.ceilingGuessFt != null ? m.ceilingGuessFt + ' ft' : '—'} · vis ${m.visGuessSm != null ? m.visGuessSm.toFixed(1) + ' SM' : '—'} · ${fmtWind(m.wind)} · ${num(m.tempC, 0)}/${num(m.dewpC, 0)}°C · ${m.wx} · precip ${num(m.precipMm, 1)} mm${m.cape != null && m.cape > 300 ? ` · CAPE ${Math.round(m.cape)}` : ''}`}</td>
              </tr>
            ))}
            <tr>
              <td>Climatology</td>
              <td className="muted small">this month × hour</td>
              <td>{s.climo ? <P p={s.climo} /> : <span className="muted">insufficient</span>}</td>
              <td className="num">—</td>
              <td className="num">{pct(h.weights.climo / wsum)}</td>
              <td className="small muted">Observed category frequency at this station for this month and hour of day.</td>
            </tr>
            <tr>
              <td>Persistence</td>
              <td>{s.persistence ? <CatBadge cat={s.persistence.cat} /> : <span className="muted">—</span>}</td>
              <td></td>
              <td className="num">—</td>
              <td className="num">{pct(h.weights.persistence / wsum)}</td>
              <td className="small muted">Current observation, decaying with lead time.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SkillCard({ o }: { o: OutlookT }) {
  return (
    <Card title="Source skill used for weighting" sub={`category hit rate at this station, last ${o.sources.historyDays} d (${o.sources.verificationPairs.toLocaleString()} TAF pairs)`}>
      <div className="grid cols-3">
        <div>
          <div className="muted tiny">TAF by lead (h)</div>
          <table className="tbl"><tbody>{Object.entries(o.skill.tafByLead).map(([k, v]) => <tr key={k}><td>{k}</td><td className="num">{pct(v)}</td></tr>)}</tbody></table>
        </div>
        <div>
          <div className="muted tiny">NWS grid by lead day</div>
          <table className="tbl"><tbody>{Object.entries(o.skill.nwsByLeadDay).slice(0, 5).map(([k, v]) => <tr key={k}><td>day {k}</td><td className="num">{v == null ? <span className="muted">accruing</span> : pct(v)}</td></tr>)}</tbody></table>
        </div>
        <div>
          <div className="muted tiny">Models (proxy) by lead day</div>
          <table className="tbl"><thead><tr><th></th>{['1', '2', '3', '5'].map((d) => <th key={d} className="num">d{d}</th>)}</tr></thead><tbody>{Object.entries(o.skill.modelByLeadDay).map(([m, v]) => <tr key={m}><td>{m.replace('_seamless', '').replace('_ifs025', '').toUpperCase()}</td>{['1', '2', '3', '5'].map((d) => <td key={d} className="num">{pct(v[d])}</td>)}</tr>)}</tbody></table>
        </div>
      </div>
      <div className="muted tiny" style={{ marginTop: 6 }}>Unknown skill falls back to defaults (TAF 0.8, NWS 0.65, models 0.6). Each source's forecast is first converted into a calibrated distribution P(observed | forecast) from station history, then blended with skill- and lead-dependent weights plus climatology and persistence.</div>
    </Card>
  );
}

export default function Outlook({ station }: { station: Station }) {
  const [horizon, setHorizon] = React.useState(120);
  const { data: o, error, loading } = useAsync(() => api.outlook(station.icao, horizon), [station.icao, horizon], 5 * 60_000);
  const [sel, setSel] = React.useState<OutlookHour | null>(null);
  React.useEffect(() => setSel(null), [station.icao]);
  if (error) return <ErrorBox error={error} />;
  if (loading && !o) return <Loading text="Building outlook…" />;
  if (!o) return null;
  const tz = o.tz;
  const chart = o.hours.map((h) => ({
    t: h.time, label: `${dayLabel(h.time, tz).split(',')[0]} ${String(new Date(h.time).getUTCHours()).padStart(2, '0')}Z`,
    pIfr: Math.round(h.pIfrOrWorse * 100), pMvfr: Math.round(h.pMvfrOrWorse * 100), ceil: h.ceilingFt == null ? 12000 : Math.min(h.ceilingFt, 12000), ceilLow: h.ceilingLowFt == null ? 12000 : Math.min(h.ceilingLowFt, 12000),
    wind: h.wind?.speedKt ?? null, gust: h.wind?.gustKt ?? null, temp: h.tempC, dewp: h.dewpC, pop: h.pop, night: h.night ? 100 : 0,
  }));
  const selected = sel ?? o.hours[0];
  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
      <div className="row spread">
        <div className="small muted">
          Generated {zulu(o.generatedAt)} · TAF {o.sources.taf ? `${zulu(o.sources.taf.issued, true)}${o.sources.taf.amended ? ' AMD' : ''} valid to ${zulu(o.sources.taf.validTo, true)}` : 'none'} · NWS {o.sources.nws ? `${o.sources.nws.office ?? ''} ${zulu(o.sources.nws.issued, true)}` : 'none'} · Models {o.sources.models.length ? o.sources.models.join(', ') : 'none'} · {o.sources.climoObsCount.toLocaleString()} obs climatology
        </div>
        <div className="tabs" style={{ margin: 0 }}>{[72, 120, 168].map((h) => <button key={h} className={h === horizon ? 'active' : ''} onClick={() => setHorizon(h)}>{h / 24} days</button>)}</div>
      </div>
      <DayCards o={o} />
      <div className="grid cols-2">
        <Card title="What matters" sub="generated from trends, calibration history and source disagreement">
          <ul className="clean small">{o.insights.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </Card>
        <TrendsCard o={o} />
      </div>
      <Card title="Hourly flight-category probabilities" sub="click an hour for the source breakdown · amber tick = flagged hour">
        <ProbStrip hours={o.hours} tz={tz} onSelect={setSel} selected={sel} />
        <div className="legend" style={{ marginTop: 6 }}>
          {CATS.map((c) => <span key={c} style={{ ['--c' as string]: CAT_COLOR[c] }}>{c}</span>)}
          <span className="muted">Hour labels: UTC (top), local (bottom). Dimmed = night.</span>
        </div>
      </Card>
      <HourDetail h={selected} tz={tz} />
      <Card title="Probability and element traces">
        <ResponsiveContainer width="100%" height={180}>
          <ComposedChart data={chart} syncId="ol">
            <CartesianGrid stroke="#26325a" />
            <XAxis dataKey="label" stroke="#8f9bc4" tick={{ fontSize: 10 }} interval={11} />
            <YAxis stroke="#8f9bc4" tick={{ fontSize: 10 }} domain={[0, 100]} width={34} unit="%" />
            <Tooltip {...tip} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Area type="monotone" dataKey="night" name="night" stroke="none" fill="#000" fillOpacity={0.18} isAnimationActive={false} />
            <Area type="monotone" dataKey="pMvfr" name="P(MVFR or worse)" stroke={CAT_COLOR.MVFR} fill={CAT_COLOR.MVFR} fillOpacity={0.2} />
            <Area type="monotone" dataKey="pIfr" name="P(IFR or worse)" stroke={CAT_COLOR.IFR} fill={CAT_COLOR.IFR} fillOpacity={0.35} />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="grid cols-3">
          <ResponsiveContainer width="100%" height={160}>
            <ComposedChart data={chart} syncId="ol">
              <CartesianGrid stroke="#26325a" />
              <XAxis dataKey="label" stroke="#8f9bc4" tick={{ fontSize: 10 }} interval={23} />
              <YAxis stroke="#8f9bc4" tick={{ fontSize: 10 }} domain={[0, 12000]} ticks={[500, 1000, 3000, 6000, 12000]} width={40} />
              <Tooltip {...tip} formatter={(v: unknown, n: unknown) => [Number(v) >= 12000 ? 'unlimited' : `${v} ft`, String(n)]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={1000} stroke={CAT_COLOR.IFR} strokeDasharray="3 3" />
              <ReferenceLine y={3000} stroke={CAT_COLOR.MVFR} strokeDasharray="3 3" />
              <Area type="stepAfter" dataKey="ceilLow" name="Pessimistic ceiling" stroke="none" fill="#f59e0b" fillOpacity={0.15} />
              <Line type="stepAfter" dataKey="ceil" name="Expected ceiling" stroke="#60a5fa" dot={false} strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
          <ResponsiveContainer width="100%" height={160}>
            <ComposedChart data={chart} syncId="ol">
              <CartesianGrid stroke="#26325a" />
              <XAxis dataKey="label" stroke="#8f9bc4" tick={{ fontSize: 10 }} interval={23} />
              <YAxis stroke="#8f9bc4" tick={{ fontSize: 10 }} width={30} />
              <Tooltip {...tip} formatter={(v: unknown, n: unknown) => [`${v} kt`, String(n)]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="gust" name="Gust" stroke="#f59e0b" dot={false} strokeDasharray="3 3" connectNulls />
              <Line type="monotone" dataKey="wind" name="Wind" stroke="#f8fafc" dot={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
          <ResponsiveContainer width="100%" height={160}>
            <ComposedChart data={chart} syncId="ol">
              <CartesianGrid stroke="#26325a" />
              <XAxis dataKey="label" stroke="#8f9bc4" tick={{ fontSize: 10 }} interval={23} />
              <YAxis stroke="#8f9bc4" tick={{ fontSize: 10 }} width={30} />
              <YAxis yAxisId="r" orientation="right" stroke="#8f9bc4" tick={{ fontSize: 10 }} domain={[0, 100]} width={30} />
              <Tooltip {...tip} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area yAxisId="r" type="monotone" dataKey="pop" name="PoP %" stroke="none" fill="#3b82f6" fillOpacity={0.25} connectNulls />
              <Line type="monotone" dataKey="temp" name="Temp °C" stroke="#fb7185" dot={false} connectNulls />
              <Line type="monotone" dataKey="dewp" name="Dew pt °C" stroke="#34d399" dot={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <SkillCard o={o} />
      <div className="muted tiny">
        This outlook is a statistical blend of public products and is not an official forecast. The TAF (issued by the NWS forecast office) and the observed METAR remain the authoritative products for flight planning; use this page to judge how much to trust them and where the risk lies.
      </div>
    </div>
  );
}
