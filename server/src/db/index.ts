/**
 * Data layer: Supabase Postgres reached over the PostgREST HTTPS API (no direct Postgres
 * connection). This runs equally well from a long-lived Node process or a Vercel serverless
 * function (no connection pool to exhaust across many concurrent Lambda instances).
 *
 * Tables live in the `public` schema of a shared Supabase project, prefixed `wxc_` so they
 * cannot collide with that project's other application (a separate product in the `pilot`
 * schema). RLS policies scope the anon key used here to just these `wxc_*` tables. This key
 * is a server-side secret in this app: only Vercel/Node env vars hold it, it is never sent to
 * the browser (the frontend only ever talks to this app's own API).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type DB = SupabaseClient;

let client: DB | null = null;

export function getDb(): DB {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set (see .env.example).');
  }
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

/** For tests: inject a specific client (e.g. pointed at a disposable project). */
export function setDb(c: DB) {
  client = c;
}

export class DbError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
  }
}

/** Throw with a useful message on a PostgREST error; otherwise return `data`. */
export function unwrap<T>(res: { data: T | null; error: { message: string; details?: string | null } | null }, context: string): T {
  if (res.error) throw new DbError(`${context}: ${res.error.message}${res.error.details ? ` (${res.error.details})` : ''}`, res.error);
  return (res.data ?? (Array.isArray(res.data) ? [] : null)) as T;
}

const CHUNK = 500;

/**
 * Upsert a large array in bounded-size batches (PostgREST accepts one JSON array per request;
 * chunking keeps request bodies small and avoids any single-request row-count limits).
 * Returns the rows PostgREST actually reports back (empty when ignoreDuplicates skipped them).
 */
export async function upsertChunked<T extends object, R = T>(
  db: DB,
  table: string,
  rows: T[],
  onConflict: string,
  opts: { ignoreDuplicates?: boolean; select?: string } = {},
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    if (!batch.length) continue;
    const res = await db
      .from(table)
      .upsert(batch, { onConflict, ignoreDuplicates: opts.ignoreDuplicates ?? false })
      .select(opts.select ?? '*');
    if (res.error) throw new DbError(`upsert ${table}: ${res.error.message}`, res.error);
    out.push(...((res.data ?? []) as R[]));
  }
  return out;
}

/**
 * PostgREST caps a single response at 1000 rows by default. Any query that can plausibly
 * exceed that (verification history, long-lived METAR/TAF archives, multi-model guidance)
 * MUST page through with this helper instead of a bare `.select()`, or results silently
 * truncate. `build` constructs a fresh query for the given inclusive [from, to] row range.
 */
export async function selectAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, pageSize = 1000): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const res = await build(from, from + pageSize - 1);
    if (res.error) throw new DbError(`selectAll: ${res.error.message}`);
    const page = res.data ?? [];
    out.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return out;
}
