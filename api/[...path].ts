/**
 * Vercel serverless entry: reuses the same Fastify app as the standalone server (server/src/app.ts),
 * built once per warm Lambda instance and fed every request via Node's raw request/response
 * objects, which is the documented way to run Fastify on a serverless platform without a
 * request-format adapter. File name is a catch-all (`[...path]`) so every `/api/*` request
 * routes here; Fastify's own router then dispatches to the matching handler in api/routes.ts.
 *
 * There is no setInterval scheduler here — a serverless function is frozen between
 * invocations, so periodic ingestion runs via Vercel Cron hitting api/cron/*.ts instead
 * (see vercel.json). Kicking off a backfill from a request (POST /api/stations) uses
 * `waitUntil` so the response returns immediately while the backfill keeps running.
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
