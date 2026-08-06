// Pure helpers for the opt-in "Ask them to check in" peer location request.
//
// The feature is deliberately NOT a "force": a verified contact can *ask* you
// to broadcast a normal check-in, and you only honor the ask if you have turned
// on the "Honor location requests from contacts" setting (default OFF). Even
// when enabled, asks are rate-limited (per contact) and only flow over an
// active, verified connection.
//
// This module is pure (no sockets, no stores) so the policy is unit-testable.

// Minimum time between honored incoming requests from the same contact, and
// between the user sending two requests to the same contact.
export const CHECKIN_REQUEST_MIN_MS = 5 * 60 * 1000 // 5 minutes

// Decide whether to honor an incoming check-in request from a contact.
//   - honor:   the user's "Honor location requests" setting (default false)
//   - lastTs:  ms timestamp of the last honored request from this contact (0/undefined = never)
//   - now:     current ms timestamp
//   - minMs:   rate-limit window (defaults to CHECKIN_REQUEST_MIN_MS)
// Returns { ok, reason } where reason is 'not-enabled' | 'rate-limited' when !ok.
export function shouldHonorCheckinRequest ({ honor, lastTs, now, minMs }) {
  if (honor !== true) return { ok: false, reason: 'not-enabled' }
  if (lastTs && now - lastTs < (minMs || CHECKIN_REQUEST_MIN_MS)) return { ok: false, reason: 'rate-limited' }
  return { ok: true }
}

// Decide whether the user is allowed to send another request to a contact
// (outbound rate-limit, so the UI can't spam asks). lastTs = last outbound send.
export function canSendCheckinRequest ({ lastTs, now, minMs }) {
  if (lastTs && now - lastTs < (minMs || CHECKIN_REQUEST_MIN_MS)) return { ok: false, reason: 'rate-limited' }
  return { ok: true }
}
