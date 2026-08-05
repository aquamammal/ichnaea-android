// 2D canvas map renderer. Draws the same data the 3D globe would — self pin,
// contact pins, dotted arcs — on a plain 2D canvas, with a user-selectable
// projection (src/map-styles.js / renderer.js):
//   - map         : equirectangular centered on Taiwan (~121°E) — the default "Map"
//   - map-center  : equirectangular centered on the user's current check-in
//   - map-dymaxion: Buckminster Fuller's Airocean ("Dymaxion") projection
//
// Projections come from d3-geo + d3-geo-polygon (bundled locally — no runtime
// fetch, no map tiles, no CDN). The world outline is the bundled Natural Earth
// 110m countries data (public domain), imported as a module from
// src/assets/world.js.
//
//   self pin     -> blue
//   active       -> green
//   stale        -> gray
//   (offline pins are removed by the caller, not rendered)

import WORLD from './assets/world.js'
import { geoEquirectangular, geoPath, geoGraticule10 } from 'd3-geo'
import { geoAirocean } from 'd3-geo-polygon'
import { countryColors } from './country-colors.js'

const COLOR_SELF = '#3b9dff'
const COLOR_ACTIVE = '#3ddc84'
const COLOR_STALE = '#9aa4b0'

const COLOR_OCEAN = '#0a0e14'
const COLOR_LAND = '#1d2735'
const COLOR_LAND_STROKE = '#2c3a4d'
const COLOR_GRID = 'rgba(255,255,255,0.05)'

// Colored-countries mode fills each country with its own hue (see
// country-colors.js) and keeps the dark ocean + subtle borders.
const COUNTRY_FILLS = countryColors(WORLD.features)

const HIT_RADIUS_PX = 10

function contactColor (id, dim) {
  let h = 2165387
  for (let i = 0; i < id.length; i++) h = ((h * 31) + id.charCodeAt(i)) >>> 0
  const hue = h % 360
  return dim ? `hsla(${hue}, 60%, 45%, 0.55)` : `hsl(${hue}, 75%, 58%)`
}

// Build the d3 projection for a given 2D style id. `center` ({lat,lng}) is used
// by the self-centered style so the projection pivots on the user's location.
function makeProjection (styleId, width, height, center) {
  const sphere = { type: 'Sphere' }
  let proj
  if (styleId === 'map-dymaxion') {
    proj = geoAirocean()
  } else if (styleId === 'map-center' && center) {
    proj = geoEquirectangular().rotate([-center.lng, -center.lat])
  } else {
    // Default "Map" — centered on Taiwan (~121°E, ~23.5°N).
    proj = geoEquirectangular().rotate([-121, -23.5])
  }
  return proj.fitSize([width, height], sphere)
}

