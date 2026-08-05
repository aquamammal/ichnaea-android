// In-app QR scanner. Opens a full-screen modal with the device camera
// (getUserMedia, back camera), decodes QR codes locally with jsqr, and calls
// onResult with the scanned text. Zero telemetry: everything runs on-device.
//
// Works on:
//   - Android (Capacitor WebView) — the WebView grants VIDEO_CAPTURE requests
//     when the app holds the CAMERA permission (see the manifest), and the
//     getUserMedia permission prompt is handled natively.
//   - Desktop (Pear/Electron renderer) — Chromium grants media requests by
//     default, so getUserMedia works out of the box.
//
// The module is import-safe outside a browser (unit tests / Node): it only
// touches the DOM / media APIs when openScanner() is called.

import jsQR from 'jsqr'

let activeScan = null // { resolve, teardown } of the current scan, if any

// Create the scanner DOM (video + canvas + chrome) once, lazily.
function buildDom () {
  const root = document.createElement('div')
  root.id = 'qr-scanner'
  root.style.cssText = [
    'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.92)',
    'display:flex;flex-direction:column;align-items:center;justify-content:center',
    'font-family:system-ui,sans-serif;color:#fff'
  ].join(';')

  const video = document.createElement('video')
  video.setAttribute('playsinline', '')
  video.setAttribute('autoplay', '')
  video.setAttribute('muted', '')
  video.style.cssText = 'width:100%;height:100%;object-fit:cover;'

  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none;'

  const overlay = document.createElement('div')
  overlay.style.cssText = [
    'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)',
    'width:70vw;height:70vw;max-width:340px;max-height:340px',
    'border:3px solid rgba(59,157,255,0.9);border-radius:12px',
    'box-shadow:0 0 0 100vmax rgba(0,0,0,0.45)',
    'pointer-events:none'
  ].join(';')

  const hint = document.createElement('div')
  hint.textContent = 'Point at a QR code'
  hint.style.cssText = 'position:absolute;top:calc(50% + 40vw);left:0;right:0;text-align:center;font-size:13px;color:#9aa4b0;'

  const close = document.createElement('button')
  close.textContent = 'Cancel'
  close.style.cssText = [
    'position:absolute;bottom:32px;left:50%;transform:translateX(-50%)',
    'padding:10px 28px;border-radius:8px;border:1px solid rgba(255,255,255,0.25)',
    'background:rgba(12,17,24,0.85);color:#fff;font-size:15px;cursor:pointer'
  ].join(';')

  const status = document.createElement('div')
  status.textContent = 'Starting camera\u2026'
  status.style.cssText = 'position:absolute;top:24px;left:0;right:0;text-align:center;font-size:13px;color:#9aa4b0;'

  root.appendChild(video)
  root.appendChild(canvas)
  root.appendChild(overlay)
  root.appendChild(hint)
  root.appendChild(close)
  root.appendChild(status)
  document.body.appendChild(root)
  return { root, video, canvas, close, status }
}

function decodeFrame (video, canvas, ctx) {
  const W = 640
  const H = 480
  canvas.width = W
  canvas.height = H
  ctx.drawImage(video, 0, 0, W, H)
  const img = ctx.getImageData(0, 0, W, H)
  return jsQR(img.data, W, H)
}

// Opens the camera scanner. Resolves with the decoded string, or null when the
// user cancels. Rejects if the camera can't start.
export function openScanner () {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined' || typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      reject(new Error('Camera not supported in this browser'))
      return
    }
    const dom = buildDom()
    let stream = null
    let raf = 0
    let closed = false

    const teardown = () => {
      if (closed) return
      closed = true
      if (raf) cancelAnimationFrame(raf)
      if (stream) stream.getTracks().forEach((t) => t.stop())
      dom.root.remove()
      if (activeScan && activeScan.teardown === teardown) activeScan = null
    }

    const finish = (text) => {
      teardown()
      resolve(text)
    }

    activeScan = { resolve, teardown }

    dom.close.addEventListener('click', () => {
      teardown()
      resolve(null)
    })

    const loop = () => {
      if (closed) return
      try {
        const code = decodeFrame(dom.video, dom.canvas, dom.canvas.getContext('2d'))
        if (code && code.data) {
          finish(code.data)
          return
        }
      } catch { /* frame decode hiccup — keep scanning */ }
      raf = requestAnimationFrame(loop)
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((s) => {
        if (closed) { s.getTracks().forEach((t) => t.stop()); return }
        stream = s
        dom.video.srcObject = s
        dom.status.textContent = 'Scanning\u2026'
        loop()
      })
      .catch((err) => {
        teardown()
        reject(err)
      })
  })
}

// Aborts an active scan (used when a modal closes underneath it). Resolves the
// pending openScanner() promise with null so callers never hang.
export function closeScanner () {
  if (activeScan) {
    const { resolve, teardown } = activeScan
    teardown()
    resolve(null)
  }
}
