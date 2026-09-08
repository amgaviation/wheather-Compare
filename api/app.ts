/**
 * Vercel serverless entry: reuses the same Fastify app as the standalone server (server/src/app.ts),
 * built once per warm Lambda instance and fed every request via Node's raw request/response
 * objects, which is the documented way to run Fastify on a serverless platform without a
 * request-format adapter.
 *
 * Fixed filename, not a `[...path]` bracket catch-all: on a bare (non-Next.js) Vercel project
 * that convention only matched one path segment past `/api/` in practice (`/api/stations`
 * worked, `/api/stations/KTEB/current` 404'd at the platform before reaching this function).
 * `vercel.json`'s `rewrites` sends every `/api/*` request here instead, while Vercel still
 * preserves the original path in `req.url` — which is all Fastify's own router needs to
 * dispatch to the matching handler in api/routes.ts.
 *
 * There is no setInterval scheduler here — a serverless function is frozen between
 * invocations, so periodic ingestion runs via Vercel Cron hitting api/cron/*.ts instead
 * (see vercel.json; those are separate literal files, matched directly, not through this
 * rewrite). Kicking off a backfill from a request (POST /api/stations) uses `waitUntil` so
 * the response returns immediately while the backfill keeps running.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { waitUntil } from '@vercel/functions';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../server/dist/db/index.js';
import { buildApp } from '../server/dist/app.js';

export const config = { maxDuration: 300 };

let appPromise: Promise<FastifyInstance> | undefined;
function getApp(): Promise<FastifyInstance> {
  appPromise ??= buildApp(getDb(), { serveStatic: false, background: (p: Promise<unknown>) => waitUntil(p) });
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp();
  app.server.emit('request', req, res);
}
