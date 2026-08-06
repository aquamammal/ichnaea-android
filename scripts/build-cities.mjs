// Build src/assets/cities-data.txt from the GeoNames cities5000.txt TSV.
// Usage: node scripts/build-cities.mjs <cities5000.txt>
// Output: one city per line, tab-separated, ordered by population desc:
//   name \t asciiname \t lat \t lng \t countryCode \t population
//   (asciiname is blank when it equals the name; coords rounded to 3 decimals
//   ≈ 111 m, city-level precision is plenty)
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = process.argv[2]
if (!src) throw new Error('usage: node scripts/build-cities.mjs <cities5000.txt>')
const out = join(root, 'cities-data.txt')

const rows = []
for (const line of readFileSync(src, 'utf8').split('\n')) {
  const p = line.split('\t')
  if (p.length < 10) continue
  const pop = parseInt(p[14], 10) || 0
  if (pop < 5000) continue // cities5000 = cities with population > 5000
  const lat = Math.round(parseFloat(p[4]) * 1000) / 1000
  const lng = Math.round(parseFloat(p[5]) * 1000) / 1000
  if (!isFinite(lat) || !isFinite(lng)) continue
  const name = (p[1] || '').trim()
  const ascii = (p[2] || '').trim() || name
  rows.push({ name, ascii, lat, lng, cc: (p[8] || '').toUpperCase(), pop })
}
rows.sort((a, b) => b.pop - a.pop)

const lines = rows.map((r) => [r.name, r.ascii === r.name ? '' : r.ascii, r.lat, r.lng, r.cc, r.pop].join('\t'))
writeFileSync(out, lines.join('\n') + '\n')
console.log(`wrote ${out}: ${rows.length} cities, ${(readFileSync(out).length / 1048576).toFixed(2)} MB`)
