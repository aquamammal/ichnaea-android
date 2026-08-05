import b4a from 'b4a'
import { pubToB64, deriveAtRestKey, generateSalt } from '../crypto.js'
import { createSwarmManager } from '../swarm.js'
import { loadOrCreateIdentity, rotateIdentityLogKey, persistIdentity } from './identity.js'
import * as contacts from './contacts.js'
import { openLocalCore, appendCheckin, readLatest, readHistory, replicateContactCore, MAX_ENTRIES } from './corelog.js'
import { loadSettings, saveSettings } from './settings.js'
import { createMainScheduler } from './scheduler.js'
import { snapCoords, PRECISION_KM_OPTIONS } from './precision.js'
import { configureAtRest, readAtRestMarker, writeAtRestMarker } from './fsx.js'
import * as pending from './pending.js'

// Main-process P2P orchestrator. Owns the entire P2P stack (identity, local
// Hypercore on the filesystem, Hyperswarm, contact-core replication, and the
// broadcast scheduler) and talks to the renderer over the Pear pipe. The
// renderer is a thin client: it renders the globe/UI and answers GPS requests.

export async function createMainApp ({ pipe }) {
  function send (obj) {
    try { pipe.write(JSON.stringify(obj)) } catch { /* pipe closing */ }
  }

  // Contact records sent to the renderer are display data only. Keep the peer's
  // key material (log key, core key) out of that process — it never needs them.
  function toRendererContact (c) {
    if (!c) return c
    const { logKeyHex, coreKeyHex, ...rest } = c
    return rest
  }

  // Re-open each contact's persisted core (if any) so their last pin shows in
  // the boot response even before the peer reconnects. Requires the peer's log
  // key to decrypt — otherwise the block can't be read and the pin is omitted.
  async function attachCachedPins (contacts) {
    const out = []
    for (const c of contacts) {
      if (!c.coreKeyHex || !c.logKeyHex) { out.push(c); continue }
      try {
        const core = await replicateContactCore(c.coreKeyHex)
        if (core.length > 0) {
          const latest = await readLatest(core, b4a.from(c.logKeyHex, 'hex'))
          if (latest) out.push({ ...c, lat: latest.lat, lng: latest.lng })
          else out.push(c)
        } else {
          out.push(c)
        }
        await core.close()
      } catch {
        out.push(c)
      }
    }
    return out
  }

  // --- state -----------------------------------------------------------------
  const state = {
    identity: null,
    localCore: null,
    swarm: null,
    scheduler: null,
    settings: null,
    atRest: { enabled: false, salt: null, unlocked: false }, // passphrase at-rest encryption
    locked: false,
    contactCores: new Map() // contactId -> { coreKeyHex, core, lastLen, timer }
  }
  // Pending GPS requests awaiting a renderer gps:result. id -> {resolve,reject}
  const pendingGps = new Map()
  let gpsSeq = 0

  // Ask the renderer for a GPS fix. Rejects if the renderer reports an error or
  // never answers (timeout) — the scheduler treats that as a failed fix.
  function requestGps () {
    const id = 'gps-' + (++gpsSeq) + '-' + Date.now()
    return new Promise((resolve, reject) => {
      pendingGps.set(id, { resolve, reject })
      send({ type: 'gps:request', id })
      setTimeout(() => {
        if (!pendingGps.has(id)) return
        pendingGps.delete(id)
        reject(new Error('GPS request timed out'))
      }, 20000) // a little longer than the renderer's own geolocation timeout
    })
  }

  function getManual () {
    return (state.settings && state.settings.manual) || { enabled: false, lat: null, lng: null }
  }

  // --- boot ------------------------------------------------------------------
  async function boot () {
    const marker = await readAtRestMarker()
    state.atRest = { enabled: marker.enabled, salt: marker.salt ? b4a.from(marker.salt, 'hex') : null, unlocked: false }
    if (state.atRest.enabled) {
      // The JSON stores are passphrase-encrypted. Defer loading until the user
      // unlocks via passphrase:unlock; don't touch the encrypted files yet.
      state.locked = true
      return
    }
    await initialize()
  }

  // Load settings/identity, open the local core, start the swarm + scheduler,
  // and join saved contacts. Called at boot (no encryption) or after unlock.
  async function initialize () {
    state.settings = await loadSettings()
    state.identity = await loadOrCreateIdentity()
    try {
      state.localCore = await openLocalCore(state.identity, state.settings.coreGeneration || 0)
    } catch (err) {
      // Most commonly ELOCKED: another instance is running and holds the core
      // lock. Surface a clear, actionable message instead of crashing later on a
      // null core.
      const msg = err && err.code === 'ELOCKED'
        ? 'Another instance is running (location log is locked). Close it first.'
        : 'Failed to open the local log: ' + String((err && err.message) || err)
      send({ type: 'error', id: null, message: msg })
      throw new Error(msg)
    }

    initSwarm()
    initScheduler()

    // Join all saved contacts in PARALLEL so slow discovery on one topic never
    // blocks the others (#5: don't serialize boot joins).
    const list = await contacts.listContacts()
    await Promise.all(list.map((c) => state.swarm.joinContact(c)))
    state.locked = false
    state.atRest.unlocked = true
  }

  // Parse ICHNAEA_BOOTSTRAP as a comma-separated list of "host:port" DHT
  // bootstrap nodes (optional; used to point at known/faster bootstrap nodes).
  function parseBootstrap (raw) {
    if (!raw || typeof raw !== 'string') return null
    const nodes = raw.split(',').map((s) => s.trim()).filter(Boolean)
    return nodes.length ? nodes : null
  }

  // --- swarm -----------------------------------------------------------------
  function initSwarm () {
    // `process` is not injected in every Pear/Bare main-process runtime (fsx.js
    // guards it for the same reason), so read env defensively.
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {}
    const bootstrap = parseBootstrap(env.ICHNAEA_BOOTSTRAP)
    state.swarm = createSwarmManager({
      identity: state.identity,
      getIntervalMs: () => state.settings.intervalMs,
      getLocalCoreKey: () => (state.localCore ? b4a.toString(state.localCore.key, 'hex') : null),
      getLocalCore: () => state.localCore,
      getLogKey: () => state.identity.logKey,
      getEncKeyPair: () => state.identity.logEnc,
      bootstrap,
      onFirstConnection: (ms, contactId) => {
        console.error(`[dht] first verified connection in ${ms}ms (${contactId.slice(0, 8)})`)
      },
      onUpdate: (s) => {
        send({ type: 'peers', verified: s.verified, connections: s.connections, connecting: s.connecting, peers: s.peers })
      },
      onPeerVerified: async (contactId, conn, meta) => {
        if (meta.intervalMs) await contacts.setContactInterval(contactId, meta.intervalMs)
        if (meta.coreKey) await contacts.setContactCoreKey(contactId, meta.coreKey)
        const contact = await contacts.getContact(contactId)
        if (contact) send({ type: 'contact:update', contact: toRendererContact(contact) })
        startContactReplication(contactId, meta.coreKey, conn)
        // Now that a peer is connected, the local core (holding any offline
        // check-ins) has replicated — clear the queue and tell the UI.
        const n = await pending.clear()
        if (n > 0) send({ type: 'pending', count: 0, synced: n })
      },
      onLogKey: async (contactId, logKey) => {
        await contacts.setContactLogKey(contactId, b4a.toString(logKey, 'hex'))
        const contact = await contacts.getContact(contactId)
        if (contact) send({ type: 'contact:update', contact: toRendererContact(contact) })
      },
      onPeerLeft: (contactId) => {
        stopContactReplication(contactId)
      }
    })
  }

  // --- contact replication -----------------------------------------------------
  function startContactReplication (contactId, coreKeyHex, conn) {
    if (!coreKeyHex) return
    const existing = state.contactCores.get(contactId)
    if (existing && existing.coreKeyHex === coreKeyHex) return // already replicating
    stopContactReplication(contactId)

    const entry = { coreKeyHex, core: null, lastLen: 0, timer: null }
    state.contactCores.set(contactId, entry)

    // The contact's symmetric log key (received via the sealed-box handshake)
    // decrypts their replicated blocks. Fetch it fresh each poll so a log-key
    // frame that arrives after replication starts is picked up on the next tick.
    const contactLogKey = async () => {
      const c = await contacts.getContact(contactId)
      return (c && c.logKeyHex) ? b4a.from(c.logKeyHex, 'hex') : null
    }

    replicateContactCore(coreKeyHex, conn).then((core) => {
      entry.core = core
      entry.timer = setInterval(async () => {
        try {
          await core.update({ wait: false })
          if (core.length > entry.lastLen) {
            entry.lastLen = core.length
            const latest = await readLatest(core, await contactLogKey())
            if (latest) await onContactCheckin(contactId, latest)
          }
        } catch { /* transient replication errors are non-fatal */ }
      }, 10000)
      core.update({ wait: true }).then(async () => {
        if (core.length > 0) {
          entry.lastLen = core.length
          const latest = await readLatest(core, await contactLogKey())
          if (latest) await onContactCheckin(contactId, latest)
        }
      }).catch(() => {})
    }).catch(() => {})
  }

  function stopContactReplication (contactId) {
    const entry = state.contactCores.get(contactId)
    if (!entry) return
    if (entry.timer) clearInterval(entry.timer)
    if (entry.core) entry.core.close().catch(() => {})
    state.contactCores.delete(contactId)
  }

  async function onContactCheckin (contactId, { lat, lng, timestamp, name }) {
    const contact = await contacts.updateLastSeen(contactId, timestamp)
    // Remember the name the peer chose for themselves (shown as a hint unless
    // the user renamed them locally).
    if (name) await contacts.setContactLastName(contactId, name)
    const updated = await contacts.getContact(contactId)
    if (updated) send({ type: 'contact:update', contact: { ...toRendererContact(updated), lat, lng } })
  }

  // --- scheduler ---------------------------------------------------------------
  function initScheduler () {
    state.scheduler = createMainScheduler({
      requestGps,
      getManual,
      onCheckin: async ({ lat, lng, timestamp }) => {
        await doCheckin({ lat, lng, timestamp })
      },
      onStatus: (msg) => send({ type: 'status', message: msg })
    })
    state.scheduler.start(state.settings.intervalMs)
  }

  // Append a check-in to the local core, push to the renderer, rotate if needed.
  // The check-in carries the sender's self-chosen name so contacts can show it.
  // When the coarse-location setting is on, coordinates are snapped to a grid
  // first so contacts only see an approximate position (covers scheduled AND
  // manual check-ins).
  async function doCheckin ({ lat, lng, timestamp }) {
    const name = (state.settings.selfName || '').trim()
    const snapped = snapCoords(lat, lng, state.settings.precisionKm || 0)
    const res = await appendCheckin(state.localCore, { lat: snapped.lat, lng: snapped.lng, timestamp, name }, state.identity.logKey)
    send({ type: 'self', lat: snapped.lat, lng: snapped.lng, timestamp, name })
    // Offline queue: if no contact is currently connected, record this check-in
    // so the UI can show it queued; it's already in the local core, so it syncs
    // via replication once a peer connects (flush happens in onPeerVerified).
    const verified = state.swarm ? state.swarm.state().verified : 0
    if (verified === 0) {
      const added = await pending.enqueue({ lat: snapped.lat, lng: snapped.lng, timestamp, name })
      if (added) send({ type: 'pending', count: await pending.count() })
    }
    if (res.shouldRotate) await rotateCore(true) // rotate core AND log key (forward secrecy)
    return res
  }

  // Current log key + the small windowed rotation history, as candidate keys for
  // decrypting a core across a rotation boundary.
  function localLogKeys () {
    const keys = [state.identity.logKey]
    for (const h of state.identity.logKeyHistory || []) keys.push(h.key)
    return keys
  }

  // Rotate to a fresh local core generation. When `rotateLogKey` is set (on the
  // normal MAX_ENTRIES rotation and the dev trigger) we ALSO rotate the user's
  // symmetric log key and re-share it with live contacts, so a compromise
  // exposes at most the recent window (forward secrecy).
  async function rotateCore (rotateLogKey = false) {
    const old = state.localCore
    const nextGen = (state.settings.coreGeneration || 0) + 1
    if (rotateLogKey) {
      state.identity = await rotateIdentityLogKey(state.identity, state.settings.coreGeneration || 0)
    }
    state.settings.coreGeneration = nextGen
    await saveSettings(state.settings)
    state.localCore = await openLocalCore(state.identity, state.settings.coreGeneration)
    if (old) old.close().catch(() => {})
    state.swarm.refreshHello() // re-share the new core key on the next handshake
    state.swarm.refreshLocalCore() // serve the new local core on existing conns
    if (rotateLogKey && typeof state.swarm.refreshLogKey === 'function') {
      state.swarm.refreshLogKey() // re-share the rotated log key on live conns
    }
    send({ type: 'status', message: 'Log rotated after ' + MAX_ENTRIES + ' check-ins' })
  }

  // --- message handling --------------------------------------------------------
  async function handleMessage (msg) {
    if (!msg || typeof msg !== 'object') return

    // GPS results are correlated by id, not request/response.
    if (msg.type === 'gps:result') {
      const pending = pendingGps.get(msg.id)
      if (pending) {
        pendingGps.delete(msg.id)
        if (typeof msg.lat === 'number' && typeof msg.lng === 'number') {
          pending.resolve({ lat: msg.lat, lng: msg.lng })
        } else {
          pending.reject(new Error(msg.error || 'GPS unavailable'))
        }
      }
      return
    }

    try {
      if (msg.type === 'boot') {
        if (state.locked) {
          send({ type: 'boot', id: msg.id, locked: true, atrest: true })
          return
        }
        const raw = await contacts.listContacts()
        const list = await attachCachedPins(raw)
        const latest = await readLatest(state.localCore, localLogKeys())
        send({
          type: 'boot',
          id: msg.id,
          publicKeyB64: pubToB64(state.identity.publicKey),
          intervalMs: state.settings.intervalMs,
          selfName: state.settings.selfName || '',
          precisionKm: state.settings.precisionKm || 0,
          atrest: state.atRest.enabled,
          pendingCount: await pending.count(),
          contacts: list.map(toRendererContact),
          selfLoc: latest ? { lat: latest.lat, lng: latest.lng } : null,
          manual: getManual()
        })
        return
      }

      if (msg.type === 'passphrase:unlock') {
        if (!state.atRest.enabled) throw new Error('Local encryption is not enabled')
        const pass = String(msg.passphrase || '')
        if (!pass) throw new Error('Enter your passphrase')
        const key = deriveAtRestKey(pass, state.atRest.salt)
        configureAtRest({ enabled: true, key })
        try {
          await initialize() // reads the encrypted stores; wrong passphrase throws
        } catch (err) {
          configureAtRest({ enabled: false, key: null })
          send({ type: 'error', id: msg.id, message: 'Wrong passphrase' })
          return
        }
        send({ type: 'passphrase:unlock', id: msg.id, ok: true })
        return
      }

      if (msg.type === 'passphrase:set') {
        // Enable at-rest encryption: derive a key, re-encrypt the existing JSON
        // stores, and record the salt in the plaintext marker.
        const pass = String(msg.passphrase || '')
        if (pass.length < 8) throw new Error('Passphrase must be at least 8 characters')
        const salt = generateSalt()
        const key = deriveAtRestKey(pass, salt)
        configureAtRest({ enabled: true, key })
        await saveSettings(state.settings) // re-encrypt settings
        await contacts.reEncrypt({ plaintextRead: true }) // read plaintext, write encrypted
        await persistIdentity(state.identity) // re-encrypt identity (holds the log key)
        await writeAtRestMarker({ enabled: true, salt: b4a.toString(salt, 'hex') })
        state.atRest = { enabled: true, salt, unlocked: true }
        send({ type: 'passphrase:set', id: msg.id, ok: true })
        return
      }

      if (msg.type === 'passphrase:disable') {
        if (!state.atRest.enabled) throw new Error('Local encryption is not enabled')
        // Verify the passphrase, then decrypt the stores back to plaintext.
        const pass = String(msg.passphrase || '')
        const key = deriveAtRestKey(pass, state.atRest.salt)
        configureAtRest({ enabled: true, key })
        try {
          state.identity = await loadOrCreateIdentity() // throws if passphrase is wrong
        } catch (err) {
          configureAtRest({ enabled: false, key: null })
          send({ type: 'error', id: msg.id, message: 'Wrong passphrase' })
          return
        }
        configureAtRest({ enabled: false, key: null })
        await saveSettings(state.settings)
        await contacts.reEncrypt({ plaintextWrite: true })
        await persistIdentity(state.identity)
        await writeAtRestMarker({ enabled: false, salt: null })
        state.atRest = { enabled: false, salt: null, unlocked: true }
        send({ type: 'passphrase:disable', id: msg.id, ok: true })
        return
      }

      if (msg.type === 'contact:add') {
        const contact = await contacts.addContact(
          { nickname: msg.nickname, publicKeyB64: msg.publicKeyB64 },
          { selfPublicKey: state.identity.publicKey }
        )
        await state.swarm.joinContact(contact)
        send({ type: 'contact:added', id: msg.id, contact: toRendererContact(contact) })
        return
      }

      if (msg.type === 'contact:remove') {
        stopContactReplication(msg.contactId)
        await state.swarm.leaveContact(msg.contactId)
        await contacts.removeContact(msg.contactId)
        send({ type: 'contact:removed', id: msg.id, contactId: msg.contactId })
        return
      }

      if (msg.type === 'contact:rename') {
        const contact = await contacts.renameContact(msg.contactId, msg.nickname)
        if (contact) {
          send({ type: 'contact:renamed', id: msg.id, contact: toRendererContact(contact) })
        } else {
          throw new Error('Contact not found')
        }
        return
      }

      if (msg.type === 'contact:history') {
        // Return the last N decrypted check-ins from a contact's replicated core
        // (paged history for the timeline panel).
        const contact = await contacts.getContact(msg.contactId)
        const entry = contact && state.contactCores.get(msg.contactId)
        const core = entry && entry.core
        if (!contact || !core) {
          send({ type: 'contact:history', id: msg.id, contactId: msg.contactId, entries: [] })
          return
        }
        const logKey = contact.logKeyHex ? b4a.from(contact.logKeyHex, 'hex') : null
        const limit = Math.min(Number(msg.limit) || 20, 50)
        const entries = await readHistory(core, logKey, limit)
        send({ type: 'contact:history', id: msg.id, contactId: msg.contactId, entries })
        return
      }

      if (msg.type === 'selfname:set') {
        const name = String(msg.name || '').trim().slice(0, 40)
        state.settings.selfName = name
        await saveSettings(state.settings)
        send({ type: 'selfname:set', id: msg.id, name })
        return
      }

      if (msg.type === 'interval:set') {
        const ms = parseInt(msg.intervalMs, 10)
        if (!ms || ms <= 0) throw new Error('Pick a valid interval')
        state.settings.intervalMs = ms
        await saveSettings(state.settings)
        state.scheduler.setIntervalMs(ms)
        state.swarm.refreshHello() // tell contacts our new interval
        send({ type: 'interval:set', id: msg.id, intervalMs: ms })
        return
      }

      if (msg.type === 'precision:set') {
        const km = Number(msg.precisionKm)
        if (PRECISION_KM_OPTIONS.indexOf(km) === -1) throw new Error('Pick a valid precision')
        state.settings.precisionKm = km
        await saveSettings(state.settings)
        send({ type: 'precision:set', id: msg.id, precisionKm: km })
        return
      }

      if (msg.type === 'checkin:now') {
        // Immediate check-in via the normal GPS path (manual override applies).
        state.scheduler.checkinNow().catch(() => {})
        send({ type: 'checkin:now', id: msg.id })
        return
      }

      if (msg.type === 'checkin:manual') {
        // Explicit one-off manual check-in: skip GPS, append directly.
        const lat = Number(msg.lat)
        const lng = Number(msg.lng)
        await doCheckin({ lat, lng, timestamp: Date.now() })
        send({ type: 'checkin:manual', id: msg.id, lat, lng })
        return
      }

      if (msg.type === 'manual:set') {
        // Persist the manual override (coords + enabled flag).
        const manual = {
          enabled: Boolean(msg.enabled),
          lat: typeof msg.lat === 'number' ? msg.lat : null,
          lng: typeof msg.lng === 'number' ? msg.lng : null
        }
        state.settings.manual = manual
        await saveSettings(state.settings)
        send({ type: 'manual:set', id: msg.id, manual })
        return
      }

      if (msg.type === 'dev:force200') {
        for (let i = 0; i < MAX_ENTRIES + 1; i++) {
          await appendCheckin(state.localCore, { lat: 0, lng: 0, timestamp: Date.now() }, state.identity.logKey)
        }
        await rotateCore(true)
        send({ type: 'dev:force200', id: msg.id })
        return
      }

      if (msg.type === 'dev:rotate-logkey') {
        // Rotate the log key + core on demand, so the forward-secrecy rotation
        // can be exercised without waiting for MAX_ENTRIES check-ins.
        await rotateCore(true)
        send({ type: 'dev:rotate-logkey', id: msg.id })
        return
      }
    } catch (err) {
      send({ type: 'error', id: msg.id, message: String((err && err.message) || err) })
    }
  }

  await boot()

  // Mobile lifecycle hooks: called from the native layer (via the Node stdin
  // control channel) when the device's network changes, so Hyperswarm re-binds
  // its UDP sockets and re-announces topics instead of silently dropping off.
  async function suspend () {
    const s = state.swarm && state.swarm.swarm
    if (s && typeof s.suspend === 'function') {
      try { await s.suspend() } catch { /* non-fatal */ }
    }
  }

  async function resume () {
    const s = state.swarm && state.swarm.swarm
    if (s && typeof s.resume === 'function') {
      try { await s.resume() } catch { /* non-fatal */ }
    }
  }

  return { handleMessage, state, suspend, resume }
}
