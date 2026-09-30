'use strict';
/*
 * Online Download Manager — download scheduler (F-9).
 *
 * A FIFO queue with a max-concurrency cap. When more downloads are submitted
 * than `max` allows, the extras wait in a persistent queue and start
 * automatically as running ones finish. The queue is serialized to
 * chrome.storage.local (via the injected `persist`) so it survives a service
 * worker restart.
 *
 * Pure logic (no chrome.*), so the service worker can unit-test it in Node (see
 * tests/scheduler.test.js). The SW supplies:
 *   - start(job, key) : actually dispatch the job (engine or native download)
 *   - persist(state)  : save the pending queue
 *   - now()           : clock (for optional time-scheduled jobs via startAt)
 * and reports a finished job back with complete(key); the next queued job then
 * runs. Concurrency is counted by the scheduler's own `active` map (a job is
 * "active" the moment it is dispatched), so snapshot lag never causes the limit
 * to be exceeded.
 */
function createScheduler(opts) {
  opts = opts || {};
  const start = typeof opts.start === 'function' ? opts.start : function () {};
  const persist = typeof opts.persist === 'function' ? opts.persist : function () {};
  const now = opts.now || (() => Date.now());

  let max = opts.max > 0 ? (opts.max | 0) : 3;
  let seq = 1;
  const active = new Map();   // key -> job (dispatched, not yet complete)
  let queue = [];             // [{ key, job, startAt }] pending, FIFO

  function serialize() {
    return { max, seq, queue: queue.map(q => ({ key: q.key, job: q.job, startAt: q.startAt })) };
  }
  function save() { try { persist(serialize()); } catch (e) { /* best-effort */ } }

  // Start due, queued jobs while slots are free.
  function pump() {
    const t = now();
    let i = 0;
    while (i < queue.length && active.size < max) {
      const item = queue[i];
      if (item.startAt && item.startAt > t) { i++; continue; } // not due yet
      queue.splice(i, 1);
      active.set(item.key, item.job);
      try { start(item.job, item.key); } catch (e) { /* dispatch errors free the slot via complete() */ }
    }
    save();
  }

  return {
    setMax(n) {
      const v = Math.max(1, parseInt(n, 10) || 1);
      if (v === max) return;
      max = v;
      pump();
    },
    getMax() { return max; },
    // opts: { key?, startAt? }. Returns the assigned key.
    submit(job, options) {
      options = options || {};
      const key = options.key != null ? options.key : ('q' + (seq++));
      queue.push({ key, job, startAt: options.startAt || 0 });
      pump();
      return key;
    },
    // Report a dispatched job as finished; frees its slot and starts the next.
    complete(key) {
      const had = active.delete(key);
      if (had) pump();
      return had;
    },
    // Remove a still-pending (not yet started) job, e.g. the user canceled it.
    dequeue(key) {
      const i = queue.findIndex(q => q.key === key);
      if (i === -1) return null;
      const [removed] = queue.splice(i, 1);
      save();
      return removed.job;
    },
    isPending(key) { return queue.some(q => q.key === key); },
    isActive(key) { return active.has(key); },
    activeCount() { return active.size; },
    pendingCount() { return queue.length; },
    // Pending jobs flattened for display (key + startAt merged into each job).
    pending() { return queue.map(q => Object.assign({ key: q.key, startAt: q.startAt }, q.job)); },
    // Rehydrate the pending queue after a restart. Does NOT auto-start; call
    // tick() once the dispatcher (engine/offscreen) is ready.
    load(state) {
      if (!state) return;
      if (typeof state.max === 'number') max = Math.max(1, state.max | 0 || 1);
      if (typeof state.seq === 'number') seq = state.seq;
      if (Array.isArray(state.queue)) {
        queue = state.queue.map(q => ({ key: q.key, job: q.job, startAt: q.startAt || 0 }));
      }
    },
    tick() { pump(); },        // re-evaluate (slots freed / startAt due / post-restart)
    snapshot() { return serialize(); }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createScheduler };
}
