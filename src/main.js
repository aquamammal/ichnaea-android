import { classify, humanize, formatLocal, STATUS } from './staleness.js'
import { createGlobeRenderer } from './globe-renderer.js'

// Renderer for Ichnaea Android. This is a THIN PIPE CLIENT: it owns only the
// globe, the UI, and geolocation. ALL P2P state (identity, contacts, the local
// Hypercore, the swarm, the scheduler) lives in the NodeJS-Mobile main process
// and arrives over a localhost WebSocket as JSON.

// --- element helpers ---------------------------------------------------------
const $ = (id) => document.getElementById(id)
const els = {
  peerDot: $('peer-dot'), peerStatus: $('peer-status'), gpsStatus: $('gps-status'),
  myPubkey: $('my-pubkey'), contactsList: $('contacts-list'),
  panelTopleft: $('panel-topleft'), panelContacts: $('panel-contacts'),
  modalAdd: $('modal-add'), addNick: $('add-nickname'), addPub: $('add-pubkey'), addErr: $('add-error'),
  modalSet: $('modal-settings'), setInterval: $('set-interval'), setErr: $('set-error'),
  manualLat: $('manual-lat'), manualLng: $('manual-lng'), manualEnabled: $('manual-enabled'),
  pinScale: $('set-pinsize'), pinsizeVal: $('pinsize-val'),
  pinOverlay: $('pin-overlay'), pinName: $('pin-name'), pinTime: $('pin-time'), pinAgo: $('pin-ago'), pinStatus: $('pin-status'), pinCoords: $('pin-coords'),
  toast: $('toast'), devPanel: $('dev-panel'), devStatus: $('dev-status'), versionTag: $('version-tag')
}

const INTERVALS = [
  { label: '1 Hour', ms: 3600000 },
  { label: '6 Hours', ms: 21600000 },
  { label: '12 Hours', ms: 43200000 },
  { label: '1 Day', ms: 86400000 },
  { label: '3 Days', ms: 259200000 },
  { label: '1 Week', ms: 604800000 }
]
const DEFAULT_INTERVAL_MS = 86400000
const GPS_TIMEOUT_MS = 15000

function toast (msg, ms = 2600) {
  els.toast.textContent = msg
  els.toast.classList.add('show')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => els.toast.classList.remove('show'), ms)
}

function setGpsStatus (msg) { els.gpsStatus.textContent = 'Location: ' + msg }

// --- state -------------------------------------------------------------------
const state = {
  globe: null,
  intervalMs: DEFAULT_INTERVAL_MS,
  contacts: [],
  manual: { enabled: false, lat: null, lng: null },
  pinScale: 1
}

// --- globe -------------------------------------------------------------------
function initGlobe () {
  state.globe = createGlobeRenderer($('globe'), { onPinClick: showPinOverlay })
}

function showPinOverlay (data) {
  if (data.self) {
    els.pinName.textContent = 'You'
    els.pinTime.textContent = '\u2014'
    els.pinAgo.textContent = '\u2014'
    els.pinStatus.textContent = 'self'
    els.pinCoords.textContent = (typeof data.lat === 'number' && typeof data.lng === 'number')
      ? round(data.lat) + ', ' + round(data.lng)
      : '\u2014'
  } else {
    const c = data.contact
    els.pinName.textContent = c.nickname || 'Contact'
    els.pinTime.textContent = formatLocal(c.lastSeenTs)
    els.pinAgo.textContent = humanize(c.lastSeenTs)
    els.pinStatus.textContent = data.status
    els.pinCoords.textContent = (typeof data.lat === 'number' && typeof data.lng === 'number')
      ? round(data.lat) + ', ' + round(data.lng)
      : '\u2014'
  }
  els.pinOverlay.style.display = 'block'
  els.pinOverlay.style.left = '50%'
  els.pinOverlay.style.top = '18%'
  els.pinOverlay.style.transform = 'translateX(-50%)'
}
$('pin-close').addEventListener('click', () => { els.pinOverlay.style.display = 'none' })

