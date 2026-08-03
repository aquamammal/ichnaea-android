import test from 'brittle'
import { classify, humanize, formatLocal, STATUS } from '../src/staleness.js'

const HOUR = 3600000
const DAY = 86400000

test('classify: never when no check-in', (t) => {
  t.is(classify(0, DAY), STATUS.NEVER)
  t.is(classify(null, DAY), STATUS.NEVER)
})

test('classify: active within 2x interval', (t) => {
  const now = 1000000000
  t.is(classify(now - 1 * DAY, DAY, now), STATUS.ACTIVE)
  t.is(classify(now - (2 * DAY - 1), DAY, now), STATUS.ACTIVE) // just under 2x
})

test('classify: stale between 2x and 4x', (t) => {
  const now = 1000000000
  t.is(classify(now - 2 * DAY, DAY, now), STATUS.STALE) // exactly 2x
  t.is(classify(now - 3 * DAY, DAY, now), STATUS.STALE)
  t.is(classify(now - (4 * DAY - 1), DAY, now), STATUS.STALE) // just under 4x
})

test('classify: offline at/after 4x', (t) => {
  const now = 1000000000
  t.is(classify(now - 4 * DAY, DAY, now), STATUS.OFFLINE)
  t.is(classify(now - 10 * DAY, DAY, now), STATUS.OFFLINE)
})

test('classify respects the contact interval, not a fixed one', (t) => {
  const now = 1000000000
  // 1-hour interval contact: 3 hours old = 3x => stale
  t.is(classify(now - 3 * HOUR, HOUR, now), STATUS.STALE)
  // 1-week interval contact: 3 days old is well within 2x => active
  t.is(classify(now - 3 * DAY, 7 * DAY, now), STATUS.ACTIVE)
})

test('classify falls back to 1 day when interval unknown', (t) => {
  const now = 1000000000
  t.is(classify(now - 1 * DAY, null, now), STATUS.ACTIVE)
  t.is(classify(now - 5 * DAY, null, now), STATUS.OFFLINE)
})

test('humanize: never and just now', (t) => {
  t.is(humanize(0), 'never')
  const now = 1000000000
  t.is(humanize(now - 5000, now), 'just now')
})

test('humanize: minutes, hours, days, weeks', (t) => {
  const now = 100 * DAY // large enough that subtracting weeks stays positive
  t.is(humanize(now - 5 * 60000, now), '5 minutes ago')
  t.is(humanize(now - 60000, now), '1 minute ago')
  t.is(humanize(now - 2 * HOUR, now), '2 hours ago')
  t.is(humanize(now - HOUR, now), '1 hour ago')
  t.is(humanize(now - 3 * DAY, now), '3 days ago')
  t.is(humanize(now - 14 * DAY, now), '2 weeks ago')
})

test('formatLocal returns a string or em-dash', (t) => {
  t.is(formatLocal(0), '—')
  t.ok(typeof formatLocal(1000000000) === 'string')
})
