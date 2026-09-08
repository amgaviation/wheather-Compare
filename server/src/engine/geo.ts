export function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3440.065; // nm
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function pointInPolygon(lat: number, lon: number, poly: Array<{ lat: number; lon: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lon, yi = poly[i].lat, xj = poly[j].lon, yj = poly[j].lat;
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Minimum distance (nm) from a point to polygon vertices/edges (vertex approximation with edge sampling). */
export function distanceToPolygonNm(lat: number, lon: number, poly: Array<{ lat: number; lon: number }>): number {
  if (!poly.length) return Infinity;
  if (pointInPolygon(lat, lon, poly)) return 0;
  let min = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    for (let f = 0; f <= 1; f += 0.25) {
      const d = haversineNm(lat, lon, a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f);
      if (d < min) min = d;
    }
  }
  return min;
}

export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (Math.round((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}
