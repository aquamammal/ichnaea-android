import { classify, humanize, formatLocal, STATUS } from './staleness.js'
import { createRenderer } from './renderer.js'
import { MAP_STYLES, getMapStyleId, setMapStyleId, getColored, setColored, getArcs, setArcs } from './map-styles.js'
import QRCode from 'qrcode/lib/browser.js'
import { openScanner } from './scanner.js'
import { checkForUpdates } from './updates.js'
import { fingerprint } from './fingerprint.js'

// Renderer for Ichnaea Android. This is a THIN PIPE CLIENT: it owns only the
// globe, the UI, and geolocation. ALL P2P state (identity, contacts, the local
// Hypercore, the swarm, the scheduler) lives in the NodeJS-Mobile main process
// and arrives over a localhost WebSocket as JSON.

// --- element helpers ---------------------------------------------------------
const $ = (id) => document.getElementById(id)
const els = {
  peerDot: $('peer-dot'), peerStatus: $('peer-status'), gpsStatus: $('gps-status'),
  myPubkey: $('my-pubkey'), contactsList: $('contacts-list'),
  btnQr: $('btn-qr'), modalQr: $('modal-qr'), qrCanvas: $('qr-canvas'), qrKey: $('qr-key'), qrClose: $('qr-close'),
  colorToggle: $('btn-color-countries'), colorVal: $('color-countries-val'),
  arcsToggle: $('btn-arcs'), arcsVal: $('arcs-val'),
  panelTopleft: $('panel-topleft'), panelContacts: $('panel-contacts'),
  modalAdd: $('modal-add'), addNick: $('add-nickname'), addPub: $('add-pubkey'), addErr: $('add-error'), addFingerprint: $('add-fingerprint'), btnScanQr: $('btn-scan-qr'),
  modalSet: $('modal-settings'), setErr: $('set-error'), setMapStyle: $('set-mapstyle'),
  setFreqMin: $('set-freq-min'), setFreqUnit: $('set-freq-unit'), freqDisplay: $('freq-display'),
  setPrecision: $('set-precision'),
  setSelfName: $('set-selfname'),
  btnCheckUpdates: $('btn-check-updates'), btnUpdateNow: $('btn-update-now'), updatesStatus: $('updates-status'), updatesDetail: $('updates-detail'),
  manualLat: $('manual-lat'), manualLng: $('manual-lng'), manualEnabled: $('manual-enabled'),
  pinScale: $('set-pinsize'), pinsizeVal: $('pinsize-val'),
  pinOverlay: $('pin-overlay'), pinName: $('pin-name'), pinTime: $('pin-time'), pinAgo: $('pin-ago'), pinStatus: $('pin-status'), pinCoords: $('pin-coords'), pinFingerprint: $('pin-fingerprint'),
  toast: $('toast'), devPanel: $('dev-panel'), devStatus: $('dev-status'), versionTag: $('version-tag')
}

// Broadcast frequency: user picks a number + unit (minutes / hours / days).
const FREQ_UNITS = [
  { id: 'minutes', ms: 60000, label: 'minutes' },
  { id: 'hours', ms: 3600000, label: 'hours' },
  { id: 'days', ms: 86400000, label: 'days' }
]
const DEFAULT_INTERVAL_MS = 86400000

// Split an interval (ms) into { value, unitId } for the dropdowns.
function freqSplit (ms) {
  ms = Number(ms) || DEFAULT_INTERVAL_MS
  // Pick the largest unit that divides evenly and keeps value >= 1.
  for (const u of [...FREQ_UNITS].reverse()) {
    if (ms >= u.ms && ms % u.ms === 0) return { value: ms / u.ms, unitId: u.id }
  }
  return { value: Math.round(ms / 60000), unitId: 'minutes' }
}

// Rebuild the {value,unit} interval from the dropdowns (ms).
function freqFromDropdowns () {
  const v = parseInt(els.setFreqMin.value, 10)
  const u = FREQ_UNITS.find((x) => x.id === els.setFreqUnit.value) || FREQ_UNITS[1]
  return (isFinite(v) && v > 0 ? v : 1) * u.ms
}

function formatFreq (ms) {
  const { value, unitId } = freqSplit(ms)
  const label = FREQ_UNITS.find((u) => u.id === unitId).label
  return `${value} ${label}`
}
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
  pinScale: 1,
  colored: getColored(),
  arcs: getArcs(),
  selfName: '',
  precisionKm: 0
}

// Most recent update-check result, so the in-app "Update now" button knows the
// APK URL to download.
let lastUpdate = null

