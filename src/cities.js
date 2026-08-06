// City search for the no-GPS fallback. Loads a compact GeoNames cities5000
// dataset (src/assets/cities-data.txt, ~68k cities) on first use and finds
// cities by name / ASCII name, ranking by population. Renderer-safe (no Node
// builtins); the data file is fetched lazily so it never bloats the JS bundle.
// Pure helpers (normalize / matchesCity / parseCities) are unit-testable.

let cache = null // parsed records, ordered by population desc

export function normalize (q) {
  return String(q || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").trim()
}

// Substring match on the city's primary or ASCII name (pre-lowercased).
export function matchesCity (c, q) {
  if (!q) return false
  return c.nameL.includes(q) || c.asciiL.includes(q)
}

// Parse the tab-separated data text into records. Sorted by population desc so
// the first matches in a scan are the most populous.
export function parseCities (text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const p = line.split('\t')
    if (p.length < 6) continue
    const lat = parseFloat(p[2])
    const lng = parseFloat(p[3])
    if (!isFinite(lat) || !isFinite(lng)) continue
    const name = p[0]
    const ascii = p[1] || name
    out.push({
      name,
      ascii,
      lat,
      lng,
      cc: p[4],
      pop: parseInt(p[5], 10) || 0,
      nameL: name.toLowerCase(),
      asciiL: ascii.toLowerCase()
    })
  }
  return out
}

const DATA_URL = './assets/cities-data.txt'

let loading = null

export function loadCities () {
  if (cache) return Promise.resolve(cache)
  if (loading) return loading
  loading = fetch(DATA_URL)
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.text()
    })
    .then((text) => {
      cache = parseCities(text)
      return cache
    })
    .finally(() => { loading = null })
  return loading
}

// Search cities by name, returning the top `limit` by population:
// [{ name, ascii, lat, lng, cc, pop }]. Empty/whitespace query returns [].
export async function searchCities (query, limit = 10) {
  const q = normalize(query)
  if (!q) return []
  const list = await loadCities()
  const out = []
  for (const c of list) {
    if (matchesCity(c, q)) {
      out.push({ name: c.name, ascii: c.ascii, lat: c.lat, lng: c.lng, cc: c.cc, pop: c.pop })
      if (out.length >= limit) break
    }
  }
  return out
}
