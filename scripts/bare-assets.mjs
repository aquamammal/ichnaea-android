// Bundles the Bare runtime for the APK:
//   1. The `bare` aarch64 executable  -> android/app/src/main/assets/bare-runtime/bare
//   2. The JS module tree (bridge bundle deps + native `.bare` addons)
//      -> android/app/src/main/assets/bare-bundle/node_modules/
//   3. Injects a stub `bare-tls` (the npm package is broken — only prebuilds
//      published; we only ever serve ws:// on localhost, never wss://, so the
//      stub just satisfies bare-ws's eager require chain).
//
// No patchelf and no Node-12 syntax patches: Bare loads `.bare` addons via
// standard N-API. Run: node scripts/bare-assets.mjs (from the project root).

import { cpSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'

const BARE_VERSION = '1.31.0'
// The Bare binary must live in jniLibs (not assets): Android's SELinux policy
// forbids exec'ing files labeled app_data_file (the app data dir), but native
// libs in nativeLibraryDir are extracted with an executable label. It's an ELF
// executable named libbare.so so Android packages it as a native lib.
const BARE_JNILIBS = 'android/app/src/main/jniLibs/arm64-v8a/libbare.so'
const BARE_MODULES = 'android/app/src/main/assets/bare-bundle/node_modules'

const ROOTS = [
  'bare-ws',       // WebSocket bridge (server.js transport)
  'bare-process',  // process.env / process.stdin for the lifecycle channel
  'bare-fs',       // node:fs equivalent (bundled node builtins)
  'bare-path',     // node:path equivalent
  'bare-url',      // node:url equivalent
  'udx-native',    // DHT UDP transport
  'sodium-native', // crypto (Noise handshake primitive)
  'require-addon', // native `.bare` addon loader (used by all native deps)
  'bare-addon-resolve',
  'which-runtime'
]

// --- 1. Bare runtime executable (into jniLibs so SELinux allows exec) ----------
function ensureBareBinary () {
  const from = 'node_modules/bare-runtime-android-arm64/bin/bare'
  mkdirSync(path.dirname(BARE_JNILIBS), { recursive: true })
  if (existsSync(from)) {
    cpSync(from, BARE_JNILIBS)
    console.log('[bare] runtime binary from node_modules')
  } else {
    // npm won't install the android-arm64 optional dep on a non-Android host, so
    // fetch the pinned tarball directly from the registry.
    const tarball = `https://registry.npmjs.org/bare-runtime-android-arm64/-/bare-runtime-android-arm64-${BARE_VERSION}.tgz`
    const tmp = path.join(os.tmpdir(), `bare-runtime-${BARE_VERSION}.tgz`)
    console.log('[bare] downloading', tarball)
    execSync(`curl -fsSL --max-time 300 -o "${tmp}" "${tarball}"`)
    execSync(`tar -xzf "${tmp}" -C "${path.dirname(BARE_JNILIBS)}" --strip-components=2 package/bin/bare`)
    cpSync(path.join(path.dirname(BARE_JNILIBS), 'bare'), BARE_JNILIBS)
    console.log('[bare] runtime binary downloaded')
  }
  copyLibCppShared()
}

// --- 2. JS module tree ----------------------------------------------------------
function copyClosure () {
  rmSync(BARE_MODULES, { recursive: true, force: true })
  mkdirSync(BARE_MODULES, { recursive: true })

  const queue = [...ROOTS]
  const seen = new Set()

  function deps (name) {
    const p = path.join('node_modules', name, 'package.json')
    if (!existsSync(p)) return []
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      return Object.keys(j.dependencies || {}).concat(Object.keys(j.optionalDependencies || {}))
    } catch { return [] }
  }

  while (queue.length) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    const src = path.join('node_modules', name)
    if (!existsSync(src)) { console.log('[bare] MISSING', name); continue }
    cpSync(src, path.join(BARE_MODULES, name), { recursive: true })
    pruneForeignPrebuilds(path.join(BARE_MODULES, name))
    for (const d of deps(name)) queue.push(d)
  }
  console.log('[bare] copied', seen.size, 'packages')
}

// Keep only the android-arm64 native prebuilds (bare-.bare / .node / .so); the
// upstream packages ship prebuilds for every platform, which would bloat the APK.
function pruneForeignPrebuilds (dir) {
  const prebuilds = path.join(dir, 'prebuilds')
  if (!existsSync(prebuilds)) return
  for (const entry of readdirSync(prebuilds)) {
    if (entry !== 'android-arm64') {
      rmSync(path.join(prebuilds, entry), { recursive: true, force: true })
    }
  }
}

