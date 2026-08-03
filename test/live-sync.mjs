// Live two-peer sync test: Android phone (via `adb forward tcp:14771 tcp:14770`)
// against a Linux peer running the same P2P stack (node src/node/server.js).
// Verifies the E2E encrypted log-key exchange AND core replication: each side
// must decrypt the other's check-in (lastSeenTs advances) over the live DHT.
//
// Prereq: adb forward tcp:14771 tcp:14770, app running on the device.
// Run: node test/live-sync.mjs
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PHONE_WS = 'ws://localhost:14771' // adb forward -> device bridge
const LINUX_WS = 'ws://localhost:14770' // local Linux peer bridge

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function connect (url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => reject(new Error('connect timeout ' + url)), 15000)
    ws.on('open', () => { clearTimeout(timer); resolve(ws) })
    ws.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

function req (ws, type, payload = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = 'r-' + Math.random().toString(36).slice(2)
    const onmsg = (d) => {
      let msg
      try { msg = JSON.parse(d.toString()) } catch { return }
      if (msg.id !== id) return
      clearTimeout(timer)
      ws.off('message', onmsg)
      if (msg.type === 'error') reject(new Error(msg.message))
      else resolve(msg)
    }
    const timer = setTimeout(() => { ws.off('message', onmsg); reject(new Error('timeout ' + type)) }, timeoutMs)
    ws.on('message', onmsg)
    ws.send(JSON.stringify({ id, type, ...payload }))
  })
}

async function contacts (ws) {
  const b = await req(ws, 'boot', {}, 15000)
  return b.contacts || []
}

async function main () {
  const linux = spawn('node', ['src/node/server.js'], { cwd: PROJECT, stdio: ['ignore', 'pipe', 'pipe'] })
  linux.stdout.on('data', (d) => process.stdout.write('[linux] ' + d.toString()))
  linux.stderr.on('data', (d) => process.stdout.write('[linux!] ' + d.toString()))
  await sleep(3500)

  const phone = await connect(PHONE_WS)
  const linuxWs = await connect(LINUX_WS)

  const keyA = (await req(phone, 'boot')).publicKeyB64
  const keyB = (await req(linuxWs, 'boot')).publicKeyB64
  console.log('phone  key:', keyA.slice(0, 18) + '...')
  console.log('linux  key:', keyB.slice(0, 18) + '...')

  await req(phone, 'contact:add', { nickname: 'LinuxPeer', publicKeyB64: keyB })
  console.log('[phone] added LinuxPeer')
  await req(linuxWs, 'contact:add', { nickname: 'AndroidPeer', publicKeyB64: keyA })
  console.log('[linux] added AndroidPeer')

  await req(phone, 'checkin:manual', { lat: 37.7749, lng: -122.4194 })
  console.log('[phone] checked in at SF')
  await req(linuxWs, 'checkin:manual', { lat: 48.8566, lng: 2.3522 })
  console.log('[linux] checked in at Paris')

  let phoneSeen = false
  let linuxSeen = false
  const deadline = Date.now() + 180000
  while (Date.now() < deadline && (!phoneSeen || !linuxSeen)) {
    await sleep(5000)
    const pc = await contacts(phone)
    const lc = await contacts(linuxWs)
    const phoneContact = pc.find((c) => c.nickname === 'LinuxPeer')
    const linuxContact = lc.find((c) => c.nickname === 'AndroidPeer')
    phoneSeen = !!(phoneContact && phoneContact.lastSeenTs > 0)
    linuxSeen = !!(linuxContact && linuxContact.lastSeenTs > 0)
    console.log(`poll: phone->linux lastSeen=${phoneContact ? phoneContact.lastSeenTs : 'none'} | linux->phone lastSeen=${linuxContact ? linuxContact.lastSeenTs : 'none'}`)
  }

  console.log('RESULT:', phoneSeen && linuxSeen ? 'LIVE SYNC PASS (both directions)' : 'LIVE SYNC FAIL')
  linux.kill('SIGTERM')
  process.exit(phoneSeen && linuxSeen ? 0 : 1)
}

main().catch((e) => { console.error('TEST ERROR:', e.message); process.exit(1) })
