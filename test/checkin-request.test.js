import test from 'brittle'
import { shouldHonorCheckinRequest, canSendCheckinRequest, CHECKIN_REQUEST_MIN_MS } from '../src/main/checkin-request.js'

const MIN = CHECKIN_REQUEST_MIN_MS
const NOW = 1000000000000

test('shouldHonor: never honors when the setting is off (default)', (t) => {
  const r = shouldHonorCheckinRequest({ honor: false, lastTs: 0, now: NOW })
  t.is(r.ok, false)
  t.is(r.reason, 'not-enabled')
})

test('shouldHonor: honors a fresh request when enabled', (t) => {
  const r = shouldHonorCheckinRequest({ honor: true, lastTs: 0, now: NOW })
  t.is(r.ok, true)
})

test('shouldHonor: rate-limits repeated requests from the same contact', (t) => {
  const r = shouldHonorCheckinRequest({ honor: true, lastTs: NOW - 60000, now: NOW })
  t.is(r.ok, false)
  t.is(r.reason, 'rate-limited')
})

test('shouldHonor: allows again after the rate-limit window elapses', (t) => {
  const r = shouldHonorCheckinRequest({ honor: true, lastTs: NOW - MIN - 1000, now: NOW })
  t.is(r.ok, true)
})

test('shouldHonor: honors at exactly the window boundary (not rate-limited)', (t) => {
  const r = shouldHonorCheckinRequest({ honor: true, lastTs: NOW - MIN, now: NOW })
  t.is(r.ok, true)
})

test('shouldHonor: accepts a custom rate-limit window', (t) => {
  // 60s ago with a 2-min window is still rate-limited...
  t.is(shouldHonorCheckinRequest({ honor: true, lastTs: NOW - 60000, now: NOW, minMs: 2 * 60 * 1000 }).ok, false)
  // ...but a longer custom window allows the default-window case.
  t.is(shouldHonorCheckinRequest({ honor: true, lastTs: NOW - 60000, now: NOW, minMs: 30000 }).ok, true)
})

test('canSend: allows a first request, rate-limits a follow-up, allows after window', (t) => {
  t.is(canSendCheckinRequest({ lastTs: 0, now: NOW }).ok, true)
  t.is(canSendCheckinRequest({ lastTs: NOW - 60000, now: NOW }).ok, false)
  t.is(canSendCheckinRequest({ lastTs: NOW - MIN - 1000, now: NOW }).ok, true)
})
