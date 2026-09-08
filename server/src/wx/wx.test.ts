import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMetar } from './metar.js';
import { expandTaf, parseTaf, tafHourAt } from './taf.js';
import { flightCategory } from './flightcat.js';

const ref = new Date('2026-09-08T01:00:00Z');

test('flight category thresholds', () => {
  assert.equal(flightCategory(null, null), null);
  assert.equal(flightCategory(null, 10), 'VFR');
  assert.equal(flightCategory(3000, 10), 'MVFR');
  assert.equal(flightCategory(3100, 10), 'VFR');
  assert.equal(flightCategory(null, 5), 'MVFR');
  assert.equal(flightCategory(900, 10), 'IFR');
  assert.equal(flightCategory(5000, 2.5), 'IFR');
  assert.equal(flightCategory(400, 10), 'LIFR');
  assert.equal(flightCategory(5000, 0.5), 'LIFR');
});

test('METAR full decode', () => {
  const m = parseMetar('METAR KTEB 080051Z 26004KT 10SM FEW070 22/12 A3016 RMK AO2 SLP212 T02220117 $', ref);
  assert.equal(m.station, 'KTEB');
  assert.equal(new Date(m.time).toISOString(), '2026-09-08T00:51:00.000Z');
  assert.equal(m.cond.wind?.dirDeg, 260);
  assert.equal(m.cond.wind?.speedKt, 4);
  assert.equal(m.cond.visibility?.sm, 10);
  assert.equal(m.cond.clouds[0].cover, 'FEW');
  assert.equal(m.cond.clouds[0].baseFt, 7000);
  assert.equal(m.tempC, 22.2);
  assert.equal(m.dewpC, 11.7);
  assert.equal(m.altimeterInHg, 30.16);
  assert.equal(m.remarks.slpHpa, 1021.2);
  assert.equal(m.remarks.maintenanceNeeded, true);
  assert.equal(m.ceilingFt, null);
  assert.equal(m.category, 'VFR');
});

test('METAR LIFR with fractional vis, VV, gusts, variable wind, RVR, remarks', () => {
  const m = parseMetar(
    'SPECI KJFK 071455Z 18015G25KT 150V210 1/4SM R04R/1200V1800FT +TSRA FG VV002 18/17 A2965 RMK AO2 PK WND 19031/1432 WSHFT 1420 FROPA RAB05 SLP012 P0035 60050 T01780172 58012 PRESFR CIG 002V004 VIS 1/4V1/2 FRQ LTG IC CG OHD',
    ref,
  );
  assert.equal(m.type, 'SPECI');
  assert.equal(m.cond.wind?.gustKt, 25);
  assert.equal(m.cond.wind?.varFromDeg, 150);
  assert.equal(m.cond.visibility?.sm, 0.25);
  assert.equal(m.rvr[0].runway, '04R');
  assert.equal(m.rvr[0].minFt, 1200);
  assert.equal(m.rvr[0].maxFt, 1800);
  assert.deepEqual(m.cond.weather.map((w) => w.raw), ['+TSRA', 'FG']);
  assert.equal(m.cond.weather[0].intensity, '+');
  assert.equal(m.cond.weather[0].descriptor, 'TS');
  assert.deepEqual(m.cond.weather[0].phenomena, ['RA']);
  assert.equal(m.cond.verticalVisFt, 200);
  assert.equal(m.ceilingFt, 200);
  assert.equal(m.category, 'LIFR');
  assert.equal(m.remarks.peakWind?.speedKt, 31);
  assert.equal(m.remarks.windShiftMin, 20);
  assert.equal(m.remarks.frontalPassage, true);
  assert.equal(m.remarks.precip1hrIn, 0.35);
  assert.equal(m.remarks.precip3or6hrIn, 0.5);
  assert.equal(m.remarks.pressureTendency?.code, 8);
  assert.equal(m.remarks.pressureTendency?.changeHpa, -1.2);
  assert.equal(m.remarks.pressureFallingRapidly, true);
  assert.deepEqual(m.remarks.variableCeiling, { minFt: 200, maxFt: 400 });
  assert.deepEqual(m.remarks.variableVis, { minSm: 0.25, maxSm: 0.5 });
  assert.equal(m.remarks.lightning, 'FRQ LTG IC CG OHD');
  assert.equal(m.remarks.thunderstormBeganEnded, 'RAB05');
});

test('METAR two-token visibility and negative temps', () => {
  const m = parseMetar('KDEN 081253Z 36012KT 1 1/2SM -SN BR OVC008 M03/M05 A3021', ref);
  assert.equal(m.cond.visibility?.sm, 1.5);
  assert.equal(m.tempC, -3);
  assert.equal(m.dewpC, -5);
  assert.equal(m.ceilingFt, 800);
  assert.equal(m.category, 'IFR');
});

