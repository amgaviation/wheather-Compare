/**
 * Standalone/self-hosted entry point (Docker, local dev, or any always-on host). Runs the
 * setInterval-based scheduler in-process. Not used on Vercel — see api/index.ts and
 * api/cron/*.ts, which reuse buildApp() but replace the scheduler with Vercel Cron.
 */
import fs from 'node:fs';
import { config } from './config.js';
import { getDb } from './db/index.js';
import { buildApp } from './app.js';
import { bootstrap, startScheduler, stopScheduler } from './engine/scheduler.js';

async function main() {
  const db = getDb();
  const app = await buildApp(db);
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`wx-compare listening on http://${config.host}:${config.port} (web dist: ${fs.existsSync(config.webDist) ? config.webDist : 'not built; run npm run build -w web'})`);
  await bootstrap(db);
  startScheduler(db);
  const shutdown = () => {
    stopScheduler();
    app.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