// --- globe -------------------------------------------------------------------
function initGlobe () {
  state.globe = createRenderer($('globe'), { onPinClick: showPinOverlay, colored: state.colored, showArcs: state.arcs })
}

function syncColorToggle () {
  if (!els.colorToggle || !els.colorVal) return
  els.colorVal.textContent = state.colored ? 'On' : 'Off'
}

function onColorToggle () {
  state.colored = !state.colored
  setColored(state.colored)
  syncColorToggle()
  if (state.globe && typeof state.globe.setColored === 'function') state.globe.setColored(state.colored)
  toast('Colored countries: ' + (state.colored ? 'on' : 'off'))
}

function syncArcsToggle () {
  if (!els.arcsToggle || !els.arcsVal) return
  els.arcsVal.textContent = state.arcs ? 'On' : 'Off'
}

function onArcsToggle () {
  state.arcs = !state.arcs
  setArcs(state.arcs)
  syncArcsToggle()
  if (state.globe && typeof state.globe.setArcs === 'function') state.globe.setArcs(state.arcs)
  toast('Connecting lines: ' + (state.arcs ? 'on' : 'off'))
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
    els.pinFingerprint.textContent = '\u2014'
  } else {
    const c = data.contact
    // The user's local nickname takes priority; the peer's self-chosen name is
    // shown as a hint when they differ.
    els.pinName.textContent = c.nickname || 'Contact'
    els.pinTime.textContent = formatLocal(c.lastSeenTs)
    els.pinAgo.textContent = humanize(c.lastSeenTs)
    els.pinStatus.textContent = data.status
    els.pinCoords.textContent = (typeof data.lat === 'number' && typeof data.lng === 'number')
      ? round(data.lat) + ', ' + round(data.lng)
      : '\u2014'
    els.pinFingerprint.textContent = fingerprint(c.publicKeyB64) || '\u2014'
    els.pinFingerprint.title = 'Verify this over a second channel before sharing real location.'
  }
  els.pinOverlay.style.display = 'block'
  els.pinOverlay.style.left = '50%'
  els.pinOverlay.style.top = '18%'
  els.pinOverlay.style.transform = 'translateX(-50%)'

  // Center the map/globe on the clicked pin.
  if (state.globe && typeof state.globe.centerOn === 'function' && typeof data.lat === 'number' && typeof data.lng === 'number') {
    state.globe.centerOn(data.lat, data.lng)
  }
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
      } else if (status === STATUS.STALE && state.globe.hasPin(c.id) && typeof c.lat === 'number' && typeof c.lng === 'number') {
        state.globe.upsertContactPin(c, { lat: c.lat, lng: c.lng }, 'stale')
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
    // Local nickname takes priority; the peer's self-chosen name is a hint.
    name.textContent = c.nickname || c.lastName || 'Unnamed'
    name.title = c.lastName && c.lastName !== c.nickname ? ('Them: ' + c.lastName) : ''
    const ago = document.createElement('span')
    ago.className = 'ago'
    ago.textContent = c.lastSeenTs ? humanize(c.lastSeenTs) : 'never'
    const rm = document.createElement('button')
    rm.className = 'rm'
    rm.textContent = '\u00d7'
    rm.title = 'Remove contact'
    rm.addEventListener('click', (e) => { e.stopPropagation(); onRemoveContact(c) })
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
    const fp = fingerprint(c.publicKeyB64)
    if (fp) {
      const fpEl = document.createElement('div')
      fpEl.className = 'contact-fingerprint'
      fpEl.textContent = fp
      fpEl.title = 'Verify this over a second channel before sharing real location.'
      item.appendChild(fpEl)
    }
    // Tap the contact row to center the map/globe on them.
    item.addEventListener('click', () => {
      if (typeof c.lat === 'number' && typeof c.lng === 'number' && state.globe && typeof state.globe.centerOn === 'function') {
        state.globe.centerOn(c.lat, c.lng)
        showPinOverlay({ self: false, contact: c, lat: c.lat, lng: c.lng, status })
      }
    })
    // Long-press (touch) to rename.
    if ('ontouchstart' in window) {
      let longPress = null
      item.addEventListener('touchstart', (e) => {
        longPress = setTimeout(() => { longPress = null; onRenameContact(c) }, 550)
      }, { passive: true })
      item.addEventListener('touchend', () => { if (longPress) clearTimeout(longPress) })
      item.addEventListener('touchmove', () => { if (longPress) clearTimeout(longPress) }, { passive: true })
    } else {
      // Desktop fallback: right-click to rename.
      item.addEventListener('contextmenu', (e) => { e.preventDefault(); onRenameContact(c) })
    }
    list.appendChild(item)
  }
}

