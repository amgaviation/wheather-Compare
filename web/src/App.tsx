import React from 'react';
import { api, type Station } from './lib/api';
import { zulu, ago } from './lib/format';
import { ErrorBox, Loading } from './components/ui';
import Dashboard from './pages/Dashboard';
import Outlook from './pages/Outlook';
import Verification from './pages/Verification';
import Hazards from './pages/Hazards';
import Status from './pages/Status';

type Page = 'dashboard' | 'outlook' | 'verification' | 'hazards' | 'status';
const PAGES: Array<{ id: Page; label: string }> = [
  { id: 'dashboard', label: 'Now & TAF' },
  { id: 'outlook', label: 'Outlook' },
  { id: 'verification', label: 'Forecast vs Actual' },
  { id: 'hazards', label: 'Hazards & Winds' },
  { id: 'status', label: 'Stations & Data' },
];

function readHash(): { page: Page; station: string | null } {
  const h = location.hash.replace(/^#\/?/, '');
  const [p, s] = h.split('/');
  const page = (PAGES.some((x) => x.id === p) ? p : 'dashboard') as Page;
  return { page, station: s ? s.toUpperCase() : null };
}

export default function App() {
  const [{ page, station }, setRoute] = React.useState(readHash);
  const [stations, setStations] = React.useState<Station[] | null>(null);
  const [err, setErr] = React.useState<unknown>(null);
  const [clock, setClock] = React.useState(Date.now());
  const [adding, setAdding] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const loadStations = React.useCallback(() => {
    api.stations().then(setStations, setErr);
  }, []);
  React.useEffect(() => {
    loadStations();
    const t = setInterval(loadStations, 60_000);
    return () => clearInterval(t);
  }, [loadStations]);
  React.useEffect(() => {
    const onHash = () => setRoute(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  React.useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const go = (p: Page, s: string | null = station) => {
    location.hash = `#/${p}${s ? '/' + s : ''}`;
  };
  const current = stations?.find((s) => s.icao === station) ?? stations?.[0] ?? null;
  React.useEffect(() => {
    if (stations && !station && stations[0]) go(page, stations[0].icao);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const icao = adding.trim().toUpperCase();
    if (!icao) return;
    setBusy(true);
    try {
      await api.addStation(icao);
      setAdding('');
      loadStations();
      go(page, icao);
    } catch (e2) {
      alert(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">WX<span>COMPARE</span> <span className="muted small">forecast verification &amp; outlook</span></div>
        <nav className="nav">
          {PAGES.map((p) => (
            <button key={p.id} className={p.id === page ? 'active' : ''} onClick={() => go(p.id)}>
              {p.label}
            </button>
          ))}
        </nav>
        <div className="clock" style={{ marginLeft: 'auto' }}>
          {zulu(clock, true)} · {new Date(clock).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} local
        </div>
      </header>
      <div className="stationbar">
        {stations?.map((s) => (
          <button key={s.icao} className={`stbtn ${s.icao === current?.icao ? 'active' : ''}`} onClick={() => go(page, s.icao)} title={`${s.name ?? ''}\n${s.latest?.raw ?? ''}\n${s.latest ? 'obs ' + ago(s.latest.time) : ''}`}>
            <span className="dot" style={{ background: s.latest?.category ? `var(--${s.latest.category.toLowerCase()})` : 'var(--border)' }} />
            {s.icao}
            {s.backfill_status !== 'done' && <span className="tiny muted">{s.backfill_status}</span>}
          </button>
        ))}
        <form onSubmit={add}>
          <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="ICAO" maxLength={4} />
          <button className="btn" disabled={busy}>{busy ? '…' : 'Add station'}</button>
        </form>
      </div>
      <main className="main">
        {err ? <ErrorBox error={err} /> : null}
        {!stations ? (
          <Loading />
        ) : page === 'status' ? (
          <Status stations={stations} onChange={loadStations} />
        ) : !current ? (
          <div className="card">No stations yet. Add an ICAO identifier above (e.g. KTEB). Backfill of history starts automatically.</div>
        ) : page === 'dashboard' ? (
          <Dashboard station={current} />
        ) : page === 'outlook' ? (
          <Outlook station={current} />
        ) : page === 'verification' ? (
          <Verification station={current} />
        ) : (
          <Hazards station={current} />
        )}
      </main>
    </div>
  );
}
