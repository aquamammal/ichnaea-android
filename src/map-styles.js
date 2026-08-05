// Map style registry for Ichnaea's renderer. The user can pick one of these in
// Settings; the choice is persisted in localStorage and applied on reload (the
// renderer is built once at boot). Each style is either a 3D WebGL globe
// (`kind: 'globe'`) or a 2D canvas map (`kind: 'map'`), and both renderers
// expose the same public interface, so switching styles is purely a matter of
// which factory the dispatcher calls.
//
//   globe (3D):
//     - wireframe   : plain dark sphere + country border lines (current default)
//     - texture     : full-color Blue Marble earth texture (the pre-wireframe look)
//     - countries   : countries filled in distinct colors, ocean as blue water
//   map (2D, d3-geo):
//     - map         : equirectangular centered on Taiwan (~121°E) — the default "Map"
//     - map-center  : equirectangular centered on your current check-in location
//     - map-dymaxion: Buckminster Fuller's Airocean ("Dymaxion") projection
//
// Zero telemetry: all surfaces are derived from the bundled Natural Earth data
// and the bundled Blue Marble texture — no CDN, no tile servers.

export const MAP_STYLES = [
  { id: 'globe-wireframe', kind: 'globe', name: 'Globe — Wireframe' },
  { id: 'globe-texture', kind: 'globe', name: 'Globe — Full Color' },
  { id: 'globe-countries', kind: 'globe', name: 'Globe — Colored Countries' },
  { id: 'map', kind: 'map', name: 'Map' },
  { id: 'map-center', kind: 'map', name: 'Map — Centered on Me' },
  { id: 'map-dymaxion', kind: 'map', name: 'Map — Dymaxion' }
]

const STORAGE_KEY = 'mapStyle'
const DEFAULT_ID = 'globe-wireframe'

export function getMapStyleId () {
  try {
    const stored = (typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem(STORAGE_KEY))
    if (stored && MAP_STYLES.some((s) => s.id === stored)) return stored
  } catch { /* ignore */ }
  // Backward compatibility: the old `globe` key toggled 3D vs 2D.
  try {
    const old = (typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem('globe'))
    if (old === '3d') return 'globe-wireframe'
    if (old === '2d') return 'map'
  } catch { /* ignore */ }
  // Migrate any pre-consolidation ids.
  try {
    const stored = (typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem(STORAGE_KEY))
    if (stored === 'map-world' || stored === 'map-taiwan') return 'map'
  } catch { /* ignore */ }
  return DEFAULT_ID
}

export function setMapStyleId (id) {
  try {
    if (id && MAP_STYLES.some((s) => s.id === id)) window.localStorage.setItem(STORAGE_KEY, id)
  } catch { /* ignore */ }
}

export function getMapStyle (id) {
  const found = MAP_STYLES.find((s) => s.id === (id || getMapStyleId()))
  return found || MAP_STYLES[0]
}

// "Colored countries" toggle (independent of the map style): fills each country
// with its own hue in every projection and on the globe. Persisted separately.
const COLORED_KEY = 'coloredCountries'

export function getColored () {
  try {
    const v = (typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem(COLORED_KEY))
    return v === '1' || v === 'true'
  } catch { /* ignore */ }
  return false
}

export function setColored (on) {
  try {
    window.localStorage.setItem(COLORED_KEY, on ? '1' : '0')
  } catch { /* ignore */ }
}

// "Connecting lines" toggle (independent of the map style): show/hide the
// dotted arcs from your pin to each contact. Persisted separately.
const ARCS_KEY = 'showArcs'

export function getArcs () {
  try {
    const v = (typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem(ARCS_KEY))
    return v === null ? true : (v === '1' || v === 'true')
  } catch { /* ignore */ }
  return true
}

export function setArcs (on) {
  try {
    window.localStorage.setItem(ARCS_KEY, on ? '1' : '0')
  } catch { /* ignore */ }
}