async function onRenameContact (c) {
  const current = c.nickname || c.lastName || ''
  const next = prompt('Rename this contact (local only):', current)
  if (next === null) return // cancelled
  const name = String(next || '').trim()
  if (!name) return
  try {
    const res = await request('contact:rename', { contactId: c.id, nickname: name })
    upsertContact(res.contact)
    toast('Contact renamed')
  } catch (err) {
    toast('Rename failed: ' + String(err.message || err))
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
  // Frequency dropdowns: minutes 1..59, hours 1..48, days 1..30.
  for (let i = 1; i <= 59; i++) {
    const o = document.createElement('option')
    o.value = String(i)
    o.textContent = String(i)
    els.setFreqMin.appendChild(o)
  }
  for (const u of FREQ_UNITS) {
    const o = document.createElement('option')
    o.value = u.id
    o.textContent = u.label
    els.setFreqUnit.appendChild(o)
  }
  const { value: fv, unitId: fu } = freqSplit(state.intervalMs)
  els.setFreqMin.value = String(fv)
  els.setFreqUnit.value = fu

  const currentStyle = getMapStyleId()
  for (const s of MAP_STYLES) {
    const o = document.createElement('option')
    o.value = s.id
    o.textContent = s.name
    if (s.id === currentStyle) o.selected = true
    els.setMapStyle.appendChild(o)
  }

  const PRECISION_OPTIONS = [
    { km: 0, label: 'Off (exact)' },
    { km: 5, label: '~5 km' },
    { km: 10, label: '~10 km' },
    { km: 25, label: '~25 km' },
    { km: 50, label: '~50 km' }
  ]
  for (const p of PRECISION_OPTIONS) {
    const o = document.createElement('option')
    o.value = String(p.km)
    o.textContent = p.label
    if (p.km === state.precisionKm) o.selected = true
    els.setPrecision.appendChild(o)
  }

  $('btn-add-contact').addEventListener('click', () => openModal(els.modalAdd))
  $('btn-settings').addEventListener('click', () => {
    const { value: fv, unitId: fu } = freqSplit(state.intervalMs)
    els.setFreqMin.value = String(fv)
    els.setFreqUnit.value = fu
    els.pinScale.value = String(state.pinScale)
    els.pinsizeVal.textContent = state.pinScale.toFixed(1) + '×'
    if (els.setSelfName) els.setSelfName.value = state.selfName
    if (els.setPrecision) els.setPrecision.value = String(state.precisionKm)
    syncManualUI()
    openModal(els.modalSet)
  })
  $('add-cancel').addEventListener('click', () => closeModal(els.modalAdd))
  $('set-cancel').addEventListener('click', () => closeModal(els.modalSet))
  $('add-confirm').addEventListener('click', onAddContact)
  $('set-confirm').addEventListener('click', onSaveSettings)
  $('btn-checkin-now').addEventListener('click', onCheckinNow)
  if (els.btnCheckUpdates) {
    els.btnCheckUpdates.addEventListener('click', onCheckUpdates)
    if (els.btnUpdateNow) els.btnUpdateNow.addEventListener('click', onUpdateNow)
  }
  if (els.btnScanQr) {
    els.btnScanQr.addEventListener('click', onScanQr)
  }
  if (els.addPub) {
    els.addPub.addEventListener('input', updateAddFingerprint)
    updateAddFingerprint()
  }

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

  if (els.colorToggle) {
    els.colorToggle.addEventListener('click', onColorToggle)
    syncColorToggle()
  }
  if (els.arcsToggle) {
    els.arcsToggle.addEventListener('click', onArcsToggle)
    syncArcsToggle()
  }
  if (els.btnQr) {
    els.btnQr.addEventListener('click', openQrModal)
    if (els.qrClose) els.qrClose.addEventListener('click', () => closeModal(els.modalQr))
    if (els.qrKey) {
      els.qrKey.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(els.qrKey.textContent)
          toast('Public key copied')
        } catch { toast('Copy failed \u2014 select and copy manually') }
      })
    }
  }

  els.versionTag.addEventListener('dblclick', () => { syncStyleToggleLabel(); els.devPanel.classList.toggle('open') })
  $('btn-dev-close').addEventListener('click', () => els.devPanel.classList.remove('open'))
  $('btn-force-200').addEventListener('click', onForce200)
  $('btn-toggle-globe').addEventListener('click', onCycleMapStyle)
}

function syncStyleToggleLabel () {
  const btn = $('btn-toggle-globe')
  if (!btn) return
  const cur = getMapStyleId()
  const i = MAP_STYLES.findIndex((s) => s.id === cur)
  const next = MAP_STYLES[(i + 1) % MAP_STYLES.length]
  btn.textContent = 'Next map: ' + next.name
}

