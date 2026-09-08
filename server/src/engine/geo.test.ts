import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineNm, pointInPolygon } from './geo.js';
import { parseWindsAloft } from '../sources/awc.js';
import { fbRegion } from './hazards.js';
import { sunTimes } from './solar.js';

test('haversine JFK-LAX ~2145 nm', () => {
  const d = haversineNm(40.6392, -73.7639, 33.9425, -118.408);
  assert.ok(Math.abs(d - 2145) < 15, String(d));
});

test('point in polygon', () => {
  const poly = [{ lat: 40, lon: -75 }, { lat: 42, lon: -75 }, { lat: 42, lon: -73 }, { lat: 40, lon: -73 }];
  assert.equal(pointInPolygon(41, -74, poly), true);
  assert.equal(pointInPolygon(39, -74, poly), false);
});

test('winds aloft decode incl. >100kt and light/variable', () => {
  const txt = `FD1US1\nDATA BASED ON 071800Z\nVALID 080000Z   FOR USE 2000-0300Z. TEMPS NEG ABV 24000\n\nFT  3000    6000    9000   12000   18000   24000  30000  34000  39000\nJFK 3211 3416+09 3314+08 3416+02 3519-12 0132-23 355838 357349 335054\nEMI 9900 9900+11 3414+09 3316+04 3620-11 3534-19 344737 345947 355358\nDEN         2707+05 2712+01 2725-10 2835-21 286737 287248 780555\n`;
  const p = parseWindsAloft(txt);
  assert.equal(p.rows.length, 3);
  const jfk = p.rows[0];
  assert.equal(jfk.levels['3000'].dirDeg, 320);
  assert.equal(jfk.levels['3000'].speedKt, 11);
  assert.equal(jfk.levels['6000'].tempC, 9);
  assert.equal(jfk.levels['30000'].tempC, -38);
  assert.equal(jfk.levels['34000'].speedKt, 73);
  const emi = p.rows[1];
  assert.equal(emi.levels['3000'].lightVariable, true);
  const den = p.rows[2];
  assert.equal(den.levels['3000'].speedKt, null);
  assert.equal(den.levels['9000'].dirDeg, 270);
  assert.equal(den.levels['39000'].dirDeg, 280); // 78 -> 28 (+50 encoding)
  assert.equal(den.levels['39000'].speedKt, 105);
});

test('fb region mapping', () => {
  assert.equal(fbRegion(40.86, -74.06), 'bos');
  assert.equal(fbRegion(25.8, -80.3), 'mia');
  assert.equal(fbRegion(34.2, -118.5), 'sfo');
  assert.equal(fbRegion(41.9, -87.9), 'chi');
});

test('sunrise/sunset KTEB early Sept ~10:30Z / ~23:20Z', () => {
  const s = sunTimes(Date.UTC(2026, 8, 8, 12), 40.859, -74.056);
  assert.ok(s.sunrise && s.sunset);
  const h = (t: number) => new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60;
  assert.ok(Math.abs(h(s.sunrise!) - 10.5) < 0.4, String(h(s.sunrise!)));
  assert.ok(Math.abs(h(s.sunset!) - 23.3) < 0.4, String(h(s.sunset!)));
});
