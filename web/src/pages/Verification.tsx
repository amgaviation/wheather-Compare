import React from 'react';
import {
  ResponsiveContainer, LineChart, Line, ComposedChart, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { api, CAT_COLOR, CATS } from '../lib/api';
import type { Station, VerificationReport, Contingency, FlightCategory, ElementErrors, Hist } from '../lib/api';
import { zulu, local, pct, num, signed, fmtCeiling, fmtVis } from '../lib/format';
import { Card, CatBadge, Stat, Loading, ErrorBox, Pill, useAsync } from '../components/ui';

const AXIS = '#8f9bc4';
const GRID = '#26325a';
const ACCENT = '#60a5fa';
const TT_STYLE = { background: '#1b2544', border: '1px solid #26325a', borderRadius: 6, fontSize: 12, color: '#e6ebff' };
const TT_LABEL = { color: '#e6ebff' };
const DAYS = [30, 60, 90, 180, 365];
const MODEL_LABEL: Record<string, string> = { gfs_seamless: 'NOAA GFS/HRRR', ecmwf_ifs025: 'ECMWF IFS', icon_seamless: 'DWD ICON' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function localHour(utcHour: number, tz: string | null): string {
  try {
    const d = new Date();
    d.setUTCHours(utcHour, 0, 0, 0);
    return new Intl.DateTimeFormat('en-US', { timeZone: tz ?? 'UTC', hour: '2-digit', hour12: false }).format(d);
  } catch {
    return '';
  }
}

function hitColor(x: number | null): string {
  if (x == null) return 'var(--border)';
  // 0.5 → red, 1.0 → green
  const t = Math.max(0, Math.min(1, (x - 0.5) / 0.5));
  return `hsl(${Math.round(t * 120)}, 60%, 38%)`;
}

function scoreColor(x: number | null, invert = false): string | undefined {
  if (x == null) return undefined;
  const v = invert ? 1 - x : x;
  if (v >= 0.7) return '#86efac';
  if (v >= 0.4) return '#fde68a';
  return '#fca5a5';
}

function histLabel(h: Hist, unit: string): string {
  const f = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v * 100) / 100));
  return `${f(h.from)}…${f(h.to)}${unit}`;
}

function ContingencyCard({ c, title }: { c: Contingency; title: string }) {
  const w = c.withTempo;
  const rows: Array<[string, number | null, number | null, string]> = [
    ['POD', c.pod, w.pod, 'fraction of observed events that were forecast'],
    ['FAR', c.far, w.far, 'fraction of forecasts that did not verify'],
    ['CSI', c.csi, w.csi, 'hits / (hits + misses + false alarms)'],
    ['Bias', c.bias, w.bias, '>1 = over-forecast, <1 = under-forecast'],
  ];
  return (
    <Card title={title} sub={`n = ${c.n.toLocaleString()} · base rate ${pct(c.baseRate, 1)}`}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 18 }}>
        <table className="confusion">
          <thead>
            <tr><th></th><th>Obs yes</th><th>Obs no</th></tr>
          </thead>
          <tbody>
            <tr><th>Fcst yes</th><td style={{ background: 'rgba(34,197,94,0.25)' }}>{c.hits}<div className="tiny muted">hits</div></td><td style={{ background: 'rgba(239,68,68,0.25)' }}>{c.falseAlarms}<div className="tiny muted">false alarms</div></td></tr>
            <tr><th>Fcst no</th><td style={{ background: 'rgba(239,68,68,0.25)' }}>{c.misses}<div className="tiny muted">misses</div></td><td>{c.correctNegatives}<div className="tiny muted">correct neg.</div></td></tr>
          </tbody>
        </table>
        <table className="tbl" style={{ width: 'auto', minWidth: 260 }}>
          <thead>
            <tr><th>Score</th><th className="num">Operative</th><th className="num">w/ TEMPO credit</th></tr>
          </thead>
          <tbody>
            {rows.map(([k, a, b, desc]) => (
              <tr key={k} title={desc}>
                <td>{k}</td>
                <td className="num" style={{ color: k === 'FAR' ? scoreColor(a, true) : k === 'Bias' ? undefined : scoreColor(a) }}>{k === 'Bias' ? num(a, 2) : pct(a)}</td>
                <td className="num">{k === 'Bias' ? num(b, 2) : pct(b)}</td>
              </tr>
            ))}
            <tr title="Heidke skill score: accuracy relative to random chance (1 = perfect, 0 = chance)"><td>HSS</td><td className="num">{num(c.hss, 2)}</td><td className="num muted">—</td></tr>
            <tr title="Peirce skill score: POD − POFD (1 = perfect, 0 = no skill)"><td>PSS</td><td className="num">{num(c.pss, 2)}</td><td className="num muted">—</td></tr>
          </tbody>
        </table>
      </div>
      <div className="muted tiny" style={{ marginTop: 8 }}>
        POD = fraction of observed events forecast · FAR = fraction of forecasts that did not verify · CSI = hits/(hits+misses+false alarms) · bias &gt;1 = over-forecast · HSS/PSS = skill vs chance. "TEMPO credit" counts the hour as forecast if any TEMPO/PROB group covered the event.
      </div>
    </Card>
  );
}

