import type { DB } from '../db/index.js';
import { config } from '../config.js';
import { getSetting, listStations, setSetting } from './store.js';
import { pollMetars, pollModels, pollNws, pollTafs, pruneModelRuns } from './ingest.js';
import { backfillStation, registerStation } from './backfill.js';

const MIN = 60_000;
let timers: NodeJS.Timeout[] = [];

async function safe(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    console.error(`[scheduler] ${name} failed:`, e);
  }
}

export async function bootstrap(db: DB) {
  const existing = listStations(db);
  if (!existing.length) {
    for (const icao of config.defaultStations) {
      try {
        await registerStation(db, icao);
      } catch (e) {
        console.error(`[bootstrap] could not register ${icao}:`, e);
      }
    }
  }
  // resume incomplete backfills (sequential, background)
  void (async () => {
    for (const s of listStations(db, true)) {
      if (s.backfill_status !== 'done') await backfillStation(db, s.icao);
    }
  })();
}

export function startScheduler(db: DB) {
  stopScheduler();
  const every = (minutes: number, name: string, fn: () => Promise<void>, initialDelayMs = 0) => {
    const t = setTimeout(() => {
      void safe(name, fn);
      timers.push(setInterval(() => void safe(name, fn), minutes * MIN));
    }, initialDelayMs);
    timers.push(t);
  };
  every(config.intervals.metarMin, 'metar', () => pollMetars(db), 2_000);
  every(config.intervals.tafMin, 'taf', () => pollTafs(db), 5_000);
  every(config.intervals.nwsMin, 'nws', async () => {
    for (const s of listStations(db, true)) await pollNws(db, s);
  }, 20_000);
  every(config.intervals.modelMin, 'models', async () => {
    for (const s of listStations(db, true)) {
      // previous-run (verification) data once per ~20 h per station
      const key = `prevruns:${s.icao}`;
      const last = Number(getSetting(db, key) ?? 0);
      const withPrev = Date.now() - last > 20 * 3600_000;
      await pollModels(db, s, withPrev);
      if (withPrev) setSetting(db, key, String(Date.now()));
    }
    pruneModelRuns(db);
  }, 40_000);
}

export function stopScheduler() {
  for (const t of timers) clearInterval(t);
  timers = [];
}
