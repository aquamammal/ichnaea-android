// Offline check-in queue (main process). When a check-in fires while no contact
// is connected, the entry is recorded here so the UI can show "N queued
// (offline)" and so we can surface a "synced" notice once a peer connects.
// The entry is ALSO appended to the local core at check-in time, so nothing is
// lost locally and replication delivers it on reconnect — this queue is the
// visibility + sync signal, not the source of truth.
//
// Persisted to data/pending.json; capped at the most recent 100 entries and
// deduped by timestamp.

import { dataDir, readJson, writeJson, resolveFs } from './fsx.js'

const CAP = 100

let cache = null // in-memory copy so reads don't hit disk every tick

async function file () {
  const { path } = await resolveFs()
  return path.join(await dataDir(), 'pending.json')
}

async function load () {
  if (cache) return cache
  const data = await readJson(await file())
  cache = Array.isArray(data && data.entries) ? data.entries : []
  return cache
}

async function save () {
  await writeJson(await file(), { version: 1, entries: cache || [] })
}

// Queue a check-in. Returns true if it was newly added, false if a duplicate
// (same timestamp) or if the queue was empty/no-op.
export async function enqueue ({ lat, lng, timestamp, name }) {
  const list = await load()
  if (typeof timestamp !== 'number' || list.some((e) => e.timestamp === timestamp)) return false
  list.push({ lat, lng, timestamp, name: String(name || '').slice(0, 40) })
  if (list.length > CAP) list.splice(0, list.length - CAP)
  await save()
  return true
}

export async function list () {
  return (await load()).slice()
}

export async function count () {
  return (await load()).length
}

// Drop all queued entries (called when a peer connects and the core has synced).
export async function clear () {
  const n = (await load()).length
  cache = []
  await save()
  return n
}
