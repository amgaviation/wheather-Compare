import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { DbError, selectAll } from '../db/index.js';
import { config } from '../config.js';
import { backfillStation, registerStation } from '../engine/backfill.js';
import { getStation, latestMetar, latestTaf, listStations, tafRowToObjects, type MetarRow, type StationRow, type TafRow } from '../engine/store.js';
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

/**
 * How a route hands off "keep working after the response is sent" (used for kicking off a
 * backfill without making the client wait). The standalone/self-hosted server just lets the
 * promise run in the background (the Node process stays alive between requests); on Vercel
 * this is swapped for `waitUntil()` so the serverless function isn't frozen before the
 * background work finishes. See api/index.ts.
 */
export type BackgroundRunner = (p: Promise<unknown>) => void;
const defaultBackground: BackgroundRunner = (p) => {
  p.catch((e) => console.error('[background]', e));
};

async function stationOr404(db: DB, icao: string): Promise<StationRow> {
  const st = await getStation(db, icao.toUpperCase());
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tableCount(db: DB, table: string, apply?: (q: any) => any): Promise<number> {
  const base = db.from(table).select('*', { count: 'exact', head: true });
  const res = await ((apply ? apply(base) : base) as PromiseLike<{ count: number | null; error: { message: string } | null }>);
  if (res.error) throw new DbError(`count ${table}: ${res.error.message}`);
  return res.count ?? 0;
}

export function registerRoutes(app: FastifyInstance, db: DB, background: BackgroundRunner = defaultBackground) {
  app.get('/api/health', async () => ({ ok: true, time: Date.now() }));

  app.get('/api/stations', async () => {
    const stations = await listStations(db);
    return Promise.all(
      stations.map(async (s) => {
        const [m, t, mCount, tCount, vCount] = await Promise.all([
          latestMetar(db, s.icao),
          latestTaf(db, s.icao),
          tableCount(db, 'wxc_metars', (q) => q.eq('station', s.icao)),
          tableCount(db, 'wxc_tafs', (q) => q.eq('station', s.icao)),
          tableCount(db, 'wxc_taf_verification', (q) => q.eq('station', s.icao)),
        ]);
        return {
          ...s,
          latest: m ? { time: m.obs_time, category: m.category, raw: m.raw, ceilingFt: m.ceiling_ft, visSm: m.vis_sm, windDir: m.wind_dir, windSpd: m.wind_spd, windGust: m.wind_gust, tempC: m.temp_c, dewpC: m.dewp_c, altimInHg: m.altim_inhg } : null,
          latestTaf: t ? { issued: t.issued, validFrom: t.valid_from, validTo: t.valid_to, amended: !!t.amended } : null,
          counts: { m: mCount, t: tCount, v: vCount },
        };
      }),
    );
  });

  app.post('/api/stations', async (req, reply) => {
    const body = z.object({ icao: z.string().min(3).max(4), days: z.number().int().min(7).max(730).optional() }).parse(req.body);
    const st = await registerStation(db, body.icao);
    background(backfillStation(db, st.icao, body.days ?? config.backfillDays).then(() => invalidateOutlook(st.icao)));
    reply.code(201);
    return st;
  });

  app.delete('/api/stations/:icao', async (req) => {
    const { icao } = req.params as { icao: string };
    const id = icao.toUpperCase();
    for (const t of ['wxc_taf_verification', 'wxc_metars', 'wxc_tafs', 'wxc_nws_hourly', 'wxc_model_hourly']) {
      const res = await db.from(t).delete().eq('station', id);
      if (res.error) throw new DbError(`delete ${t}: ${res.error.message}`, res.error);
    }
    const res = await db.from('wxc_stations').delete().eq('icao', id);
    if (res.error) throw new DbError(`delete station: ${res.error.message}`, res.error);
    invalidateOutlook(id);
    return { ok: true };
  });

  app.post('/api/stations/:icao/backfill', async (req) => {
    const { icao } = req.params as { icao: string };
    const st = await stationOr404(db, icao);
    const body = z.object({ days: z.number().int().min(7).max(730).optional() }).parse(req.body ?? {});
    background(backfillStation(db, st.icao, body.days ?? config.backfillDays).then(() => invalidateOutlook(st.icao)));
    return { started: true };
  });

  app.post('/api/refresh', async () => {
    await Promise.all([pollMetars(db), pollTafs(db)]);
    for (const s of await listStations(db, true)) {
      await pollNws(db, s);
      await pollModels(db, s, false);
    }
    invalidateOutlook();
    return { ok: true };
  });

  app.get('/api/stations/:icao/current', async (req) => {
    const { icao } = req.params as { icao: string };
    const st = await stationOr404(db, icao);
    const [m, tafsRes] = await Promise.all([latestMetar(db, st.icao), db.from('wxc_tafs').select('*').eq('station', st.icao).order('issued', { ascending: false }).limit(6)]);
    if (tafsRes.error) throw new DbError(`current tafs: ${tafsRes.error.message}`, tafsRes.error);
    const tafs = (tafsRes.data ?? []) as TafRow[];
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
    const st = await stationOr404(db, icao);
    const q = z.object({ hours: z.coerce.number().int().min(6).max(24 * 45).default(48), end: z.coerce.number().optional() }).parse(req.query);
    const end = q.end ?? Date.now() + HOUR;
    const start = end - q.hours * HOUR;

    const [metarRows, tafRows, verification, nwsIssuedRows] = await Promise.all([
      selectAll<MetarRow>((r0, r1) => db.from('wxc_metars').select('*').eq('station', st.icao).gte('obs_time', start).lte('obs_time', end).order('obs_time').range(r0, r1)),
      selectAll<TafRow>((r0, r1) => db.from('wxc_tafs').select('*').eq('station', st.icao).gte('valid_to', start).lte('issued', end).order('issued').range(r0, r1)),
      selectAll<Record<string, unknown>>((r0, r1) =>
        db
          .from('wxc_taf_verification')
          .select('hour_time,taf_id,lead_hours,fcst_cat,obs_cat,worst_cat,cat_hit,cat_err,tempo_covered,fcst_ceiling,obs_ceiling,fcst_vis,obs_vis,fcst_wspd,obs_wspd,fcst_wdir,obs_wdir,wspd_err,wdir_err')
          .eq('station', st.icao)
          .eq('operative', 1)
          .gte('hour_time', start)
          .lte('hour_time', end)
          .order('hour_time')
          .range(r0, r1),
      ),
      selectAll<{ issued: number }>((r0, r1) => db.from('wxc_nws_hourly').select('issued').eq('station', st.icao).gte('valid_time', start).lte('valid_time', end).range(r0, r1)),
    ]);

    const metars = metarRows.map(lightMetar);
    const tafs = tafRows.map((t) => ({
      id: t.id, issued: t.issued, validFrom: t.valid_from, validTo: t.valid_to, amended: !!t.amended, raw: t.raw,
      hours: (JSON.parse(t.hours) as TafHour[]).filter((h) => h.time >= start - HOUR && h.time <= end).map((h) => ({ time: h.time, cat: h.prevailingCategory, ceilingFt: h.prevailingCeilingFt, visSm: h.prevailing.visibility?.sm ?? null, wind: h.prevailing.wind, worstCat: h.worstCategory, worstCeilingFt: h.worstCeilingFt, worstVisSm: h.worstVisSm, wx: h.prevailing.weather.map((w) => w.raw), alternates: h.alternates.map((a) => ({ kind: a.kind, cat: a.category, ceilingFt: a.ceilingFt, wx: a.cond.weather.map((w) => w.raw) })) })),
    }));
    const nwsIssuedTimes = [...new Set(nwsIssuedRows.map((r) => r.issued))].sort((a, b) => b - a).slice(0, 4);
    const nws = await Promise.all(
      nwsIssuedTimes.map(async (issued) => {
        const res = await db
          .from('wxc_nws_hourly')
          .select('valid_time,temp_c,dewp_c,wind_dir,wind_spd,wind_gust,sky_pct,pop,ceiling_ft,vis_sm,wx,short_forecast')
          .eq('station', st.icao)
          .eq('issued', issued)
          .gte('valid_time', start)
          .lte('valid_time', end)
          .order('valid_time');
        if (res.error) throw new DbError(`history nws: ${res.error.message}`, res.error);
        return { issued, hours: res.data ?? [] };
      }),
    );
    return { station: st.icao, start, end, metars, tafs, verification, nws };
  });

  app.get('/api/stations/:icao/verification', async (req) => {
    const { icao } = req.params as { icao: string };
    const st = await stationOr404(db, icao);
    const q = z.object({ days: z.coerce.number().int().min(7).max(730).default(90) }).parse(req.query);
    return report(db, st.icao, q.days);
  });

  app.get('/api/stations/:icao/outlook', async (req) => {
    const { icao } = req.params as { icao: string };
    const st = await stationOr404(db, icao);
    const q = z.object({ hours: z.coerce.number().int().min(24).max(168).default(120), historyDays: z.coerce.number().int().min(14).max(730).default(120) }).parse(req.query);
    return buildOutlook(db, st, q.hours, q.historyDays);
  });

  app.get('/api/stations/:icao/hazards', async (req) => {
    const { icao } = req.params as { icao: string };
    const st = await stationOr404(db, icao);
    const q = z.object({ radius: z.coerce.number().int().min(25).max(500).default(200) }).parse(req.query);
    return stationHazards(st, q.radius);
  });

  app.get('/api/hazards', async () => allHazards());

  app.get('/api/stations/:icao/winds-aloft', async (req) => {
    const { icao } = req.params as { icao: string };
    const st = await stationOr404(db, icao);
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
    const st = await stationOr404(db, icao);
    const q = z.object({ days: z.number().int().min(1).max(730).default(30) }).parse(req.body ?? {});
    const n = await verifyStation(db, st.icao, Date.now() - q.days * 86_400_000, Date.now() + HOUR);
    invalidateOutlook(st.icao);
    return { inserted: n };
  });

  app.get('/api/status', async () => {
    const [logRows, okRows, metars, tafs, verification, nws, models] = await Promise.all([
      db.from('wxc_ingest_log').select('*').order('id', { ascending: false }).limit(60),
      selectAll<{ source: string; at: number }>((r0, r1) => db.from('wxc_ingest_log').select('source,at').eq('ok', 1).range(r0, r1)),
      tableCount(db, 'wxc_metars'),
      tableCount(db, 'wxc_tafs'),
      tableCount(db, 'wxc_taf_verification'),
      tableCount(db, 'wxc_nws_hourly'),
      tableCount(db, 'wxc_model_hourly'),
    ]);
    if (logRows.error) throw new DbError(`status log: ${logRows.error.message}`, logRows.error);
    const lastOkMap = new Map<string, number>();
    for (const r of okRows) if (!lastOkMap.has(r.source) || r.at > lastOkMap.get(r.source)!) lastOkMap.set(r.source, r.at);
    const lastOk = [...lastOkMap.entries()].map(([source, at]) => ({ source, at }));
    const counts = { metars, tafs, verification, nws, models };
    return { now: Date.now(), config: { backfillDays: config.backfillDays, useOpenMeteo: config.useOpenMeteo, intervals: config.intervals, defaultStations: config.defaultStations }, counts, lastOk, log: logRows.data ?? [] };
  });
}
