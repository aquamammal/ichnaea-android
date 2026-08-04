import Hypercore from 'hypercore'
import Protomux from 'protomux'
import b4a from 'b4a'
import { encrypt, decrypt } from '../crypto.js'
import { dataDir, resolveFs } from './fsx.js'

// Local append-only check-in log (persisted on the FILESYSTEM in the main
// process) plus replication of contact cores (kept in RAM, re-replicated on
// reconnect). Hypercore is pinned to v10; v10 accepts a directory path for
// filesystem RAF storage (verified: append + reopen + read).

const MAX_ENTRIES = 200 // rotate to a fresh core beyond this (Hypercore is append-only)

// --- Local core --------------------------------------------------------------

// Open (or create) the local core for this identity. Storage is a directory on
// disk under data/cores/; the keypair signs every appended block. `generation`
// namespaces the directory so rotating to a fresh core (after MAX_ENTRIES)
// opens a brand-new, empty log instead of the old one.
export async function openLocalCore (keyPair, generation = 0) {
  const { path } = await resolveFs()
  const name = 'beacon-local-' + b4a.toString(keyPair.publicKey, 'hex').slice(0, 16) + '-g' + generation
  const dir = path.join(await dataDir(), 'cores', name)
  const core = new Hypercore(dir, { keyPair, createIfMissing: true })
  await core.ready()
  return core
}

// Append a check-in. Never appends null/invalid locations. The block is
// encrypted with the caller's symmetric `logKey` before appending.
// Returns { entry, length, shouldRotate }.
export async function appendCheckin (core, { lat, lng, timestamp }, logKey) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) {
    throw new Error('Invalid coordinates — refusing to append')
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error('Coordinates out of range')
  }
  const entry = { lat, lng, timestamp: timestamp || Date.now() }
  const payload = b4a.from(JSON.stringify(entry))
  await core.append(encrypt(payload, logKey))
  return { entry, length: core.length, shouldRotate: core.length > MAX_ENTRIES }
}

// Read + decode the latest entry from any core (local or replicated). Tries the
// given `logKey` first; if it fails (auth error or legacy plaintext block), falls
// back to treating the block as plaintext so old logs stay readable.
// Returns null for an empty, missing, or not-yet-open core.
export async function readLatest (core, logKey) {
  if (!core || !core.length) return null
  const block = await core.get(core.length - 1)
  let plain = decrypt(block, logKey)
  if (!plain) plain = block // legacy plaintext fallback
  try {
    return JSON.parse(b4a.toString(plain))
  } catch {
    return null
  }
}

// --- Contact core replication ------------------------------------------------

// Storage directory for a contact's replicated core, keyed by their core key
// so it reopens across restarts and the last pin stays visible offline.
async function contactCoreDir (coreKeyHex) {
  const { path } = await resolveFs()
  return path.join(await dataDir(), 'cores', 'contact-' + coreKeyHex.slice(0, 16))
}

// Open a contact's core for replication over a live Hyperswarm connection. The
// connection is a @hyperswarm/secret-stream with a shared Protomux at
// `conn.userData` (created in src/swarm.js); we attach to that same mux so
// replication multiplexes with the JSON handshake. Storage is on disk (not RAM)
// so the contact's history survives restarts. Pass no `conn` to just open the
// persisted core (used on boot to show cached pins).
export async function replicateContactCore (coreKeyHex, conn) {
  const key = b4a.from(coreKeyHex, 'hex')
  const core = new Hypercore(await contactCoreDir(coreKeyHex), key, { createIfMissing: true })
  await core.ready()
  const mux = conn && conn.userData && Protomux.isProtomux(conn.userData)
    ? conn.userData
    : conn
  if (mux) core.replicate(mux)
  return core
}

export { MAX_ENTRIES }
