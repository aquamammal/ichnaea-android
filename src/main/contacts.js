import b4a from 'b4a'
import { pubFromB64, pubToB64 } from '../crypto.js'
import { dataDir, readJson, readJsonPlain, writeJson, writeJsonPlain, resolveFs } from './fsx.js'

// Contacts store for the MAIN process, persisted as a JSON file on the
// filesystem (the renderer's IndexedDB contacts store is replaced by pipe calls
// to this module). Record shape matches the old renderer src/contacts.js so the
// pipe protocol and UI stay consistent:
//   { id, nickname, publicKeyB64, intervalMs, lastSeenTs, coreKeyHex, logKeyHex, created }

async function storeFile () {
  const { path } = await resolveFs()
  return path.join(await dataDir(), 'contacts.json')
}

async function load () {
  const data = await readJson(await storeFile())
  if (data && typeof data === 'object' && data.contacts && typeof data.contacts === 'object') {
    return data.contacts
  }
  return {}
}

async function save (contacts) {
  await writeJson(await storeFile(), { version: 1, contacts })
}

// Re-write the store, used when at-rest encryption is enabled/disabled.
//   plaintextRead  = true  -> the file on disk is currently plaintext (enable)
//   plaintextWrite = true  -> write the result as plaintext (disable)
export async function reEncrypt ({ plaintextRead = false, plaintextWrite = false } = {}) {
  return serialized(async () => {
    const file = await storeFile()
    let data
    if (plaintextRead) {
      const raw = await readJsonPlain(file)
      data = raw && typeof raw === 'object' && raw.contacts ? raw.contacts : {}
    } else {
      data = await load()
    }
    const out = { version: 1, contacts: data }
    if (plaintextWrite) await writeJsonPlain(file, out)
    else await writeJson(file, out)
    return true
  })
}

function keyId (publicKeyBuf) {
  return b4a.toString(publicKeyBuf, 'hex')
}

// The store is one JSON file; serialize all read-modify-write mutations so
// concurrent updates (e.g. setContactCoreKey + setContactLogKey from the
// handshake) can't lose each other's fields.
let writeQueue = Promise.resolve()

function serialized (fn) {
  const run = writeQueue.then(fn, fn)
  writeQueue = run.then(() => undefined, () => undefined)
  return run
}

export async function addContact ({ nickname, publicKeyB64 }, { selfPublicKey } = {}) {
  const buf = pubFromB64(publicKeyB64) // throws on invalid
  const id = keyId(buf)

  if (selfPublicKey) {
    const selfBuf = typeof selfPublicKey === 'string' ? pubFromB64(selfPublicKey) : selfPublicKey
    if (b4a.equals(buf, selfBuf)) throw new Error('Cannot add yourself as a contact')
  }

  return serialized(async () => {
    const contacts = await load()
    if (contacts[id]) throw new Error('Contact already exists')

    const contact = {
      id,
      nickname: String(nickname || '').trim() || 'Unnamed',
      publicKeyB64: pubToB64(buf), // normalized
      intervalMs: null,
      lastSeenTs: 0,
      coreKeyHex: null,
      created: Date.now()
    }
    contacts[id] = contact
    await save(contacts)
    return contact
  })
}

export async function removeContact (id) {
  return serialized(async () => {
    const contacts = await load()
    delete contacts[id]
    await save(contacts)
    return true
  })
}

export async function getContact (id) {
  const contacts = await load()
  return contacts[id] || null
}

export async function listContacts () {
  const contacts = await load()
  return Object.values(contacts).sort((a, b) => a.created - b.created)
}

async function patch (id, fields) {
  return serialized(async () => {
    const contacts = await load()
    const c = contacts[id]
    if (!c) return null
    Object.assign(c, fields)
    await save(contacts)
    return c
  })
}

export async function setContactInterval (id, intervalMs) {
  return patch(id, { intervalMs })
}

export async function updateLastSeen (id, ts) {
  return patch(id, { lastSeenTs: ts })
}

export async function setContactCoreKey (id, coreKeyHex) {
  return patch(id, { coreKeyHex })
}

export async function setContactLogKey (id, logKeyHex) {
  return patch(id, { logKeyHex })
}

// Rename a contact (local-only nickname — never sent to the peer).
export async function renameContact (id, nickname) {
  const name = String(nickname || '').trim()
  if (!name) throw new Error('Nickname cannot be empty')
  return patch(id, { nickname: name })
}

// Remember the name the peer sent with their latest check-in ("self name").
export async function setContactLastName (id, name) {
  return patch(id, { lastName: String(name || '').slice(0, 40) })
}
