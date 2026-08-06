import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// Regression guard for the #14 discovery: a line-comment in src/swarm.js once
// swallowed `const byPubKey = new Map()` (two declarations joined on one line,
// the second eaten by the `//` comment), so `joinContact` crashed at runtime
// with "byPubKey is not defined" — on desktop AND Android. Tests never imported
// swarm.js (network), so nothing caught it. This asserts the module's top-level
// declarations stay intact.
const SWARM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'swarm.js')
const SRC = fs.readFileSync(SWARM, 'utf8')

const REQUIRED = [
  'const discoveries = new Map()',
  'const byPubKey = new Map()',
  'const conns = new Map()',
  'const connToEncPub = new Map()',
  'const verifiedConns = new Set()',
  'export function createSwarmManager',
  'function sendCheckinRequest (contactId)'
]

test('swarm.js top-level declarations are intact (not swallowed by comments)', (t) => {
  const lines = SRC.split('\n')
  for (const decl of REQUIRED) {
    t.ok(lines.some((l) => l.trim().startsWith(decl)), decl + ' is declared')
  }
  // No line joins a `//` comment with a following declaration on the same line.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const ci = line.indexOf('//')
    if (ci > -1) {
      const after = line.slice(ci + 2)
      t.not(after.includes('const '), true, 'no declaration swallowed after a line comment (line ' + (i + 1) + ')')
    }
  }
})
