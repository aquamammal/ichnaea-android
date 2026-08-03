import { dataDir, readJson, writeJson, resolveFs } from './fsx.js'

// Settings store for the MAIN process, persisted as a JSON file. Holds the
// broadcast interval, the local-core rotation generation, and the manual-GPS
// override (so it survives reload). Renderer-only UI state stays in the
// renderer; anything the scheduler/P2P needs lives here.

const DEFAULTS = {
  intervalMs: 86400000, // 1 day
  coreGeneration: 0,
  manual: { enabled: false, lat: null, lng: null }
}

async function settingsFile () {
  const { path } = await resolveFs()
  return path.join(await dataDir(), 'settings.json')
}

export async function loadSettings () {
  const data = await readJson(await settingsFile())
  const merged = { ...DEFAULTS, ...(data && typeof data === 'object' ? data : {}) }
  merged.manual = { ...DEFAULTS.manual, ...(merged.manual && typeof merged.manual === 'object' ? merged.manual : {}) }
  return merged
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
