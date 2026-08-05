import test from 'brittle'
import { fingerprint, WORDS } from '../src/fingerprint.js'

const KEY_A = 'OcfNtb7phkwvQAdJtJKaFOnnsRT5/nKrpvtMZDSTTAg='
const KEY_B = 'NyTADiQwgn8x5mPiXxczkVOnTLEnkZxyfhl7O28SfQM='
const WORD = /^[a-z]+(-[a-z]+){3}$/

test('word list is a fixed 256 distinct words', (t) => {
  t.is(WORDS.length, 256)
  t.is(new Set(WORDS).size, 256)
  for (const w of WORDS) t.ok(/^[a-z]+$/.test(w), 'word ' + w + ' is lowercase alpha')
})

test('fingerprint is a 4-word lowercase pair', (t) => {
  const fp = fingerprint(KEY_A)
  t.ok(WORD.test(fp), fp + ' matches word-word-word-word')
})

test('fingerprint is deterministic for the same key', (t) => {
  t.is(fingerprint(KEY_A), fingerprint(KEY_A))
})

test('different keys give different fingerprints', (t) => {
  t.not(fingerprint(KEY_A), fingerprint(KEY_B))
})

test('returns null for unparseable / non-string input', (t) => {
  t.is(fingerprint(''), null)
  t.is(fingerprint(null), null)
  t.is(fingerprint(undefined), null)
  t.is(fingerprint('!!!!not-base64!!!!'), null)
  t.is(fingerprint('short'), null) // length % 4 === 1
  t.is(fingerprint(12345), null)
})

test('rejects non-ASCII characters even when length is preserved', (t) => {
  const base = 'OcfNtb7phkwvQAdJtJKaFOnnsRT5/nKrpvtMZDSTTAg='
  // Replace a mid-string char with a multi-byte char without changing length.
  const polluted = base.slice(0, 20) + '\u2014' + base.slice(21)
  t.is(polluted.length, base.length)
  t.is(fingerprint(polluted), null)
})

test('url-safe alphabet is tolerated', (t) => {
  const fp = fingerprint(KEY_A)
  t.is(fp, fingerprint(KEY_A.replace(/\+/g, '-').replace(/\//g, '_')))
})
