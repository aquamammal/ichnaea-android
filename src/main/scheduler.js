// Broadcast scheduler for the MAIN process. Owns the user-defined interval and
// fires check-ins, but the GPS fix itself comes from the renderer (geolocation
// is browser-only) via the injected `requestGps()` callback, which round-trips
// a gps:request/gps:result over the Pear pipe.

const GPS_RETRY_MS = 60000 // retry once after 1 minute on GPS failure

export function createMainScheduler ({
  requestGps, // () => Promise<{lat,lng}> — rejects on failure/denial
  onCheckin, // async ({lat,lng,timestamp}) => void — append to Hypercore
  onStatus // (msg) => void — transient status for the GPS status line
} = {}) {
  let intervalMs = 86400000
  let timer = null
  let running = false
  let firing = false

  function status (msg) { if (onStatus) onStatus(msg) }

  async function fire () {
    if (firing) return
    firing = true
    try {
      const coords = await requestGps()
      await onCheckin?.({ ...coords, timestamp: Date.now() })
      status('checked in')
    } catch (firstErr) {
      status('location unavailable — retrying in 1 minute')
      await sleep(GPS_RETRY_MS)
      try {
        const coords = await requestGps()
        await onCheckin?.({ ...coords, timestamp: Date.now() })
        status('checked in (after retry)')
      } catch (secondErr) {
        // Give up until the next scheduled fire. Never append a null location.
        status('location unavailable — will try again next interval')
      }
    } finally {
      firing = false
    }
  }

  function scheduleNext () {
    if (!running) return
    clearTimeout(timer)
    timer = setTimeout(async () => {
      await fire()
      scheduleNext()
    }, intervalMs)
  }

  function start (ms) {
    if (typeof ms === 'number' && ms > 0) intervalMs = ms
    if (running) { scheduleNext(); return intervalMs }
    running = true
    scheduleNext()
    return intervalMs
  }

  function setIntervalMs (ms) {
    intervalMs = ms
    if (running) scheduleNext() // restart the clock on the new interval
    return intervalMs
  }

  function stop () {
    running = false
    clearTimeout(timer)
  }

  // Fire immediately (manual "check in now"), independent of the schedule.
  async function checkinNow () { await fire(); if (running) scheduleNext() }

  return {
    start, stop, setIntervalMs, checkinNow,
    get intervalMs () { return intervalMs },
    get running () { return running }
  }
}

function sleep (ms) { return new Promise((r) => setTimeout(r, ms)) }
