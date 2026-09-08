import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Vercel automatically adds `Authorization: Bearer $CRON_SECRET` to requests it makes to
 * invoke a Cron Job, whenever the CRON_SECRET env var is set on the project. Checking it stops
 * anyone who finds the URL from triggering ingestion on demand (each poll makes real requests
 * to the upstream weather APIs and writes to the database).
 */
export function checkCronAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured (e.g. local testing): allow
  if (req.headers.authorization === `Bearer ${secret}`) return true;
  res.statusCode = 401;
  res.end('Unauthorized');
  return false;
}
