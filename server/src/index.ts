import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getDb } from './db/index.js';
import { registerRoutes } from './api/routes.js';
import { bootstrap, startScheduler } from './engine/scheduler.js';

async function main() {
  const db = getDb();
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(cors, { origin: true });
  registerRoutes(app, db);
  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { statusCode?: number; message?: string; issues?: unknown };
    const status = e.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ error: e.message ?? 'Internal error', issues: e.issues });
  });
  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`wx-compare listening on http://${config.host}:${config.port} (web dist: ${fs.existsSync(config.webDist) ? config.webDist : 'not built; run npm run build -w web'})`);
  await bootstrap(db);
  startScheduler(db);
  const shutdown = () => {
    app.close().finally(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
