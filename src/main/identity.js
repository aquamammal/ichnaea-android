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
    const { record, encKp, logKey } = ensureEncryptionFields(existing)
    if (record) await writeJson(file, record) // persist any backfilled hex fields
    return {
      publicKey: b4a.from(existing.publicKey, 'hex'),
      secretKey: b4a.from(existing.secretKey, 'hex'),
      created: existing.created || 0,
      logEnc: encKp,
      logKey
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
    created
  })
  return {
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    created,
    logEnc: encKp,
    logKey
  }
}

// Backfill the log-encryption keypair + log key on an identity created before
// this feature. Returns { record|null, encKp, logKey }: `record` is the object
// to persist ONLY when the hex fields were missing (never Buffer-valued), and
// encKp/logKey are the parsed Buffers either way.
function ensureEncryptionFields (rec) {
  if (rec.logKey && rec.logEncPublicKey && rec.logEncSecretKey) {
    return {
      record: null,
      encKp: {
        publicKey: b4a.from(rec.logEncPublicKey, 'hex'),
        secretKey: b4a.from(rec.logEncSecretKey, 'hex')
      },
      logKey: b4a.from(rec.logKey, 'hex')
    }
  }
  const encKp = generateLogEncryptionKeyPair()
  const logKey = generateLogKey()
  return {
    record: {
      ...rec,
      logEncPublicKey: b4a.toString(encKp.publicKey, 'hex'),
      logEncSecretKey: b4a.toString(encKp.secretKey, 'hex'),
      logKey: b4a.toString(logKey, 'hex')
    },
    encKp,
    logKey
  }
}
