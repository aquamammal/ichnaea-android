import Globe from 'globe.gl'
import * as THREE from 'three'
import { create2DRenderer } from './map2d.js'

// Globe renderer factory. Picks the 3D WebGL globe when a WebGL context can be
// created, otherwise falls back to the 2D canvas map (src/map2d.js) — some
// Linux GPU/driver combos block WebGL in the Pear/Electron window and Pear
// gives app code no way to inject Chromium flags. Both renderers expose the
// same interface, so src/main.js needs no changes:
//
//   { setSelf, upsertContactPin, removeContactPin, hasPin, resize, globe, webgl }
//
//   self pin     -> blue
//   active       -> green
//   stale        -> gray
//   (offline pins are removed by the caller, not rendered)
//
// Zero telemetry: the 3D earth texture and the 2D world outline are bundled
// locally under src/assets/ — no CDN, no map-tile servers.

const COLOR_SELF = '#3b9dff'
const COLOR_ACTIVE = '#3ddc84'
const COLOR_STALE = '#9aa4b0'

function webglAvailable () {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'))
  } catch {
    return false
  }
}

// Renderer selection. Default is the 2D canvas map — it always works (no WebGL
// needed) and is fully offline. The 3D WebGL globe is opt-in because some Linux
// GPU/driver combos block WebGL context creation in the Pear/Electron window
// and Pear gives app code no way to inject Chromium flags. Force 3D by adding
// `?globe=3d` to the window URL (or localStorage 'globe' = '3d'); force 2D with
// `?globe=2d`. When 3D is requested but the context can't be created, we fall
// back to 2D automatically.
function wants3D () {
  try {
    const q = (typeof window !== 'undefined' && window.location && window.location.search) || ''
    if (/[?&]globe=2d/.test(q)) return false
    if (/[?&]globe=3d/.test(q)) return true
    const stored = (typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem('globe'))
    if (stored === '3d') return true
    if (stored === '2d') return false
  } catch { /* ignore */ }
  // Default to the 3D globe on Android; desktop keeps the lightweight 2D map.
  try { if (/Android/i.test(navigator.userAgent)) return true } catch { /* ignore */ }
  return false // default: 2D
}

// Inverted-teardrop (map-pin) point geometry. three-globe hardcodes its points
// as cylinders with no geometry accessor, so we swap each point mesh's geometry
// after every pointsData render. Local space: point at Z=0 (the surface),
// bulb up to Z=1 (the outward axis three-globe scales by altitude).
let teardropGeo = null
function teardropGeometry () {
  if (!teardropGeo) {
    const pts = []
    const N = 14
    for (let i = 0; i <= N; i++) {
      const y = i / N
      let r
      if (y < 0.4) r = Math.sin((y / 0.4) * (Math.PI / 2)) // point -> widest
      else r = 1 - ((y - 0.4) / 0.6) * 0.3 // slight taper toward the top
      pts.push([Math.max(r, 0.002), y])
    }
    teardropGeo = new THREE.LatheGeometry(pts, 24)
    teardropGeo.rotateX(Math.PI / 2) // height axis Y -> outward Z
  }
  return teardropGeo
}

export function createGlobeRenderer (container, { onPinClick } = {}) {
  if (!wants3D()) return create2DRenderer(container, { onPinClick })
  if (!webglAvailable()) return create2DRenderer(container, { onPinClick })

  let globe
  try {
    globe = Globe()(container)
      .backgroundColor('rgba(0,0,0,0)')
      .showAtmosphere(true)
      .atmosphereColor('#4a90d9')
      .atmosphereAltitude(0.25)
      .pointAltitude('alt')
      .pointColor('color')
      .pointRadius('size')
      .pointResolution(24)
      .pointsMerge(false)
      .arcColor('color')
      .arcDashLength(0.4)
      .arcDashGap(0.6)
      .arcDashAnimateTime(2000)
      .arcStroke(0.5)
      .arcAltitudeAutoScale(0.3)
      .onPointClick((pt) => { if (onPinClick && pt && pt.data) onPinClick(pt.data) })
  } catch (err) {
    // THREE.WebGLRenderer throws when the WebGL context can't be created even
    // though the pre-check passed — fall back to the 2D canvas map.
    console.error('[globe] 3D init failed:', err && err.message)
    return create2DRenderer(container, { onPinClick })
  }

  // Earth surface texture, bundled locally (copied from three-globe's examples)
  // so the 3D globe makes no third-party network call either. Falls back to a
  // plain globe if the image can't load.
  try {
    globe.globeImageUrl('./assets/earth-blue-marble.jpg')
  } catch { /* texture optional */ }

  const pins = new Map() // id -> { id, lat, lng, alt, color, size, data }
  let selfLoc = null

  function applyPointShapes () {
    try {
      const roots = [globe.scene()]
      if (typeof globe.globe === 'function' && globe.globe()) roots.push(globe.globe())
      for (const root of roots) {
        root.traverse((obj) => {
          if (obj.__globeObjType === 'point' && obj.geometry && obj.geometry !== teardropGeo) {
            obj.geometry = teardropGeometry()
          }
        })
      }
    } catch (e) { console.log('[globe] applyPointShapes error:', e.message) }
  }

  // The points layer renders its meshes on the frame loop, so swap the geometry
  // after a few ticks (idempotent — only replaces meshes still using the
  // default cylinder).
  function scheduleShapeSwap () {
    for (const ms of [0, 100, 300, 900, 2000]) setTimeout(applyPointShapes, ms)
  }

  function sync () {
    globe.pointsData([...pins.values()])
    scheduleShapeSwap()
    syncArcs()
  }

  function syncArcs () {
    if (!selfLoc) { globe.arcsData([]); return }
    const arcs = []
    for (const p of pins.values()) {
      if (p.id === 'self') continue
      arcs.push({
        startLat: selfLoc.lat,
        startLng: selfLoc.lng,
        endLat: p.lat,
        endLng: p.lng,
        color: [[COLOR_SELF, p.color], [COLOR_SELF, p.color]]
      })
    }
    globe.arcsData(arcs)
  }

  function setSelf ({ lat, lng }) {
    selfLoc = { lat, lng }
    pins.set('self', {
      id: 'self', lat, lng, alt: 0.03, color: COLOR_SELF, size: 0.35,
      data: { self: true, lat, lng }
    })
    sync()
  }

  // contact: { id, nickname, lastSeenTs, intervalMs }
  // loc: { lat, lng }  status: 'active' | 'stale'
  function upsertContactPin (contact, loc, status) {
    const color = status === 'stale' ? COLOR_STALE : COLOR_ACTIVE
    pins.set(contact.id, {
      id: contact.id, lat: loc.lat, lng: loc.lng, alt: 0.025, color, size: 0.3,
      data: { self: false, contact, lat: loc.lat, lng: loc.lng, status }
    })
    sync()
  }

  function removeContactPin (contactId) {
    if (pins.delete(contactId)) sync()
  }

  function hasPin (contactId) {
    return pins.has(contactId)
  }

  function resize () {
    globe.width(container.clientWidth).height(container.clientHeight)
  }

  resize()
  if (typeof window !== 'undefined') window.addEventListener('resize', resize)

  return { setSelf, upsertContactPin, removeContactPin, hasPin, resize, globe, webgl: true }
}
