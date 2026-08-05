// Filesystem helpers for the Pear MAIN process. The renderer has no fs access,
// so identity, the contacts store, and the local Hypercore all persist on disk
// under a `data/` directory in the project cwd. Uses bare-fs/bare-path when
// running under Bare, falling back to Node's fs/path (same pattern as v1).

import { encryptJson, decryptJson } from '../crypto.js'

let resolved = null

// --- Opt-in at-rest encryption ------------------------------------------------
// When enabled (and a key is set), the JSON stores identity.json / contacts.json
// / settings.json are transparently encrypted on write and decrypted on read.
// The key is derived from the user's passphrase (see crypto.deriveAtRestKey);
// the marker file data/atrest.json (never encrypted) records whether encryption
// is on and the salt. Off by default so existing installs are unaffected until
// the user opts in.
const atRest = { enabled: false, key: null }
const ENCRYPTED_STORES = new Set(['identity.json', 'contacts.json', 'settings.json'])

export function configureAtRest ({ enabled, key }) {
  atRest.enabled = Boolean(enabled)
  atRest.key = key || null
}

function isEncryptedStore (file) {
  const base = String(file).split(/[\\/]/).pop()
  return ENCRYPTED_STORES.has(base)
}

export async function resolveFs () {
  if (resolved) return resolved
  let fsMod = null
  let pathMod = null
  try {
    fsMod = await import('bare-fs')
  } catch {
    fsMod = await import('fs')
  }
  try {
    pathMod = await import('bare-path')
  } catch {
    pathMod = await import('path')
  }
  resolved = {
    fs: fsMod.default || fsMod,
    path: pathMod.default || pathMod
  }
  return resolved
}

export async function dataDir () {
  const { path } = await resolveFs()
  // Android's NodeService sets ICHNAEA_DATA_DIR; honor it so the app writes to
  // the native data dir. Tests set it to a temp dir to avoid touching repo data/.
  if (typeof process !== 'undefined' && process.env && process.env.ICHNAEA_DATA_DIR) {
    return process.env.ICHNAEA_DATA_DIR
  }
  const cwd = typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : '.'
  return path.join(cwd, 'data')
}

export async function readJson (file) {
  const { fs } = await resolveFs()
  let raw
  try {
    raw = await fs.promises.readFile(file, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
  if (isEncryptedStore(file) && atRest.enabled && atRest.key) {
    let envelope
    try {
      envelope = JSON.parse(raw)
    } catch {
      throw new Error('Corrupt encrypted store: ' + file)
    }
    const obj = decryptJson(envelope, atRest.key)
    if (obj === null) throw new Error('Wrong passphrase or tampered data: ' + file)
    return obj
  }
  return JSON.parse(raw)
}

// Read a JSON file as plaintext regardless of the at-rest encryption state.
// Used only for the enable/disable migration when a store is being converted.
export async function readJsonPlain (file) {
  const { fs } = await resolveFs()
  try {
    const raw = await fs.promises.readFile(file, 'utf8')
    return JSON.parse(raw)
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

export async function writeJson (file, data) {
  const { fs, path } = await resolveFs()
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  let out = data
  if (isEncryptedStore(file) && atRest.enabled && atRest.key) {
    out = encryptJson(data, atRest.key, null)
  }
  await fs.promises.writeFile(file, JSON.stringify(out), 'utf8')
}

// Write a JSON file as plaintext regardless of the at-rest encryption state.
// Used only for the enable/disable migration when a store is being converted.
export async function writeJsonPlain (file, data) {
  const { fs, path } = await resolveFs()
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, JSON.stringify(data), 'utf8')
}

// --- At-rest marker (always plaintext) ---------------------------------------

async function atrestMarkerFile () {
  const { path } = await resolveFs()
  return path.join(await dataDir(), 'atrest.json')
}

export async function readAtRestMarker () {
  const m = await readJson(await atrestMarkerFile())
  if (m && typeof m === 'object' && m.enabled) {
    return { enabled: true, salt: typeof m.salt === 'string' ? m.salt : null }
  }
  return { enabled: false, salt: null }
}

export async function writeAtRestMarker (s) {
  await writeJson(await atrestMarkerFile(), { enabled: Boolean(s.enabled), salt: s.salt || null })
}
