import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDb } from '../../server/dist/db/index.js';
import { pollTafs } from '../../server/dist/engine/ingest.js';
import { checkCronAuth } from './_auth.js';

export const config = { maxDuration: 60 };

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!checkCronAuth(req, res)) return;
  await pollTafs(getDb());
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}
