// Low-precision solar ephemeris (Astronomical Almanac approximation, ~0.01° accuracy).
// Returns the subsolar point — where the Sun is directly overhead — for a given instant.

const DEG = Math.PI / 180;

export function subsolarPoint(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;

  const L = (280.46 + 0.9856474 * n) % 360;              // mean longitude
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;     // mean anomaly
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG; // ecliptic longitude
  const eps = (23.439 - 0.0000004 * n) * DEG;            // obliquity of the ecliptic

  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));

  const gmstHours = (18.697374558 + 24.06570982441908 * n) % 24;
  const gmst = gmstHours * 15 * DEG;

  let lon = ra - gmst;
  lon = Math.atan2(Math.sin(lon), Math.cos(lon)); // wrap to [-π, π]

  return { lat: dec, lon };
}

// Equirectangular texture on a three.js SphereGeometry maps longitude λ to (cos λ, 0, -sin λ).
export function latLonToVector(lat, lon, target) {
  return target.set(
    Math.cos(lat) * Math.cos(lon),
    Math.sin(lat),
    -Math.cos(lat) * Math.sin(lon)
  );
}

export function vectorToLatLon(v) {
  const r = v.length();
  return {
    lat: Math.asin(v.y / r),
    lon: Math.atan2(-v.z, v.x),
  };
}

export function formatLatLon(lat, lon) {
  const la = lat / DEG;
  const lo = lon / DEG;
  const f = (x) => Math.abs(x).toFixed(1).padStart(5, '0');
  return `${f(la)}°${la >= 0 ? 'N' : 'S'}  ${Math.abs(lo).toFixed(1).padStart(5, '0')}°${lo >= 0 ? 'E' : 'W'}`;
}
