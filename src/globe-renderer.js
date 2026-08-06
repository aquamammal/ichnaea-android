import Globe from 'globe.gl'
import * as THREE from 'three'
import WORLD from './assets/world.js'
import { countryColors } from './country-colors.js'

// 3D WebGL globe renderer. Callers (the dispatcher in src/renderer.js) choose
// a map style first (src/map-styles.js) and pass a 3D style id here:
//   - globe-wireframe   : plain dark sphere + country border lines
//   - globe-texture     : full-color Blue Marble earth
//   - globe-countries   : distinct country fills over blue water
// It throws 'webgl-unavailable' when WebGL can't be created so the dispatcher
// can fall back to the 2D map renderer (src/map2d.js). Both renderers expose
// the same interface, so callers need no changes:
//
//   { setSelf, upsertContactPin, removeContactPin, hasPin, resize, globe, webgl }
//
//   self pin     -> blue
//   active       -> green
//   stale        -> yellow
//   offline      -> red (pin is KEPT and tinted red — not removed, so the last
//                   known position stays visible as it ages)
//
// Zero telemetry: the 3D earth texture and the world outline are bundled
// locally under src/assets/ — no CDN, no map-tile servers.

const COLOR_SELF = '#3b9dff'
const COLOR_ACTIVE = '#3ddc84'
const COLOR_STALE = '#ffd54a'
const COLOR_OFFLINE = '#ff5252'

function webglAvailable () {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'))
  } catch {
    return false
  }
}

// Renderer selection used to live here (wants3D / ?globe=3d / localStorage
// 'globe'). Selection now happens in the dispatcher (renderer.js) which reads
// the user's chosen map style from src/map-styles.js. Both renderers expose
// the same interface, so callers need no changes.

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
// Contact pin color by staleness status: fresh = green, stale = yellow,
// offline (old) = red. Arcs reuse the pin color, so the connecting lines carry
// the same status signal.
function contactColor (status) {
  if (status === 'offline') return COLOR_OFFLINE
  if (status === 'stale') return COLOR_STALE
  return COLOR_ACTIVE
}

// Pre-build feature -> index lookups once (features are stable module data).
const featureIndex = new Map()
WORLD.features.forEach((f, i) => featureIndex.set(f, i))

// Shared per-country palette (matches the 2D map renderer).
const COUNTRY_FILLS = countryColors(WORLD.features)

// A per-country fill color accessor that three-globe calls with each feature.
const countryCapColor = (d) => {
  const i = featureIndex.get(d)
  return COUNTRY_FILLS[typeof i === 'number' ? i : 0]
}

