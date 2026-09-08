import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDb } from '../../server/dist/db/index.js';
import { getSetting, listStations, setSetting } from '../../server/dist/engine/store.js';
import { pollModels, pruneModelRuns } from '../../server/dist/engine/ingest.js';
import { checkCronAuth } from './_auth.js';

export const config = { maxDuration: 200 };

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!checkCronAuth(req, res)) return;
  const db = getDb();
  for (const s of await listStations(db, true)) {
    // previous-run (verification) data once per ~20 h per station
    const key = `prevruns:${s.icao}`;
    const last = Number((await getSetting(db, key)) ?? 0);
    const withPrev = Date.now() - last > 20 * 3600_000;
    await pollModels(db, s, withPrev);
    if (withPrev) await setSetting(db, key, String(Date.now()));
  }
  await pruneModelRuns(db);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}
