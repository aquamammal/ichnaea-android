import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { APP_VERSION } from '../src/updates.js'

// #15 — version auto-sync guard. APP_VERSION (updates.js), package.json, the
// on-screen beacon title + version tag (index.html), and (on Android, where the
// gitignored platform exists locally) the gradle versionName must all agree.
// A forgotten bump fails `npm test` immediately.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8')
const tagPrefix = pkg.name // ichnaea-v2 | ichnaea-android

test('APP_VERSION matches package.json and the on-screen version strings', (t) => {
  t.is(APP_VERSION, pkg.version, 'APP_VERSION mirrors package.json')

  const tagMatch = html.match(new RegExp(tagPrefix + ' v(\\d+\\.\\d+\\.\\d+)'))
  t.ok(tagMatch, 'version tag found in index.html')
  t.is(tagMatch[1], pkg.version, 'version tag mirrors package.json')

  const titleMatch = html.match(/Ichnaea Ver\. (\d+\.\d+\.\d+)/)
  t.ok(titleMatch, 'beacon title found in index.html')
  t.is(titleMatch[1], pkg.version, 'beacon title mirrors package.json')
})

test('android: gradle versionName agrees (when the gitignored platform exists)', (t) => {
  const gradle = path.join(ROOT, 'android', 'app', 'build.gradle')
  if (!fs.existsSync(gradle)) {
    t.ok(true, 'android/ platform not generated locally — gradle check skipped')
    return
  }
  const src = fs.readFileSync(gradle, 'utf8')
  const m = src.match(/versionName "(\d+\.\d+\.\d+)"/)
  t.ok(m, 'versionName found in build.gradle')
  t.is(m[1], pkg.version, 'gradle versionName mirrors package.json')
})
