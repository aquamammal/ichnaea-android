import b4a from 'b4a'
import { pubToB64 } from '../crypto.js'
import { createSwarmManager } from '../swarm.js'
import { loadOrCreateIdentity } from './identity.js'
import * as contacts from './contacts.js'
import { openLocalCore, appendCheckin, readLatest, replicateContactCore, MAX_ENTRIES } from './corelog.js'
import { loadSettings, saveSettings } from './settings.js'
import { createMainScheduler } from './scheduler.js'
import { snapCoords, PRECISION_KM_OPTIONS } from './precision.js'

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

    // Join all saved contacts.
    const list = await contacts.listContacts()
    for (const c of list) await state.swarm.joinContact(c)
  }

  // --- swarm -----------------------------------------------------------------
  function initSwarm () {
    state.swarm = createSwarmManager({
      identity: state.identity,
      getIntervalMs: () => state.settings.intervalMs,
      getLocalCoreKey: () => (state.localCore ? b4a.toString(state.localCore.key, 'hex') : null),
      getLocalCore: () => state.localCore,
      getLogKey: () => state.identity.logKey,
      getEncKeyPair: () => state.identity.logEnc,
      onUpdate: (s) => {
        send({ type: 'peers', verified: s.verified, connections: s.connections })
      },
      onPeerVerified: async (contactId, conn, meta) => {
        if (meta.intervalMs) await contacts.setContactInterval(contactId, meta.intervalMs)
        if (meta.coreKey) await contacts.setContactCoreKey(contactId, meta.coreKey)
        const contact = await contacts.getContact(contactId)
        if (contact) send({ type: 'contact:update', contact: toRendererContact(contact) })
        startContactReplication(contactId, meta.coreKey, conn)
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
    if (res.shouldRotate) await rotateCore()
    return res
  }

  async function rotateCore () {
    const old = state.localCore
    state.settings.coreGeneration = (state.settings.coreGeneration || 0) + 1
    await saveSettings(state.settings)
    state.localCore = await openLocalCore(state.identity, state.settings.coreGeneration)
    if (old) old.close().catch(() => {})
    state.swarm.refreshHello() // re-share the new core key on the next handshake
    state.swarm.refreshLocalCore() // serve the new local core on existing conns
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
        const raw = await contacts.listContacts()
        const list = await attachCachedPins(raw)
        const latest = await readLatest(state.localCore, state.identity.logKey)
        send({
          type: 'boot',
          id: msg.id,
          publicKeyB64: pubToB64(state.identity.publicKey),
          intervalMs: state.settings.intervalMs,
          selfName: state.settings.selfName || '',
          precisionKm: state.settings.precisionKm || 0,
          contacts: list.map(toRendererContact),
          selfLoc: latest ? { lat: latest.lat, lng: latest.lng } : null,
          manual: getManual()
        })
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
        await rotateCore()
        send({ type: 'dev:force200', id: msg.id })
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
