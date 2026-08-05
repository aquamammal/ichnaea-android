// Safety-number / key-fingerprint derivation.
//
// Pure, deterministic, offline: given a contact's Base64 public key it returns
// a short 4-word pair (e.g. `falcon-fern-ember-dune`) that two peers can read
// aloud over a second, independent channel to verify the key exchange. The
// trust anchor in Ichnaea is the out-of-band key swap — if an attacker
// substitutes their key during that first exchange the handshake verifies
// happily — so a human fingerprint lets users confirm the identity before
// sharing real location. No network, no state, no DOM (import-safe in Node).
//
// Same file in both repos (ichnaea-v2 and ichnaea-android); copy, don't diverge.
//
// Entropy note: the 4-word × 256-word format is inherently a 32-bit signature
// (8 bits/word), so matching a *specific* target fingerprint costs ~2^32 and a
// general collision (birthday) ~2^16. The words are derived from a full
// SHA-256 digest of the key so the mapping is opaque and free of FNV-1a's
// structure; a contact who wants to forge a matching fingerprint must still
// brute-force the key space. Raising the collision bound further would require
// more words or a larger word list (a format change).

// Fixed 256-word list. Lowercase, short, distinct, deliberately not part of any
// standard phrase list so it reads as a unique "code word" pair rather than a
// mnemonic.
const WORDS = [
  'adobe', 'agate', 'alder', 'amber', 'anise', 'anvil', 'apron', 'apricot',
  'arrow', 'aspic', 'barge', 'basil', 'camel', 'cobra', 'atlas', 'avocet',
  'azure', 'balsa', 'bamboo', 'basalt', 'beacon', 'beaver', 'beetle', 'birch',
  'bison', 'blossom', 'bogus', 'bonnet', 'borax', 'bramble', 'breeze', 'brim',
  'brooch', 'buckeye', 'burlap', 'butter', 'cactus', 'camden', 'candle', 'canopy',
  'capri', 'carnet', 'cedar', 'chalice', 'chime', 'cinder', 'citron', 'clover',
  'cobalt', 'comet', 'conch', 'coral', 'cougar', 'coyote', 'crane', 'cress',
  'cricket', 'crimson', 'crown', 'cuddle', 'cypress', 'dahlia', 'dandelion', 'dart',
  'dazzle', 'deer', 'delta', 'denim', 'dewlap', 'dime', 'dolphin', 'donut',
  'dove', 'drapery', 'drift', 'dune', 'dusk', 'eagle', 'ebony', 'egret',
  'elm', 'ember', 'emery', 'ermine', 'falcon', 'fawn', 'feldspar', 'fern',
  'ferret', 'finch', 'fir', 'flamingo', 'flint', 'flume', 'fob', 'fog',
  'foliage', 'fox', 'frost', 'fuchsia', 'fulcrum', 'gadfly', 'garnet', 'gazelle',
  'gecko', 'gem', 'ginkgo', 'glacier', 'glow', 'gnome', 'goose', 'gourd',
  'granite', 'grebe', 'grit', 'grouse', 'gull', 'gypsum', 'harbor', 'harvest',
  'hawk', 'heather', 'hedge', 'heron', 'hollow', 'honey', 'horn', 'hound',
  'ibex', 'indigo', 'iris', 'iron', 'ivory', 'jade', 'jaguar', 'juniper',
  'kale', 'kelp', 'kite', 'kiwi', 'koala', 'lace', 'lagoon', 'larch',
  'latte', 'laurel', 'lemur', 'lichen', 'loon', 'lotus', 'lynx', 'magnet',
  'mallow', 'mantis', 'maple', 'marble', 'marmot', 'marigold', 'meadow', 'mercury',
  'mica', 'mink', 'mist', 'moose', 'moss', 'moth', 'mustard', 'myrtle',
  'nectar', 'nest', 'nickel', 'nomad', 'north', 'oasis', 'olive', 'onyx',
  'otter', 'oxide', 'paddle', 'palm', 'panda', 'pebble', 'pelican', 'petal',
  'pine', 'pinto', 'plum', 'prism', 'puffin', 'quartz', 'quill', 'rabbit',
  'radish', 'raven', 'reef', 'ridge', 'river', 'robin', 'rose', 'ruby',
  'sable', 'saffron', 'sage', 'salmon', 'sardine', 'satin', 'scarlet', 'seal',
  'seabird', 'shale', 'shark', 'silver', 'skink', 'slate', 'smoke', 'snow',
  'sparrow', 'spruce', 'squid', 'stork', 'sumac', 'swan', 'talc', 'tanager',
  'taurus', 'teal', 'tern', 'thistle', 'tide', 'tiger', 'tin', 'toad',
  'topaz', 'trout', 'tulip', 'tundra', 'umber', 'urchin', 'valley', 'varnish',
  'veil', 'velvet', 'violet', 'viper', 'volcano', 'vulcan', 'walnut', 'weasel',
  'whale', 'willow', 'wren', 'xenon', 'yarrow', 'yellow', 'zephyr', 'zinc'
]

