import { WebSocketServer } from 'ws'
import { createMainApp } from '../main/app.js'

const PORT = 14770

const wss = new WebSocketServer({ port: PORT })
console.log(`[ichnaea] WebSocket bridge listening on localhost:${PORT}`)

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
