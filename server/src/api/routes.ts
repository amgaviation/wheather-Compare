import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { config } from '../config.js';
import { backfillStation, registerStation } from '../engine/backfill.js';
import { getStation, latestMetar, latestTaf, listStations, tafRowToObjects, type MetarRow, type TafRow } from '../engine/store.js';
import { report } from '../engine/stats.js';
import { buildOutlook, invalidateOutlook } from '../engine/outlook.js';
import { allHazards, stationHazards, windsAloftFor } from '../engine/hazards.js';
import { parseMetar } from '../wx/metar.js';
import { expandTaf, parseTaf } from '../wx/taf.js';
import { pollMetars, pollModels, pollNws, pollTafs } from '../engine/ingest.js';
import { verifyStation } from '../engine/verify.js';
import { sunTimes } from '../engine/solar.js';
import type { Metar, TafHour } from '../wx/types.js';

const HOUR = 3600_000;

function stationOr404(db: DB, icao: string) {
  const st = getStation(db, icao.toUpperCase());
  if (!st) throw Object.assign(new Error(`Unknown station ${icao}`), { statusCode: 404 });
  return st;
}

function lightMetar(m: MetarRow) {
  const d = JSON.parse(m.decoded) as Metar;
  return {
    id: m.id, time: m.obs_time, hourTime: m.hour_time, type: m.type, raw: m.raw, category: m.category, ceilingFt: m.ceiling_ft, visSm: m.vis_sm,
    wind: d.cond.wind, tempC: m.temp_c, dewpC: m.dewp_c, altimInHg: m.altim_inhg, slpHpa: m.slp_hpa, wx: d.cond.weather.map((w) => w.raw), clouds: d.cond.clouds,
    rvr: d.rvr, remarks: d.remarks, verticalVisFt: d.cond.verticalVisFt, auto: d.auto,
  };
}

