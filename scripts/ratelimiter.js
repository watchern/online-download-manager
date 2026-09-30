'use strict';
/*
 * Online Download Manager — global bandwidth throttle (F-9).
 *
 * A token bucket shared by EVERY download segment in the offscreen engine, so
 * the COMBINED read rate across all active segments/downloads is capped. The
 * engine paces its fetch read loop with `await throttle.consume(chunk.length)`;
 * delaying the next `reader.read()` slows how fast the response body is drained
 * which, with TCP flow control, throttles the real network rate.
 *
 * Pure logic with injectable `now`/`sleep`, so it is unit-testable in Node with
 * a virtual clock (see tests/ratelimiter.test.js). Loaded as a classic script in
 * ui/offscreen.html (defines the global `createRateLimiter`) and as a CommonJS
 * module in the tests.
 *
 * Model: tokens accrue at `rate` bytes/sec, capped at `rate * burstSeconds`
 * (idle credit). consume(n) subtracts n; if the balance goes negative it sleeps
 * just long enough for the deficit to be repaid. Starting empty means the very
 * first chunk is paced too, so total bytes by time T converges to exactly
 * rate * T (no free initial burst). A rate of 0 means unlimited (no-op).
 */
function createRateLimiter(opts) {
  opts = opts || {};
  const now = opts.now || (() => Date.now());
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms > 0 ? ms : 0)));
  const burstSeconds = opts.burstSeconds > 0 ? opts.burstSeconds : 1;

  let rate = 0;     // bytes/sec; 0 = unlimited
  let tokens = 0;   // available bytes; may go negative (debt)
  let last = now();

  const capacity = () => rate * burstSeconds;

  function refill() {
    const t = now();
    const elapsed = (t - last) / 1000;
    last = t;
    if (rate <= 0) return;
    tokens = Math.min(capacity(), tokens + elapsed * rate);
  }

  return {
    // bytesPerSecond <= 0 (or non-finite) => unlimited
    setLimit(bytesPerSecond) {
      const n = Number(bytesPerSecond);
      const next = isFinite(n) && n > 0 ? n : 0;
      if (next === rate) return;       // no-op on unchanged limit (avoids hiccups)
      rate = next;
      last = now();
      tokens = 0;                      // start empty so pacing is exact from now
    },
    getLimit() { return rate; },
    // Resolves once `bytes` of budget is available, sleeping if necessary.
    // Returns the number of milliseconds it waited (0 when unlimited / no wait).
    async consume(bytes) {
      const n = Number(bytes);
      if (rate <= 0 || !(n > 0)) return 0;
      refill();
      tokens -= n;
      if (tokens < 0) {
        const waitMs = Math.ceil((-tokens) / rate * 1000);
        await sleep(waitMs);
        return waitMs;
      }
      return 0;
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createRateLimiter };
}
