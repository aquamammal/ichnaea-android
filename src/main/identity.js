import b4a from 'b4a'
import { generateKeyPair, generateLogEncryptionKeyPair, generateLogKey } from '../crypto.js'
import { dataDir, readJson, writeJson, resolveFs } from './fsx.js'

// Identity keypair for the MAIN process, persisted on the filesystem (the main
// process has no IndexedDB). The public key is the user's address; the secret
// key never leaves the device. Reuses src/crypto.js generateKeyPair().
//
// Also persists the user's X25519 "log encryption" keypair (used to receive
// contacts' sealed-box log keys during the handshake) and the 32-byte symmetric
// "log key" that encrypts their OWN local core blocks. These are generated once
// and survive reload so the local log stays decryptable after a restart.

async function identityFile () {
  const { path } = await resolveFs()
  return path.join(await dataDir(), 'identity.json')
}

export async function loadOrCreateIdentity () {
  const file = await identityFile()
  const existing = await readJson(file)
  if (existing && existing.publicKey && existing.secretKey) {
    const { record, encKp, logKey, logKeyHistory } = ensureEncryptionFields(existing)
    if (record) await writeJson(file, record) // persist any backfilled hex fields
    return {
      publicKey: b4a.from(existing.publicKey, 'hex'),
      secretKey: b4a.from(existing.secretKey, 'hex'),
      created: existing.created || 0,
      logEnc: encKp,
      logKey,
      logKeyHistory
    }
  }

  const kp = generateKeyPair()
  const encKp = generateLogEncryptionKeyPair()
  const logKey = generateLogKey()
  const created = Date.now()
  await writeJson(file, {
    publicKey: b4a.toString(kp.publicKey, 'hex'),
    secretKey: b4a.toString(kp.secretKey, 'hex'),
    logEncPublicKey: b4a.toString(encKp.publicKey, 'hex'),
    logEncSecretKey: b4a.toString(encKp.secretKey, 'hex'),
    logKey: b4a.toString(logKey, 'hex'),
    logKeyHistory: [],
    created
  })
  return {
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    created,
    logEnc: encKp,
    logKey,
    logKeyHistory: []
  }
}

// Backfill the log-encryption keypair + log key on an identity created before
// this feature. Returns { record|null, encKp, logKey, logKeyHistory }:
// `record` is the object to persist ONLY when the hex fields were missing
// (never Buffer-valued), and encKp/logKey/logKeyHistory are the parsed Buffers
// either way. logKeyHistory is `[{ coreGeneration, key(Buffer) }]` newest first.
function ensureEncryptionFields (rec) {
  let encKp
  let logKey
  if (rec.logKey && rec.logEncPublicKey && rec.logEncSecretKey) {
    encKp = {
      publicKey: b4a.from(rec.logEncPublicKey, 'hex'),
      secretKey: b4a.from(rec.logEncSecretKey, 'hex')
    }
    logKey = b4a.from(rec.logKey, 'hex')
  } else {
    encKp = generateLogEncryptionKeyPair()
    logKey = generateLogKey()
  }
  const history = parseHistory(rec.logKeyHistory)
  if (rec.logKey && rec.logEncPublicKey && rec.logEncSecretKey && rec.logKeyHistory) {
    return { record: null, encKp, logKey, logKeyHistory: history }
  }
  // Persist the missing pieces (enc keypair + log key + normalized history).
  return {
    record: {
      ...rec,
      logEncPublicKey: b4a.toString(encKp.publicKey, 'hex'),
      logEncSecretKey: b4a.toString(encKp.secretKey, 'hex'),
      logKey: b4a.toString(logKey, 'hex'),
      logKeyHistory: history.map((h) => ({ coreGeneration: h.coreGeneration, logKeyHex: b4a.toString(h.key, 'hex') }))
    },
    encKp,
    logKey,
    logKeyHistory: history
  }
}

// Parse the persisted log-key history (old keys retained for a small window so
// recent history stays decryptable across a rotation, then dropped). Normalizes
// missing/garbage into an empty list.
function parseHistory (raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const h of raw) {
    if (h && typeof h.logKeyHex === 'string' && typeof h.coreGeneration === 'number') {
      try { out.push({ coreGeneration: h.coreGeneration, key: b4a.from(h.logKeyHex, 'hex') }) } catch { /* skip */ }
    }
  }
  return out
}

// Rotate the user's symmetric log key: push the current key into the windowed
// history, persist a fresh key + history to identity.json, and return an updated
// identity object. The caller then opens a fresh core (new generation) encrypted
// with the new key and re-shares the new key with contacts over the handshake.
// Forward-secrecy win: a compromise exposes at most the recent window, not all
// history.
export async function rotateIdentityLogKey (identity, coreGeneration) {
  const newKey = generateLogKey()
  // Normalize both the current key and any prior history into hex records so
  // the persisted JSON and the in-memory buffer list stay consistent.
  const currentEntry = { coreGeneration, logKeyHex: b4a.toString(identity.logKey, 'hex') }
  const prior = (identity.logKeyHistory || []).map((h) => ({
    coreGeneration: h.coreGeneration,
    logKeyHex: b4a.toString(h.key, 'hex')
  }))
  const history = [currentEntry, ...prior].slice(0, 3)
  const rec = {
    publicKey: b4a.toString(identity.publicKey, 'hex'),
    secretKey: b4a.toString(identity.secretKey, 'hex'),
    logEncPublicKey: b4a.toString(identity.logEnc.publicKey, 'hex'),
    logEncSecretKey: b4a.toString(identity.logEnc.secretKey, 'hex'),
    logKey: b4a.toString(newKey, 'hex'),
    logKeyHistory: history.map((h) => ({ coreGeneration: h.coreGeneration, logKeyHex: h.logKeyHex })),
    created: identity.created
  }
  await writeJson(await identityFile(), rec)
  return {
    ...identity,
    logKey: newKey,
    logKeyHistory: history.map((h) => ({ coreGeneration: h.coreGeneration, key: b4a.from(h.logKeyHex, 'hex') }))
  }
}

// Rewrite the identity record to disk (e.g. to re-encrypt it when at-rest
// encryption is enabled). Serializes the in-memory Buffers back to hex.
export async function persistIdentity (identity) {
  const rec = {
    publicKey: b4a.toString(identity.publicKey, 'hex'),
    secretKey: b4a.toString(identity.secretKey, 'hex'),
    logEncPublicKey: b4a.toString(identity.logEnc.publicKey, 'hex'),
    logEncSecretKey: b4a.toString(identity.logEnc.secretKey, 'hex'),
    logKey: b4a.toString(identity.logKey, 'hex'),
    logKeyHistory: (identity.logKeyHistory || []).map((h) => ({
      coreGeneration: h.coreGeneration,
      logKeyHex: b4a.toString(h.key, 'hex')
    })),
    created: identity.created
  }
  await writeJson(await identityFile(), rec)
  return identity
}