// --- WebSocket pipe client ---------------------------------------------------
const WS_URL = 'ws://localhost:14770'
let ws = null
const pending = new Map()
let reqSeq = 0

function request (type, payload = {}, timeoutMs = 8000) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('No connection to main process'))
  const id = 'r-' + (++reqSeq) + '-' + Date.now()
  try { ws.send(JSON.stringify({ id, type, ...payload })) } catch (err) { return Promise.reject(err) }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      reject(new Error('Request timed out: ' + type))
    }, timeoutMs)
  })
}

function getPositionOnce () {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation not available'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: false, timeout: GPS_TIMEOUT_MS, maximumAge: 60000 }
    )
  })
}

function handlePush (msg) {
  if (!msg || typeof msg !== 'object') return

  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.type === 'error') p.reject(new Error(msg.message || 'error'))
    else p.resolve(msg)
  }

  switch (msg.type) {
    case 'peers': {
      els.peerDot.classList.toggle('on', msg.verified > 0)
      els.peerStatus.textContent = msg.verified > 0
        ? `${msg.verified} contact${msg.verified === 1 ? '' : 's'} connected`
        : (state.contacts.length ? 'Waiting for contacts\u2026' : 'No contacts yet')
      break
    }
    case 'contact:update': {
      upsertContact(msg.contact)
      break
    }
    case 'contact:remove-pin': {
      state.globe.removeContactPin(msg.contactId)
      break
    }
    case 'self': {
      state.globe.setSelf({ lat: msg.lat, lng: msg.lng })
      setGpsStatus(statusSuffix('checked in ' + humanize(msg.timestamp)))
      break
    }
    case 'gps:request': {
      getPositionOnce()
        .then(({ lat, lng }) => ws.send(JSON.stringify({ type: 'gps:result', id: msg.id, lat, lng })))
        .catch((err) => ws.send(JSON.stringify({ type: 'gps:result', id: msg.id, error: String((err && err.message) || err) })))
      break
    }
    case 'status': {
      setGpsStatus(statusSuffix(msg.message))
      break
    }
  }
}

function statusSuffix (msg) {
  const m = state.manual
  if (m && m.enabled && typeof m.lat === 'number' && typeof m.lng === 'number') {
    return `${msg} \u00b7 manual: ${round(m.lat)},${round(m.lng)}`
  }
  return msg
}
function round (n) { return Math.round(n * 10000) / 10000 }

function upsertContact (contact) {
  if (!contact) return
  const i = state.contacts.findIndex((c) => c.id === contact.id)
  if (i >= 0) state.contacts[i] = { ...state.contacts[i], ...contact }
  else state.contacts.push(contact)

  const status = classify(contact.lastSeenTs, contact.intervalMs)
  if (status === STATUS.OFFLINE) {
    state.globe.removeContactPin(contact.id)
  } else if (typeof contact.lat === 'number' && typeof contact.lng === 'number') {
    state.globe.upsertContactPin(contact, { lat: contact.lat, lng: contact.lng }, status === STATUS.STALE ? 'stale' : 'active')
  }
  renderContactsList()
}

function startStalenessSweep () {
  setInterval(() => {
    for (const c of state.contacts) {
      const status = classify(c.lastSeenTs, c.intervalMs)
      if (status === STATUS.OFFLINE && state.globe.hasPin(c.id)) {
        state.globe.removeContactPin(c.id)
      } else if (status === STATUS.STALE && state.globe.hasPin(c.id)) {
        state.globe.upsertContactPin(c, pinCoords(c.id), 'stale')
      }
    }
    renderContactsList()
  }, 30000)
}

function pinCoords (contactId) {
  const c = state.contacts.find((x) => x.id === contactId)
  return { lat: c.lat, lng: c.lng }
}

