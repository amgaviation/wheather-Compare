import React from 'react';
import { api } from '../lib/api';
import type { Station, Taf, TafHour, Conditions } from '../lib/api';
import { zulu, local, ago, fmtWind, fmtVis, fmtCeiling, cToF } from '../lib/format';
import { Card, CatBadge, Stat, Loading, ErrorBox, Pill, useAsync } from '../components/ui';

const SOURCES: Array<{ name: string; url: string; provides: string; note?: string }> = [
  { name: 'aviationweather.gov Data API', url: 'https://aviationweather.gov/data/api/', provides: 'METAR/SPECI, TAF, PIREP, SIGMET/AIRMET, G-AIRMET, CWA, winds aloft (FB), station info' },
  { name: 'NWS API (api.weather.gov)', url: 'https://www.weather.gov/documentation/services-web-api', provides: 'Gridpoint hourly forecast, raw grid ceiling / visibility / sky / PoP / thunder, active alerts' },
  { name: 'Iowa Environmental Mesonet archives', url: 'https://mesonet.agron.iastate.edu/request/download.phtml', provides: 'Historical METAR + TAF archive used for backfill' },
  { name: 'Open-Meteo', url: 'https://open-meteo.com/', provides: 'GFS/HRRR, ECMWF IFS, DWD ICON hourly guidance + previous runs', note: 'CC-BY 4.0 · not an aviation product' },
];

const INTERVAL_LABEL: Record<string, string> = { metarMin: 'METAR', tafMin: 'TAF', nwsMin: 'NWS gridpoint', modelMin: 'Models (Open-Meteo)', hazardsMin: 'Hazards / PIREPs' };

function statusPill(s: string): React.ReactNode {
  const k = s === 'done' ? 'good' : s === 'running' ? 'info' : s === 'error' ? 'bad' : '';
  return <Pill kind={k}>{s || 'unknown'}</Pill>;
}

type DecodeResult = Awaited<ReturnType<typeof api.decode>>;

interface DecodedMetar {
  raw?: string; station?: string; type?: string; time?: number; auto?: boolean; corrected?: boolean; nil?: boolean;
  cond?: Conditions; tempC?: number | null; dewpC?: number | null; altimeterInHg?: number | null; qnhHpa?: number | null;
  ceilingFt?: number | null; category?: 'VFR' | 'MVFR' | 'IFR' | 'LIFR' | null; parseWarnings?: string[];
  remarks?: Record<string, unknown>; rvr?: Array<{ runway: string; minFt: number; maxFt: number | null; qualifier: string | null; trend: string | null }>;
}

function condSummary(c: Conditions | null | undefined): string {
  if (!c) return '—';
  const parts: string[] = [];
  if (c.wind) parts.push(fmtWind(c.wind));
  if (c.cavok) parts.push('CAVOK');
  if (c.visibility) parts.push(fmtVis(c.visibility.sm, c.visibility.plus));
  if (c.weather?.length) parts.push(c.weather.map((w) => w.raw).join(' '));
  if (c.clouds?.length) parts.push(c.clouds.map((k) => `${k.cover}${k.baseFt != null ? String(Math.round(k.baseFt / 100)).padStart(3, '0') : ''}${k.type ?? ''}`).join(' '));
  if (c.verticalVisFt != null) parts.push(`VV${String(Math.round(c.verticalVisFt / 100)).padStart(3, '0')}`);
  if (c.windShear) parts.push(`WS${String(Math.round(c.windShear.heightFt / 100)).padStart(3, '0')}/${c.windShear.dirDeg}${c.windShear.speedKt}KT`);
  return parts.join(' · ') || '—';
}

