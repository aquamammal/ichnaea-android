import test from 'brittle'
import b4a from 'b4a'
import {
  generateKeyPair,
  pubToB64,
  pubFromB64,
  derivePairTopic,
  generateLogEncryptionKeyPair,
  generateLogKey,
  sealLogKey,
  openLogKey,
  encrypt,
  decrypt
} from '../src/crypto.js'

test('keypair generation produces 32/64-byte keys', (t) => {
  const kp = generateKeyPair()
  t.is(kp.publicKey.length, 32)
  t.is(kp.secretKey.length, 64)
})

test('base64 round-trip', (t) => {
  const kp = generateKeyPair()
  const b64 = pubToB64(kp.publicKey)
  const back = pubFromB64(b64)
  t.ok(b4a.equals(back, kp.publicKey))
})

test('pubFromB64 rejects malformed input', (t) => {
  t.exception(() => pubFromB64('not valid base64 !!!'))
  t.exception(() => pubFromB64(''))
  t.exception(() => pubFromB64(null))
})

test('pubFromB64 rejects wrong decoded length', (t) => {
  const short = b4a.toString(b4a.from('hello'), 'base64') // 5 bytes
  t.exception(() => pubFromB64(short))
})

test('pubFromB64 trims surrounding whitespace', (t) => {
  const kp = generateKeyPair()
  const b64 = pubToB64(kp.publicKey)
  const back = pubFromB64('  ' + b64 + '\n')
  t.ok(b4a.equals(back, kp.publicKey))
})

test('pair topic is symmetric and deterministic', (t) => {
  const a = generateKeyPair().publicKey
  const b = generateKeyPair().publicKey
  const t1 = derivePairTopic(a, b)
  const t2 = derivePairTopic(b, a) // reversed
  const t3 = derivePairTopic(a, b)
  t.is(t1.length, 32)
  t.ok(b4a.equals(t1, t2)) // symmetric
  t.ok(b4a.equals(t1, t3)) // deterministic
})

test('different pairs produce different topics', (t) => {
  const a = generateKeyPair().publicKey
  const b = generateKeyPair().publicKey
  const c = generateKeyPair().publicKey
  const tab = derivePairTopic(a, b)
  const tac = derivePairTopic(a, c)
  t.unlike(b4a.toString(tab, 'hex'), b4a.toString(tac, 'hex'))
})

test('derivePairTopic rejects wrong key sizes', (t) => {
  const a = generateKeyPair().publicKey
  t.exception(() => derivePairTopic(a, b4a.from('short')))
})

test('generateLogKey produces a 32-byte symmetric key', (t) => {
  const k = generateLogKey()
  t.is(k.length, 32)
})

test('generateLogEncryptionKeyPair produces X25519 keys', (t) => {
  const kp = generateLogEncryptionKeyPair()
  t.is(kp.publicKey.length, 32)
  t.is(kp.secretKey.length, 32)
})

test('symmetric encrypt/decrypt round-trips with the same log key', (t) => {
  const logKey = generateLogKey()
  const payload = b4a.from('secret location')
  const cipher = encrypt(payload, logKey)
  t.ok(!b4a.equals(cipher, payload), 'ciphertext differs from plaintext')
  const plain = decrypt(cipher, logKey)
  t.ok(plain !== null && b4a.equals(plain, payload))
})

test('decrypt with the wrong log key returns null', (t) => {
  const payload = b4a.from('secret location')
  const cipher = encrypt(payload, generateLogKey())
  t.is(decrypt(cipher, generateLogKey()), null)
})

test('sealed-box log-key exchange works between two peers', (t) => {
  const a = generateLogEncryptionKeyPair()
  const b = generateLogEncryptionKeyPair()
  const aLogKey = generateLogKey()
  const box = sealLogKey(aLogKey, b.publicKey)
  const opened = openLogKey(box, b)
  t.ok(opened !== null && b4a.equals(opened, aLogKey), 'recipient recovers the log key')
  // The wrong keypair cannot open a box sealed to another recipient.
  t.is(openLogKey(box, a), null)
})

test('encrypt/decrypt are pass-through when no log key is supplied', (t) => {
  const data = b4a.from('legacy plaintext')
  t.ok(b4a.equals(encrypt(data), data))
  t.ok(b4a.equals(decrypt(data), data))
})
