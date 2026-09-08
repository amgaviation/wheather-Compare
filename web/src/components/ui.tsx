import React from 'react';
import type { FlightCategory } from '../lib/api';
import { CAT_DESC } from '../lib/format';

export function Card({ title, sub, children, className = '', right }: { title?: string; sub?: string; children: React.ReactNode; className?: string; right?: React.ReactNode }) {
  return (
    <div className={`card ${className}`}>
      {title && (
        <h3>
          <span>{title}{sub && <span className="sub"> · {sub}</span>}</span>
          {right}
        </h3>
      )}
      {children}
    </div>
  );
}

export function CatBadge({ cat, big = false, title }: { cat: FlightCategory | null | undefined; big?: boolean; title?: string }) {
  return (
    <span className={`cat ${cat ?? 'none'} ${big ? 'big' : ''}`} title={title ?? (cat ? CAT_DESC[cat] : 'Unknown')}>
      {cat ?? '—'}
    </span>
  );
}

export function Stat({ label, value, hint, small = false }: { label: string; value: React.ReactNode; hint?: React.ReactNode; small?: boolean }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className={`value ${small ? 'small' : ''}`}>{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Loading({ text = 'Loading…' }: { text?: string }) {
  return <div className="loading">{text}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  return <div className="error">{error instanceof Error ? error.message : String(error)}</div>;
}

export function Pill({ kind = '', children, title }: { kind?: '' | 'warn' | 'bad' | 'good' | 'info'; children: React.ReactNode; title?: string }) {
  return <span className={`pill ${kind}`} title={title}>{children}</span>;
}

export function useAsync<T>(fn: () => Promise<T>, deps: React.DependencyList, intervalMs?: number) {
  const [state, setState] = React.useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (error) => alive && setState((s) => ({ data: s.data, error, loading: false })),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  React.useEffect(() => {
    if (!intervalMs) return;
    const t = setInterval(() => setTick((x) => x + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return { ...state, reload: () => setTick((x) => x + 1) };
}
