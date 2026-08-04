import { WebSocketServer } from 'ws'
import { createInterface } from 'node:readline'
import dgram from 'node:dgram'
import UDX from 'udx-native'
import { createMainApp } from '../main/app.js'

const PORT = Number(process.env.ICHNAEA_PORT) || 14770

const wss = new WebSocketServer({ port: PORT })
console.log(`[ichnaea] WebSocket bridge listening on localhost:${PORT}`)

// Kotlin -> Node lifecycle channel. The Android NodeService writes JSON lines to
// our stdin (a socketpair wired in the JNI bridge) on network changes, so we can
// suspend/resume the Hyperswarm DHT instead of letting sockets silently rot.
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch (_) { return }
  if (msg.type !== 'network') return
  getApp()
    .then((app) => {
      if (msg.action === 'suspend') {
        console.log('[ichnaea] lifecycle: suspending swarm')
        return app.suspend()
      }
      if (msg.action === 'resume') {
        console.log('[ichnaea] lifecycle: resuming swarm')
        return app.resume()
      }
    })
    .catch((err) => console.error('[ichnaea] lifecycle error:', err))
})

// One P2P app instance for the process lifetime. Multiple renderer connections
// (the WebView + diagnostics) share it: app -> renderer messages are broadcast
// to every connection, and each client matches replies by request id. State
// (identity, contacts, swarm, Hypercore lock) is preserved across reconnects.
const connections = new Set()
let appPromise = null
let currentPipe = { write () {} } // broadcasts to all connected renderers

function getApp () {
  if (!appPromise) {
    appPromise = createMainApp({ pipe: currentPipe })
      .catch((err) => {
        appPromise = null // allow a retry on the next connection
        throw err
      })
  }
  return appPromise
}

currentPipe.write = (data) => {
  for (const ws of connections) {
    try { ws.send(data) } catch (_) { /* ws closed */ }
  }
}

wss.on('connection', async (ws) => {
  connections.add(ws)

  // Route renderer -> app requests.
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch (_) { return }
    if (msg.type === 'udp:test') {
      handleUdpTest(msg, ws)
      return
    }
    getApp()
      .then((app) => app.handleMessage(msg).catch((err) => console.error('[ichnaea] handleMessage error:', err)))
      .catch((err) => {
        try { ws.send(JSON.stringify({ type: 'error', id: msg && msg.id, message: String((err && err.message) || err) })) } catch (_) {}
      })
  })

  ws.on('close', () => {
    connections.delete(ws)
    console.log('[ichnaea] renderer pipe closed')
  })

  try {
    await getApp()
    console.log('[ichnaea] app ready')
  } catch (err) {
    console.error('[ichnaea] boot failed:', err.message || err)
    try { ws.send(JSON.stringify({ type: 'error', id: null, message: String((err && err.message) || err) })) } catch (_) {}
  }
})

wss.on('error', (err) => {
  console.error('[ichnaea] WebSocket error:', err.message || err)
})

// UDP connectivity self-test — the DHT depends on udx-native UDP, which is the
// risky piece on NodeJS-Mobile. Echoes against the given host:port.
function handleUdpTest (msg, ws) {
  const host = msg.host || '127.0.0.1'
  const port = msg.port || 14999
  const respond = (info) => {
    try { ws.send(JSON.stringify({ type: 'udp:test', id: msg.id, ok: !!info.ok, ...info })) } catch (_) {}
  }

  // 1) udx-native (the DHT transport)
  try {
    const udx = new UDX()
    const socket = udx.createSocket()
    socket.bind(0, '0.0.0.0')
    const fail = (error) => {
      respond({ via: 'udx-native', ok: false, error })
      try { socket.close() } catch (_) {}
      try { udx.close() } catch (_) {}
    }
    socket.once('message', (buf, rinfo) => {
      respond({ via: 'udx-native', ok: true, echo: buf.toString(), from: rinfo.host + ':' + rinfo.port })
      try { socket.close() } catch (_) {}
      try { udx.close() } catch (_) {}
    })
    socket.send(Buffer.from('ping'), port, host)
      .then(() => setTimeout(() => fail('echo timeout after 4s'), 4000))
      .catch((err) => fail(String((err && err.message) || err)))
  } catch (err) {
    respond({ via: 'udx-native', ok: false, error: 'threw: ' + ((err && err.message) || err) })
  }

  // 2) node:dgram (libuv UDP) — distinguishes udx-native issues from no-UDP-at-all.
  try {
    const s = dgram.createSocket('udp4')
    s.send(Buffer.from('ping-dgram'), port, host, (err) => {
      if (err) return respond({ via: 'dgram', ok: false, error: String(err) })
      const timer = setTimeout(() => { respond({ via: 'dgram', ok: false, error: 'echo timeout' }); try { s.close() } catch (_) {} }, 4000)
      s.once('message', (m) => { clearTimeout(timer); respond({ via: 'dgram', ok: true, echo: m.toString() }); try { s.close() } catch (_) {} })
    })
  } catch (err) {
    respond({ via: 'dgram', ok: false, error: 'threw: ' + ((err && err.message) || err) })
  }
}