function DecodedView({ r }: { r: DecodeResult }) {
  if (r.kind === 'METAR') {
    const m = (r.metar ?? {}) as DecodedMetar;
    const c = m.cond;
    return (
      <div>
        <div className="row" style={{ marginBottom: 8 }}>
          <CatBadge cat={m.category ?? null} big />
          <div>
            <div><b>{m.station ?? '?'}</b> {m.type ?? 'METAR'} {m.time != null && zulu(m.time, true)} {m.auto && <Pill>AUTO</Pill>} {m.corrected && <Pill kind="warn">COR</Pill>} {m.nil && <Pill kind="bad">NIL</Pill>}</div>
            <div className="muted small">Ceiling {fmtCeiling(m.ceilingFt)} · Vis {c?.visibility ? fmtVis(c.visibility.sm, c.visibility.plus) : '—'}</div>
          </div>
        </div>
        <dl className="kv">
          <dt>Wind</dt><dd>{fmtWind(c?.wind)}{c?.wind?.varFromDeg != null ? ` (${c.wind.varFromDeg}V${c.wind.varToDeg})` : ''}</dd>
          <dt>Visibility</dt><dd>{c?.cavok ? 'CAVOK' : c?.visibility ? fmtVis(c.visibility.sm, c.visibility.plus) : '—'}</dd>
          <dt>Weather</dt><dd>{c?.weather?.length ? c.weather.map((w) => w.raw).join(' ') : 'none'}</dd>
          <dt>Clouds</dt><dd>{c?.clouds?.length ? c.clouds.map((k) => `${k.cover} ${k.baseFt != null ? `${k.baseFt.toLocaleString()} ft` : ''}${k.type ? ` ${k.type}` : ''}`).join(', ') : c?.verticalVisFt != null ? `VV ${c.verticalVisFt} ft` : 'none reported'}</dd>
          <dt>Ceiling</dt><dd>{fmtCeiling(m.ceilingFt)}</dd>
          <dt>Temp / dewpoint</dt><dd>{m.tempC != null ? `${m.tempC}°C (${cToF(m.tempC)})` : '—'} / {m.dewpC != null ? `${m.dewpC}°C (${cToF(m.dewpC)})` : '—'}</dd>
          <dt>Altimeter</dt><dd>{m.altimeterInHg != null ? `${m.altimeterInHg.toFixed(2)} inHg` : '—'}{m.qnhHpa != null ? ` · ${m.qnhHpa} hPa` : ''}</dd>
          {m.rvr && m.rvr.length > 0 && <><dt>RVR</dt><dd>{m.rvr.map((v) => `RWY ${v.runway} ${v.minFt}${v.maxFt != null ? `–${v.maxFt}` : ''} ft${v.trend ? ` ${v.trend}` : ''}`).join(', ')}</dd></>}
          {m.remarks && Object.keys(m.remarks).length > 0 && (
            <>
              <dt>Remarks</dt>
              <dd className="small">{Object.entries(m.remarks).filter(([, v]) => v != null && v !== false && !(Array.isArray(v) && v.length === 0)).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ') || '—'}</dd>
            </>
          )}
        </dl>
        {m.parseWarnings && m.parseWarnings.length > 0 && (
          <div style={{ marginTop: 8 }}>{m.parseWarnings.map((w, i) => <span key={i} className="flag">{w}</span>)}</div>
        )}
      </div>
    );
  }
  const t: Taf = r.taf;
  const hours: TafHour[] = r.hours.slice(0, 12);
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <b>{t.station}</b> TAF issued {zulu(t.issued, true)} · valid {zulu(t.validFrom, true)} – {zulu(t.validTo, true)}
        {t.amended && <Pill kind="warn">AMD</Pill>} {t.corrected && <Pill kind="warn">COR</Pill>} {t.cancelled && <Pill kind="bad">CNL</Pill>} {t.nil && <Pill kind="bad">NIL</Pill>}
        {t.maxTemp && <span className="muted small">TX {t.maxTemp.c}°C @ {zulu(t.maxTemp.time)}</span>}
        {t.minTemp && <span className="muted small">TN {t.minTemp.c}°C @ {zulu(t.minTemp.time)}</span>}
      </div>
      <div className="scroll-x">
        <table className="tbl">
          <thead><tr><th>Group</th><th>From – to</th><th>Prob</th><th>Conditions</th><th>Raw</th></tr></thead>
          <tbody>
            {t.groups.map((g, i) => (
              <tr key={i}>
                <td><Pill kind={g.kind === 'TEMPO' || g.kind.startsWith('PROB') ? 'warn' : g.kind === 'BASE' || g.kind === 'FM' ? 'info' : ''}>{g.kind}</Pill></td>
                <td className="mono small">{zulu(g.from, true)} – {zulu(g.to)}</td>
                <td className="num">{g.probability != null ? `${g.probability}%` : ''}</td>
                <td className="small">{condSummary(g.cond)}</td>
                <td className="mono small muted">{g.raw}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted small" style={{ margin: '10px 0 4px' }}>First {hours.length} hours, expanded</div>
      <div className="scroll-x">
        <table className="tbl">
          <thead><tr><th>Hour</th><th>Prevailing</th><th>Worst</th><th>Ceiling</th><th>Vis</th><th>Wind</th><th>Wx</th><th>Groups</th></tr></thead>
          <tbody>
            {hours.map((h) => (
              <tr key={h.time}>
                <td className="mono">{zulu(h.time, true)}</td>
                <td><CatBadge cat={h.prevailingCategory} /></td>
                <td>{h.worstCategory && h.worstCategory !== h.prevailingCategory ? <CatBadge cat={h.worstCategory} /> : <span className="muted">—</span>}</td>
                <td className="mono">{fmtCeiling(h.prevailingCeilingFt)}{h.worstCeilingFt != null && h.worstCeilingFt !== h.prevailingCeilingFt ? <span className="muted"> / {fmtCeiling(h.worstCeilingFt)}</span> : ''}</td>
                <td className="mono">{h.prevailing.visibility ? fmtVis(h.prevailing.visibility.sm, h.prevailing.visibility.plus) : '—'}</td>
                <td className="mono">{fmtWind(h.prevailing.wind)}</td>
                <td className="small">{h.prevailing.weather.map((w) => w.raw).join(' ') || '—'}{h.alternates.length > 0 && <span className="muted"> {h.alternates.map((a) => `${a.kind}${a.probability ? a.probability : ''}: ${a.cond.weather.map((w) => w.raw).join(' ') || a.category || ''}`).join('; ')}</span>}</td>
                <td className="muted tiny">{h.sourceGroups.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {t.parseWarnings.length > 0 && <div style={{ marginTop: 8 }}>{t.parseWarnings.map((w, i) => <span key={i} className="flag">{w}</span>)}</div>}
    </div>
  );
}

function Decoder() {
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<unknown>(null);
  const [res, setRes] = React.useState<DecodeResult | null>(null);
  const run = async () => {
    if (!text.trim()) return;
    setBusy(true); setErr(null);
    try { setRes(await api.decode(text.trim())); } catch (e) { setErr(e); setRes(null); } finally { setBusy(false); }
  };
  return (
    <Card title="Decoder" sub="paste a raw METAR or TAF">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="KTEB 081251Z 27008KT 10SM FEW250 22/12 A3012 RMK AO2 SLP199 …  or  TAF KTEB 081120Z 0812/0912 27008KT P6SM FEW250 FM082000 …"
        style={{ width: '100%', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: 8, fontFamily: 'var(--mono)', fontSize: 12.5, resize: 'vertical' }}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void run(); }}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={busy || !text.trim()} onClick={() => void run()}>{busy ? 'Decoding…' : 'Decode'}</button>
        {res && <span className="muted small">Decoded as {res.kind}</span>}
        <span className="muted tiny">Ctrl/⌘+Enter</span>
      </div>
      {err != null && <div style={{ marginTop: 8 }}><ErrorBox error={err} /></div>}
      {res && <div style={{ marginTop: 10 }}><DecodedView r={res} /></div>}
    </Card>
  );
}

export default function Status({ stations, onChange }: { stations: Station[]; onChange: () => void }) {
  const anyBusy = stations.some((s) => s.backfill_status === 'running' || s.backfill_status === 'pending');
  const status = useAsync(() => api.status(), [], anyBusy ? 10_000 : 60_000);
  const [days, setDays] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  // auto-refresh station list every 10 s while any backfill is running/pending
  React.useEffect(() => {
    if (!anyBusy) return;
    const t = setInterval(() => onChange(), 10_000);
    return () => clearInterval(t);
  }, [anyBusy, onChange]);

  const backfill = async (icao: string) => {
    const d = parseInt(days[icao] ?? '120', 10);
    if (!Number.isFinite(d) || d <= 0) { setMsg({ ok: false, text: 'Enter a positive number of days.' }); return; }
    setBusy((b) => ({ ...b, [icao]: 'backfill' }));
    try {
      await api.backfill(icao, d);
      setMsg({ ok: true, text: `Backfill of ${d} days started for ${icao}.` });
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[icao]; return n; });
    }
  };
  const remove = async (icao: string) => {
    if (!window.confirm(`Remove ${icao} and all of its stored observations, forecasts and verification data?`)) return;
    setBusy((b) => ({ ...b, [icao]: 'remove' }));
    try {
      await api.removeStation(icao);
      setMsg({ ok: true, text: `${icao} removed.` });
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[icao]; return n; });
    }
  };
  const refreshAll = async () => {
    setRefreshing(true); setMsg(null);
    try {
      await api.refresh();
      setMsg({ ok: true, text: 'All sources refreshed.' });
      onChange();
      status.reload();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setRefreshing(false);
    }
  };

  const st = status.data;
  const lastOkMap = new Map((st?.lastOk ?? []).map((x) => [x.source, x.at]));

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="row spread">
        <div>
          <h2 style={{ margin: 0 }}>Status &amp; stations</h2>
          <div className="muted small">{stations.length} station{stations.length === 1 ? '' : 's'}{anyBusy ? ' · backfill in progress, auto-refreshing every 10 s' : ''}</div>
        </div>
        <div className="row">
          {msg && <span className={msg.ok ? 'small' : 'small'} style={{ color: msg.ok ? '#86efac' : '#fca5a5' }}>{msg.text}</span>}
          <button className="btn primary" disabled={refreshing} onClick={() => void refreshAll()}>{refreshing ? 'Refreshing all sources…' : 'Refresh all sources now'}</button>
        </div>
      </div>

      {/* a. Station management */}
      <Card title="Stations">
        {stations.length === 0 ? <div className="muted">No stations yet. Add one from the station bar.</div> : (
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>ICAO</th><th>Name</th><th>Region</th><th>TZ</th><th>NWS</th><th>Backfill</th>
                  <th className="num">METARs</th><th className="num">TAFs</th><th className="num">Pairs</th><th>Latest obs</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {stations.map((s) => {
                  const b = busy[s.icao];
                  return (
                    <tr key={s.icao} style={s.enabled ? undefined : { opacity: 0.5 }}>
                      <td className="mono"><b>{s.icao}</b>{s.iata && <div className="muted tiny">{s.iata}{s.faa && s.faa !== s.iata ? ` / ${s.faa}` : ''}</div>}</td>
                      <td>{s.name ?? '—'}{!s.has_taf && <div><Pill kind="warn">no TAF</Pill></div>}</td>
                      <td>{[s.state, s.country].filter(Boolean).join(', ') || '—'}<div className="muted tiny">{s.lat.toFixed(3)}, {s.lon.toFixed(3)}{s.elev_ft != null ? ` · ${s.elev_ft} ft` : ''}</div></td>
                      <td className="mono small">{s.tz ?? '—'}</td>
                      <td className="mono small">{s.nws_office ?? '—'}{s.nws_grid_id ? ` ${s.nws_grid_id}` : ''}{s.nws_radar && <div className="muted tiny">radar {s.nws_radar}</div>}</td>
                      <td>
                        {statusPill(s.backfill_status)}
                        <div className="muted tiny" style={{ maxWidth: 220 }}>{s.backfill_message ?? ''}{s.backfill_days ? ` · ${s.backfill_days} d` : ''}{s.backfill_done_at ? ` · done ${ago(s.backfill_done_at)}` : ''}</div>
                      </td>
                      <td className="num">{(s.counts?.m ?? 0).toLocaleString()}</td>
                      <td className="num">{(s.counts?.t ?? 0).toLocaleString()}</td>
                      <td className="num">{(s.counts?.v ?? 0).toLocaleString()}</td>
                      <td>
                        {s.latest ? (
                          <>
                            <CatBadge cat={s.latest.category} /> <span className="mono small">{zulu(s.latest.time)}</span>
                            <div className="muted tiny">{ago(s.latest.time)} · {local(s.latest.time, s.tz)} local</div>
                          </>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                          <input
                            type="number" min={1} max={3650} value={days[s.icao] ?? '120'} title="days to backfill"
                            onChange={(e) => setDays((d) => ({ ...d, [s.icao]: e.target.value }))}
                            style={{ width: 62, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 6px', fontFamily: 'var(--mono)', fontSize: 12 }}
                          />
                          <button className="btn small" disabled={!!b || s.backfill_status === 'running'} onClick={() => void backfill(s.icao)}>{b === 'backfill' ? 'Starting…' : 'Re-backfill'}</button>
                          <button className="btn small danger" disabled={!!b} onClick={() => void remove(s.icao)}>{b === 'remove' ? 'Removing…' : 'Remove'}</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid cols-2">
        {/* d. System status */}
        <Card title="System status" sub={st ? `server time ${zulu(st.now, true)}` : undefined} right={status.loading && st ? <span className="muted small">refreshing…</span> : undefined}>
          {status.error != null ? <ErrorBox error={status.error} /> : null}
          {!st ? <Loading /> : (
            <>
              <div className="stats" style={{ marginBottom: 12 }}>
                {Object.entries(st.counts).map(([k, v]) => <Stat key={k} label={k} value={v.toLocaleString()} small />)}
              </div>
              <div className="grid cols-2" style={{ gap: 12 }}>
                <div>
                  <div className="muted small" style={{ marginBottom: 4 }}>Last successful fetch</div>
                  <table className="tbl">
                    <tbody>
                      {st.lastOk.length === 0 && <tr><td className="muted">nothing yet</td></tr>}
                      {st.lastOk.map((x) => (
                        <tr key={x.source}><td className="mono">{x.source}</td><td className="num">{ago(x.at)}</td><td className="muted tiny">{zulu(x.at, true)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <div className="muted small" style={{ marginBottom: 4 }}>Config</div>
                  <dl className="kv">
                    <dt>Backfill days</dt><dd>{st.config.backfillDays}</dd>
                    <dt>Open-Meteo</dt><dd>{st.config.useOpenMeteo ? 'enabled' : 'disabled'}</dd>
                    {Object.entries(st.config.intervals).map(([k, v]) => <React.Fragment key={k}><dt>{INTERVAL_LABEL[k] ?? k}</dt><dd>every {v} min</dd></React.Fragment>)}
                    <dt>Default stations</dt><dd>{st.config.defaultStations.join(', ') || '—'}</dd>
                  </dl>
                </div>
              </div>
            </>
          )}
        </Card>

        {/* c. Data sources */}
        <Card title="Data sources" sub="all free, public, no API keys">
          <table className="tbl">
            <thead><tr><th>Source</th><th>Provides</th><th>Last OK</th></tr></thead>
            <tbody>
              {SOURCES.map((s) => {
                const prefix = s.name.startsWith('aviationweather') ? 'awc.' : s.name.startsWith('NWS') ? 'nws.' : s.name.startsWith('Iowa') ? 'iem.' : 'openmeteo.';
                const ats = [...lastOkMap.entries()].filter(([k]) => k.startsWith(prefix)).map(([, at]) => at);
                const at = ats.length ? Math.max(...ats) : null;
                return (
                  <tr key={s.name}>
                    <td><a href={s.url} target="_blank" rel="noreferrer">{s.name}</a>{s.note && <div className="muted tiny">{s.note}</div>}</td>
                    <td className="small">{s.provides}</td>
                    <td className="small muted">{at ? ago(at) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>

      {/* d. Ingest log */}
      <Card title="Recent ingest log">
        {!st ? <Loading /> : st.log.length === 0 ? <div className="muted">No log entries.</div> : (
          <div className="scroll-x">
            <table className="tbl">
              <thead><tr><th>Time</th><th>Source</th><th>Station</th><th>Result</th><th>Message</th><th className="num">Count</th></tr></thead>
              <tbody>
                {st.log.map((l) => (
                  <tr key={l.id}>
                    <td className="mono small">{zulu(l.at, true)}<div className="muted tiny">{ago(l.at)}</div></td>
                    <td className="mono small">{l.source}</td>
                    <td className="mono small">{l.station ?? <span className="muted">—</span>}</td>
                    <td>{l.ok ? <Pill kind="good">ok</Pill> : <Pill kind="bad">fail</Pill>}</td>
                    <td className="small" style={{ color: l.ok ? undefined : '#fca5a5' }}>{l.message}</td>
                    <td className="num">{l.count != null ? l.count.toLocaleString() : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* e. Decoder */}
      <Decoder />
    </div>
  );
}
