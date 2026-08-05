// Renderer dispatcher. Reads the user's chosen map style (src/map-styles.js),
// then builds the appropriate renderer:
//   - globe styles  -> 3D WebGL globe (src/globe-renderer.js)
//   - map styles    -> 2D canvas map (src/map2d.js)
//
// Both renderers expose the same public interface:
//   { setSelf, upsertContactPin, removeContactPin, hasPin, setPinScale,
//     setGrayscale, resize, globe, webgl }
// so callers (src/main.js) never need to know which one they got.
//
// If a globe style is selected but WebGL is unavailable, we transparently fall
// back to the 2D world map so the app always renders something useful.
//
// Zero telemetry: every style derives its surface from the bundled Natural
// Earth data and the bundled Blue Marble texture — no CDN, no tile servers.

import { createGlobeRenderer } from './globe-renderer.js'
import { create2DRenderer } from './map2d.js'
import { getMapStyle } from './map-styles.js'

function webglAvailable () {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'))
  } catch {
    return false
  }
}

export function createRenderer (container, opts = {}) {
  const style = getMapStyle(opts.styleId)

  if (style.kind === 'globe') {
    if (!webglAvailable()) {
      console.warn('[renderer] WebGL unavailable — falling back to 2D map')
      return create2DRenderer(container, { ...opts, style: 'map' })
    }
    try {
      return createGlobeRenderer(container, { ...opts, style: style.id })
    } catch (err) {
      console.error('[renderer] 3D globe failed, falling back to 2D map:', err && err.message)
      return create2DRenderer(container, { ...opts, style: 'map' })
    }
  }

  // 2D map style.
  return create2DRenderer(container, { ...opts, style: style.id })
}
