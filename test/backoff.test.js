import test from 'brittle'
import { backoffDelay, createBackoff } from '../src/backoff.js'

test('backoffDelay: doubles from base and caps at max', (t) => {
  t.is(backoffDelay(0, { base: 1000, max: 30000 }), 1000)
  t.is(backoffDelay(1, { base: 1000, max: 30000 }), 2000)
  t.is(backoffDelay(2, { base: 1000, max: 30000 }), 4000)
  t.is(backoffDelay(4, { base: 1000, max: 30000 }), 16000)
  t.is(backoffDelay(5, { base: 1000, max: 30000 }), 30000) // 32000 capped
  t.is(backoffDelay(20, { base: 1000, max: 30000 }), 30000)
})

test('backoffDelay: custom base/max and negative/non-numeric attempts', (t) => {
  t.is(backoffDelay(0, { base: 2000, max: 30000 }), 2000)
  t.is(backoffDelay(10, { base: 2000, max: 30000 }), 30000)
  t.is(backoffDelay(-1), 1000) // negative resets to 0
  t.is(backoffDelay('x'), 1000) // non-numeric resets to 0
})

test('createBackoff: advances on next() and resets on reset()', (t) => {
  const b = createBackoff({ base: 1000, max: 30000 })
  t.is(b.next(), 1000)
  t.is(b.next(), 2000)
  t.is(b.next(), 4000)
  b.reset()
  t.is(b.next(), 1000, 'reset restarts the sequence')
})

test('createBackoff: caps at max so a long-down peer is not hammered', (t) => {
  const b = createBackoff({ base: 2000, max: 30000 })
  let last = 0
  for (let i = 0; i < 20; i++) last = b.next()
  t.is(last, 30000)
})
