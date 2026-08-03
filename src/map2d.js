// 2D canvas fallback map. Used when WebGL is unavailable (some Linux
// GPU/driver combos block context creation in the Pear/Electron window).
// Draws the same data the 3D globe would — self pin, contact pins, dotted
// arcs — on a plain 2D canvas using a simple equirectangular projection.
//
// Fully offline / zero-telemetry: the world outline is the bundled Natural
// Earth 110m countries data (public domain), imported as a module from
// src/assets/world.js — no runtime fetch, no map tiles, no CDN.
//
//   self pin     -> blue
//   active       -> green
//   stale        -> gray
//   (offline pins are removed by the caller, not rendered)

import WORLD from './assets/world.js'

const COLOR_SELF = '#3b9dff'
const COLOR_ACTIVE = '#3ddc84'
const COLOR_STALE = '#9aa4b0'

const COLOR_OCEAN = '#0a0e14'
const COLOR_LAND = '#1d2735'
const COLOR_LAND_STROKE = '#2c3a4d'
const COLOR_GRID = 'rgba(255,255,255,0.05)'

const HIT_RADIUS_PX = 10

export function create2DRenderer (container, { onPinClick } = {}) {
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;'
  container.style.position = 'relative'
  container.appendChild(canvas)
  const ctx = canvas.getContext('2d')

  const pins = new Map() // id -> { id, lat, lng, color, data }
  let selfLoc = null
  const world = WORLD // bundled Natural Earth FeatureCollection (no fetch needed)

  // View transform: the equirectangular world map is drawn into a rect of
  // `scale` pixels per degree, offset by (ox, oy). Fitted to the container.
  let scale = 1
  let ox = 0
  let oy = 0
  let userZoomed = false

  // --- projection -------------------------------------------------------------
  // Equirectangular (plate carrée): lng -> x linear, lat -> y linear (top = 90N).
  function project (lat, lng) {
    return { x: ox + (lng + 180) * scale, y: oy + (90 - lat) * scale }
  }

  // Logical (CSS-pixel) drawing dimensions, independent of layout timing.
  function dims () {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
    const w = canvas.width ? canvas.width / dpr : (canvas.clientWidth || 1)
    const h = canvas.height ? canvas.height / dpr : (canvas.clientHeight || 1)
    return { w, h }
  }

  function fitView () {
    // World spans 360 x 180 degrees; fit inside the canvas with a small margin.
    const { w, h } = dims()
    scale = Math.min(w / 360, h / 180) * 0.98
    ox = (w - 360 * scale) / 2
    oy = (h - 180 * scale) / 2
  }

  // --- drawing ----------------------------------------------------------------
  function draw () {
    if (!ctx) return
    const { w, h } = dims()
    ctx.clearRect(0, 0, w, h)

    // Ocean + graticule
    ctx.fillStyle = COLOR_OCEAN
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = COLOR_GRID
    ctx.lineWidth = 1
    for (let lng = -180; lng <= 180; lng += 30) {
      const a = project(-90, lng); const b = project(90, lng)
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const a = project(lat, -180); const b = project(lat, 180)
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
    }

    // Landmass (Natural Earth 110m countries)
    ctx.fillStyle = COLOR_LAND
    ctx.strokeStyle = COLOR_LAND_STROKE
    ctx.lineWidth = 1
    for (const f of world.features) {
      const g = f.geometry
      if (!g) continue
      if (g.type === 'Polygon') drawPolygon(g.coordinates)
      else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) drawPolygon(poly)
    }

    // Dotted arcs from self to each contact (straight lines in this projection).
    if (selfLoc) {
      const a = project(selfLoc.lat, selfLoc.lng)
      ctx.setLineDash([4, 5])
      ctx.lineWidth = 1.5
      for (const p of pins.values()) {
        if (p.id === 'self') continue
        const b = project(p.lat, p.lng)
        ctx.strokeStyle = p.color
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
      }
      ctx.setLineDash([])
    }

    // Pins (contacts first, self on top).
    const ordered = [...pins.values()].sort((a, b) => (a.id === 'self' ? 1 : 0) - (b.id === 'self' ? 1 : 0))
    for (const p of ordered) {
      const { x, y } = project(p.lat, p.lng)
      const r = p.id === 'self' ? 6 : 5
      ctx.beginPath(); ctx.arc(x, y, r + 2.5, 0, Math.PI * 2)
      ctx.fillStyle = p.color + '33'; ctx.fill() // soft halo
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle = p.color; ctx.fill()
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#05080d'; ctx.stroke()
    }
  }

  function drawPolygon (rings) {
    ctx.beginPath()
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const { x, y } = project(ring[i][1], ring[i][0])
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.closePath()
    }
    ctx.fill()
    ctx.stroke()
  }

  // --- hit testing --------------------------------------------------------------
  function pinAt (mx, my) {
    let best = null
    let bestD = HIT_RADIUS_PX
    for (const p of pins.values()) {
      const { x, y } = project(p.lat, p.lng)
      const d = Math.hypot(x - mx, y - my)
      if (d <= bestD) { best = p; bestD = d }
    }
    return best
  }

  function eventPos (e) {
    const r = canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  // --- interaction: click pins, drag-pan, wheel-zoom -----------------------------
  let drag = null // { x, y, ox, oy, moved }

  canvas.addEventListener('mousedown', (e) => {
    const p = eventPos(e)
    drag = { x: p.x, y: p.y, ox, oy, moved: false }
    canvas.style.cursor = 'grabbing'
  })
  if (typeof window !== 'undefined') {
    window.addEventListener('mousemove', (e) => {
      if (!drag) return
      const p = eventPos(e)
      const dx = p.x - drag.x
      const dy = p.y - drag.y
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
      ox = drag.ox + dx
      oy = drag.oy + dy
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
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    userZoomed = true
    const p = eventPos(e)
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    const ns = Math.min(Math.max(scale * factor, (canvas.clientWidth || 1) / 360 * 0.5), scale * 20)
    // Zoom around the cursor: keep the world point under the cursor fixed.
    ox = p.x - (p.x - ox) * (ns / scale)
    oy = p.y - (p.y - oy) * (ns / scale)
    scale = ns
    draw()
  }, { passive: false })

  // --- public API (same shape as the 3D renderer) --------------------------------
  function setSelf ({ lat, lng }) {
    selfLoc = { lat, lng }
    pins.set('self', { id: 'self', lat, lng, color: COLOR_SELF, data: { self: true, lat, lng } })
    draw()
  }

  // contact: { id, nickname, lastSeenTs, intervalMs }
  // loc: { lat, lng }  status: 'active' | 'stale'
  function upsertContactPin (contact, loc, status) {
    const color = status === 'stale' ? COLOR_STALE : COLOR_ACTIVE
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
    // #globe is position:fixed;inset:0 (viewport-sized). Read the viewport
    // directly so we never depend on layout timing (clientWidth/Height can be
    // 0 if resize() runs before first layout). Fall back to the container.
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 0
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 0
    const w = container.clientWidth || vw || 1
    const h = container.clientHeight || vh || 1
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    // Keep the CSS box in sync so clientWidth/Height match the backing store.
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (!userZoomed) fitView()
    draw()
  }

  resize()
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', resize)
    // Re-fit once layout has definitely happened (boot can run before first
    // paint, when clientWidth/Height may still be 0).
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { userZoomed = false; resize() })
    }
  }

  return { setSelf, upsertContactPin, removeContactPin, hasPin, resize, globe: null, webgl: false }
}