export function registerRoutes(app: FastifyInstance, db: DB) {
  app.get('/api/health', async () => ({ ok: true, time: Date.now() }));

  app.get('/api/stations', async () => {
    return listStations(db).map((s) => {
      const m = latestMetar(db, s.icao);
      const t = latestTaf(db, s.icao);
      const counts = db.prepare('SELECT (SELECT count(*) FROM metars WHERE station=?) m, (SELECT count(*) FROM tafs WHERE station=?) t, (SELECT count(*) FROM taf_verification WHERE station=?) v').get(s.icao, s.icao, s.icao) as { m: number; t: number; v: number };
      return {
        ...s,
        latest: m ? { time: m.obs_time, category: m.category, raw: m.raw, ceilingFt: m.ceiling_ft, visSm: m.vis_sm, windDir: m.wind_dir, windSpd: m.wind_spd, windGust: m.wind_gust, tempC: m.temp_c, dewpC: m.dewp_c, altimInHg: m.altim_inhg } : null,
        latestTaf: t ? { issued: t.issued, validFrom: t.valid_from, validTo: t.valid_to, amended: !!t.amended } : null,
        counts,
      };
    });
  });

  app.post('/api/stations', async (req, reply) => {
    const body = z.object({ icao: z.string().min(3).max(4), days: z.number().int().min(7).max(730).optional() }).parse(req.body);
    const st = await registerStation(db, body.icao);
    void backfillStation(db, st.icao, body.days ?? config.backfillDays).then(() => invalidateOutlook(st.icao));
    reply.code(201);
    return st;
  });

  app.delete('/api/stations/:icao', async (req) => {
    const { icao } = req.params as { icao: string };
    const id = icao.toUpperCase();
    const tx = db.transaction(() => {
      for (const t of ['taf_verification', 'metars', 'tafs', 'nws_hourly', 'model_hourly']) db.prepare(`DELETE FROM ${t} WHERE station=?`).run(id);
      db.prepare('DELETE FROM stations WHERE icao=?').run(id);
    });
    tx();
    invalidateOutlook(id);
    return { ok: true };
  });

  app.post('/api/stations/:icao/backfill', async (req) => {
    const { icao } = req.params as { icao: string };
    const st = stationOr404(db, icao);
    const body = z.object({ days: z.number().int().min(7).max(730).optional() }).parse(req.body ?? {});
    void backfillStation(db, st.icao, body.days ?? config.backfillDays).then(() => invalidateOutlook(st.icao));
    return { started: true };
  });

  app.post('/api/refresh', async () => {
    await Promise.all([pollMetars(db), pollTafs(db)]);
    for (const s of listStations(db, true)) {
      await pollNws(db, s);
      await pollModels(db, s, false);
    }
    invalidateOutlook();
    return { ok: true };
  });

  app.get('/api/stations/:icao/current', async (req) => {
    const { icao } = req.params as { icao: string };
    const st = stationOr404(db, icao);
    const m = latestMetar(db, st.icao);
    const tafs = db.prepare('SELECT * FROM tafs WHERE station=? ORDER BY issued DESC LIMIT 6').all(st.icao) as TafRow[];
    const now = Date.now();
    const tafOut = tafs.map((t) => {
      const { taf, hours } = tafRowToObjects(t);
      return { id: t.id, issued: t.issued, validFrom: t.valid_from, validTo: t.valid_to, amended: !!t.amended, raw: t.raw, taf, hours, current: t.valid_to > now };
    });
    const sun = sunTimes(now, st.lat, st.lon);
    return { station: st, metar: m ? { ...lightMetar(m), decoded: JSON.parse(m.decoded) as Metar, ageMin: Math.round((now - m.obs_time) / 60000) } : null, tafs: tafOut, sun };
  });

  app.get('/api/stations/:icao/history', async (req) => {
    const { icao } = req.params as { icao: string };
    const st = stationOr404(db, icao);
    const q = z.object({ hours: z.coerce.number().int().min(6).max(24 * 45).default(48), end: z.coerce.number().optional() }).parse(req.query);
    const end = q.end ?? Date.now() + HOUR;
    const start = end - q.hours * HOUR;
    const metars = (db.prepare('SELECT * FROM metars WHERE station=? AND obs_time>=? AND obs_time<=? ORDER BY obs_time').all(st.icao, start, end) as MetarRow[]).map(lightMetar);
    const tafs = (db.prepare('SELECT * FROM tafs WHERE station=? AND valid_to>=? AND issued<=? ORDER BY issued').all(st.icao, start, end) as TafRow[]).map((t) => ({
      id: t.id, issued: t.issued, validFrom: t.valid_from, validTo: t.valid_to, amended: !!t.amended, raw: t.raw,
      hours: (JSON.parse(t.hours) as TafHour[]).filter((h) => h.time >= start - HOUR && h.time <= end).map((h) => ({ time: h.time, cat: h.prevailingCategory, ceilingFt: h.prevailingCeilingFt, visSm: h.prevailing.visibility?.sm ?? null, wind: h.prevailing.wind, worstCat: h.worstCategory, worstCeilingFt: h.worstCeilingFt, worstVisSm: h.worstVisSm, wx: h.prevailing.weather.map((w) => w.raw), alternates: h.alternates.map((a) => ({ kind: a.kind, cat: a.category, ceilingFt: a.ceilingFt, wx: a.cond.weather.map((w) => w.raw) })) })),
    }));
    // operative verification rows for the same window
    const verification = db.prepare('SELECT hour_time, taf_id, lead_hours, fcst_cat, obs_cat, worst_cat, cat_hit, cat_err, tempo_covered, fcst_ceiling, obs_ceiling, fcst_vis, obs_vis, fcst_wspd, obs_wspd, fcst_wdir, obs_wdir, wspd_err, wdir_err FROM taf_verification WHERE station=? AND operative=1 AND hour_time>=? AND hour_time<=? ORDER BY hour_time').all(st.icao, start, end);
    const nwsIssued = db.prepare('SELECT DISTINCT issued FROM nws_hourly WHERE station=? AND valid_time>=? AND valid_time<=? ORDER BY issued DESC LIMIT 4').all(st.icao, start, end) as Array<{ issued: number }>;
    const nws = nwsIssued.map((i) => ({ issued: i.issued, hours: db.prepare('SELECT valid_time, temp_c, dewp_c, wind_dir, wind_spd, wind_gust, sky_pct, pop, ceiling_ft, vis_sm, wx, short_forecast FROM nws_hourly WHERE station=? AND issued=? AND valid_time>=? AND valid_time<=? ORDER BY valid_time').all(st.icao, i.issued, start, end) }));
    return { station: st.icao, start, end, metars, tafs, verification, nws };
  });

  app.get('/api/stations/:icao/verification', async (req) => {
    const { icao } = req.params as { icao: string };
    const st = stationOr404(db, icao);
    const q = z.object({ days: z.coerce.number().int().min(7).max(730).default(90) }).parse(req.query);
    return report(db, st.icao, q.days);
  });

  app.get('/api/stations/:icao/outlook', async (req) => {
    const { icao } = req.params as { icao: string };
    const st = stationOr404(db, icao);
    const q = z.object({ hours: z.coerce.number().int().min(24).max(168).default(120), historyDays: z.coerce.number().int().min(14).max(730).default(120) }).parse(req.query);
    return buildOutlook(db, st, q.hours, q.historyDays);
  });

  app.get('/api/stations/:icao/hazards', async (req) => {
    const { icao } = req.params as { icao: string };
    const st = stationOr404(db, icao);
    const q = z.object({ radius: z.coerce.number().int().min(25).max(500).default(200) }).parse(req.query);
    return stationHazards(st, q.radius);
  });

  app.get('/api/hazards', async () => allHazards());

  app.get('/api/stations/:icao/winds-aloft', async (req) => {
    const { icao } = req.params as { icao: string };
    const st = stationOr404(db, icao);
    if (st.country && st.country !== 'US') return { unsupported: true, reason: 'FB winds/temps aloft products cover US regions only' };
    return windsAloftFor(st);
  });

  app.post('/api/decode', async (req) => {
    const body = z.object({ text: z.string().min(4).max(4000), reference: z.string().optional() }).parse(req.body);
    const ref = body.reference ? new Date(body.reference) : new Date();
    const text = body.text.trim();
    if (/^(TAF|TAF AMD|TAF COR)\b/.test(text) || /\d{6}Z \d{4}\/\d{4}/.test(text)) {
      const taf = parseTaf(text, ref);
      return { kind: 'TAF', taf, hours: expandTaf(taf) };
    }
    return { kind: 'METAR', metar: parseMetar(text, ref) };
  });

  app.post('/api/stations/:icao/verify', async (req) => {
    const { icao } = req.params as { icao: string };
    const st = stationOr404(db, icao);
    const q = z.object({ days: z.number().int().min(1).max(730).default(30) }).parse(req.body ?? {});
    const n = verifyStation(db, st.icao, Date.now() - q.days * 86_400_000, Date.now() + HOUR);
    invalidateOutlook(st.icao);
    return { inserted: n };
  });

  app.get('/api/status', async () => {
    const log = db.prepare('SELECT * FROM ingest_log ORDER BY id DESC LIMIT 60').all();
    const lastOk = db.prepare('SELECT source, max(at) at FROM ingest_log WHERE ok=1 GROUP BY source').all();
    const counts = db.prepare('SELECT (SELECT count(*) FROM metars) metars, (SELECT count(*) FROM tafs) tafs, (SELECT count(*) FROM taf_verification) verification, (SELECT count(*) FROM nws_hourly) nws, (SELECT count(*) FROM model_hourly) models').get();
    return { now: Date.now(), config: { backfillDays: config.backfillDays, useOpenMeteo: config.useOpenMeteo, intervals: config.intervals, defaultStations: config.defaultStations }, counts, lastOk, log };
  });
}
