import crypto from 'hypercore-crypto'
import sodium from 'sodium-universal'
import b4a from 'b4a'

// --- Keypair ---------------------------------------------------------------

// Generate an Ed25519 keypair. publicKey is 32 bytes, secretKey is 64 bytes.
export function generateKeyPair () {
  const kp = crypto.keyPair()
  return { publicKey: b4a.from(kp.publicKey), secretKey: b4a.from(kp.secretKey) }
}

// --- Base64 public-key encoding --------------------------------------------

// Encode a 32-byte public key to Base64 for out-of-band sharing.
export function pubToB64 (publicKey) {
  const buf = toBuf(publicKey)
  if (buf.length !== 32) throw new Error('Public key must be 32 bytes')
  return b4a.toString(buf, 'base64')
}

// Decode + strictly validate a pasted Base64 public key.
// Throws on malformed Base64 or wrong length. Returns a 32-byte buffer.
export function pubFromB64 (b64) {
  if (typeof b64 !== 'string') throw new Error('Public key must be a Base64 string')
  const trimmed = b64.trim()
  if (trimmed.length === 0) throw new Error('Public key is empty')
  // Strict Base64 alphabet check (standard + padding). Rejects URL-unsafe junk.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new Error('Public key is not valid Base64')
  }
  let buf
  try {
    buf = b4a.from(trimmed, 'base64')
  } catch {
    throw new Error('Public key is not valid Base64')
  }
  if (buf.length !== 32) {
    throw new Error(`Public key must decode to 32 bytes (got ${buf.length})`)
  }
  return buf
}

// --- Pair-wise swarm topic derivation --------------------------------------

// Deterministic 32-byte topic shared by exactly two public keys.
// topic = blake2b( sort([pubA, pubB]).join('|') + '|beacon' )
// sort() makes it symmetric: both peers derive the same topic.
export function derivePairTopic (pubA, pubB) {
  const a = toBuf(pubA)
  const b = toBuf(pubB)
  if (a.length !== 32 || b.length !== 32) throw new Error('Both keys must be 32 bytes')
  const [lo, hi] = b4a.compare(a, b) <= 0 ? [a, b] : [b, a]
  const sep = b4a.from('|')
  const suffix = b4a.from('|beacon')
  const input = b4a.concat([lo, sep, hi, suffix])
  return b4a.from(crypto.hash(input)) // blake2b-256
}

// --- Encryption (X25519 E2E) --------------------------------------------------
//
// Design (see ARCHITECTURE.md / SECURITY.md):
//   - Each user holds a persistent X25519 "log encryption" keypair and a
//     32-byte symmetric "log key", both persisted in identity.json.
//   - Every block the user appends to their OWN local core is encrypted with
//     their symmetric log key (XSalsa20-Poly1305, sodium crypto_secretbox).
//     Because the log key is deterministic/persisted, the user can always
//     decrypt their own core after a restart.
//   - The log key is shared end-to-end with each contact during the handshake
//     as a sealed box (sodium crypto_box_seal) to the contact's X25519 public
//     key — only that contact's secret key can open it. So a third party who
//     holds the core's discovery key still cannot read the location history.
//
// Sealed-box helpers exchange the log key; encrypt/decrypt are the symmetric
// per-block AEAD. `encrypt(payload)` without a key stays a pass-through so old
// call sites / legacy plaintext blocks degrade gracefully.

// A fresh X25519 keypair used for the sealed-box log-key exchange.
export function generateLogEncryptionKeyPair () {
  const kp = crypto.encryptionKeyPair()
  return { publicKey: b4a.from(kp.publicKey), secretKey: b4a.from(kp.secretKey) }
}

// A fresh 32-byte symmetric key for encrypting one user's local core blocks.
export function generateLogKey () {
  return crypto.randomBytes(32)
}

// Sealed-box encrypt the given log key to a recipient's X25519 public key.
export function sealLogKey (logKey, recipientPublicKey) {
  return crypto.encrypt(toBuf(logKey), toBuf(recipientPublicKey))
}

// Sealed-box open a log key with MY X25519 keypair. Returns null on failure
// (wrong key / tampered box).
export function openLogKey (sealed, myEncKeyPair) {
  return crypto.decrypt(
    toBuf(sealed),
    { publicKey: toBuf(myEncKeyPair.publicKey), secretKey: toBuf(myEncKeyPair.secretKey) }
  )
}

// Symmetric AEAD encrypt a location payload. Wire format:
//   [ 24-byte nonce ][ XSalsa20-Poly1305 ciphertext (payload + 16-byte MAC) ]
// Without a logKey this passes through unchanged (legacy plaintext).
export function encrypt (plainBuffer, logKey) {
  if (!logKey) return plainBuffer
  const nonce = crypto.randomBytes(sodium.crypto_secretbox_NONCEBYTES)
  const out = b4a.alloc(nonce.length + plainBuffer.length + sodium.crypto_secretbox_MACBYTES)
  nonce.copy(out, 0)
  sodium.crypto_secretbox_easy(out.subarray(nonce.length), plainBuffer, nonce, toBuf(logKey))
  return out
}

// Symmetric AEAD decrypt. Returns null on auth failure / bad key; passes
// through unchanged if no key is supplied.
export function decrypt (cipherBuffer, logKey) {
  if (!logKey) return cipherBuffer
  if (!cipherBuffer || cipherBuffer.length < sodium.crypto_secretbox_NONCEBYTES) return null
  const nonce = cipherBuffer.subarray(0, sodium.crypto_secretbox_NONCEBYTES)
  const boxed = cipherBuffer.subarray(nonce.length)
  if (boxed.length < sodium.crypto_secretbox_MACBYTES) return null
  const plain = b4a.alloc(boxed.length - sodium.crypto_secretbox_MACBYTES)
  if (!sodium.crypto_secretbox_open_easy(plain, boxed, nonce, toBuf(logKey))) return null
  return plain
}

// --- helpers ----------------------------------------------------------------

function toBuf (key) {
  if (b4a.isBuffer(key)) return key
  if (key instanceof Uint8Array) return b4a.from(key)
  if (typeof key === 'string') return b4a.from(key, 'hex')
  throw new Error('Invalid key type')
}
