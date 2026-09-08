import { config } from '../config.js';

export class HttpError extends Error {
  constructor(public status: number, public url: string, body: string) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
  }
}

export interface FetchOpts {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch with timeout + exponential backoff; returns text. */
export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const { timeoutMs = 30_000, retries = 3 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { 'User-Agent': config.userAgent, Accept: 'application/json, text/plain, */*', ...opts.headers },
      });
      const body = await res.text();
      if (!res.ok) {
        // 4xx (other than 429) are not retryable
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new HttpError(res.status, url, body);
        throw new HttpError(res.status, url, body);
      }
      return body;
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
      if (attempt < retries) await sleep(500 * 2 ** attempt + Math.random() * 300);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T> {
  const txt = await fetchText(url, opts);
  try {
    return JSON.parse(txt) as T;
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${txt.slice(0, 120)}`);
  }
}

/** Simple TTL cache for hazard/PIREP style products. */
export class TtlCache<T> {
  private store = new Map<string, { at: number; value: T }>();
  constructor(private ttlMs: number) {}
  get(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return e.value;
  }
  set(key: string, value: T) {
    this.store.set(key, { at: Date.now(), value });
  }
  async getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const v = this.get(key);
    if (v !== undefined) return v;
    const loaded = await loader();
    this.set(key, loaded);
    return loaded;
  }
}
