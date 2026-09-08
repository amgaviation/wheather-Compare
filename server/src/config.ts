import path from 'node:path';

const env = process.env;

export const config = {
  port: parseInt(env.PORT ?? '8787', 10),
  host: env.HOST ?? '0.0.0.0',
  /** NWS requires a descriptive User-Agent with contact info. */
  userAgent: env.WX_USER_AGENT ?? 'wx-compare/0.1 (aviation forecast verification; contact via repo)',
  /** Days of METAR/TAF history pulled from the IEM archive when a station is added. */
  backfillDays: parseInt(env.BACKFILL_DAYS ?? '120', 10),
  /** Stations auto-added on first boot (comma separated ICAO). */
  defaultStations: (env.DEFAULT_STATIONS ?? 'KTEB,KHPN,KVNY')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  /** Whether Open-Meteo multi-model guidance is used (public, free, no key). */
  useOpenMeteo: (env.USE_OPEN_METEO ?? 'true') !== 'false',
  webDist: env.WEB_DIST ?? path.resolve(process.cwd(), '..', 'web', 'dist'),
  intervals: {
    metarMin: 5,
    tafMin: 10,
    nwsMin: 60,
    modelMin: 180,
    hazardsMin: 10,
  },
};