// SHA-256 (FIPS 180-4) over a Uint8Array. Self-contained and deterministic so
// the renderer (browser) and Node tests get byte-identical results. Returns a
// 32-byte Uint8Array.
function sha256 (bytes) {
  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]
  const len = bytes.length
  const bitLenHi = Math.floor(len / 0x20000000) // len*8 as 64-bit (hi word)
  const bitLenLo = (len << 3) >>> 0
  const numBlocks = (((len + 8) >> 6) + 1)
  const padded = new Uint8Array(numBlocks * 64)
  padded.set(bytes)
  padded[len] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32((numBlocks * 64) - 8, bitLenHi)
  dv.setUint32((numBlocks * 64) - 4, bitLenLo)

  const w = new Uint32Array(64)
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  for (let block = 0; block < numBlocks; block++) {
    const base = block * 64
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(base + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + temp1) >>> 0
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (H[i] >>> 24) & 0xff
    out[i * 4 + 1] = (H[i] >>> 16) & 0xff
    out[i * 4 + 2] = (H[i] >>> 8) & 0xff
    out[i * 4 + 3] = H[i] & 0xff
  }
  return out
}

// Minimal pure base64 decoder (no Buffer, no atob) so this file runs unchanged
// in the renderer (browser) and in Node tests. Tolerates URL-safe alphabet and
// rejects any non-ASCII / out-of-alphabet character rather than guessing.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_LOOKUP = (() => {
  const m = new Int8Array(256).fill(-1)
  for (let i = 0; i < 64; i++) m[B64.charCodeAt(i)] = i
  return m
})()

function decodeB64 (str) {
  const s = str.replace(/\s+/g, '')
  if (s.length % 4 === 1) throw new Error('invalid base64 length')
  const out = []
  let buffer = 0
  let bits = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 61) break // '='
    if (c >= 128) throw new Error('invalid base64 character') // non-ASCII
    const v = B64_LOOKUP[c]
    if (v < 0) throw new Error('invalid base64 character')
    buffer = (buffer << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return out
}

// Derive a 4-word fingerprint from a Base64 public key, one word per distinct
// byte of the key's SHA-256 digest. Returns null for input that isn't a
// parseable Base64 string (empty, malformed, non-string).
export function fingerprint (publicKeyB64) {
  if (typeof publicKeyB64 !== 'string' || publicKeyB64.length === 0) return null
  let bytes
  try {
    bytes = decodeB64(publicKeyB64.replace(/-/g, '+').replace(/_/g, '/'))
  } catch {
    return null
  }
  if (!bytes.length) return null
  const digest = sha256(new Uint8Array(bytes))
  const words = []
  for (let i = 0; i < 4; i++) {
    words.push(WORDS[digest[i] % WORDS.length])
  }
  return words.join('-')
}

export { WORDS }
export const FINGERPRINT_WORDS = WORDS.length
