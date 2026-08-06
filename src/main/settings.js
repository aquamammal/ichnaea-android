import { dataDir, readJson, writeJson, resolveFs } from './fsx.js'

// Settings store for the MAIN process, persisted as a JSON file. Holds the
// broadcast interval, the local-core rotation generation, self name, and the
// precision dial. Renderer-only UI state stays in the renderer; anything the
// scheduler/P2P needs lives here.

const DEFAULTS = {
  intervalMs: 86400000, // 1 day
  coreGeneration: 0,
  selfName: '', // user's own name, shared with contacts in every check-in
  precisionKm: 0, // coarse-location snap: 0 = off, else 5/10/25/50 km
  honorLocationRequests: false // opt-in: honor "please check in" asks from verified contacts
}

async function settingsFile () {
  const { path } = await resolveFs()
  return path.join(await dataDir(), 'settings.json')
}

export async function loadSettings () {
  const data = await readJson(await settingsFile())
  return { ...DEFAULTS, ...(data && typeof data === 'object' ? data : {}) }
}

export async function saveSettings (settings) {
  await writeJson(await settingsFile(), settings)
  return settings
}

export async function getSetting (key) {
  const s = await loadSettings()
  return s[key]
}

export async function setSetting (key, value) {
  const s = await loadSettings()
  s[key] = value
  await saveSettings(s)
  return s
}
