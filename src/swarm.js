import Hyperswarm from 'hyperswarm'
import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import { derivePairTopic, pubToB64, sealLogKey, openLogKey } from './crypto.js'

// Manages one Hyperswarm and a pair-wise topic join per contact. Each contact
// pair derives a deterministic topic from both public keys, so only the two
// peers ever meet in that swarm. On connect we run a handshake and verify the
// remote public key matches a joined contact (basic MITM guard).
//
// Identification is keyed off the hello's publicKey (matched against our joined
// contacts), NOT info.topics — which is unreliable on the inbound/server side.
//
// TRANSPORT: the Hyperswarm connection is a @hyperswarm/secret-stream. We open
// ONE Protomux over it (stored at conn.userData) and share it with Hypercore
// replication: our handshake rides on an `ichnaea-handshake` protomux channel,
// and contact-core replication attaches to the SAME mux (see corelog.js). This
// keeps the JSON handshake and Hypercore's binary protocol multiplexed cleanly
// instead of corrupting each other on a shared byte stream.
//
// End-to-end log-key exchange:
//   - Each peer's hello carries their X25519 "log encryption" PUBLIC key.
//   - Once a peer is verified, each side seals its OWN symmetric log key to the
//     other's enc pub key (crypto_box_seal) and sends it as a `log-key` frame.
//   - Each side opens the other's box with its own enc secret key and hands the
//     recovered log key to onLogKey(contactId, logKey). That key then decrypts
//     the peer's replicated core blocks. Only the two peers can read it.

const HELLO = 'beacon-hello'
const LOG_KEY = 'beacon-log-key'
const REQ_CHECKIN = 'beacon-request-checkin'
const HANDSHAKE_PROTOCOL = 'ichnaea-handshake'

