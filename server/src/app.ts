/**
 * Fastify app assembly, shared by the standalone/self-hosted server (src/index.ts) and the
 * Vercel serverless entry (../api/index.ts). Building this once and reusing the same Fastify
 * instance across invocations is what makes the serverless entry cheap on warm starts.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import { config } from './config.js';
import type { DB } from './db/index.js';
import { registerRoutes, type BackgroundRunner } from './api/routes.js';

export async function buildApp(db: DB, opts: { serveStatic?: boolean; background?: BackgroundRunner } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(cors, { origin: true });
  registerRoutes(app, db, opts.background);
  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { statusCode?: number; message?: string; issues?: unknown };
    const status = e.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ error: e.message ?? 'Internal error', issues: e.issues });
  });
  if ((opts.serveStatic ?? true) && fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }
  await app.ready();
  return app;
}