// --- contacts UI -------------------------------------------------------------
function renderContactsList () {
  const list = els.contactsList
  if (!state.contacts.length) {
    list.innerHTML = '<div class="empty">No contacts yet. Add one to begin.</div>'
    return
  }
  list.innerHTML = ''
  for (const c of state.contacts) {
    const item = document.createElement('div')
    item.className = 'contact-item'
    const status = classify(c.lastSeenTs, c.intervalMs)
    const dot = document.createElement('span')
    dot.className = 'dot' + (status === STATUS.ACTIVE ? ' on' : '')
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = c.nickname
    const ago = document.createElement('span')
    ago.className = 'ago'
    ago.textContent = c.lastSeenTs ? humanize(c.lastSeenTs) : 'never'
    const rm = document.createElement('button')
    rm.className = 'rm'
    rm.textContent = '\u00d7'
    rm.title = 'Remove contact'
    rm.addEventListener('click', () => onRemoveContact(c))
    const top = document.createElement('div')
    top.className = 'contact-top'
    top.append(dot, name, ago, rm)
    item.appendChild(top)
    if (typeof c.lat === 'number' && typeof c.lng === 'number') {
      const coords = document.createElement('div')
      coords.className = 'contact-coords'
      coords.textContent = round(c.lat) + ', ' + round(c.lng)
      item.appendChild(coords)
    }
    list.appendChild(item)
  }
}

async function onRemoveContact (c) {
  if (!confirm(`Remove ${c.nickname}? This leaves the shared swarm.`)) return
  try {
    await request('contact:remove', { contactId: c.id })
    state.contacts = state.contacts.filter((x) => x.id !== c.id)
    state.globe.removeContactPin(c.id)
    renderContactsList()
    toast('Contact removed')
  } catch (err) {
    toast('Remove failed: ' + String(err.message || err))
  }
}

// --- UI wiring ---------------------------------------------------------------
function initUI () {
  for (const opt of INTERVALS) {
    const o = document.createElement('option')
    o.value = String(opt.ms)
    o.textContent = opt.label
    els.setInterval.appendChild(o)
  }
  els.setInterval.value = String(state.intervalMs)

  $('btn-add-contact').addEventListener('click', () => openModal(els.modalAdd))
  $('btn-settings').addEventListener('click', () => {
    els.setInterval.value = String(state.intervalMs)
    els.pinScale.value = String(state.pinScale)
    els.pinsizeVal.textContent = state.pinScale.toFixed(1) + '×'
    syncManualUI()
    openModal(els.modalSet)
  })
  $('add-cancel').addEventListener('click', () => closeModal(els.modalAdd))
  $('set-cancel').addEventListener('click', () => closeModal(els.modalSet))
  $('add-confirm').addEventListener('click', onAddContact)
  $('set-confirm').addEventListener('click', onSaveSettings)
  $('btn-checkin-now').addEventListener('click', onCheckinNow)

  // Minimize/expand the panels.
  const toggleMin = (panel, btn) => {
    const collapsed = panel.classList.toggle('collapsed')
    btn.textContent = collapsed ? '+' : '–'
    btn.title = collapsed ? 'Expand' : 'Minimize'
  }
  $('min-beacon').addEventListener('click', () => toggleMin(els.panelTopleft, $('min-beacon')))
  $('min-contacts').addEventListener('click', () => toggleMin(els.panelContacts, $('min-contacts')))


  // Pin size slider (persisted in localStorage).
  els.pinScale.addEventListener('input', () => {
    const v = parseFloat(els.pinScale.value)
    state.pinScale = v
    els.pinsizeVal.textContent = v.toFixed(1) + '×'
    try { window.localStorage.setItem('pinScale', String(v)) } catch { /* ignore */ }
    if (state.globe && typeof state.globe.setPinScale === 'function') state.globe.setPinScale(v)
  })
  // Load saved prefs into the controls and the current globe.
  try {
    const ps = parseFloat(window.localStorage.getItem('pinScale'))
    if (isFinite(ps) && ps > 0) { state.pinScale = ps; els.pinScale.value = String(ps); els.pinsizeVal.textContent = ps.toFixed(1) + '×' }
  } catch { /* ignore */ }
  if (state.globe && typeof state.globe.setPinScale === 'function') state.globe.setPinScale(state.pinScale)

  $('btn-manual-checkin').addEventListener('click', onManualCheckin)
  els.manualEnabled.addEventListener('change', onManualToggle)

  els.myPubkey.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(els.myPubkey.textContent)
      toast('Public key copied')
    } catch { toast('Copy failed \u2014 select and copy manually') }
  })

  els.versionTag.addEventListener('dblclick', () => { syncGlobeToggleLabel(); els.devPanel.classList.toggle('open') })
  $('btn-dev-close').addEventListener('click', () => els.devPanel.classList.remove('open'))
  $('btn-force-200').addEventListener('click', onForce200)
  $('btn-toggle-globe').addEventListener('click', onToggleGlobe)
}

