// Coarse-location "snap to grid" precision reduction.
//
// Check-ins normally share whatever precision GPS returns. When a user opts
// into a coarse-location setting, coordinates are snapped onto a grid before
// being appended, so contacts only see an approximate position. Pure + shared
// by the main process and the unit tests (no native deps here).

export const PRECISION_KM_OPTIONS = [0, 5, 10, 25, 50]

// Snap lat/lng onto a ~`precisionKm`-sized grid. `precisionKm` of 0 (or any
// non-positive / non-finite value) passes coordinates through unchanged.
// 1° of latitude ≈ 111 km, so the latitude step is km/111. The longitude step
// is scaled by cos(lat) so the grid stays roughly square on the surface
// (clamped to avoid blowups near the poles). The rounded result is clamped back
// into the valid geographic ranges so a check-in near a pole or the
// anti-meridian never stores an invalid lat/lng.
export function snapCoords (lat, lng, precisionKm) {
  const km = Number(precisionKm)
  if (!(km > 0) || !isFinite(km)) return { lat, lng }
  if (!isFinite(lat) || !isFinite(lng)) return { lat, lng }
  const step = km / 111
  const cosLat = Math.abs(Math.cos(lat * Math.PI / 180))
  const lngStep = step / Math.max(0.01, cosLat)
  const snappedLat = Math.round(lat / step) * step
  const snappedLng = Math.round(lng / lngStep) * lngStep
  return {
    lat: Math.max(-90, Math.min(90, snappedLat)),
    lng: Math.max(-180, Math.min(180, snappedLng))
  }
}
