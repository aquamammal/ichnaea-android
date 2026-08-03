// Builds the NodeJS-Mobile native-assets dir from node_modules.
//   - copies the external native packages + their transitive JS deps
//   - patches which-runtime for Node 12 parse compatibility
//   - patchelf's each prebuilt .node to declare libnode.so + the JNI shim lib
//     as NEEDED dependencies (fixes Android linker-namespace N-API resolution)
//
// Run: node scripts/native-assets.mjs  (must be run from the project root)
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const dest = 'android/app/src/main/assets/nodejs-native-assets-arm64-v8a'
const roots = ['udx-native', 'sodium-native', 'require-addon', 'bare-events', 'b4a', 'streamx', 'which-runtime', 'bare-assert']

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })

const queue = [...roots]
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
  if (!existsSync(src)) { console.log('MISSING', name); continue }
  cpSync(src, path.join(dest, name), { recursive: true })
  for (const d of deps(name)) queue.push(d)
}
console.log('copied', seen.size, 'packages')

// which-runtime uses `?.` (Node 14+ syntax) — NodeJS-Mobile is Node 12.
const wr = path.join(dest, 'which-runtime', 'index.js')
const wrSrc = readFileSync(wr, 'utf8')
const patched = wrSrc.replace('!!global.process.versions?.electron', '!!(global.process.versions && global.process.versions.electron)')
if (patched !== wrSrc) { writeFileSync(wr, patched); console.log('patched which-runtime for Node 12') }

// patchelf the prebuilt native addons so their N-API/uv symbols resolve.
const addons = [
  'udx-native/prebuilds/android-arm64/udx-native.node',
  'sodium-native/prebuilds/android-arm64/sodium-native.node'
]
const patchelf = process.env.PATCHELF || '/tmp/bin/patchelf'
for (const rel of addons) {
  const file = path.join(dest, rel)
  if (!existsSync(file)) { console.log('skip (missing)', rel); continue }
  try {
    execSync(`"${patchelf}" --add-needed libnode.so "${file}"`, { stdio: 'ignore' })
    execSync(`"${patchelf}" --add-needed libichnaea-nodejs-mobile.so "${file}"`, { stdio: 'ignore' })
    console.log('patched', rel)
  } catch (e) {
    console.log('patchelf failed for', rel, e.message)
  }
}