test('METAR ICAO format (meters, hPa)', () => {
  const m = parseMetar('EGLL 080050Z 24008KT 210V270 9999 FEW030 SCT045 15/11 Q1019 NOSIG', ref);
  assert.equal(m.cond.visibility?.meters, 9999);
  assert.equal(m.qnhHpa, 1019);
  assert.equal(m.category, 'VFR');
  const m2 = parseMetar('EDDF 080050Z 00000KT 0400 R25L/0600N FG VV001 09/09 Q1023', ref);
  assert.equal(m2.cond.visibility?.meters, 400);
  assert.equal(m2.category, 'LIFR');
});

test('TAF decode and hourly expansion with FM/TEMPO/BECMG/PROB', () => {
  const raw =
    'TAF AMD KTEB 072323Z 0800/0906 VRB03KT P6SM FEW250 TEMPO 0806/0810 4SM BR BKN008 ' +
    'FM081500 32007KT P6SM FEW250 BECMG 0818/0820 26012G20KT SCT040 PROB30 0900/0904 2SM -RA OVC006 FM090300 VRB03KT P6SM SCT250';
  const taf = parseTaf(raw, ref);
  assert.equal(taf.station, 'KTEB');
  assert.equal(taf.amended, true);
  assert.equal(new Date(taf.issued).toISOString(), '2026-09-07T23:23:00.000Z');
  assert.equal(new Date(taf.validFrom).toISOString(), '2026-09-08T00:00:00.000Z');
  assert.equal(new Date(taf.validTo).toISOString(), '2026-09-09T06:00:00.000Z');
  assert.deepEqual(taf.groups.map((g) => g.kind), ['BASE', 'TEMPO', 'FM', 'BECMG', 'PROB30', 'FM']);
  assert.equal(taf.groups[0].to, taf.groups[2].from);
  const hours = expandTaf(taf);
  assert.equal(hours.length, 30);
  const h07 = tafHourAt(hours, Date.parse('2026-09-08T07:30:00Z'))!;
  assert.equal(h07.prevailingCategory, 'VFR');
  assert.equal(h07.alternates[0].kind, 'TEMPO');
  assert.equal(h07.alternates[0].category, 'IFR');
  assert.equal(h07.worstCategory, 'IFR');
  assert.equal(h07.worstCeilingFt, 800);
  const h16 = tafHourAt(hours, Date.parse('2026-09-08T16:00:00Z'))!;
  assert.equal(h16.prevailing.wind?.dirDeg, 320);
  assert.equal(h16.alternates.length, 0);
  const h19 = tafHourAt(hours, Date.parse('2026-09-08T19:00:00Z'))!;
  assert.equal(h19.prevailing.wind?.dirDeg, 320); // BECMG not yet complete
  assert.equal(h19.alternates[0].kind, 'BECMG');
  assert.equal(h19.alternates[0].cond.wind?.gustKt, 20);
  const h21 = tafHourAt(hours, Date.parse('2026-09-08T21:00:00Z'))!;
  assert.equal(h21.prevailing.wind?.dirDeg, 260); // BECMG complete
  assert.equal(h21.prevailing.clouds[0].cover, 'SCT');
  assert.equal(h21.prevailing.visibility?.plus, true); // inherited
  const h01 = tafHourAt(hours, Date.parse('2026-09-09T01:00:00Z'))!;
  assert.equal(h01.alternates[0].kind, 'PROB30');
  assert.equal(h01.alternates[0].probability, 0.3);
  assert.equal(h01.worstCategory, 'IFR');
  const h04 = tafHourAt(hours, Date.parse('2026-09-09T04:00:00Z'))!;
  assert.equal(h04.prevailing.wind?.variable, true); // FM090300 reset BECMG
  assert.equal(h04.prevailing.clouds[0].baseFt, 25000);
});

test('TAF month rollover and hour 24', () => {
  const taf = parseTaf('TAF KORD 302330Z 0100/0124 27010KT P6SM SKC', new Date('2026-08-31T00:00:00Z'));
  assert.equal(new Date(taf.issued).toISOString(), '2026-08-30T23:30:00.000Z');
  assert.equal(new Date(taf.validFrom).toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(new Date(taf.validTo).toISOString(), '2026-09-02T00:00:00.000Z');
});

test('TAF with wind shear, NSW, TX/TN', () => {
  const taf = parseTaf('TAF KBOS 081130Z 0812/0918 WS020/24045KT 20015KT 3SM -RA BR OVC012 TX22/0819Z TN14/0910Z FM081800 22012KT P6SM NSW SCT025', ref);
  assert.equal(taf.groups[0].cond.windShear?.speedKt, 45);
  assert.equal(taf.maxTemp?.c, 22);
  assert.equal(taf.minTemp?.c, 14);
  const hours = expandTaf(taf);
  const h19 = tafHourAt(hours, Date.parse('2026-09-08T19:00:00Z'))!;
  assert.equal(h19.prevailing.weather.length, 0);
  assert.equal(h19.prevailingCategory, 'VFR');
  assert.equal(taf.parseWarnings.length, 0, taf.parseWarnings.join(';'));
});