export function createSwarmManager ({
  identity, // { publicKey: Buffer, ... }
  getIntervalMs, // () => our current broadcast interval
  getLocalCoreKey, // () => hex of our current local core key
  getLocalCore, // () => our local Hypercore (served to contacts so they receive our check-ins)
  getLogKey, // () => Buffer — our symmetric log key (encrypts our local core)
  getEncKeyPair, // () => { publicKey, secretKey } — our X25519 log-enc keypair
  onPeerVerified, // (contactId, conn, meta) => void
  onPeerLeft, // (contactId) => void
  onLogKey, // (contactId, logKeyBuffer) => void
  onUpdate, // (state) => void  — peer/connection counts
  bootstrap, // optional DHT bootstrap node list (default when omitted)
  onFirstConnection, // optional timing hook: (msSinceBoot, contactId) => void
  onCheckinRequest // optional (contactId) => void — a verified contact asked us to check in
}) {
  const swarm = new Hyperswarm(bootstrap && bootstrap.length ? { bootstrap } : undefined)
  const discoveries = new Map() // contactId -> { discovery, topicHex, publicKeyB64 }
  const byPubKey = new Map() // publicKeyB64 -> contactId
  const conns = new Map() // contactId -> verified conn
  const connToContact = new Map() // conn -> contactId (verified)
  const connToEncPub = new Map() // conn -> peer's X25519 enc public key (base64)
  const connToChannel = new Map() // conn -> protomux message sender
  const verifiedConns = new Set() // conns that completed the handshake
  const servedCores = new Map() // protomux -> local core already served on it

  const state = { peers: 0, connections: 0, connecting: 0, verified: 0 }
  const bootTs = Date.now() // for first-connection latency profiling (#5)

  function emit () {
    state.peers = swarm.peers ? swarm.peers.size : 0
    state.connections = swarm.connections ? swarm.connections.size : 0
    state.connecting = swarm.connecting || 0
    state.verified = conns.size
    if (onUpdate) onUpdate({ ...state })
  }

  swarm.on('update', emit)

  swarm.on('connection', (conn) => {
    const mux = getMux(conn)
    serveLocalCore(mux)
    const channel = mux.createChannel({ protocol: HANDSHAKE_PROTOCOL })
    if (!channel) {
      try { conn.destroy() } catch { /* ignore */ }
      return
    }
    const sender = channel.addMessage({
      encoding: c.string,
      onmessage: (frame) => {
        let msg
        try { msg = JSON.parse(frame) } catch { return }
        if (!msg || typeof msg.type !== 'string') return
        if (msg.type === HELLO) handleHelloFrame(conn, msg)
        else if (msg.type === LOG_KEY) handleLogKeyFrame(conn, msg)
        else if (msg.type === REQ_CHECKIN) handleCheckinRequestFrame(conn)
      }
    })
    connToChannel.set(conn, sender)
    channel.open()
    sendHello(conn)

    const drop = () => {
      verifiedConns.delete(conn)
      connToContact.delete(conn)
      connToEncPub.delete(conn)
      connToChannel.delete(conn)
      servedCores.delete(mux)
      for (const [key, c] of conns) {
        if (c === conn) {
          conns.delete(key)
          if (onPeerLeft) onPeerLeft(key)
        }
      }
      emit()
    }
    conn.on('close', drop)
    conn.on('error', drop)
  })

  // Reuse the Protomux that Hypercore replication also attaches to, so both
  // protocols multiplex over one framing layer. Stored on the secret-stream's
  // userData so corelog.js can attach the same mux to core.replicate().
  function getMux (conn) {
    if (conn.userData && Protomux.isProtomux(conn.userData)) return conn.userData
    const mux = Protomux.from(conn)
    conn.userData = mux
    return mux
  }

  // Attach our own local core to a connection's mux so the contact can pull our
  // check-ins. Idempotent per (mux, core) so re-serves after rotation are safe.
  function serveLocalCore (mux) {
    const local = getLocalCore ? getLocalCore() : null
    if (!mux || !local) return
    if (servedCores.get(mux) === local) return
    try { local.replicate(mux) } catch { /* ignore */ }
    servedCores.set(mux, local)
  }

  function sendHello (conn) {
    const sender = connToChannel.get(conn)
    if (!sender) return
    const encPubKey = getEncKeyPair ? b4a.toString(getEncKeyPair().publicKey, 'base64') : null
    const hello = JSON.stringify({
      type: HELLO,
      publicKey: pubToB64(identity.publicKey),
      intervalMs: getIntervalMs ? getIntervalMs() : null,
      coreKey: getLocalCoreKey ? getLocalCoreKey() : null,
      encPubKey
    })
    try { sender.send(hello) } catch { /* ignore */ }
  }

  // Seal our log key to the (verified) peer's enc pub key and send it.
  function sendLogKey (conn, peerEncPubKeyB64) {
    const sender = connToChannel.get(conn)
    const logKey = getLogKey ? getLogKey() : null
    const enc = getEncKeyPair ? getEncKeyPair() : null
    if (!sender || !logKey || !enc || !peerEncPubKeyB64) return
    const box = sealLogKey(logKey, b4a.from(peerEncPubKeyB64, 'base64'))
    const frame = JSON.stringify({ type: LOG_KEY, box: b4a.toString(box, 'base64') })
    try { sender.send(frame) } catch { /* ignore */ }
  }

  function handleHelloFrame (conn, msg) {
    if (typeof msg.publicKey !== 'string') return
    const contactId = byPubKey.get(msg.publicKey)
    if (!contactId) {
      // A peer whose key is not one of our contacts somehow joined our private
      // topic. We can't place them — drop the connection.
      try { conn.destroy() } catch { /* ignore */ }
      return
    }

    const already = conns.get(contactId)
    if (already && already !== conn) {
      // Duplicate connection to the same verified contact — keep the first.
      try { conn.destroy() } catch { /* ignore */ }
      return
    }

    const firstTime = !verifiedConns.has(conn)
    verifiedConns.add(conn)
    conns.set(contactId, conn)
    connToContact.set(conn, contactId)
    // Remember the peer's enc pub key so we can re-share a rotated log key on
    // this live connection (not just the next reconnect).
    if (msg.encPubKey) connToEncPub.set(conn, msg.encPubKey)
    // Once we know the peer's enc pub key, share our log key with them.
    if (msg.encPubKey) sendLogKey(conn, msg.encPubKey)
    emit()
    if (firstTime && onPeerVerified) {
      onPeerVerified(contactId, conn, {
        publicKey: msg.publicKey,
        intervalMs: msg.intervalMs || null,
        coreKey: msg.coreKey || null,
        encPubKey: msg.encPubKey || null
      })
    }
    if (firstTime && onFirstConnection) {
      onFirstConnection(Date.now() - bootTs, contactId)
    }
  }

  function handleLogKeyFrame (conn, msg) {
    const contactId = connToContact.get(conn)
    const enc = getEncKeyPair ? getEncKeyPair() : null
    if (!contactId || !enc || typeof msg.box !== 'string') return
    const logKey = openLogKey(b4a.from(msg.box, 'base64'), enc)
    if (!logKey) return
    if (onLogKey) onLogKey(contactId, logKey)
  }

  // A verified contact asked us to broadcast a check-in. Only ever fires on an
  // active, verified connection (the frame is only accepted on such a conn).
  // Whether we honor it (and how often) is the app's policy (onCheckinRequest).
  function handleCheckinRequestFrame (conn) {
    const contactId = connToContact.get(conn)
    if (!contactId) return
    if (onCheckinRequest) onCheckinRequest(contactId)
  }

  // Join the pair-wise topic for a contact. contact = { id, publicKeyB64 }.
  async function joinContact (contact) {
    if (discoveries.has(contact.id)) return
    const theirKey = b4a.from(contact.publicKeyB64, 'base64')
    const topic = derivePairTopic(identity.publicKey, theirKey)
    const discovery = swarm.join(topic, { server: true, client: true })
    discoveries.set(contact.id, {
      discovery,
      topicHex: b4a.toString(topic, 'hex'),
      publicKeyB64: contact.publicKeyB64
    })
    byPubKey.set(contact.publicKeyB64, contact.id)
    emit()
    discovery.flushed().then(emit, () => {})
  }

  async function leaveContact (contactId) {
    const entry = discoveries.get(contactId)
    if (!entry) return
    discoveries.delete(contactId)
    byPubKey.delete(entry.publicKeyB64)
    const conn = conns.get(contactId)
    if (conn) { try { conn.destroy() } catch { /* ignore */ } conns.delete(contactId) }
    try { await entry.discovery.destroy() } catch { /* ignore */ }
    emit()
  }

  function getConn (contactId) {
    return conns.get(contactId) || null
  }

  // Send a "please check in" request to a verified contact over their active
  // connection. Returns true if sent, false if there's no live verified conn
  // (the contact is offline — the caller decides what to tell the user).
  function sendCheckinRequest (contactId) {
    const conn = conns.get(contactId)
    const sender = conn && connToChannel.get(conn)
    if (!sender) return false
    try {
      sender.send(JSON.stringify({ type: REQ_CHECKIN }))
      return true
    } catch {
      return false
    }
  }

  // Re-broadcast our hello on all verified conns (e.g. after core rotation
  // changes our core key, or our interval changes).
  function refreshHello () {
    for (const conn of conns.values()) sendHello(conn)
  }

  // Re-serve our (possibly rotated) local core on all active connections.
  function refreshLocalCore () {
    for (const conn of conns.values()) serveLocalCore(getMux(conn))
  }

  // Re-seal and re-send our (possibly rotated) log key to all verified peers on
  // live connections, so a rotated key reaches them without waiting for a
  // reconnect. No-op for connections whose enc pub key we don't hold yet.
  function refreshLogKey () {
    for (const conn of conns.values()) {
      const encPub = connToEncPub.get(conn)
      if (encPub) sendLogKey(conn, encPub)
    }
  }

  async function close () {
    for (const cid of [...discoveries.keys()]) await leaveContact(cid)
    await swarm.destroy()
  }

  return { joinContact, leaveContact, getConn, refreshHello, refreshLocalCore, refreshLogKey, sendCheckinRequest, close, state: () => ({ ...state }), swarm }}
