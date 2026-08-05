import test from 'brittle'
import os from 'os'
import fs from 'fs'
import path from 'path'
import b4a from 'b4a'
import { encrypt, decrypt, generateLogKey } from '../src/crypto.js'
import { loadOrCreateIdentity, rotateIdentityLogKey } from '../src/main/identity.js'
import { openLocalCore, appendCheckin, readLatest } from '../src/main/corelog.js'

// Isolate all disk writes to a throwaway dir so we never touch the repo's data/.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ichnaea-rotate-'))
process.env.ICHNAEA_DATA_DIR = TMP

test('crypto: an old log key still decrypts; the new key alone does not (forward secrecy)', (t) => {
  const oldKey = generateLogKey()
  const newKey = generateLogKey()
  const payload = b4a.from(JSON.stringify({ lat: 1, lng: 2, timestamp: 3 }))
  const cipher = encrypt(payload, oldKey)
  t.ok(decrypt(cipher, oldKey), 'old key decrypts old block')
  t.is(decrypt(cipher, newKey), null, 'new key cannot decrypt old block')
  t.ok(b4a.equals(decrypt(cipher, oldKey), payload))
})

test('rotateIdentityLogKey: rotates the key, keeps a windowed history, persists it', async (t) => {
  process.env.ICHNAEA_DATA_DIR = TMP
  const identity = await loadOrCreateIdentity()
  const oldKey = identity.logKey
  const rotated = await rotateIdentityLogKey(identity, 0)
  t.not(rotated.logKey, oldKey, 'log key changed after rotation')
  t.is(rotated.logKeyHistory.length, 1, 'history has the retired key')
  t.ok(b4a.equals(rotated.logKeyHistory[0].key, oldKey), 'history entry is the old key')
  // History is capped at 3.
  let cur = rotated
  for (let i = 0; i < 5; i++) cur = await rotateIdentityLogKey(cur, i + 1)
  t.is(cur.logKeyHistory.length, 3, 'history window is capped at 3')

  // Persisted record carries the same history (hex strings).
  const rec = JSON.parse(fs.readFileSync(path.join(TMP, 'identity.json'), 'utf8'))
  t.is(rec.logKeyHistory.length, 3)
  t.is(typeof rec.logKeyHistory[0].logKeyHex, 'string')
  t.ok(rec.logKeyHistory[0].logKeyHex.length > 0)
})

test('rotation keeps old local-core blocks readable via the retained key', async (t) => {
  process.env.ICHNAEA_DATA_DIR = TMP
  const identity = await loadOrCreateIdentity()
  const core = await openLocalCore(identity, 0)
  await appendCheckin(core, { lat: 10, lng: 20, timestamp: 1000 }, identity.logKey)
  const rotated = await rotateIdentityLogKey(identity, 0)

  // Old block decrypts with the retained history key, not the new key alone.
  const withHistory = await readLatest(core, [rotated.logKey, ...rotated.logKeyHistory.map((h) => h.key)])
  t.ok(withHistory, 'old block readable with current + history keys')
  t.is(withHistory.lat, 10)
  const newKeyOnly = await readLatest(core, [rotated.logKey])
  t.is(newKeyOnly, null, 'old block is NOT readable with the new key alone')
  await core.close()

  // Clean up the temp dir (last test in this file).
  delete process.env.ICHNAEA_DATA_DIR
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
})
