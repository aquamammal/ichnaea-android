import test from 'brittle'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { deriveAtRestKey, generateSalt } from '../src/crypto.js'
import { configureAtRest, readJson, dataDir } from '../src/main/fsx.js'
import { loadOrCreateIdentity, persistIdentity } from '../src/main/identity.js'
import { loadSettings, saveSettings } from '../src/main/settings.js'
import * as contacts from '../src/main/contacts.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ichnaea-atrest-'))
process.env.ICHNAEA_DATA_DIR = TMP
const FILE = (n) => path.join(TMP, n)
const PASSWORD = 'correct horse battery staple'
const DIR = () => dataDir()

test('at-rest: stores are plaintext JSON by default', async (t) => {
  process.env.ICHNAEA_DATA_DIR = TMP
  const id = await loadOrCreateIdentity()
  const raw = fs.readFileSync(FILE('identity.json'), 'utf8')
  t.ok(raw.includes('logKey'), 'identity is plaintext when encryption is off')
  t.is(id.logKey.length, 32)
})

test('at-rest: enabling encrypts, round-trips, and wrong passphrase fails', async (t) => {
  process.env.ICHNAEA_DATA_DIR = TMP
  // Load the (plaintext) state first — the app enables while state is in memory.
  const settings = await loadSettings()
  const identity = await loadOrCreateIdentity()
  await contacts.reEncrypt()
  const salt = generateSalt()
  const key = deriveAtRestKey(PASSWORD, salt)

  // Enable: re-encrypt the three stores with the derived key.
  configureAtRest({ enabled: true, key })
  await saveSettings(settings)
  await persistIdentity(identity)
  await contacts.reEncrypt({ plaintextRead: true })

  for (const name of ['identity.json', 'contacts.json', 'settings.json']) {
    const raw = fs.readFileSync(FILE(name), 'utf8')
    const env = JSON.parse(raw)
    t.ok(env && env.v === 1 && typeof env.data === 'string', name + ' is an encrypted envelope')
    t.not(raw.includes('logKey'), name + ' has no plaintext logKey')
  }

  // Round-trip with the correct key.
  const id2 = await loadOrCreateIdentity()
  t.is(id2.logKey.length, 32, 'identity decrypts with the correct key')
  t.is((await loadSettings()).intervalMs, settings.intervalMs, 'settings decrypt with the correct key')

  // A wrong passphrase (same salt) cannot decrypt.
  configureAtRest({ enabled: true, key: deriveAtRestKey('not the right passphrase', salt) })
  await t.exception(() => readJson(FILE('identity.json')), 'wrong passphrase read throws')
})

test('cleanup', async (t) => {
  configureAtRest({ enabled: false, key: null })
  delete process.env.ICHNAEA_DATA_DIR
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
  t.ok(true)
})
