import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { normalize, matchesCity, parseCities, searchCities } from '../src/cities.js'

// searchCities lazy-loads the data via fetch('./assets/cities-data.txt'), which
// only works in the WebView. Stub fetch for Node tests to read the local file.
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'cities-data.txt')
globalThis.fetch = (url) => {
  if (String(url).includes('cities-data.txt')) {
    const text = fs.readFileSync(DATA, 'utf8')
    return Promise.resolve({ ok: true, text: () => Promise.resolve(text) })
  }
  return Promise.reject(new Error('unexpected fetch: ' + url))
}

test('normalize: lowercases, trims, folds curly quotes', (t) => {
  t.is(normalize('  Tokyo '), 'tokyo')
  t.is(normalize('S\u00e3o Paulo'), 's\u00e3o paulo')
  t.is(normalize('Xi\u2019an'), "xi'an")
  t.is(normalize(''), '')
})

test('matchesCity: substring on primary or ASCII name', (t) => {
  const c = { nameL: 's\u00e3o paulo', asciiL: 'sao paulo' }
  t.ok(matchesCity(c, 'sao'))
  t.ok(matchesCity(c, 'paulo'))
  t.not(matchesCity(c, 'tokyo'))
  t.not(matchesCity(c, ''))
})

test('parseCities: parses the compact tab-separated format', (t) => {
  const text = [
    'Shanghai\t\t31.222\t121.458\tCN\t24874500',
    'Tokyo\tTokyo\t35.69\t139.69\tJP\t37400068',
    'bad-line-with-no-tabs',
    ''
  ].join('\n')
  const list = parseCities(text)
  t.is(list.length, 2)
  t.is(list[0].name, 'Shanghai')
  t.is(list[0].lat, 31.222)
  t.is(list[0].cc, 'CN')
  t.is(list[0].pop, 24874500)
  t.is(list[1].ascii, 'Tokyo')
})

test('the bundled cities data file exists and parses (dataset smoke test)', (t) => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'cities-data.txt')
  t.ok(fs.existsSync(file), 'cities-data.txt exists')
  const text = fs.readFileSync(file, 'utf8')
  const list = parseCities(text)
  t.ok(list.length > 60000, 'at least 60k cities parsed (' + list.length + ')')
  // Highest-population city is Shanghai (dataset is sorted by pop desc).
  t.is(list[0].name, 'Shanghai')
})

test('searchCities ranks by population (uses the bundled data)', async (t) => {
  const hits = await searchCities('tokyo')
  t.ok(hits.length >= 1)
  t.is(hits[0].name, 'Tokyo')
  t.is(hits[0].lat, 35.69)
  t.ok(hits[0].pop > 0)

  const san = await searchCities('san')
  t.ok(san.length > 0)
  // Highest-pop "san..." city should be near the top (San Francisco/San Diego).
  t.ok(san[0].pop >= 1000000)

  t.is((await searchCities('')).length, 0)
  t.is((await searchCities('zzzzzznomatch')).length, 0)
})
