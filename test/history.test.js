import test from 'brittle'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { loadOrCreateIdentity } from '../src/main/identity.js'
import { openLocalCore, appendCheckin, readHistory } from '../src/main/corelog.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ichnaea-history-'))
process.env.ICHNAEA_DATA_DIR = TMP

test('readHistory returns the last N decrypted entries, oldest→newest', async (t) => {
  process.env.ICHNAEA_DATA_DIR = TMP
  const id = await loadOrCreateIdentity()
  const core = await openLocalCore(id, 0)
  for (let i = 1; i <= 5; i++) {
    await appendCheckin(core, { lat: i, lng: i * 2, timestamp: 1000 + i }, id.logKey)
  }
  const all = await readHistory(core, id.logKey, 10)
  t.is(all.length, 5)
  t.is(all[0].lat, 1, 'oldest first')
  t.is(all[4].lat, 5, 'newest last')

  const last2 = await readHistory(core, id.logKey, 2)
  t.is(last2.length, 2)
  t.is(last2[0].lat, 4, 'paging returns the tail')
  t.is(last2[1].lat, 5)

  // A wrong key cannot decrypt, and the fallback (raw block) is unparseable.
  const wrong = await readHistory(core, Buffer.alloc(32, 7), 10)
  t.is(wrong.length, 0, 'wrong key yields no history')

  // History keys array works too (rotation path).
  const viaArray = await readHistory(core, [id.logKey], 10)
  t.is(viaArray.length, 5)

  await core.close()
  delete process.env.ICHNAEA_DATA_DIR
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
})
