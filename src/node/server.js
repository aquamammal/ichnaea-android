import ws from 'bare-ws'
import UDX from 'udx-native'
import { createMainApp } from '../main/app.js'

// Ichnaea Android bridge. Runs under the Bare runtime (the NodeJS-Mobile swap)
// and still under plain Node for local debugging via `node src/node/server.js`.
//
// TRANSPORT: the WebView connects to this WebSocket server on localhost:14770.
// The protocol is unchanged — newline/JSON messages exactly as before. The
// socket library is bare-ws (Holepunch's Bare WebSocket lib) instead of Node's
// `ws`, because `ws` cannot load under Bare (it needs node:events/http/net).
// bare-ws uses a streamx API: `socket.on('data')` instead of `on('message')`,
// and `socket.write(...)` instead of `socket.send(...)`.
//
// PORTABILITY: Bare does not inject a `process` global (only `Bare`), and has
// no node:readline / node:dgram. The stdin lifecycle channel and the UDP probe
// are therefore guarded so they work on both runtimes.

// Bare has no `process` global; the port env var is only ever set in tests.
const NODE_RUNTIME = typeof process !== 'undefined' && process.versions && process.versions.node
const ENV = NODE_RUNTIME ? process.env : null
const PORT = Number((ENV && ENV.ICHNAEA_PORT) || 0) || 14770

const wss = new ws.Server({ port: PORT }, onConnection)
wss.on('error', (err) => {
  console.error('[ichnaea] WebSocket error:', (err && err.message) || err)
})
console.log(`[ichnaea] WebSocket bridge listening on localhost:${PORT}`)

// Kotlin -> runtime lifecycle channel. The Android NodeService writes JSON lines
// to our stdin on network changes, so we can suspend/resume the Hyperswarm DHT
// instead of letting sockets silently rot. On Node that is process.stdin; on
// Bare it comes from require('bare-process').stdin (the child's fd 0).
async function attachStdin () {
  let input = null
  if (NODE_RUNTIME && process.stdin) {
    input = process.stdin
  } else {
    try {
      const proc = await import('bare-process')
      input = (proc.default || proc).stdin
    } catch {
      input = null
    }
  }
  if (!input) return
  let buf = ''
  input.on('data', (chunk) => {
    buf += String(chunk)
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      handleLifecycleLine(line)
    }
  })
}

function handleLifecycleLine (line) {
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
}

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
  for (const socket of connections) {
    try { socket.write(data) } catch (_) { /* socket closed */ }
  }
}

function onConnection (socket) {
  connections.add(socket)

  // Route renderer -> app requests.
  socket.on('data', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch (_) { return }
    if (msg.type === 'udp:test') {
      handleUdpTest(msg, socket)
      return
    }
    getApp()
      .then((app) => app.handleMessage(msg).catch((err) => console.error('[ichnaea] handleMessage error:', err)))
      .catch((err) => {
        try { socket.write(JSON.stringify({ type: 'error', id: msg && msg.id, message: String((err && err.message) || err) })) } catch (_) {}
      })
  })

  socket.on('close', () => {
    connections.delete(socket)
    console.log('[ichnaea] renderer pipe closed')
  })

  getApp()
    .then(() => console.log('[ichnaea] app ready'))
    .catch((err) => {
      console.error('[ichnaea] boot failed:', (err && err.message) || err)
      try { socket.write(JSON.stringify({ type: 'error', id: null, message: String((err && err.message) || err) })) } catch (_) {}
    })
}

// UDP connectivity self-test — the DHT depends on udx-native UDP, which is the
// risky piece on a mobile runtime. Echoes against the given host:port. On Bare
// there is no node:dgram, so only the udx-native probe runs there.
function handleUdpTest (msg, socket) {
  const host = msg.host || '127.0.0.1'
  const port = msg.port || 14999
  const respond = (info) => {
    try { socket.write(JSON.stringify({ type: 'udp:test', id: msg.id, ok: !!info.ok, ...info })) } catch (_) {}
  }

  // 1) udx-native (the DHT transport)
  try {
    const udx = new UDX()
    const udxSocket = udx.createSocket()
    udxSocket.bind(0, '0.0.0.0')
    const fail = (error) => {
      respond({ via: 'udx-native', ok: false, error })
      try { udxSocket.close() } catch (_) {}
      try { udx.close() } catch (_) {}
    }
    udxSocket.once('message', (buf, rinfo) => {
      respond({ via: 'udx-native', ok: true, echo: buf.toString(), from: rinfo.host + ':' + rinfo.port })
      try { udxSocket.close() } catch (_) {}
      try { udx.close() } catch (_) {}
    })
    udxSocket.send(Buffer.from('ping'), port, host)
      .then(() => setTimeout(() => fail('echo timeout after 4s'), 4000))
      .catch((err) => fail(String((err && err.message) || err)))
  } catch (err) {
    respond({ via: 'udx-native', ok: false, error: 'threw: ' + ((err && err.message) || err) })
  }

  // 2) node:dgram (libuv UDP) — distinguishes udx-native issues from no-UDP-at-all.
  //    Only available under Node; skipped on Bare.
  if (!NODE_RUNTIME) return
  import('node:dgram')
    .then((dgram) => {
      try {
        const s = dgram.default.createSocket('udp4')
        s.send(Buffer.from('ping-dgram'), port, host, (err) => {
          if (err) return respond({ via: 'dgram', ok: false, error: String(err) })
          const timer = setTimeout(() => { respond({ via: 'dgram', ok: false, error: 'echo timeout' }); try { s.close() } catch (_) {} }, 4000)
          s.once('message', (m) => { clearTimeout(timer); respond({ via: 'dgram', ok: true, echo: m.toString() }); try { s.close() } catch (_) {} })
        })
      } catch (err) {
        respond({ via: 'dgram', ok: false, error: 'threw: ' + ((err && err.message) || err) })
      }
    })
    .catch((err) => respond({ via: 'dgram', ok: false, error: 'unavailable: ' + String((err && err.message) || err) }))
}

attachStdin()