function onCycleMapStyle () {
  const cur = getMapStyleId()
  const i = MAP_STYLES.findIndex((s) => s.id === cur)
  const next = MAP_STYLES[(i + 1) % MAP_STYLES.length]
  setMapStyleId(next.id)
  toast('Map: ' + next.name + '\u2026')
  setTimeout(() => window.location.reload(), 300)
}

function openModal (m) { m.classList.add('open') }
function closeModal (m) { m.classList.remove('open'); const e = m.querySelector('.form-error'); if (e) e.textContent = '' }

// QR share of your public key — scannable by a friend's phone to add you as a
// contact. Generated locally (qrcode lib, bundled — no network).
async function openQrModal () {
  const key = els.myPubkey.textContent || ''
  if (!key || key === '\u2026' || key === '') {
    toast('No public key yet')
    return
  }
  try {
    els.qrKey.textContent = key
    if (els.qrCanvas && els.qrCanvas.getContext) {
      const size = Math.min(els.qrCanvas.clientWidth || 260, 260)
      await QRCode.toCanvas(els.qrCanvas, key, { margin: 2, width: size, errorCorrectionLevel: 'M' })
    }
    openModal(els.modalQr)
  } catch (err) {
    toast('QR failed: ' + String(err && err.message || err))
  }
}

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

// Live safety-number preview under the Add Contact key field, so the user can
// verify the fingerprint *before* saving the contact.
function updateAddFingerprint () {
  if (!els.addFingerprint) return
  const key = (els.addPub.value || '').trim()
  const fp = key ? fingerprint(key) : null
  els.addFingerprint.textContent = fp
    ? 'Fingerprint: ' + fp
    : 'Paste or scan a key to see its fingerprint.'
  els.addFingerprint.title = fp
    ? 'Verify this over a second channel before sharing real location.'
    : ''
}

async function onAddContact () {
  els.addErr.textContent = ''
  try {
    const res = await request('contact:add', { nickname: els.addNick.value, publicKeyB64: els.addPub.value })
    upsertContact(res.contact)
    closeModal(els.modalAdd)
    els.addNick.value = ''; els.addPub.value = ''
    updateAddFingerprint()
    toast(`Added ${res.contact.nickname}`)
  } catch (err) {
    els.addErr.textContent = String(err.message || err)
  }
}

// Scan a friend's QR code with the camera and fill the public-key field.
async function onScanQr () {
  els.addErr.textContent = ''
  closeModal(els.modalAdd)
  try {
    const text = await openScanner()
    if (text) {
      // Normalize: our keys are raw base64 (no scheme prefix); strip any
      // "ichnaea:" / "beacon:" prefix a future QR variant might carry.
      els.addPub.value = text.replace(/^(ichnaea|beacon|iot):/i, '').trim()
      updateAddFingerprint()
      openModal(els.modalAdd)
      if (!els.addPub.value) {
        els.addErr.textContent = 'That QR didn\u2019t contain a public key'
      }
    } else {
      openModal(els.modalAdd) // cancelled
    }
  } catch (err) {
    openModal(els.modalAdd)
    els.addErr.textContent = 'Camera unavailable: ' + String(err && err.message || err)
  }
}

// Manual update check (Settings → Check for updates). Only makes a network
// request when tapped — no traffic on boot or in the background. When a newer
// build exists, offer an in-app install (download + package installer).
async function onCheckUpdates () {
  if (!els.btnCheckUpdates) return
  els.btnCheckUpdates.disabled = true
  els.updatesStatus.textContent = '\u2026'
  els.updatesDetail.textContent = 'Checking GitHub\u2026'
  const res = await checkForUpdates()
  els.btnCheckUpdates.disabled = false
  if (!res.ok) {
    els.updatesStatus.textContent = ''
    els.updatesDetail.textContent = 'Couldn\u2019t check: ' + (res.error || 'network error')
    hideUpdateNow()
    return
  }
  if (res.updateAvailable) {
    lastUpdate = res
    els.updatesStatus.textContent = '!'
    els.updatesDetail.textContent = `v${res.current} \u2192 v${res.latest} available`
    if (els.btnUpdateNow) {
      els.btnUpdateNow.style.display = 'block'
      els.btnUpdateNow.disabled = false
    }
  } else {
    lastUpdate = null
    els.updatesStatus.textContent = '\u2713'
    els.updatesDetail.textContent = `You\u2019re up to date (v${res.current}).`
    hideUpdateNow()
  }
}

