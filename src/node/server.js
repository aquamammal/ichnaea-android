import { WebSocketServer } from 'ws'
import { createMainApp } from '../main/app.js'

const PORT = 14770

const wss = new WebSocketServer({ port: PORT })
console.log(`[ichnaea] WebSocket bridge listening on localhost:${PORT}`)

wss.on('connection', async (ws) => {
  const pipe = {
    write(data) {
      try { ws.send(data) } catch (_) { /* ws closed */ }
    },
    on(event, cb) {
      if (event === 'close') ws.on('close', cb)
      if (event === 'error') ws.on('error', cb)
    }
  }

  let app
  try {
    app = await createMainApp({ pipe })
  } catch (err) {
    console.error('[ichnaea] boot failed:', err.message || err)
    try { ws.send(JSON.stringify({ type: 'error', id: null, message: String(err.message || err) })) } catch (_) {}
    try { ws.close() } catch (_) {}
    return
  }

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch (_) { return }
    app.handleMessage(msg).catch((err) => {
      console.error('[ichnaea] handleMessage error:', err)
    })
  })

  ws.on('close', () => {
    console.log('[ichnaea] renderer pipe closed')
  })
})

wss.on('error', (err) => {
  console.error('[ichnaea] WebSocket error:', err.message || err)
})
