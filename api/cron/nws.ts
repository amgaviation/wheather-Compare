import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDb } from '../../server/dist/db/index.js';
import { listStations } from '../../server/dist/engine/store.js';
import { pollNws } from '../../server/dist/engine/ingest.js';
import { checkCronAuth } from './_auth.js';

export const config = { maxDuration: 120 };

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!checkCronAuth(req, res)) return;
  const db = getDb();
  for (const s of await listStations(db, true)) await pollNws(db, s);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}
