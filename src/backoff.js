// Exponential backoff for reconnect logic (shared by desktop + Android renderers
// and the Android WebSocket client). Pure + renderer-safe (no Node builtins).

// Delay (ms) for a given reconnect attempt (0-based): base * 2^attempt, capped
// at `max`. attempt 0 returns `base`. Pass attempt = -1/0 reset to immediate.
export function backoffDelay (attempt, { base = 1000, max = 30000 } = {}) {
  if (typeof attempt !== 'number' || attempt < 0) attempt = 0
  const exp = base * Math.pow(2, attempt)
  return Math.min(exp, max)
}

// A tiny stateful backoff: call `next()` to advance and get the delay, and
// `reset()` on a successful connection.
export function createBackoff (opts) {
  let attempt = 0
  return {
    next () {
      const delay = backoffDelay(attempt, opts)
      attempt += 1
      return delay
    },
    reset () { attempt = 0 }
  }
}