function currentGlobeMode () {
  try {
    const q = (window.location && window.location.search) || ''
    if (/[?&]globe=3d/.test(q)) return '3d'
    if (/[?&]globe=2d/.test(q)) return '2d'
    const stored = window.localStorage && window.localStorage.getItem('globe')
    if (stored === '3d') return '3d'
    if (stored === '2d') return '2d'
  } catch { /* ignore */ }
  // Default to the 3D globe on mobile; desktop keeps the lightweight 2D map.
  try { if (/Android/i.test(navigator.userAgent)) return '3d' } catch { /* ignore */ }
  return '2d'
}

function syncGlobeToggleLabel () {
  const btn = $('btn-toggle-globe')
  if (btn) btn.textContent = currentGlobeMode() === '3d' ? 'Use 2D map' : 'Try 3D globe'
}

function onToggleGlobe () {
  const next = currentGlobeMode() === '3d' ? '2d' : '3d'
  try { window.localStorage.setItem('globe', next) } catch { /* ignore */ }
  toast(next === '3d' ? 'Reloading with 3D globe\u2026' : 'Reloading with 2D map\u2026')
  setTimeout(() => window.location.reload(), 300)
}

function openModal (m) { m.classList.add('open') }
function closeModal (m) { m.classList.remove('open'); const e = m.querySelector('.form-error'); if (e) e.textContent = '' }

function syncManualUI () {
  const m = state.manual || {}
  els.manualEnabled.checked = Boolean(m.enabled)
  if (typeof m.lat === 'number') els.manualLat.value = String(m.lat)
  if (typeof m.lng === 'number') els.manualLng.value = String(m.lng)
}

function readManualInputs () {
  const lat = parseFloat(els.manualLat.value)
  const lng = parseFloat(els.manualLng.value)
  if (!isFinite(lat) || lat < -90 || lat > 90) throw new Error('Latitude must be \u221290..90')
  if (!isFinite(lng) || lng < -180 || lng > 180) throw new Error('Longitude must be \u2212180..180')
  return { lat, lng }
}

async function onAddContact () {
  els.addErr.textContent = ''
  try {
    const res = await request('contact:add', { nickname: els.addNick.value, publicKeyB64: els.addPub.value })
    upsertContact(res.contact)
    closeModal(els.modalAdd)
    els.addNick.value = ''; els.addPub.value = ''
    toast(`Added ${res.contact.nickname}`)
  } catch (err) {
    els.addErr.textContent = String(err.message || err)
  }
}

async function onSaveSettings () {
  const ms = parseInt(els.setInterval.value, 10)
  if (!ms || ms <= 0) { els.setErr.textContent = 'Pick a valid interval'; return }
  try {
    await saveManual()
    const res = await request('interval:set', { intervalMs: ms })
    state.intervalMs = res.intervalMs
    closeModal(els.modalSet)
    toast('Settings saved')
  } catch (err) {
    els.setErr.textContent = String(err.message || err)
  }
}