function ConfusionMatrix({ m, rowLabel = 'Forecast', colLabel = 'Observed' }: { m: number[][]; rowLabel?: string; colLabel?: string }) {
  return (
    <table className="confusion">
      <thead>
        <tr>
          <th className="muted tiny">{rowLabel} ↓ / {colLabel} →</th>
          {CATS.map((c) => <th key={c}><CatBadge cat={c} /></th>)}
          <th className="muted">Σ</th>
        </tr>
      </thead>
      <tbody>
        {CATS.map((fc, i) => {
          const row = m[i] ?? [];
          const total = row.reduce((a, b) => a + b, 0);
          return (
            <tr key={fc}>
              <th><CatBadge cat={fc} /></th>
              {CATS.map((oc, j) => {
                const v = row[j] ?? 0;
                const share = total ? v / total : 0;
                return (
                  <td key={oc} style={{ background: `rgba(96,165,250,${(share * 0.85).toFixed(2)})`, color: share > 0.5 ? '#fff' : undefined, outline: i === j ? '1px solid rgba(255,255,255,0.25)' : undefined }} title={`${rowLabel} ${fc}, ${colLabel} ${oc}: ${v} (${pct(share)} of row)`}>
                    {v}<div className="tiny" style={{ opacity: 0.8 }}>{total ? pct(share) : ''}</div>
                  </td>
                );
              })}
              <td className="muted">{total}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function StackedBar({ probs, height = 14 }: { probs: Record<FlightCategory, number>; height?: number }) {
  return (
    <div style={{ display: 'flex', height, borderRadius: 3, overflow: 'hidden', background: 'var(--border)' }}>
      {CATS.map((c) => (
        <div key={c} style={{ width: `${(probs[c] ?? 0) * 100}%`, background: CAT_COLOR[c] }} title={`${c} ${pct(probs[c], 1)}`} />
      ))}
    </div>
  );
}

function ErrHist({ title, data, unit, note }: { title: string; data: Hist[]; unit: string; note: string }) {
  const rows = data.map((h) => ({ ...h, label: histLabel(h, unit), mid: (h.from + h.to) / 2 }));
  return (
    <Card title={title} sub={note}>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={rows} margin={{ top: 4, right: 8, left: -18, bottom: 4 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" stroke={AXIS} tick={{ fontSize: 9 }} interval={0} angle={-40} textAnchor="end" height={54} />
          <YAxis stroke={AXIS} tick={{ fontSize: 10 }} />
          <Tooltip contentStyle={TT_STYLE} labelStyle={TT_LABEL} cursor={{ fill: 'rgba(255,255,255,0.05)' }} formatter={(v: number) => [v, 'hours']} />
          <Bar dataKey="n" isAnimationActive={false}>
            {rows.map((r, i) => <Cell key={i} fill={r.mid > 0 ? '#3b82f6' : r.mid < 0 ? '#ef4444' : '#8f9bc4'} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}

function ErrCols({ e }: { e: ElementErrors }) {
  return (
    <>
      <td className="num">{num(e.ceiling.mae, 0)}</td>
      <td className="num">{num(e.visibility.mae, 2)}</td>
      <td className="num">{num(e.windSpeed.mae, 1)}</td>
      <td className="num">{pct(e.windDir.within30)}</td>
    </>
  );
}

export default function Verification({ station }: { station: Station }) {
  const [days, setDays] = React.useState(90);
  const { data, error, loading } = useAsync(() => api.verification(station.icao, days), [station.icao, days]);
  const tz = station.tz;

  const daysTabs = (
    <div className="tabs" style={{ marginBottom: 0 }}>
      {DAYS.map((d) => <button key={d} className={d === days ? 'active' : ''} onClick={() => setDays(d)}>{d} d</button>)}
    </div>
  );

  if (error && !data) return <div><div className="row spread" style={{ marginBottom: 10 }}><h2 style={{ margin: 0 }}>Verification · {station.icao}</h2>{daysTabs}</div><ErrorBox error={error} /></div>;
  if (!data) return <div><div className="row spread" style={{ marginBottom: 10 }}><h2 style={{ margin: 0 }}>Verification · {station.icao}</h2>{daysTabs}</div><Loading text="Computing verification report…" /></div>;

  const r: VerificationReport = data;
  const op = r.operative;
  const cat = op.errors.category;

  const leadRows = r.byLead.map((b) => ({ lead: b.lead, hitRate: b.errors.category.hitRate, ifrPod: b.ifr.pod, ifrFar: b.ifr.far, mvfrPod: b.mvfr.pod, n: b.n }));
  const diurnalRows = r.diurnal.map((d) => ({ ...d, label: `${String(d.hourUtc).padStart(2, '0')}Z`, obsIfrPct: d.obsIfrRate == null ? null : d.obsIfrRate * 100, fcstIfrPct: d.fcstIfrRate == null ? null : d.fcstIfrRate * 100 }));
  const amendRows = (r.amendments.amendmentsByHourUtc ?? []).map((n, h) => ({ hour: `${String(h).padStart(2, '0')}Z`, n }));
  const calibLeads = Object.keys(r.calibration);
  const climoTotal = Object.values(r.climatology.overall).reduce((a, b) => a + b, 0);
  const climoMonths = Object.keys(r.climatology.byMonthHour).sort();
  const modelsGrouped = Object.entries(
    r.models.reduce<Record<string, VerificationReport['models']>>((acc, m) => { (acc[m.model] ??= []).push(m); return acc; }, {}),
  ).map(([model, rows]) => [model, rows.slice().sort((a, b) => a.leadDays - b.leadDays)] as const);

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="row spread">
        <div>
          <h2 style={{ margin: 0 }}>Verification · {station.icao} <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>{station.name ?? ''}</span></h2>
          <div className="muted small">
            TAF vs METAR, {r.days} days{r.span ? ` · ${zulu(r.span.from, true)} – ${zulu(r.span.to, true)}` : ''} · {r.pairs.toLocaleString()} forecast-hour pairs, {r.operativePairs.toLocaleString()} operative (latest TAF valid at the time)
            {loading && <span className="muted"> · refreshing…</span>}
          </div>
        </div>
        {daysTabs}
      </div>
      {error && <ErrorBox error={error} />}

      {/* a. Headline */}
      <Card title="Headline" sub="operative TAF (the one a pilot would have read), all lead times">
        <div className="stats">
          <Stat label="Operative pairs" value={r.operativePairs.toLocaleString()} hint={`${r.pairs.toLocaleString()} incl. superseded TAFs`} />
          <Stat label="Category hit rate" value={pct(cat.hitRate)} hint="forecast cat = observed cat" />
          <Stat label="TEMPO/PROB covered" value={pct(cat.tempoCoveredRate)} hint="hit incl. TEMPO / PROB groups" />
          <Stat label="Too optimistic" value={pct(cat.tooOptimistic)} hint="forecast better than observed" />
          <Stat label="Too pessimistic" value={pct(cat.tooPessimistic)} hint="forecast worse than observed" />
          <Stat label="IFR+ POD" value={pct(op.ifr.pod)} hint={`${op.ifr.hits} hits / ${op.ifr.misses} misses`} />
          <Stat label="IFR+ FAR" value={pct(op.ifr.far)} hint={`${op.ifr.falseAlarms} false alarms`} />
          <Stat label="IFR+ CSI" value={pct(op.ifr.csi)} hint={`bias ${num(op.ifr.bias, 2)}`} />
          <Stat label="Amendments / day" value={num(r.amendments.amendmentsPerDay, 1)} hint={`${pct(r.amendments.amendmentRate)} of TAFs amended`} />
          <Stat label="Ceiling MAE" value={`${num(op.errors.ceiling.mae, 0)} ft`} hint={`bias ${signed(op.errors.ceiling.bias, 0, ' ft')} · n ${op.errors.ceiling.n}`} />
          <Stat label="Wind speed bias" value={signed(op.errors.windSpeed.bias, 1, ' kt')} hint={`MAE ${num(op.errors.windSpeed.mae, 1)} kt · RMSE ${num(op.errors.windSpeed.rmse, 1)}`} />
          <Stat label="Wind dir within 30°" value={pct(op.errors.windDir.within30)} hint={`MAE ${num(op.errors.windDir.mae, 0)}° · n ${op.errors.windDir.n}`} />
        </div>
        <div className="row" style={{ marginTop: 10, gap: 14 }}>
          <span className="muted small">Visibility MAE {num(op.errors.visibility.mae, 2)} SM (bias {signed(op.errors.visibility.bias, 2)})</span>
          <span className="muted small">Ceiling within one category {pct(op.errors.ceiling.withinOneCat)}</span>
          <span className="muted small">Gusts missed {pct(op.errors.windSpeed.gustMissed)} · gusts false {pct(op.errors.windSpeed.gustFalse)}</span>
          <span className="muted small">Mean category error {signed(cat.meanErr, 2)} (+ = observed worse than forecast)</span>
        </div>
      </Card>

      {/* b. Skill by lead time */}
      <Card title="Skill by lead time" sub="hours between TAF issuance and the verified hour; all TAFs, not just operative">
        <div className="grid cols-2">
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Lead (h)</th><th className="num">n</th><th className="num">Hit rate</th>
                  <th className="num">IFR POD</th><th className="num">IFR FAR</th><th className="num">IFR CSI</th><th className="num">IFR bias</th>
                  <th className="num">MVFR POD</th><th className="num">MVFR FAR</th>
                  <th className="num">Ceil MAE ft</th><th className="num">Vis MAE SM</th><th className="num">Wspd MAE kt</th><th className="num">Wdir ≤30°</th>
                </tr>
              </thead>
              <tbody>
                {r.byLead.map((b) => (
                  <tr key={b.lead}>
                    <td className="mono">{b.lead}</td>
                    <td className="num">{b.n.toLocaleString()}</td>
                    <td className="num" style={{ color: scoreColor(b.errors.category.hitRate) }}>{pct(b.errors.category.hitRate)}</td>
                    <td className="num" style={{ color: scoreColor(b.ifr.pod) }}>{pct(b.ifr.pod)}</td>
                    <td className="num" style={{ color: scoreColor(b.ifr.far, true) }}>{pct(b.ifr.far)}</td>
                    <td className="num">{pct(b.ifr.csi)}</td>
                    <td className="num">{num(b.ifr.bias, 2)}</td>
                    <td className="num">{pct(b.mvfr.pod)}</td>
                    <td className="num">{pct(b.mvfr.far)}</td>
                    <ErrCols e={b.errors} />
                  </tr>
                ))}
                <tr style={{ fontWeight: 600 }}>
                  <td>Operative</td>
                  <td className="num">{op.errors.n.toLocaleString()}</td>
                  <td className="num">{pct(cat.hitRate)}</td>
                  <td className="num">{pct(op.ifr.pod)}</td><td className="num">{pct(op.ifr.far)}</td><td className="num">{pct(op.ifr.csi)}</td><td className="num">{num(op.ifr.bias, 2)}</td>
                  <td className="num">{pct(op.mvfr.pod)}</td><td className="num">{pct(op.mvfr.far)}</td>
                  <ErrCols e={op.errors} />
                </tr>
              </tbody>
            </table>
          </div>
          <div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={leadRows} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
                <CartesianGrid stroke={GRID} />
                <XAxis dataKey="lead" stroke={AXIS} tick={{ fontSize: 11 }} label={{ value: 'lead hours', position: 'insideBottomRight', fill: AXIS, fontSize: 10, dy: 8 }} />
                <YAxis stroke={AXIS} tick={{ fontSize: 11 }} domain={[0, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} />
                <Tooltip contentStyle={TT_STYLE} labelStyle={TT_LABEL} formatter={(v: number) => pct(v)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="hitRate" name="Category hit rate" stroke={ACCENT} strokeWidth={2} dot isAnimationActive={false} connectNulls />
                <Line type="monotone" dataKey="ifrPod" name="IFR+ POD" stroke={CAT_COLOR.IFR} strokeWidth={2} dot isAnimationActive={false} connectNulls />
                <Line type="monotone" dataKey="ifrFar" name="IFR+ FAR" stroke={CAT_COLOR.IFR} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />
                <Line type="monotone" dataKey="mvfrPod" name="MVFR+ POD" stroke={CAT_COLOR.MVFR} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </Card>

      {/* c. Contingency tables */}
      <div className="grid cols-3">
        <ContingencyCard c={op.ifr} title="IFR or worse" />
        <ContingencyCard c={op.mvfr} title="MVFR or worse" />
        <ContingencyCard c={op.lifr} title="LIFR" />
      </div>

      {/* d. Confusion matrix + e. Calibration */}
      <div className="grid cols-2">
        <Card title="Confusion matrix" sub="operative TAF · rows = forecast, columns = observed · shading = share of row">
          <ConfusionMatrix m={op.confusion} />
          <div className="muted tiny" style={{ marginTop: 8 }}>Cells above the diagonal are too-optimistic forecasts (observed worse); below the diagonal are too-pessimistic.</div>
        </Card>
        <Card title="Calibration / reliability" sub="when the TAF says X at lead L, what was actually observed">
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr><th>TAF says</th>{calibLeads.map((l) => <th key={l}>{l} h</th>)}</tr>
              </thead>
              <tbody>
                {CATS.map((fc) => (
                  <tr key={fc} style={fc === 'IFR' ? { background: 'rgba(239,68,68,0.10)', outline: '1px solid rgba(239,68,68,0.5)' } : undefined}>
                    <td><CatBadge cat={fc} /></td>
                    {calibLeads.map((l) => {
                      const cell = r.calibration[l]?.[fc];
                      if (!cell || !cell.n) return <td key={l} className="muted tiny">—</td>;
                      return (
                        <td key={l} style={{ minWidth: 110 }}>
                          <StackedBar probs={cell.probs} />
                          <div className="tiny mono" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
                            <span style={{ color: CAT_COLOR[fc] }}>{pct(cell.probs[fc])} verified</span>
                            <span className="muted">n {cell.n}</span>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="legend" style={{ marginTop: 8 }}>
            {CATS.map((c) => <span key={c} style={{ '--c': CAT_COLOR[c] } as React.CSSProperties}>observed {c}</span>)}
          </div>
          <div className="muted tiny" style={{ marginTop: 6 }}>Bar segments show the distribution of observed categories given the forecast. A well-calibrated TAF has the matching colour dominating each row; the IFR row is highlighted because that is the call that matters most operationally.</div>
        </Card>
      </div>

      {/* f. Diurnal */}
      <Card title="Diurnal behaviour" sub="by UTC hour of the verified observation · operative TAF">
        <div className="small muted" style={{ marginBottom: 4 }}>Category hit rate by hour</div>
        <div className="heat">
          {HOURS.map((h) => {
            const d = r.diurnal.find((x) => x.hourUtc === h);
            return (
              <div key={h} className="c" style={{ background: hitColor(d?.hitRate ?? null) }} title={d ? `${String(h).padStart(2, '0')}Z: hit ${pct(d.hitRate)} · n ${d.n} · obs IFR ${pct(d.obsIfrRate)} · fcst IFR ${pct(d.fcstIfrRate)}` : ''}>
                {d?.hitRate != null ? Math.round(d.hitRate * 100) : ''}
              </div>
            );
          })}
        </div>
        <div className="heat" style={{ marginTop: 2 }}>
          {HOURS.map((h) => (
            <div key={h} className="tiny mono" style={{ textAlign: 'center', lineHeight: 1.15 }}>
              <div>{String(h).padStart(2, '0')}Z</div>
              <div className="muted">{localHour(h, tz)}L</div>
            </div>
          ))}
        </div>
        <div className="muted tiny" style={{ marginTop: 6, marginBottom: 10 }}>Local hour uses {tz ?? 'UTC'} at today's offset.</div>
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={diurnalRows} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
            <CartesianGrid stroke={GRID} />
            <XAxis dataKey="label" stroke={AXIS} tick={{ fontSize: 10 }} interval={1} />
            <YAxis yAxisId="rate" stroke={AXIS} tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${v}%`} />
            <YAxis yAxisId="bias" orientation="right" stroke={AXIS} tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${v} ft`} width={60} />
            <Tooltip contentStyle={TT_STYLE} labelStyle={TT_LABEL} formatter={(v: number, name: string) => (name.includes('bias') ? [`${signed(v, 0)} ft`, name] : [`${num(v, 1)}%`, name])} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar yAxisId="rate" dataKey="obsIfrPct" name="Observed IFR+ rate" fill={CAT_COLOR.IFR} isAnimationActive={false} />
            <Bar yAxisId="rate" dataKey="fcstIfrPct" name="Forecast IFR+ rate" fill="#f59e0b" isAnimationActive={false} />
            <Line yAxisId="bias" type="monotone" dataKey="ceilingBias" name="Ceiling bias (fcst − obs)" stroke={ACCENT} dot={false} strokeWidth={2} isAnimationActive={false} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="muted tiny">Observed IFR+ rate above forecast IFR+ rate in a given hour means the TAF systematically under-forecasts low conditions at that time (typical for radiation fog / night stratus). Ceiling bias is forecast minus observed among hours with a ceiling in both.</div>
      </Card>

      {/* g. Error distributions */}
      <div className="grid cols-4">
        <ErrHist title="Ceiling error" unit="" data={op.histograms.ceiling} note="ft, forecast − observed" />
        <ErrHist title="Visibility error" unit="" data={op.histograms.visibility} note="SM, forecast − observed" />
        <ErrHist title="Wind speed error" unit="" data={op.histograms.windSpeed} note="kt, forecast − observed" />
        <ErrHist title="Wind direction error" unit="°" data={op.histograms.windDir} note="deg, forecast − observed" />
      </div>
      <div className="muted tiny" style={{ marginTop: -8 }}>Errors are forecast minus observed: positive (blue) = forecast higher / more than observed (e.g. ceiling forecast higher than it turned out); negative (red) = forecast lower / less.</div>

      {/* h. Present weather + i. Amendments */}
      <div className="grid cols-2">
        <Card title="Present weather" sub="operative TAF · phenomenon forecast in the prevailing or TEMPO group vs observed in METAR">
          <table className="tbl">
            <thead>
              <tr><th>Phenomenon</th><th className="num">Obs hours</th><th className="num">Hits</th><th className="num">Misses</th><th className="num">False alarms</th><th className="num">POD</th><th className="num">FAR</th><th className="num">CSI</th></tr>
            </thead>
            <tbody>
              {op.wx.map((w) => (
                <tr key={w.phenomenon} className={w.obsHours === 0 && w.falseAlarms === 0 ? 'muted' : ''}>
                  <td>{w.phenomenon}</td>
                  <td className="num">{w.obsHours}</td><td className="num">{w.hits}</td><td className="num">{w.misses}</td><td className="num">{w.falseAlarms}</td>
                  <td className="num" style={{ color: scoreColor(w.pod) }}>{pct(w.pod)}</td>
                  <td className="num" style={{ color: scoreColor(w.far, true) }}>{pct(w.far)}</td>
                  <td className="num">{pct(w.csi)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Amendments" sub={`${r.amendments.days} days`}>
          <div className="stats" style={{ marginBottom: 10 }}>
            <Stat label="TAFs issued" value={r.amendments.total.toLocaleString()} hint={`${num(r.amendments.perDay, 1)} / day`} />
            <Stat label="Amended (AMD)" value={r.amendments.amended.toLocaleString()} hint={`${pct(r.amendments.amendmentRate)} of issuances`} />
            <Stat label="Amendments / day" value={num(r.amendments.amendmentsPerDay, 1)} />
            <Stat label="Median gap" value={`${num(r.amendments.medianGapHours, 1)} h`} hint="between successive issuances" />
          </div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={amendRows} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="hour" stroke={AXIS} tick={{ fontSize: 10 }} interval={1} />
              <YAxis stroke={AXIS} tick={{ fontSize: 10 }} />
              <Tooltip contentStyle={TT_STYLE} labelStyle={TT_LABEL} cursor={{ fill: 'rgba(255,255,255,0.05)' }} formatter={(v: number) => [v, 'amendments']} />
              <Bar dataKey="n" fill="#f59e0b" isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
          <div className="muted tiny">Amendments by UTC hour of issuance. Peaks at the scheduled issuance hours (≈02/08/14/20Z) are routine re-issues flagged AMD; off-cycle peaks show when forecasters are chasing conditions.</div>
        </Card>
      </div>

      {/* j. Busts */}
      <Card title="Biggest busts" sub="largest category misses of the operative TAF; expand a row for the raw METAR and TAF">
        {r.busts.length === 0 ? <div className="muted">No busts in this window.</div> : (
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr><th>Time</th><th className="num">Lead</th><th>Forecast → observed</th><th>Ceiling fcst / obs</th><th>Vis fcst / obs</th><th>Kind</th></tr>
              </thead>
              <tbody>
                {r.busts.map((b, i) => (
                  <React.Fragment key={i}>
                    <tr>
                      <td>
                        <div className="mono">{zulu(b.hourTime, true)}</div>
                        <div className="muted tiny">{local(b.hourTime, tz, { month: 'short', day: 'numeric' })} local</div>
                      </td>
                      <td className="num">{num(b.leadHours, 1)} h</td>
                      <td>
                        <CatBadge cat={b.fcstCat} /> <span className="muted">→</span> <CatBadge cat={b.obsCat} />
                        {b.worstCat && b.worstCat !== b.fcstCat && <span className="muted tiny"> (TEMPO/PROB worst: {b.worstCat})</span>}
                      </td>
                      <td className="mono">{fmtCeiling(b.fcstCeiling)} / {fmtCeiling(b.obsCeiling)}</td>
                      <td className="mono">{fmtVis(b.fcstVis)} / {fmtVis(b.obsVis)}</td>
                      <td><Pill kind={b.kind === 'unforecast deterioration' ? 'bad' : b.kind === 'over-forecast' ? 'warn' : ''}>{b.kind}</Pill></td>
                    </tr>
                    <tr>
                      <td colSpan={6} style={{ paddingTop: 0 }}>
                        <details>
                          <summary>Raw METAR / TAF (issued {zulu(b.tafIssued, true)})</summary>
                          <div className="raw" style={{ marginTop: 6 }}><b>METAR</b> {b.metarRaw}</div>
                          <div className="raw" style={{ marginTop: 6 }}><b>TAF</b> {b.tafRaw}</div>
                        </details>
                      </td>
                    </tr>
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* k. NWS gridpoint */}
      <Card title="NWS gridpoint forecast verification" sub="api.weather.gov hourly forecast vs METAR, by lead day">
        {r.nws.length === 0 ? (
          <div className="muted">NWS forecast history accrues from the time the station was added; check back after a few days.</div>
        ) : (
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Lead day</th><th className="num">n</th>
                  <th className="num">Temp MAE</th><th className="num">Temp bias</th>
                  <th className="num">Dewp MAE</th><th className="num">Dewp bias</th>
                  <th className="num">Wspd MAE</th><th className="num">Wspd bias</th>
                  <th className="num">Wdir MAE</th><th className="num">Wdir ≤30°</th>
                  <th className="num">Sky MAE</th><th className="num">Sky bias</th>
                  <th className="num">Cat hit</th><th className="num">IFR POD</th><th className="num">IFR FAR</th>
                </tr>
              </thead>
              <tbody>
                {r.nws.map((n) => (
                  <tr key={n.leadDay}>
                    <td>D+{n.leadDay}</td><td className="num">{n.n}</td>
                    <td className="num">{num(n.temp.mae, 1, '°')}</td><td className="num">{signed(n.temp.bias, 1, '°')}</td>
                    <td className="num">{num(n.dewp.mae, 1, '°')}</td><td className="num">{signed(n.dewp.bias, 1, '°')}</td>
                    <td className="num">{num(n.windSpd.mae, 1, ' kt')}</td><td className="num">{signed(n.windSpd.bias, 1, ' kt')}</td>
                    <td className="num">{num(n.windDir.mae, 0, '°')}</td><td className="num">{pct(n.windDir.within30)}</td>
                    <td className="num">{num(n.sky.mae, 0, '%')}</td><td className="num">{signed(n.sky.bias, 0, '%')}</td>
                    <td className="num" style={{ color: scoreColor(n.category.hitRate) }}>{pct(n.category.hitRate)}</td>
                    <td className="num">{pct(n.category.ifr?.pod)}</td><td className="num">{pct(n.category.ifr?.far)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="muted tiny" style={{ marginTop: 6 }}>Only {r.nws.reduce((a, b) => a + b.n, 0)} forecast-hour pairs so far; scores are noisy until a few weeks of history accrue.</div>
          </div>
        )}
      </Card>

      {/* l. Models */}
      <Card title="Model guidance verification" sub="Open-Meteo previous-run archive vs METAR, by lead day">
        {r.models.length === 0 ? <div className="muted">No model verification yet. Model runs are archived as they are fetched; check back after a few days.</div> : (
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Model</th><th>Lead</th><th className="num">n</th>
                  <th className="num">Temp MAE</th><th className="num">Temp bias</th>
                  <th className="num">Dewp MAE</th><th className="num">Dewp bias</th>
                  <th className="num">Wind MAE</th><th className="num">Wind bias</th><th className="num">Wdir ≤30°</th>
                  <th className="num">Low cld MAE</th><th className="num">Low cld bias</th>
                  <th className="num">Cat-proxy hit</th><th className="num">IFR POD</th><th className="num">IFR FAR</th>
                </tr>
              </thead>
              <tbody>
                {modelsGrouped.map(([model, rows]) => rows.map((m, i) => (
                  <tr key={`${model}-${m.leadDays}`} style={i === 0 ? { borderTop: '2px solid var(--border)' } : undefined}>
                    <td>{i === 0 ? <b>{MODEL_LABEL[model] ?? model}</b> : <span className="muted tiny">{model}</span>}</td>
                    <td>D+{m.leadDays}</td><td className="num">{m.n}</td>
                    <td className="num">{num(m.temp.mae, 1, '°')}</td><td className="num">{signed(m.temp.bias, 1, '°')}</td>
                    <td className="num">{num(m.dewp.mae, 1, '°')}</td><td className="num">{signed(m.dewp.bias, 1, '°')}</td>
                    <td className="num">{num(m.windSpd.mae, 1, ' kt')}</td><td className="num">{signed(m.windSpd.bias, 1, ' kt')}</td><td className="num">{pct(m.windDir.within30)}</td>
                    <td className="num">{num(m.lowCloud.mae, 0, '%')}</td><td className="num">{signed(m.lowCloud.bias, 0, '%')}</td>
                    <td className="num" style={{ color: scoreColor(m.category.hitRate) }}>{pct(m.category.hitRate)}</td>
                    <td className="num">{pct(m.category.ifrPod)}</td><td className="num">{pct(m.category.ifrFar)}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        )}
        <div className="muted tiny" style={{ marginTop: 6 }}>Model flight category is a proxy derived from low cloud cover, dew-point depression, visibility and weather code — not an official product.</div>
      </Card>

      {/* m. Climatology */}
      <Card title="Observed climatology" sub={`${r.climatology.span.n.toLocaleString()} METARs · ${zulu(r.climatology.span.a, true)} – ${zulu(r.climatology.span.b, true)}`}>
        <div className="small muted" style={{ marginBottom: 4 }}>Observed flight category share</div>
        <div style={{ display: 'flex', height: 22, borderRadius: 4, overflow: 'hidden', background: 'var(--border)' }}>
          {CATS.map((c) => {
            const n = r.climatology.overall[c] ?? 0;
            const share = climoTotal ? n / climoTotal : 0;
            return <div key={c} style={{ width: `${share * 100}%`, background: CAT_COLOR[c], display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontFamily: 'var(--mono)', color: c === 'VFR' ? '#052e16' : '#fff', overflow: 'hidden', whiteSpace: 'nowrap' }} title={`${c}: ${n} obs (${pct(share, 1)})`}>{share > 0.06 ? `${c} ${pct(share)}` : ''}</div>;
          })}
        </div>
        <div className="legend" style={{ marginTop: 6, marginBottom: 14 }}>
          {CATS.map((c) => <span key={c} style={{ '--c': CAT_COLOR[c] } as React.CSSProperties}>{c} {r.climatology.overall[c] ?? 0} obs ({pct(climoTotal ? (r.climatology.overall[c] ?? 0) / climoTotal : null, 1)})</span>)}
        </div>
        <div className="small muted" style={{ marginBottom: 4 }}>IFR-or-worse frequency by month × UTC hour (months present in the data)</div>
        <div className="scroll-x">
          <table className="confusion" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th></th>
                {HOURS.map((h) => <th key={h} className="tiny" style={{ padding: '3px 2px' }}>{String(h).padStart(2, '0')}<div className="muted" style={{ fontWeight: 400 }}>{localHour(h, tz)}L</div></th>)}
                <th className="tiny">All</th>
              </tr>
            </thead>
            <tbody>
              {climoMonths.map((m) => {
                const byHour = r.climatology.byMonthHour[m];
                let tIfr = 0; let tAll = 0;
                const cells = HOURS.map((h) => {
                  const v = byHour[String(h).padStart(2, '0')] ?? byHour[String(h)];
                  if (!v) return null;
                  const n = CATS.reduce((a, c) => a + (v[c] ?? 0), 0);
                  const ifr = (v.IFR ?? 0) + (v.LIFR ?? 0);
                  tIfr += ifr; tAll += n;
                  return { n, f: n ? ifr / n : null };
                });
                const mi = parseInt(m, 10);
                return (
                  <tr key={m}>
                    <th className="tiny" style={{ textAlign: 'left' }}>{Number.isFinite(mi) && mi >= 1 && mi <= 12 ? MONTHS[mi - 1] : m}</th>
                    {cells.map((c, h) => (
                      <td key={h} style={{ padding: '3px 2px', fontSize: 10, background: c?.f != null ? `rgba(239,68,68,${Math.min(1, c.f * 1.6).toFixed(2)})` : undefined, color: c?.f != null && c.f > 0.35 ? '#fff' : undefined }} title={c ? `${String(h).padStart(2, '0')}Z: IFR+ ${pct(c.f)} of ${c.n} obs` : 'no data'}>
                      {c?.f != null ? Math.round(c.f * 100) : ''}
                    </td>
                    ))}
                    <td className="tiny mono" style={{ fontWeight: 600 }}>{tAll ? pct(tIfr / tAll) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="muted tiny" style={{ marginTop: 6 }}>Cell value = percent of observations in that month/hour that were IFR or LIFR. This is the base rate the TAF is being scored against; a low base rate makes POD/FAR noisy.</div>
      </Card>
    </div>
  );
}
