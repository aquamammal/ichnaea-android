// Shared per-country colors for "colored countries" surfaces. Both the 2D map
// renderer (src/map2d.js) and the 3D globe renderer (src/globe-renderer.js)
// use the same function so a country looks the same in every projection/style.
//
// Hue is hashed from the feature index — the bundled Natural Earth data has no
// properties. `dim` produces a darker, more saturated fill so borders stay
// readable. Stable across sessions: index-based, deterministic.

const countryColorCache = new Map()
export function countryColor (index, dim) {
  const key = dim ? 'd' + index : 'b' + index
  if (countryColorCache.has(key)) return countryColorCache.get(key)
  let h = 2654435761
  h = ((h * 33) + index * 2654435761) >>> 0
  const hue = h % 360
  const c = dim ? `hsl(${hue}, 65%, 42%)` : `hsl(${hue}, 62%, 52%)`
  countryColorCache.set(key, c)
  return c
}

// Feature -> color for every country in the bundled world data (stable order).
export function countryColors (features) {
  return features.map((f, i) => countryColor(i, false))
}
