import { WebSocketServer } from 'ws'
import { createInterface } from 'node:readline'
import { createMainApp } from '../main/app.js'

const PORT = 14770

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

// One P2P app instance for the process lifetime. The WebView may reconnect
// (suspend/resume, app restart) — each connection re-targets the same pipe so
// state (identity, contacts, swarm, Hypercore lock) is preserved.
let appPromise = null
let currentPipe = { write () {} } // mutated to the active ws

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

wss.on('connection', async (ws) => {
  // Route app -> renderer pushes to this connection.
  currentPipe.write = (data) => {
    try { ws.send(data) } catch (_) { /* ws closed */ }
  }

  // Route renderer -> app requests.
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch (_) { return }
    getApp()
      .then((app) => app.handleMessage(msg).catch((err) => console.error('[ichnaea] handleMessage error:', err)))
      .catch((err) => {
        try { ws.send(JSON.stringify({ type: 'error', id: msg && msg.id, message: String((err && err.message) || err) })) } catch (_) {}
      })
  })

  ws.on('close', () => {
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
