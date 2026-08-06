// Manual update checker (zero automatic telemetry). Fetches the latest GitHub
// Release for this repo ONLY when the user taps "Check for updates" in
// Settings — no network traffic happens on boot or in the background.
//
// The version marker is the GitHub Release tag (e.g. "v0.2.2"), which you
// publish when cutting a release:
//   gh release create v0.2.2 dist/ichnaea-android-v0.2.2-debug.apk
// The app compares tags with plain semver ordering (numeric, dot-separated)
// and reports whether a newer build exists, linking to the release page.

// Change when bumping the app version (mirrors package.json / versionName).
export const APP_VERSION = '0.3.1'
const REPO = 'aquamammal/ichnaea-android'

const GITHUB_API = `https://api.github.com/repos/${REPO}/releases/latest`
const GITHUB_WEB = `https://github.com/${REPO}/releases`

// Parse "1.2.3" (optional leading "v") into [major, minor, patch, ...].
function parseVersion (v) {
  const s = String(v || '').trim().replace(/^v/i, '')
  const nums = s.split('.').map((n) => parseInt(n, 10))
  if (!nums.length || nums.some((n) => Number.isNaN(n))) return null
  return nums
}

// a >= b numerically, treating missing trailing components as 0.
function gte (a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0
    const bv = b[i] || 0
    if (av !== bv) return av > bv
  }
  return true
}

export function versionParts (v) { return parseVersion(v) }
export function isNewerVersion (candidate, current) {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false // unparseable -> treat as not newer
  return gte(a, b) && a.join('.') !== b.join('.')
}

// Returns { ok, updateAvailable, current, latest, latestTag, releaseUrl,
//           assetUrl, error }
// `current` defaults to APP_VERSION; pass a custom value in tests.
export async function checkForUpdates (current = APP_VERSION) {
  let res
  try {
    res = await fetch(GITHUB_API, { headers: { Accept: 'application/vnd.github+json' } })
  } catch (err) {
    return { ok: false, updateAvailable: false, current, error: String(err && err.message || err) }
  }
  if (!res.ok) {
    // 404 = no releases yet; anything else = rate limit / network.
    const err = res.status === 404 ? 'No releases published yet' : `GitHub responded ${res.status}`
    return { ok: false, updateAvailable: false, current, error: err }
  }
  let data
  try {
    data = await res.json()
  } catch (err) {
    return { ok: false, updateAvailable: false, current, error: String(err && err.message || err) }
  }
  const tag = (data && data.tag_name) || ''
  const releaseUrl = (data && data.html_url) || GITHUB_WEB
  const asset = (data && data.assets && data.assets[0]) || null
  const assetUrl = asset ? asset.browser_download_url : null
  // Second download candidate: the committed dist/ APK served from raw
  // content — a different GitHub host than the release-asset CDN, useful when a
  // network can reach api.github.com but not objects.githubusercontent.com.
  const rawUrl = asset && asset.name
    ? `https://raw.githubusercontent.com/${REPO}/main/dist/${asset.name}`
    : null
  return {
    ok: true,
    updateAvailable: isNewerVersion(tag, current),
    current,
    latest: tag.replace(/^v/i, ''),
    latestTag: tag,
    releaseUrl,
    assetUrl,
    rawUrl
  }
}