function hideUpdateNow () {
  lastUpdate = null
  if (els.btnUpdateNow) els.btnUpdateNow.style.display = 'none'
}

// Download the new APK in-app and hand it to the Android package installer via
// the native IchnaeaUpdater plugin. Falls back to opening the URL in a browser
// if the plugin is unavailable (e.g. on desktop).
async function onUpdateNow () {
  const res = lastUpdate
  if (!res || !res.assetUrl) return
  const cap = typeof window !== 'undefined' && window.Capacitor &&
    window.Capacitor.Plugins && window.Capacitor.Plugins.IchnaeaUpdater
  if (cap) {
    els.updatesStatus.textContent = '\u2b07'
    els.updatesDetail.textContent = 'Downloading update\u2026'
    els.btnUpdateNow.disabled = true
    try {
      await cap.install({ url: res.assetUrl })
      els.updatesDetail.textContent = 'Installer opened \u2014 confirm the update on the next screen.'
    } catch (err) {
      els.updatesDetail.textContent = 'Couldn\u2019t update: ' + String((err && err.message) || err)
      els.btnUpdateNow.disabled = false
    }
  } else {
    window.open(res.assetUrl, '_blank')
    els.updatesDetail.textContent = 'Opening download\u2026'
  }
}

function syncFreqDisplay () {
  if (els.freqDisplay) els.freqDisplay.textContent = 'Broadcast: every ' + formatFreq(state.intervalMs)
}

async function onSaveSettings () {
  const ms = freqFromDropdowns()
  if (!ms || ms <= 0) { els.setErr.textContent = 'Pick a valid interval'; return }
  try {
    await saveManual()
    if (els.setSelfName) {
      const name = String(els.setSelfName.value || '').trim().slice(0, 40)
      const res = await request('selfname:set', { name })
      state.selfName = res.name
    }
    const res = await request('interval:set', { intervalMs: ms })
    state.intervalMs = res.intervalMs
    syncFreqDisplay()
    if (els.setPrecision) {
      const km = Number(els.setPrecision.value) || 0
      if (km !== state.precisionKm) {
        await request('precision:set', { precisionKm: km })
        state.precisionKm = km
      }
    }
    closeModal(els.modalSet)
    toast('Settings saved')
    // Map style change needs a reload (the renderer is built once at boot).
    if (els.setMapStyle.value && els.setMapStyle.value !== getMapStyleId()) {
      setMapStyleId(els.setMapStyle.value)
      setTimeout(() => window.location.reload(), 400)
    }
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
let booted = false

function connect () {
  // Guard against double init: ws.onclose schedules another connect(), which
  // would re-run initGlobe() + initUI() (duplicate globes, duplicate options,
  // and re-attached listeners racing with the first pass) and break panel
  // minimize. Only the first boot initializes the renderer and UI; reconnects
  // just open a fresh WebSocket.
  if (booted) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
    ws = new WebSocket(WS_URL)
    ws.onopen = onOpen
    ws.onmessage = onMessage
    ws.onclose = onClose
    ws.onerror = () => {}
    return
  }
  booted = true

  initGlobe()
  initUI()
  startStalenessSweep()

  ws = new WebSocket(WS_URL)
  ws.onopen = onOpen
  ws.onmessage = onMessage
  ws.onclose = onClose
  ws.onerror = () => {}
}

async function onOpen () {
  setGpsStatus('connected \u00b7 awaiting first check-in')
  try {
    const res = await request('boot')
    els.myPubkey.textContent = res.publicKeyB64
    state.intervalMs = res.intervalMs || DEFAULT_INTERVAL_MS
    const { value: fv, unitId: fu } = freqSplit(state.intervalMs)
    els.setFreqMin.value = String(fv)
    els.setFreqUnit.value = fu
    syncFreqDisplay()
    state.manual = res.manual || { enabled: false, lat: null, lng: null }
    state.contacts = res.contacts || []
    state.selfName = res.selfName || ''
    state.precisionKm = typeof res.precisionKm === 'number' ? res.precisionKm : 0
    if (els.setPrecision) els.setPrecision.value = String(state.precisionKm)
    if (res.selfLoc) state.globe.setSelf(res.selfLoc)
    renderContactsList()
  } catch (err) {
    setGpsStatus('no connection to main process')
    console.error('boot error:', err)
  }
}

function onMessage (ev) {
  let msg
  try { msg = JSON.parse(ev.data) } catch { return }
  handlePush(msg)
}

function onClose () {
  setGpsStatus('connection closed \u00b7 reconnecting\u2026')
  setTimeout(connect, 2000)
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