async function onCheckinNow () {
  setGpsStatus(statusSuffix('requesting\u2026'))
  try {
    await request('checkin:now')
  } catch (err) {
    setGpsStatus(statusSuffix('unavailable'))
    toast('Location unavailable \u2014 check permission')
  }
}

async function onManualCheckin () {
  els.setErr.textContent = ''
  try {
    const { lat, lng } = readManualInputs()
    state.manual = { ...state.manual, lat, lng }
    if (state.globe && typeof state.globe.setSelf === 'function') {
      state.globe.setSelf({ lat, lng })
    }
    await request('checkin:manual', { lat, lng })
    toast(`Checked in at ${round(lat)},${round(lng)}`)
  } catch (err) {
    els.setErr.textContent = String(err.message || err)
  }
}

async function onManualToggle () {
  try {
    await saveManual()
    toast(els.manualEnabled.checked ? 'Manual location enabled' : 'Manual location disabled')
  } catch (err) {
    els.setErr.textContent = String(err.message || err)
    els.manualEnabled.checked = Boolean(state.manual && state.manual.enabled)
  }
}

async function saveManual () {
  let lat = state.manual ? state.manual.lat : null
  let lng = state.manual ? state.manual.lng : null
  if (els.manualLat.value !== '' && els.manualLng.value !== '') {
    const c = readManualInputs()
    lat = c.lat; lng = c.lng
  }
  const enabled = els.manualEnabled.checked
  const res = await request('manual:set', { enabled, lat, lng })
  state.manual = res.manual
  setGpsStatus(statusSuffix(els.gpsStatus.textContent.replace(/^Location: /, '').split(' \u00b7 manual:')[0]))
}

async function onForce200 () {
  els.devStatus.textContent = 'forcing\u2026'
  try {
    await request('dev:force200', {}, 30000)
    els.devStatus.textContent = 'rotated.'
  } catch (err) {
    els.devStatus.textContent = 'error: ' + String(err.message || err)
  }
}

// --- boot --------------------------------------------------------------------
function connect () {
  initGlobe()
  initUI()
  startStalenessSweep()

  ws = new WebSocket(WS_URL)
  ws.onopen = async () => {
    setGpsStatus('connected \u00b7 awaiting first check-in')
    try {
      const res = await request('boot')
      els.myPubkey.textContent = res.publicKeyB64
      state.intervalMs = res.intervalMs || DEFAULT_INTERVAL_MS
      els.setInterval.value = String(state.intervalMs)
      state.manual = res.manual || { enabled: false, lat: null, lng: null }
      state.contacts = res.contacts || []
      if (res.selfLoc) state.globe.setSelf(res.selfLoc)
      renderContactsList()
    } catch (err) {
      setGpsStatus('no connection to main process')
      console.error('boot error:', err)
    }
  }
  ws.onmessage = (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    handlePush(msg)
  }
  ws.onclose = () => { setGpsStatus('connection closed \u00b7 reconnecting\u2026'); setTimeout(connect, 2000) }
  ws.onerror = () => {}
}

// --- start -------------------------------------------------------------------
function showFatal (msg) {
  els.peerStatus.textContent = 'Error: ' + msg
  els.peerDot.classList.remove('on')
  let box = document.getElementById('fatal-box')
  if (!box) {
    box = document.createElement('div')
    box.id = 'fatal-box'
    box.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:99;background:rgba(80,10,10,0.92);color:#ffd7d7;border:1px solid #ff6b6b;border-radius:10px;padding:10px 14px;font:12px ui-monospace,monospace;max-width:80vw;white-space:pre-wrap;'
    document.body.appendChild(box)
  }
  box.textContent = 'Boot error:\n' + msg
}
window.addEventListener('error', (e) => showFatal(String(e.message || e.error || e)))
window.addEventListener('unhandledrejection', (e) => showFatal(String((e.reason && e.reason.message) || e.reason || e)))

connect()