export function create2DRenderer (container, { onPinClick, style, colored, showArcs = true } = {}) {
  const styleId = style || 'map'
  let coloredMode = Boolean(colored)
  let arcsOn = Boolean(showArcs)
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;'
  container.style.position = 'relative'
  container.appendChild(canvas)
  const ctx = canvas.getContext('2d')

  const pins = new Map() // id -> { id, lat, lng, color, data }
  let selfLoc = null
  let pinScale = 1
  const graticule = geoGraticule10()

  let proj = null
  let path = null
  let baseScale = 1
  let baseTranslate = [0, 0]
  // Cached, resolution-independent base-projection shapes (land + graticule).
  // Rebuilding geoPath for all 177 countries every frame is slow (Airocean
  // clips each polygon into many pieces) — that's what made Dymaxion choppy.
  // We render them once per fit, then on each frame only apply the affine
  // zoom/pan transform. Falls back to live re-projection when Path2D is absent.
  const canCache = typeof Path2D === 'function'
  let landPath = null
  let gridPath = null
  let countryPaths = null // per-country Path2D for colored mode (fit-time cache)
  // Interactive view: zoom is a relative multiplier on baseScale; panX/panY are
  // pixel offsets added to the projection's translate.
  let zoom = 1
  let panX = 0
  let panY = 0
  let userZoomed = false

  // Logical (CSS-pixel) drawing dimensions, independent of layout timing.
  function dims () {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
    const w = canvas.width ? canvas.width / dpr : (canvas.clientWidth || 1)
    const h = canvas.height ? canvas.height / dpr : (canvas.clientHeight || 1)
    return { w, h }
  }

  function applyView () {
    proj.scale(baseScale * zoom)
    proj.translate([baseTranslate[0] + panX, baseTranslate[1] + panY])
  }

  function fitView (center) {
    const { w, h } = dims()
    const sphere = { type: 'Sphere' }
    proj = makeProjection(styleId, w, h, center)
    path = geoPath(proj, ctx)
    baseScale = proj.scale()
    baseTranslate = proj.translate()
    zoom = 1
    panX = 0
    panY = 0
    applyView()

    // Cache base-projection shapes so per-frame redraw is just an affine blit.
    if (canCache) {
      try {
        const gen = geoPath(proj) // string generator (no ctx)
        gridPath = new Path2D(gen(graticule))
        landPath = new Path2D()
        countryPaths = WORLD.features.map((f) => {
          const p = new Path2D(gen(f.geometry))
          landPath.addPath(p)
          return p
        })
      } catch (err) {
        // Some WebViews lack Path2D.addPath or throw on huge strings — degrade
        // gracefully to per-frame re-projection.
        console.warn('[map] Path2D cache failed, falling back to re-projection:', err && err.message)
        landPath = null
        gridPath = null
        countryPaths = null
      }
    }
  }

  // Project a lat/lng to screen pixel, or null if the projection clips it out.
  function project (lat, lng) {
    const p = proj([lng, lat])
    if (!p || !isFinite(p[0]) || !isFinite(p[1])) return null
    return { x: p[0], y: p[1] }
  }

  // Draw the cached base-projection land + graticule, transformed to the current
  // zoom/pan. Base pixel b maps to screen as zoom*b + pan + (1-zoom)*baseTranslate,
  // i.e. translate then scale.
  function drawBaseShapes () {
    const tx = panX + (1 - zoom) * baseTranslate[0]
    const ty = panY + (1 - zoom) * baseTranslate[1]
    ctx.save()
    ctx.translate(tx, ty)
    ctx.scale(zoom, zoom)
    // Graticule
    ctx.strokeStyle = COLOR_GRID
    ctx.lineWidth = 1 / zoom
    ctx.stroke(gridPath)
    if (coloredMode && countryPaths) {
      // Each country filled with its own hue (colored-countries mode).
      countryPaths.forEach((p, i) => {
        ctx.fillStyle = COUNTRY_FILLS[i]
        ctx.fill(p, 'evenodd')
      })
      ctx.strokeStyle = 'rgba(5,15,30,0.4)'
    } else {
      ctx.fillStyle = COLOR_LAND
      ctx.fill(landPath, 'evenodd')
      ctx.strokeStyle = COLOR_LAND_STROKE
    }
    ctx.lineWidth = 1 / zoom
    ctx.stroke(landPath)
    ctx.restore()
  }

  // Fallback: re-project the world every frame (used when Path2D is unavailable).
  function drawBaseShapesLive () {
    ctx.strokeStyle = COLOR_GRID
    ctx.lineWidth = 1
    ctx.beginPath()
    path(graticule)
    ctx.stroke()

    if (coloredMode) {
      WORLD.features.forEach((f, i) => {
        ctx.beginPath()
        path(f.geometry)
        ctx.fillStyle = COUNTRY_FILLS[i]
        ctx.fill('evenodd')
      })
      ctx.strokeStyle = 'rgba(5,15,30,0.4)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (const f of WORLD.features) { if (f.geometry) path(f.geometry) }
      ctx.stroke()
    } else {
      ctx.fillStyle = COLOR_LAND
      ctx.strokeStyle = COLOR_LAND_STROKE
      ctx.lineWidth = 1
      ctx.beginPath()
      for (const f of WORLD.features) {
        const g = f.geometry
        if (!g) continue
        path(g)
      }
      ctx.fill('evenodd')
      ctx.stroke()
    }
  }

  // --- drawing ----------------------------------------------------------------
  function draw () {
    if (!ctx) return
    const { w, h } = dims()
    ctx.clearRect(0, 0, w, h)

    // Ocean + landmass + graticule
    ctx.fillStyle = COLOR_OCEAN
    ctx.fillRect(0, 0, w, h)
    if (canCache && landPath && gridPath) drawBaseShapes()
    else drawBaseShapesLive()

    // Dotted arcs from self to each contact (straight lines in this projection).
    if (arcsOn && selfLoc) {
      const a = project(selfLoc.lat, selfLoc.lng)
      if (a) {
        ctx.setLineDash([4, 5])
        ctx.lineWidth = 1.5
        for (const p of pins.values()) {
          if (p.id === 'self') continue
          const b = project(p.lat, p.lng)
          if (!b) continue
          ctx.strokeStyle = p.color
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
        }
        ctx.setLineDash([])
      }
    }

    // Pins (contacts first, self on top).
    const ordered = [...pins.values()].sort((a, b) => (a.id === 'self' ? 1 : 0) - (b.id === 'self' ? 1 : 0))
    for (const p of ordered) {
      const pt = project(p.lat, p.lng)
      if (!pt) continue
      const r = (p.id === 'self' ? 6 : 5) * pinScale
      ctx.beginPath(); ctx.arc(pt.x, pt.y, r + 2.5, 0, Math.PI * 2)
      ctx.fillStyle = p.color + '33'; ctx.fill() // soft halo
      ctx.beginPath(); ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
      ctx.fillStyle = p.color; ctx.fill()
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#05080d'; ctx.stroke()
    }
  }

  // --- hit testing --------------------------------------------------------------
  function pinAt (mx, my) {
    let best = null
    let bestD = HIT_RADIUS_PX
    for (const p of pins.values()) {
      const pt = project(p.lat, p.lng)
      if (!pt) continue
      const d = Math.hypot(pt.x - mx, pt.y - my)
      if (d <= bestD) { best = p; bestD = d }
    }
    return best
  }

  // --- interaction: click pins, drag-pan, pinch/wheel-zoom ---------------------
  let drag = null // { x, y, panX, panY, moved }
  let pinch = null // { dist, midX, midY, zoom, panX, panY }

  function eventPos (e) {
    const r = canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function touchPos (e) {
    const r = canvas.getBoundingClientRect()
    const t = e.touches ? e.touches[0] : e.changedTouches[0]
    return t ? { x: t.clientX - r.left, y: t.clientY - r.top } : null
  }

  function pinchInfo (e) {
    const r = canvas.getBoundingClientRect()
    const a = e.touches[0]
    const b = e.touches[1]
    return {
      dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      midX: (a.clientX + b.clientX) / 2 - r.left,
      midY: (a.clientY + b.clientY) / 2 - r.top
    }
  }

  const clampZoom = (z) => Math.min(Math.max(z, 0.5), 40)

  function zoomAt (px, py, nzoom) {
    const before = proj.invert([px, py]) // geographic point under the cursor
    zoom = clampZoom(nzoom)
    applyView()
    if (before) {
      const after = proj(before)
      // Shift the view so the same geographic point stays under the cursor.
      panX += px - after[0]
      panY += py - after[1]
      applyView()
    }
    userZoomed = true
    draw()
  }

  canvas.addEventListener('mousedown', (e) => {
    const p = eventPos(e)
    drag = { x: p.x, y: p.y, panX, panY, moved: false }
    canvas.style.cursor = 'grabbing'
  })
  // Touch: drag-pan with one finger, pinch-zoom with two.
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      e.preventDefault()
      const p = pinchInfo(e)
      pinch = { dist: p.dist, midX: p.midX, midY: p.midY, zoom, panX, panY }
      drag = null
      return
    }
    if (e.touches.length !== 1) return
    e.preventDefault()
    const p = touchPos(e)
    if (p) drag = { x: p.x, y: p.y, panX, panY, moved: false }
  }, { passive: false })
  canvas.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault()
      const p = pinchInfo(e)
      const factor = p.dist / pinch.dist
      zoomAt(p.midX, p.midY, pinch.zoom * factor)
      return
    }
    if (!drag || e.touches.length !== 1) return
    e.preventDefault()
    const p = touchPos(e)
    if (!p) return
    const dx = p.x - drag.x
    const dy = p.y - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
    panX = drag.panX + dx
    panY = drag.panY + dy
    userZoomed = true
    applyView()
    draw()
  }, { passive: false })
  if (typeof window !== 'undefined') {
    window.addEventListener('mousemove', (e) => {
      if (!drag) return
      const p = eventPos(e)
      const dx = p.x - drag.x
      const dy = p.y - drag.y
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
      panX = drag.panX + dx
      panY = drag.panY + dy
      userZoomed = true
      applyView()
      draw()
    })
    window.addEventListener('mouseup', (e) => {
      if (!drag) return
      const wasDrag = drag.moved
      drag = null
      canvas.style.cursor = 'grab'
      if (wasDrag) return
      const p = eventPos(e)
      const pin = pinAt(p.x, p.y)
      if (pin && onPinClick) onPinClick(pin.data)
    })
  }
  canvas.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinch = null
    if (!drag) return
    const wasDrag = drag.moved
    drag = null
    if (wasDrag) return
    const p = touchPos(e)
    if (!p) return
    const pin = pinAt(p.x, p.y)
    if (pin && onPinClick) onPinClick(pin.data)
  }, { passive: true })
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const p = eventPos(e)
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    zoomAt(p.x, p.y, zoom * factor)
  }, { passive: false })

  // --- public API (same shape as the 3D renderer) --------------------------------
  function setSelf ({ lat, lng }) {
    selfLoc = { lat, lng }
    // For the self-centered style, recenter the projection on the new location.
    if (styleId === 'map-center') {
      fitView(selfLoc)
    }
    pins.set('self', { id: 'self', lat, lng, color: COLOR_SELF, data: { self: true, lat, lng } })
    draw()
  }

  // contact: { id, nickname, lastSeenTs, intervalMs }
  // loc: { lat, lng }  status: 'active' | 'stale'
  function upsertContactPin (contact, loc, status) {
    if (!loc || !isFinite(loc.lat) || !isFinite(loc.lng)) return // no coords yet
    const color = String(contactColor(contact.id, status === 'stale'))
    pins.set(contact.id, {
      id: contact.id, lat: loc.lat, lng: loc.lng, color,
      data: { self: false, contact, lat: loc.lat, lng: loc.lng, status }
    })
    draw()
  }

  function removeContactPin (contactId) {
    if (pins.delete(contactId)) draw()
  }

  function hasPin (contactId) {
    return pins.has(contactId)
  }

  function resize () {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 0
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 0
    const w = container.clientWidth || vw || 1
    const h = container.clientHeight || vh || 1
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (!userZoomed) fitView()
    draw()
  }

  resize()
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', resize)
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { userZoomed = false; resize() })
    }
  }

  function setPinScale (scale) {
    pinScale = Math.max(0.2, Math.min(20, Number(scale) || 1))
    draw()
  }

  function setGrayscale (on) {
    canvas.style.filter = on ? 'grayscale(1)' : ''
  }

  // Live toggle for colored-countries mode (no rebuild — just redraw).
  function setColored (on) {
    coloredMode = Boolean(on)
    draw()
  }

  // Live toggle for the dotted connecting lines (arcs).
  function setArcs (on) {
    arcsOn = Boolean(on)
    draw()
  }

  // Center the map on a location (used when a contact pin is clicked). Pans so
  // the point sits at the viewport center, preserving the current zoom.
  function centerOn (lat, lng) {
    const pt = project(lat, lng)
    if (!pt) return
    const { w, h } = dims()
    const dx = (w / 2) - pt.x
    const dy = (h / 2) - pt.y
    panX += dx
    panY += dy
    applyView()
    draw()
  }

  return { setSelf, upsertContactPin, removeContactPin, hasPin, setPinScale, setGrayscale, setColored, setArcs, centerOn, resize, globe: null, webgl: false }
}