// --- 3. bare-tls stub -----------------------------------------------------------
// bare-tls is referenced eagerly by bare-https (which bare-ws loads), but the
// npm tarball ships only prebuilds — no JS/package.json. We never use TLS
// (localhost ws:// only), so install a stub with the real prebuilds preserved.
function stubBareTls () {
  const dir = path.join(BARE_MODULES, 'bare-tls')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'bare-tls',
    version: '3.0.0-stub',
    main: 'index.js',
    type: 'commonjs'
  }, null, 2) + '\n')
  writeFileSync(path.join(dir, 'index.js'),
    `// Stub for bare-tls (the npm package ships only prebuilds). Ichnaea serves
// ws:// on localhost only, never wss://, so the TLS socket is never used.
// Satisfies the eager require chain in bare-https/lib/socket.js so bare-ws loads.
const Socket = class HTTPSSocketStub {}
Socket.prototype.setKeepAlive = function () {}
Socket.prototype.setNoDelay = function () {}
module.exports = { Socket, Server: class {}, connect: function () {} }
`)
  console.log('[bare] bare-tls stub written (prebuilds preserved)')
}

// --- 4. Make the native `.bare` addons find libc++_shared.so --------------------
// The app execs libbare.so from nativeLibraryDir, so its dlopen uses the default
// linker namespace — the app's lib dir and the device's /vendor libc++ are both
// invisible to it, and Android's linker does NOT search a dlopen'd DSO's own
// directory nor resolve `..` in RUNPATH. Verified on-device: each addon needs
// DT_RUNPATH=$ORIGIN with a libc++_shared.so sitting next to it.
function patchNativeAddons () {
  const patchelf = findPatchelf()
  const shared = 'android/app/src/main/jniLibs/arm64-v8a/libc++_shared.so'
  if (!existsSync(shared)) return
  let patched = 0
  for (const dir of listDirsRecursive(BARE_MODULES)) {
    if (path.basename(dir) !== 'android-arm64') continue
    const bare = readdirSync(dir).filter((f) => f.endsWith('.bare'))
    if (!bare.length) continue
    cpSync(shared, path.join(dir, 'libc++_shared.so'))
    for (const f of bare) {
      execSync(`"${patchelf}" --set-rpath '$ORIGIN' "${path.join(dir, f)}"`)
      patched++
    }
  }
  console.log('[bare] patched', patched, '.bare addons (RUNPATH=$ORIGIN + per-dir libc++_shared.so)')
}

function listDirsRecursive (dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { out.push(full); listDirsRecursive(full, out) }
  }
  return out
}

function findPatchelf () {
  if (process.env.PATCHELF && existsSync(process.env.PATCHELF)) return process.env.PATCHELF
  try { const which = execSync('command -v patchelf || true').toString().trim(); if (which) return which } catch {}
  const cached = '/tmp/kilo/patchelf-bin' // fetched on this box; override via PATCHELF
  if (existsSync(cached)) return cached
  throw new Error('patchelf not found — set PATCHELF=/path/to/patchelf')
}

function copyLibCppShared () {
  const sdk = readSdkDir()
  const ndks = sdk ? `${sdk}/ndk/*` : `${process.env.ANDROID_HOME || ''}/ndk/*`
  const candidates = [
    `${ndks}/toolchains/llvm/prebuilt/*/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so`,
    `${ndks}/sources/cxx-stl/llvm-libc++/libs/arm64-v8a/libc++_shared.so`
  ]
  for (const pattern of candidates) {
    if (pattern.includes('undefined/')) continue
    let out = ''
    try { out = execSync(`ls ${pattern} 2>/dev/null || true`).toString().trim() } catch { out = '' }
    const match = out.split('\n').filter(Boolean)[0]
    if (match) {
      mkdirSync('android/app/src/main/jniLibs/arm64-v8a', { recursive: true })
      cpSync(match, 'android/app/src/main/jniLibs/arm64-v8a/libc++_shared.so')
      console.log('[bare] libc++_shared.so from', match)
      return
    }
  }
  console.log('[bare] WARNING: libc++_shared.so not found (add it to jniLibs manually)')
}

function readSdkDir () {
  for (const p of ['android/local.properties', 'local.properties']) {
    if (existsSync(p)) {
      const m = /^\s*sdk\.dir\s*=\s*(.+?)\s*$/m.exec(readFileSync(p, 'utf8'))
      if (m) return m[1]
    }
  }
  return process.env.ANDROID_HOME || ''
}

ensureBareBinary()
copyClosure()
stubBareTls()
copyLibCppShared()
patchNativeAddons()
console.log('[bare] done')
