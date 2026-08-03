// Filesystem helpers for the Pear MAIN process. The renderer has no fs access,
// so identity, the contacts store, and the local Hypercore all persist on disk
// under a `data/` directory in the project cwd. Uses bare-fs/bare-path when
// running under Bare, falling back to Node's fs/path (same pattern as v1).

let resolved = null

export async function resolveFs () {
  if (resolved) return resolved
  let fsMod = null
  let pathMod = null
  try {
    fsMod = await import('bare-fs')
  } catch {
    fsMod = await import('fs')
  }
  try {
    pathMod = await import('bare-path')
  } catch {
    pathMod = await import('path')
  }
  resolved = {
    fs: fsMod.default || fsMod,
    path: pathMod.default || pathMod
  }
  return resolved
}

export async function dataDir () {
  const { path } = await resolveFs()
  // On Android the JNI layer sets ICHNAEA_DATA_DIR to the app's writable files
  // dir (process.cwd() is "/" and not writable there). On desktop it falls back
  // to the project's ./data directory.
  const mobileDir = typeof process !== 'undefined' ? process.env.ICHNAEA_DATA_DIR : null
  if (mobileDir) return path.join(mobileDir, 'data')
  const cwd = typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : '.'
  return path.join(cwd, 'data')
}

export async function readJson (file) {
  const { fs } = await resolveFs()
  try {
    const raw = await fs.promises.readFile(file, 'utf8')
    return JSON.parse(raw)
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

export async function writeJson (file, data) {
  const { fs, path } = await resolveFs()
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, JSON.stringify(data), 'utf8')
}
