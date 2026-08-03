// Staleness classification relative to a contact's OWN broadcast interval.
//   active  — last check-in within 2x their interval
//   stale   — between 2x and 4x their interval
//   offline — no update for 4x their interval (pin removed)

export const STATUS = { ACTIVE: 'active', STALE: 'stale', OFFLINE: 'offline', NEVER: 'never' }

export function classify (lastSeenTs, intervalMs, now = Date.now()) {
  if (!lastSeenTs || lastSeenTs <= 0) return STATUS.NEVER
  // If we don't know their interval yet, assume the default 1 day.
  const interval = typeof intervalMs === 'number' && intervalMs > 0 ? intervalMs : 86400000
  const age = now - lastSeenTs
  if (age < 2 * interval) return STATUS.ACTIVE
  if (age < 4 * interval) return STATUS.STALE
  return STATUS.OFFLINE
}

// Humanize a timestamp as "x ago" ("just now", "5 minutes ago", "2 hours ago",
// "3 days ago"). Returns 'never' for a falsy timestamp.
export function humanize (ts, now = Date.now()) {
  if (!ts || ts <= 0) return 'never'
  const diff = Math.max(0, now - ts)
  const sec = Math.floor(diff / 1000)
  if (sec < 45) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 1) return 'a minute ago'
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day} day${day === 1 ? '' : 's'} ago`
  const week = Math.floor(day / 7)
  if (week < 5) return `${week} week${week === 1 ? '' : 's'} ago`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month} month${month === 1 ? '' : 's'} ago`
  const year = Math.floor(day / 365)
  return `${year} year${year === 1 ? '' : 's'} ago`
}

// Format a timestamp to a readable local-time string for the pin overlay.
export function formatLocal (ts) {
  if (!ts || ts <= 0) return '—'
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return '—'
  }
}
