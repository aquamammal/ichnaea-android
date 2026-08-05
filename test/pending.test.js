import test from 'brittle'
import os from 'os'
import fs from 'fs'
import path from 'path'
import * as pending from '../src/main/pending.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ichnaea-pending-'))
process.env.ICHNAEA_DATA_DIR = TMP

test('pending: enqueue, dedupe by timestamp, count, list, clear', async (t) => {
  process.env.ICHNAEA_DATA_DIR = TMP
  t.is(await pending.count(), 0)
  t.ok(await pending.enqueue({ lat: 1, lng: 2, timestamp: 1000, name: 'A' }))
  t.ok(await pending.enqueue({ lat: 2, lng: 3, timestamp: 2000, name: 'B' }))
  t.not(await pending.enqueue({ lat: 9, lng: 9, timestamp: 1000, name: 'dup' }), true, 'same timestamp is deduped')
  t.is(await pending.count(), 2)
  const list = await pending.list()
  t.is(list.length, 2)
  t.is(list[0].timestamp, 1000)
  t.is(list[1].lat, 2)
  const n = await pending.clear()
  t.is(n, 2, 'clear returns the flushed count')
  t.is(await pending.count(), 0)
})

test('pending: capped at 100 (drops oldest), persists to disk', async (t) => {
  process.env.ICHNAEA_DATA_DIR = TMP
  for (let i = 1; i <= 120; i++) await pending.enqueue({ lat: i, lng: i, timestamp: 1000 + i, name: '' })
  const list = await pending.list()
  t.is(list.length, 100, 'capped to 100')
  t.is(list[0].timestamp, 1021, 'oldest dropped')
  t.is(list[99].timestamp, 1120, 'newest kept')

  // Survives "restart": reading the on-disk file gives the same entries.
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'pending.json'), 'utf8'))
  t.is(onDisk.entries.length, 100)
  t.is(onDisk.entries[99].timestamp, 1120)

  await pending.clear()
  delete process.env.ICHNAEA_DATA_DIR
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
})