export function createGlobeRenderer (container, { onPinClick, style, colored, showArcs = true } = {}) {
  // 3D globe only. Map styles and WebGL unavailability are handled by the
  // dispatcher / fallback in the caller.
  if (!webglAvailable()) throw new Error('webgl-unavailable')

  const isTexture = style === 'globe-texture'
  const isCountries = style === 'globe-countries'
  const isWireframe = !isTexture && !isCountries
  let coloredMode = Boolean(colored)
  let arcsOn = Boolean(showArcs)

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
      .polygonAltitude(0.001)
      .onPointClick((pt) => { if (onPinClick && pt && pt.data) onPinClick(pt.data) })
  } catch (err) {
    // THREE.WebGLRenderer throws when the WebGL context can't be created even
    // though the pre-check passed.
    console.error('[globe] 3D init failed:', err && err.message)
    throw err
  }

  // Configure the earth surface. `colored` overlays the shared country palette
  // on top of ANY style (wireframe, texture, or the countries style itself),
  // live — the toggle calls setColored() and this re-applies in place.
  function applySurface (colored) {
    if (colored) {
      // Colored-countries overlay: each country filled with its own hue over
      // blue water, side walls matching the fill (no transparent seams), plates
      // raised so they sit clearly above the sphere.
      globe
        .polygonAltitude(0.004)
        .polygonCapColor(countryCapColor)
        .polygonSideColor(countryCapColor)
        .polygonStrokeColor(() => 'rgba(5,15,30,0.4)')
      try {
        const mat = globe.globeMaterial()
        if (mat) {
          mat.color = new THREE.Color('#123c6b') // blue water under the countries
          mat.needsUpdate = true
        }
      } catch { /* non-fatal */ }
      return
    }
    // Base style surface.
    if (isTexture) {
      // Full-color Blue Marble earth (bundled locally — no network calls).
      globe.globeImageUrl('./assets/earth-blue-marble.jpg')
      globe
        .polygonCapColor(() => 'rgba(0,0,0,0)')
        .polygonSideColor(() => 'rgba(0,0,0,0)')
        .polygonStrokeColor(() => 'rgba(255,255,255,0.18)')
    } else if (isCountries) {
      // Distinct country fills on a blue-ocean sphere for legibility.
      globe
        .polygonAltitude(0.004)
        .polygonCapColor(countryCapColor)
        .polygonSideColor(countryCapColor)
        .polygonStrokeColor(() => 'rgba(5,15,30,0.4)')
    } else {
      // Wireframe: transparent countries, borders drawn as lines.
      globe
        .polygonAltitude(0.001)
        .polygonCapColor(() => 'rgba(0,0,0,0)')
        .polygonSideColor(() => 'rgba(0,0,0,0)')
        .polygonStrokeColor(() => 'rgba(148,163,184,0.5)')
    }
    // Configure the earth material per base style.
    try {
      const mat = globe.globeMaterial()
      if (mat) {
        if (isTexture) {
          mat.color = new THREE.Color('#ffffff') // let the texture show
        } else if (isCountries) {
          mat.color = new THREE.Color('#123c6b') // blue water under the countries
        } else {
          mat.color = new THREE.Color('#0a1a2e') // dark sphere + border lines
        }
        mat.needsUpdate = true
      }
    } catch { /* non-fatal */ }
  }

  applySurface(coloredMode)

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
    if (!arcsOn || !selfLoc || !isFinite(selfLoc.lat) || !isFinite(selfLoc.lng)) { globe.arcsData([]); return }
    const arcs = []
    for (const p of pins.values()) {
      if (p.id === 'self') continue
      // Guard against contacts without coords (e.g. a STALE sweep on a contact
      // that never checked in): an undefined endLat/endLng can break three-globe's
      // arc color interpolation and throw "str.trim is not a function".
      if (!isFinite(p.lat) || !isFinite(p.lng)) continue
      const c = String(p.color || COLOR_STALE)
      arcs.push({
        startLat: selfLoc.lat,
        startLng: selfLoc.lng,
        endLat: p.lat,
        endLng: p.lng,
        // Flat color gradient (three-globe interpolates between the two stops).
        // A nested [[a,b],[a,b]] makes d3 return an array and color2ShaderArr
        // crashes with "str.trim is not a function".
        color: [COLOR_SELF, c]
      })
    }
    globe.arcsData(arcs)
  }

  // Bring the globe's camera around to a location so it's visible. Smooth
  // transition so it doesn't jump. Used to center on a clicked contact.
  function centerOn (lat, lng) {
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
    centerOn(lat, lng)
  }

  // contact: { id, nickname, lastSeenTs, intervalMs }
  // loc: { lat, lng }  status: 'active' | 'stale' | 'offline'
  function upsertContactPin (contact, loc, status) {
    if (!loc || !isFinite(loc.lat) || !isFinite(loc.lng)) return // no coords yet
    const color = String(contactColor(status))
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

  // Live toggle for colored-countries mode (re-applies the surface in place).
  function setColored (on) {
    coloredMode = Boolean(on)
    applySurface(coloredMode)
  }

  // Live toggle for the dotted connecting lines (arcs).
  function setArcs (on) {
    arcsOn = Boolean(on)
    syncArcs()
  }

  return { setSelf, upsertContactPin, removeContactPin, hasPin, setPinScale, setGrayscale, setColored, setArcs, centerOn, resize, globe, webgl: true }
}
