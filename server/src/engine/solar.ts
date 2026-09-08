/** Sunrise/sunset (UTC ms) for the UTC date containing `dateUtcMs`, at a location. Null in polar day/night. */
export function sunTimes(dateUtcMs: number, lat: number, lon: number): { sunrise: number | null; sunset: number | null; civilDawn: number | null; civilDusk: number | null } {
  const d = new Date(dateUtcMs);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const jd = dayStart / 86400000 + 2440587.5; // JD at 0h UTC
  const n = Math.ceil(jd - 2451545.0 + 0.0008); // days since J2000 epoch (integer)
  const rad = Math.PI / 180;
  const lw = lon; // longitude, west negative (per the sunrise equation convention)
  const calc = (angle: number): [number | null, number | null] => {
    const Jstar = n - lw / 360; // mean solar noon
    const M = ((357.5291 + 0.98560028 * Jstar) % 360 + 360) % 360;
    const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
    const lambda = (M + C + 180 + 102.9372) % 360;
    const Jtransit = 2451545.0 + Jstar + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lambda * rad);
    const delta = Math.asin(Math.sin(lambda * rad) * Math.sin(23.44 * rad));
    const cosW = (Math.sin(angle * rad) - Math.sin(lat * rad) * Math.sin(delta)) / (Math.cos(lat * rad) * Math.cos(delta));
    if (cosW < -1 || cosW > 1) return [null, null];
    const w = Math.acos(cosW) / rad;
    const toMs = (j: number) => (j - 2440587.5) * 86400000;
    return [toMs(Jtransit - w / 360), toMs(Jtransit + w / 360)];
  };
  const [sunrise, sunset] = calc(-0.833);
  const [civilDawn, civilDusk] = calc(-6);
  return { sunrise, sunset, civilDawn, civilDusk };
}

export function isNight(t: number, lat: number, lon: number): boolean {
  const day = 86400000;
  let sawSun = false;
  for (const off of [-day, 0, day]) {
    const s = sunTimes(t + off, lat, lon);
    if (s.sunrise != null && s.sunset != null) {
      sawSun = true;
      if (t >= s.sunrise && t <= s.sunset) return false;
    }
  }
  if (!sawSun) {
    // polar: summer hemisphere = day
    const m = new Date(t).getUTCMonth();
    const summer = m >= 3 && m <= 8;
    return lat > 0 ? !summer : summer;
  }
  return true;
}
