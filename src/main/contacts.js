import b4a from 'b4a'
import { pubFromB64, pubToB64 } from '../crypto.js'
import { dataDir, readJson, writeJson, resolveFs } from './fsx.js'

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
