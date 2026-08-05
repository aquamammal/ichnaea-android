import Globe from 'globe.gl'
import * as THREE from 'three'
import WORLD from './assets/world.js'
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
    const N = 32
    for (let i = 0; i <= N; i++) {
      const t = i / N
      let r
      if (t < 0.7) r = 0.62 * Math.pow(t / 0.7, 1.4) // point widening to the bulb
      else r = 0.62 * Math.pow(Math.max(1 - (t - 0.7) / 0.3, 0), 1.1) // dome closing at the top
      pts.push(new THREE.Vector2(Math.max(r, 0.015), t))
    }
    teardropGeo = new THREE.LatheGeometry(pts, 24)
    teardropGeo.rotateX(-Math.PI / 2) // height axis Y -> -Z (outward from the globe surface)
  }
  return teardropGeo
}

// Stable per-contact color (hue hashed from the contact id) so each contact
// keeps its own color across sessions. `dim` produces a faded variant for stale pins.
function contactColor (id, dim) {
  let h = 2165387
  for (let i = 0; i < id.length; i++) h = ((h * 31) + id.charCodeAt(i)) >>> 0
  const hue = h % 360
  return dim ? `hsla(${hue}, 60%, 45%, 0.5)` : `hsl(${hue}, 75%, 62%)`
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
      .polygonsData(WORLD.features)
      .polygonCapColor(() => 'rgba(0,0,0,0)')
      .polygonSideColor(() => 'rgba(0,0,0,0)')
      .polygonStrokeColor(() => 'rgba(148,163,184,0.5)')
      .polygonAltitude(0.001)
      .onPointClick((pt) => { if (onPinClick && pt && pt.data) onPinClick(pt.data) })
  } catch (err) {
    // THREE.WebGLRenderer throws when the WebGL context can't be created even
    // though the pre-check passed — fall back to the 2D canvas map.
    console.error('[globe] 3D init failed:', err && err.message)
    return create2DRenderer(container, { onPinClick })
  }

  // Plain dark sphere + country borders drawn as lines (Natural Earth 110m,
  // bundled locally — no network calls). Pins stay colored on top.
  try {
    const mat = globe.globeMaterial()
    if (mat) mat.color = new THREE.Color('#0a1a2e')
  } catch { /* non-fatal */ }

  const pins = new Map() // id -> { id, lat, lng, alt, color, size, data }
  let selfLoc = null
  let pinScale = 1
  let refAlt = null // camera altitude at which pins have their base size
  let lastAlt = null
  const GLOBE_RADIUS = 100 // matches three-globe's internal radius
  const PX_PER_DEG = 2 * Math.PI * GLOBE_RADIUS / 360

  // Camera counter-scale: as the globe zooms, keep pins a constant screen size.
  function currentK () {
    try {
      const pov = globe.pointOfView()
      const alt = pov && pov.altitude ? pov.altitude : 2.5
      if (refAlt === null) { refAlt = alt; return 1 }
      return alt / refAlt
    } catch { return 1 }
  }

  // Recompute each point mesh's world scale directly from its pin data (size =
  // width, alt = height) times the camera counter-scale k. No cached base scale,
  // so the slider and zoom never fight or leave stale scales.
  function applyPinScales () {
    const k = currentK()
    try {
      globe.scene().traverse((obj) => {
        if (obj.__globeObjType === 'point' && obj.__data) {
          const d = obj.__data
          obj.scale.x = obj.scale.y = (d.size || 0.3) * PX_PER_DEG * k
          obj.scale.z = Math.max((d.alt || 0.025) * GLOBE_RADIUS, 0.1) * k
        }
      })
    } catch { /* non-fatal */ }
  }

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
      applyPinScales()
    } catch { /* non-fatal */ }
  }

  // The points layer renders its meshes on the frame loop, so swap the geometry
  // after a few ticks (idempotent — only replaces meshes still using the
  // default cylinder).
  function scheduleShapeSwap () {
    for (const ms of [0, 100, 300, 900, 2000]) setTimeout(applyPointShapes, ms)
  }

  function sync () {
    globe.pointsData([...pins.values()])
    applyPinScales() // meshes exist after the synchronous digest — set scale now
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

  // Bring the globe's camera around to the self pin so it's actually visible
  // (the default view faces the Atlantic). Smooth transition so it doesn't jump.
  function centerOnSelf (lat, lng) {
    try {
      const pov = globe.pointOfView()
      globe.pointOfView({ lat, lng, altitude: (pov && pov.altitude) || 2.5 }, 1200)
    } catch { /* non-fatal */ }
  }

  function setSelf ({ lat, lng }) {
    selfLoc = { lat, lng }
    pins.set('self', {
      id: 'self', lat, lng, alt: 0.03 * pinScale, color: COLOR_SELF, baseSize: 0.5, baseAlt: 0.03,
      size: 0.5 * pinScale, data: { self: true, lat, lng }
    })
    sync()
    centerOnSelf(lat, lng)
  }

  // contact: { id, nickname, lastSeenTs, intervalMs }
  // loc: { lat, lng }  status: 'active' | 'stale'
  function upsertContactPin (contact, loc, status) {
    const color = contactColor(contact.id, status === 'stale')
    pins.set(contact.id, {
      id: contact.id, lat: loc.lat, lng: loc.lng, alt: 0.025 * pinScale, color, baseSize: 0.42, baseAlt: 0.025,
      size: 0.42 * pinScale, data: { self: false, contact, lat: loc.lat, lng: loc.lng, status }
    })
    sync()
  }

  // Rescale every pin (0.2x..3x) and re-render.
  function setPinScale (scale) {
    pinScale = Math.max(0.2, Math.min(20, Number(scale) || 1))
    for (const p of pins.values()) {
      p.size = (p.baseSize || 0.3) * pinScale
      p.alt = (p.baseAlt || 0.025) * pinScale
    }
    sync()
  }

  // Toggle the globe surface to grayscale. Pins keep their color (only the
  // earth texture is desaturated) so per-contact colors stay meaningful.
  function setGrayscale (on) {
    try {
      const mat = globe.globeMaterial()
      if (!mat || !mat.map) return
      if (on) {
        if (!grayMap) {
          const img = mat.map.image
          if (!img) return
          const canvas = document.createElement('canvas')
          const c2 = canvas.getContext('2d')
          canvas.width = img.width || 1024
          canvas.height = img.height || 512
          c2.drawImage(img, 0, 0, canvas.width, canvas.height)
          const id = c2.getImageData(0, 0, canvas.width, canvas.height)
          const d = id.data
          for (let i = 0; i < d.length; i += 4) {
            const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0
            d[i] = d[i + 1] = d[i + 2] = g
          }
          c2.putImageData(id, 0, 0)
          grayMap = new THREE.CanvasTexture(canvas)
          grayMap.colorSpace = mat.map.colorSpace || THREE.SRGBColorSpace
        }
        if (!originalMap) originalMap = mat.map
        mat.map = grayMap
      } else if (originalMap) {
        mat.map = originalMap
      }
      mat.needsUpdate = true
    } catch { /* non-fatal */ }
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

  // Keep pins a constant on-screen size regardless of globe zoom.
  const tick = () => {
    try {
      const pov = globe.pointOfView()
      const alt = pov && pov.altitude ? pov.altitude : null
      if (alt && alt !== lastAlt) {
        lastAlt = alt
        if (refAlt === null) refAlt = alt
        else applyPinScales()
      }
    } catch { /* non-fatal */ }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  return { setSelf, upsertContactPin, removeContactPin, hasPin, setPinScale, setGrayscale, resize, globe, webgl: true }
}
