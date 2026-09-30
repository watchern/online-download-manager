'use strict';
/*
 * Online Download Manager — service worker (MV3 coordinator).
 *
 * The heavy engine lives in the offscreen document (scripts/offscreen.js).
 * This worker stays thin: it owns the privileged chrome.* APIs and routes
 * messages between the manager UI, the engine, and the browser.
 *
 * Design notes vs. the old background page:
 *  - ALL listeners are registered once, synchronously, at top level. The old
 *    code registered message handlers inside a repeating alarm callback whose
 *    sub-second delay was clamped to ~1 min, leaving the UI dead on arrival
 *    and leaking a new listener on every tick (runaway CPU). (B-8, B-9)
 *  - No window/localStorage/XHR/createObjectURL here — none exist in a worker.
 *  - chrome.runtime.sendMessage always passes a callback that reads lastError,
 *    so "receiving end does not exist" never becomes an unhandled rejection.
 *    (B-11)
 */

// Pure scheduler logic lives in its own module so it can be unit-tested in Node
// (classic service workers support importScripts; the path is relative to this
// worker, i.e. scripts/scheduler.js).
importScripts('scheduler.js');

const OFFSCREEN_URL = 'ui/offscreen.html';
const MANAGER_URL = 'ui/feature.html';

/* ------------------------------- settings ------------------------------- */
const DEFAULTS = {
  threads: 3,
  maxitems: 30,
  orderBy: 'recent',     // manager's default client-side sort: recent | name | size
  url: '',
  colors: [],
  notifications: true,   // desktop notification when a download completes (F-2)
  autoCapture: false,    // intercept browser downloads and accelerate them (F-6)
  credentials: 'include', // send cookies with download requests (B-16: configurable)
  bandwidth: 0,          // combined download speed cap in KB/s; 0 = unlimited (F-9)
  maxConcurrent: 3,      // how many downloads run at once; the rest queue (F-9)
  // redesign settings
  saveAs: false,         // prompt for a save location instead of the default folder
  clearOnClose: false,   // clear finished items when the manager tab closes
  timeout: 30,           // per-connection timeout in seconds
  retries: 10,           // engine retry-max per segment
  contextMenu: true,     // show the right-click "Download with accelerator" item
  notifyError: true,     // desktop notification when a download fails
  soundComplete: false,  // play a chime in the manager on completion
  openIn: 'tab',         // toolbar-icon launch surface: tab | popup | window
  theme: 'light',        // light | dark | system
  density: 'comfortable',// comfortable | compact
  accent: '#0a9bd4'      // UI accent color
};
let settings = Object.assign({}, DEFAULTS);

let engineItems = [];          // latest active-download snapshot from the engine
let knownIds = new Set();      // engine ids seen last snapshot (structural change detection)
let startTimes = {};           // download id -> ISO start time (true elapsed display)
let urlMap = {};               // native download id -> original source url
const ourDownloadIds = new Set(); // chrome.downloads ids we created (skip auto-capture loop)

/* ------------------------------ scheduler ------------------------------- */
// F-9: a max-concurrency queue. startDownload() submits a job; the scheduler
// either dispatches it now (dispatchJob) or holds it until a slot frees. Display
// ids for queued rows live in a high range that can't collide with the engine's
// (2e9) or chrome.downloads' (small, monotonic) ids.
let queueSeq = 3000000000;
const engineWatch = new Map();   // qid -> { seen, timer }  (engine job completion)
const nativeKeyById = new Map(); // chrome download id -> qid (native job completion)
const scheduler = createScheduler({
  start: (job, key) => dispatchJob(job, key),
  persist: state => persist({ __queue: state })
});

function makeColors(n) {
  const colors = [];
  for (let i = 0; i < Math.max(n, 5); i++) {
    const c = () => Math.floor(Math.random() * 170);
    colors.push(`rgb(${c()},${c()},${c()})`);
  }
  return colors;
}

const ready = (async () => {
  let stored = {};
  try { stored = await chrome.storage.local.get(null); } catch (e) {}
  for (const k of Object.keys(DEFAULTS)) if (k in stored) settings[k] = stored[k];
  startTimes = stored.__startTimes || {};
  urlMap = stored.__urlMap || {};
  if (!Array.isArray(settings.colors) || settings.colors.length < 5) {
    settings.colors = makeColors(5);
    persist({ colors: settings.colors });
  }
  // F-9: restore the persisted download queue + concurrency cap. tick() (after
  // the engine is up, see ensureOffscreen) starts anything that was still queued.
  scheduler.setMax(settings.maxConcurrent);
  scheduler.load(stored.__queue);
  // Advance the queued-id counter past any restored keys so a new submission
  // can never collide with a job that was already in the persisted queue.
  if (stored.__queue && Array.isArray(stored.__queue.queue)) {
    for (const item of stored.__queue.queue) {
      if (typeof item.key === 'number' && item.key >= queueSeq) queueSeq = item.key + 1;
    }
  }
})();

// Combined bandwidth limit in bytes/sec (settings store KB/s; 0 = unlimited).
function bandwidthBytes() { return Math.max(0, parseInt(settings.bandwidth, 10) || 0) * 1024; }
// Push the current throttle limit to the engine (it owns the token bucket).
function pushEngineConfig() { toEngine('config', { bandwidth: bandwidthBytes() }); }

function persist(obj) { chrome.storage.local.set(obj, () => void chrome.runtime.lastError); }

function persistMaps() {
  // keep the bookkeeping maps from growing without bound
  const trim = (obj, max) => {
    const keys = Object.keys(obj);
    if (keys.length > max) for (const k of keys.slice(0, keys.length - max)) delete obj[k];
    return obj;
  };
  persist({ __startTimes: trim(startTimes, 300), __urlMap: trim(urlMap, 300) });
}

const i18n = (k, sub) => chrome.i18n.getMessage(k, sub) || k;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const baseName = p => (p ? p.substring(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1) : '');
const isHttp = u => /^https?:\/\//i.test(u || '');

/* --------------------------- offscreen lifecycle ------------------------ */
let offscreenReadyResolve;
let offscreenReady = new Promise(r => (offscreenReadyResolve = r));
let creating = null;

async function hasOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    try { return await chrome.offscreen.hasDocument(); } catch (e) {}
  }
  // fallback for older runtimes
  try {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctxs.length > 0;
  } catch (e) { return false; }
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creating) { await creating; return; }
  offscreenReady = new Promise(r => (offscreenReadyResolve = r));
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['BLOBS', 'LOCAL_STORAGE'],
    justification: 'Assemble multi-threaded download segments into a Blob and create an object URL to save the file to disk.'
  }).catch(e => { /* "single document" race — treat as present */ });
  await creating;
  creating = null;
  // wait for the engine to announce itself (bounded so we never hang)
  await Promise.race([offscreenReady, new Promise(r => setTimeout(r, 3000))]);
  // a freshly created engine needs the current throttle limit, and should pick
  // up any interrupted downloads (F-9 config + B-10 restore).
  pushEngineConfig();
  toEngine('restore', {});
}

function toEngine(method, data) {
  chrome.runtime.sendMessage({ path: 'bg-offscreen', method, data }, () => void chrome.runtime.lastError);
}

/* ------------------------------- UI bridge ------------------------------ */
function broadcast(method, data) {
  chrome.runtime.sendMessage({ path: 'background-to-popup', method, data }, () => void chrome.runtime.lastError);
}

function searchNative(query) {
  return new Promise(res => chrome.downloads.search(query, items => { void chrome.runtime.lastError; res(items || []); }));
}

function patchNative(d) {
  const o = Object.assign({}, d);
  if (urlMap[d.id]) o.url = urlMap[d.id];
  if (startTimes[d.id]) o._startTime = startTimes[d.id];
  return o;
}

async function sendLoad(opts = {}) {
  await ready;
  // Always fetch the most-recent downloads first. chrome.downloads.search sorts
  // ASCENDING and `limit` keeps the FIRST N, so an ascending key (the legacy
  // orderBy default was 'state') pins the window to the OLDEST N items — a
  // brand-new download then falls off the end once history exceeds maxitems, and
  // the manager's "All files" list never changes when you download something new.
  // The redesigned UI sorts client-side (state.sort), so this window only needs
  // to hand over the newest N; the saved orderBy now drives that client sort.
  const native = await searchNative({ orderBy: ['-startTime'], limit: settings.maxitems });
  const queued = scheduler.pending().map(queuedRow);
  const list = engineItems.map(i => Object.assign({}, i)).concat(native.map(patchNative)).concat(queued);
  broadcast('load', {
    reset: opts.reset !== false,
    listener: !!opts.listener,
    progress: !!opts.progress,
    data: {
      appui: 'tab',
      url: settings.url,
      colors: settings.colors,
      orderBy: settings.orderBy,
      threads: settings.threads,
      maxitems: settings.maxitems,
      theme: settings.theme,
      density: settings.density,
      accent: settings.accent,
      soundComplete: settings.soundComplete,
      clearOnClose: settings.clearOnClose,
      downloads: list
    }
  });
}

/* ------------------------------ the badge ------------------------------- */
function updateBadge() {
  const active = engineItems.filter(i => i.state === 'in_progress' && !i.paused);
  if (!active.length) { chrome.action.setBadgeText({ text: '' }); return; }
  let text;
  if (active.length === 1 && active[0].totalBytes) {
    text = clamp(Math.floor(100 * active[0].bytesReceived / active[0].totalBytes), 0, 99) + '%';
  } else {
    text = String(active.length);
  }
  chrome.action.setBadgeBackgroundColor({ color: '#2b8a3e' });
  chrome.action.setBadgeText({ text });
}

/* ----------------------------- notifications ---------------------------- */
function showNotification(message) {
  if (!message || !chrome.notifications) return;
  chrome.notifications.create('', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/64.png'),
    title: i18n('app_name'),         // B-15: real localized title, not the literal key
    message
  }, () => void chrome.runtime.lastError);
}
function notify(message) { if (settings.notifications) showNotification(message); }       // completion (F-2)
function notifyError(message) { if (settings.notifyError) showNotification(message); }     // failure (redesign)

/* --------------------------- start a download --------------------------- */
// qid (optional) ties a native download back to its scheduler slot so the slot
// is freed when the download finishes (or fails to start).
function nativeDownload(opts, qid) {
  if (settings.saveAs) opts.saveAs = true; // prompt for a save location (redesign setting)
  chrome.downloads.download(opts, id => {
    if (chrome.runtime.lastError || id === undefined) {
      notifyError(i18n('notification_invalid'));
      if (qid != null) scheduler.complete(qid); // free the slot on failure
      return;
    }
    ourDownloadIds.add(id); // don't let auto-capture grab our own download
    if (qid != null) nativeKeyById.set(id, qid);
  });
}

async function startDownload(input) {
  await ready;
  const opts = typeof input === 'string' ? { url: input } : (input || {});
  const url = (opts.url || '').trim();
  if (!isHttp(url)) { notifyError(i18n('notification_invalid')); return; }
  settings.url = url;
  persist({ url });
  const threads = clamp(parseInt(opts.threads || settings.threads, 10) || 1, 1, 5);
  const sha256 = opts.sha256 ? String(opts.sha256).replace(/[^a-f0-9]/gi, '').toLowerCase() : '';
  const wantVerify = sha256.length === 64;
  // A requested integrity check only runs in the engine, so force the engine
  // path (>=2 threads) instead of silently dropping the checksum.
  const job = {
    kind: (threads <= 1 && !wantVerify) ? 'native' : 'engine',
    url,
    threads: wantVerify ? Math.max(threads, 2) : threads,
    filename: opts.filename || '',
    referrer: opts.referrer || '',
    sha256: wantVerify ? sha256 : ''
  };
  // F-9: hand the job to the scheduler. It dispatches now if a slot is free,
  // otherwise it queues the job (shown as a "queued" row) until one opens up.
  scheduler.submit(job, { key: queueSeq++ });
  sendLoad({ reset: true });
}

// The scheduler's dispatcher: actually launch a job once it has a slot.
function dispatchJob(job, qid) {
  if (job.kind === 'native') {
    nativeDownload({ url: job.url }, qid);
    return;
  }
  // Engine job. Track it so onSnapshot can free the slot when it finishes. The
  // safety timer covers the rare case where the job dies before ever appearing
  // in a snapshot (e.g. an instant inspect failure), so the slot can't leak.
  const watch = { seen: false, timer: null };
  watch.timer = setTimeout(() => {
    if (!watch.seen && engineWatch.get(qid) === watch) {
      engineWatch.delete(qid);
      scheduler.complete(qid);
    }
  }, 30000);
  engineWatch.set(qid, watch);
  ensureOffscreen().then(() => {
    pushEngineConfig();
    toEngine('download', {
      options: {
        url: job.url, threads: job.threads, timeout: timeoutMs(),
        filename: job.filename || undefined, referrer: job.referrer,
        credentials: settings.credentials,
        sha256: job.sha256, key: qid
      },
      props: engineProps()
    });
  });
}

// Per-connection timeout (seconds in settings) and engine tuning props. retry-max
// comes from the "Retry attempts on failure" setting; the rest keep engine defaults.
function timeoutMs() { return Math.max(5, parseInt(settings.timeout, 10) || 30) * 1000; }
function engineProps() {
  return {
    'segment-min': 50 * 1024, 'segment-max': 1024 * 1024 * 1024,
    'retry-max': Math.max(0, parseInt(settings.retries, 10) || 0),
    'speed-cache': 10
  };
}

// A download-shaped row so queued (not-yet-started) jobs are visible in the
// manager and can be canceled. The id is the scheduler key (queueSeq range).
function queuedRow(job) {
  return {
    id: job.key, url: job.url, finalUrl: job.url,
    filename: guessName(job.url),
    state: 'queued', paused: false, error: '',
    totalBytes: 0, bytesReceived: 0,
    exists: true, multi: false, queued: true, startTime: ''
  };
}
function guessName(u) {
  try {
    const path = new URL(u).pathname.replace(/\/$/, '');
    return decodeURIComponent(path.substring(path.lastIndexOf('/') + 1)) || u;
  } catch (e) { return u; }
}

// "Start now" on a queued row: pull it out of the queue and dispatch immediately,
// running one past the concurrency cap rather than waiting for a free slot.
function startNow(data) {
  if (!data) return;
  const job = scheduler.dequeue(data.id);
  if (job) { dispatchJob(job, data.id); sendLoad({ reset: true }); }
}

/* ------------------------- engine event handling ------------------------ */
function onSnapshot(items) {
  engineItems = items || [];
  // F-9: free a scheduler slot once an engine job has appeared in a snapshot and
  // then left it (completed / interrupted / fell back to native). We wait for the
  // job to be "seen" first so a just-dispatched job isn't freed before the engine
  // has even registered it.
  if (engineWatch.size) {
    const present = new Set(engineItems.filter(i => i.key != null).map(i => i.key));
    for (const [qid, w] of engineWatch) {
      if (present.has(qid)) { w.seen = true; if (w.timer) { clearTimeout(w.timer); w.timer = null; } }
      else if (w.seen) { engineWatch.delete(qid); scheduler.complete(qid); }
    }
  }
  // The signature includes state + paused so a pause/resume/finish flip counts
  // as structural and triggers a full re-render (which re-evaluates the row's
  // buttons). Plain byte progress keeps the same signature -> smooth in-place
  // update without rebuilding the list.
  const sig = new Set(engineItems.map(i => i.id + ':' + i.state + ':' + i.paused));
  let structural = sig.size !== knownIds.size;
  if (!structural) for (const s of sig) if (!knownIds.has(s)) { structural = true; break; }
  knownIds = sig;
  updateBadge();
  sendLoad({ reset: structural, progress: !structural });
}

function handleCommit(data, sendResponse) {
  // The engine assembled the file as a blob: URL inside the offscreen document.
  // Save it through chrome.downloads (only available here), wait for the file to
  // land on disk, then report back so the engine can clean up its temp store.
  let done = false;
  let savedId;
  let safety = null;
  // Inactivity backstop: a healthy save emits onChanged deltas that keep
  // resetting this timer; only true silence (e.g. a download stuck awaiting a
  // dangerous-file decision the user ignores) trips it, so we never leak the
  // listener / hang the engine, and never kill a slow-but-progressing save.
  const bump = () => { if (safety) clearTimeout(safety); safety = setTimeout(() => finish(false, 'save timeout'), 300000); };
  const observe = delta => {
    if (delta.id !== savedId) return;
    bump();
    if (delta.state && delta.state.current === 'complete') finish(true);
    else if (delta.state && delta.state.current === 'interrupted') finish(false, 'interrupted');
  };
  const finish = (ok, err) => {
    if (done) return;
    done = true;
    if (safety) clearTimeout(safety);
    chrome.downloads.onChanged.removeListener(observe);
    if (ok) {
      chrome.downloads.search({ id: savedId }, ([d]) => {
        void chrome.runtime.lastError;
        const name = baseName(d ? d.filename : data.filename);
        sendResponse({ ok: true, id: savedId, filename: d ? d.filename : data.filename, exists: d ? d.exists : true });
        notify(i18n('notification_complete') + name + (data.verified ? ' ' + i18n('notification_verified') : ''));
      });
    } else {
      sendResponse({ ok: false, error: err || 'save failed' });
    }
  };

  chrome.downloads.download({
    url: data.url,
    filename: data.filename ? baseName(data.filename) : undefined,
    saveAs: !!settings.saveAs
  }, id => {
    if (chrome.runtime.lastError || id === undefined) {
      done = true;
      notifyError(i18n('notification_failed'));
      sendResponse({ ok: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : 'download failed' });
      return;
    }
    savedId = id;
    ourDownloadIds.add(id);
    startTimes[id] = data.startTime || (new Date()).toISOString();
    if (data.originalUrl) urlMap[id] = data.originalUrl;
    persistMaps();
    chrome.downloads.onChanged.addListener(observe);
    bump();
    // the state transition may have already fired before the listener attached
    chrome.downloads.search({ id }, ([d]) => {
      void chrome.runtime.lastError;
      if (d && d.state === 'complete') finish(true);
      else if (d && d.state === 'interrupted') finish(false, 'interrupted');
    });
  });
}

function handleOffscreen(method, data, sendResponse) {
  switch (method) {
    case 'offscreen-ready': offscreenReadyResolve && offscreenReadyResolve(); break;
    case 'snapshot': onSnapshot(data.items); break;
    case 'native': nativeDownload({ url: data.url, ...(data.filename ? { filename: baseName(data.filename) } : {}) });
      if (data.originalUrl) { /* native item keeps its own url; nothing to map */ } break;
    case 'notify': notify(data.message); break;
    case 'notify-error': notifyError(data.message); break;
    case 'commit': handleCommit(data, sendResponse); return true; // async response
  }
}

/* ------------------------------ UI handling ----------------------------- */
async function handleUi(method, data) {
  await ready;
  switch (method) {
    case 'load': sendLoad({ reset: true, listener: true }); break;
    case 'download': startDownload(data); break;
    case 'thread': {
      settings.threads = clamp(parseInt(data, 10) || 1, 1, 5);
      settings.colors = makeColors(5);
      persist({ threads: settings.threads, colors: settings.colors });
      broadcast('thread', settings.threads);
      break;
    }
    case 'maxitems': settings.maxitems = clamp(parseInt(data, 10) || 1, 1, 1000); persist({ maxitems: settings.maxitems }); sendLoad({ reset: true }); break;
    case 'orderBy': settings.orderBy = data; persist({ orderBy: data }); sendLoad({ reset: true }); break;
    case 'search': {
      const q = data && data.query ? data.query.filter(Boolean) : [];
      if (q.length) {
        const native = await searchNative({});
        const list = engineItems.concat(native.map(patchNative))
          .filter(it => q.some(s => (it.url || '').includes(s) || (it.finalUrl || '').includes(s) || (it.filename || '').includes(s)));
        broadcast('load', { reset: true, listener: false, progress: false, data: {
          appui: 'tab', url: settings.url, colors: settings.colors, orderBy: settings.orderBy,
          threads: settings.threads, maxitems: settings.maxitems, downloads: list
        }});
      } else sendLoad({ reset: true, listener: true });
      break;
    }
    case 'erase':
      // a still-queued job: drop it from the scheduler queue
      if (data && typeof data.id === 'number' && scheduler.dequeue(data.id)) { sendLoad({ reset: true }); break; }
      eraseItem(data); break;
    case 'remove': removeFile(data); break;
    case 'icon': getFileIcon(data); break;
    case 'open':
      if (data && typeof data.id === 'number') chrome.downloads.open(data.id, () => void chrome.runtime.lastError);
      break;
    case 'show': // reveal a finished file in its folder
      if (data && typeof data.id === 'number' && chrome.downloads.show) chrome.downloads.show(data.id);
      break;
    case 'startNow': startNow(data); break;
    case 'referrer': if (data) chrome.tabs.create({ url: data }); break;
    case 'pause': if (data.multi) toEngine('pause', { id: data.id }); else chrome.downloads.pause(data.id, () => void chrome.runtime.lastError); sendLoad({ reset: false }); break;
    case 'resume': if (data.multi) toEngine('resume', { id: data.id }); else chrome.downloads.resume(data.id, () => void chrome.runtime.lastError); sendLoad({ reset: false }); break;
    case 'cancel':
      // a still-queued job cancels by leaving the scheduler queue (F-9)
      if (data && scheduler.dequeue(data.id)) { sendLoad({ reset: true }); break; }
      if (data.multi) toEngine('cancel', { id: data.id }); else chrome.downloads.cancel(data.id, () => void chrome.runtime.lastError); sendLoad({ reset: true }); break;
    case 'support': chrome.tabs.create({ url: chrome.runtime.getManifest().homepage_url }); break;
    case 'folder': if (chrome.downloads.showDefaultFolder) chrome.downloads.showDefaultFolder(); break;
    case 'options': chrome.runtime.openOptionsPage(); break;
    case 'appui': break; // single launch surface (tab); kept for UI compatibility
  }
}

function eraseItem(data) {
  if (data && typeof data.id === 'number') {
    // an active engine row "clear from list" cancels it; otherwise erase the record
    if (engineItems.some(i => i.id === data.id)) { toEngine('cancel', { id: data.id }); sendLoad({ reset: true }); }
    else chrome.downloads.erase({ id: data.id }, () => { void chrome.runtime.lastError; sendLoad({ reset: true }); });
  } else {
    // clear all finished items
    chrome.downloads.search({}, arr => {
      void chrome.runtime.lastError;
      (arr || []).forEach(d => { if (d.state !== 'in_progress') chrome.downloads.erase({ id: d.id }, () => void chrome.runtime.lastError); });
      sendLoad({ reset: true });
    });
  }
}

function removeFile(data) {
  if (!data || typeof data.id !== 'number') return;
  chrome.downloads.search({ id: data.id }, ([d]) => {
    void chrome.runtime.lastError;
    if (d && d.exists && d.state === 'complete') {
      chrome.downloads.removeFile(d.id, () => {
        void chrome.runtime.lastError;
        chrome.downloads.erase({ id: d.id }, () => { void chrome.runtime.lastError; sendLoad({ reset: true }); });
      });
    }
  });
}

function getFileIcon(data) {
  if (data.multi) {
    broadcast('icon', { id: data.id, fileextension: data.fileextension, src: 'unknown.png' });
  } else {
    chrome.downloads.getFileIcon(data.id, { size: 32 }, src => {
      void chrome.runtime.lastError;
      broadcast('icon', { id: data.id, fileextension: data.fileextension, src: src || 'unknown.png' });
    });
  }
}

/* ------------------------------ auto-capture ---------------------------- */
// F-6: when enabled, intercept browser downloads and route them through the
// accelerator. Off by default; the engine falls back to native if the server
// can't be accelerated, so nothing is lost.
chrome.downloads.onCreated.addListener(async item => {
  await ready;
  // A newly created download needs a structural refresh so its row appears
  // (the debounced onChanged refresh only updates rows that already exist).
  sendLoad({ reset: true });
  if (!settings.autoCapture) return;
  // Skip anything an extension started (including our own commit, native
  // fallback and single-thread downloads). This is race-free, unlike checking
  // an id Set that is populated only after download() returns.
  if (item.byExtensionId) return;
  if (ourDownloadIds.has(item.id)) return;
  const url = item.finalUrl || item.url || '';
  if (!isHttp(url)) return;                                 // skip blob:/data:/file:
  if (item.state !== 'in_progress') return;
  try {
    await new Promise(r => chrome.downloads.cancel(item.id, () => { void chrome.runtime.lastError; r(); }));
    await new Promise(r => chrome.downloads.erase({ id: item.id }, () => { void chrome.runtime.lastError; r(); }));
  } catch (e) { return; }
  startDownload({ url, threads: settings.threads, filename: item.filename, referrer: item.referrer });
});

/* ------------------------------- routing -------------------------------- */
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (!req) return;
  if (req.path === 'popup-to-background') { handleUi(req.method, req.data); return; }
  if (req.path === 'offscreen-bg') return handleOffscreen(req.method, req.data, sendResponse);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let changed = false;
  for (const k in changes) if (k in DEFAULTS) { settings[k] = changes[k].newValue; changed = true; }
  // F-9: apply throttle / concurrency changes live.
  if ('bandwidth' in changes) pushEngineConfig();
  if ('maxConcurrent' in changes) { scheduler.setMax(settings.maxConcurrent); sendLoad({ reset: true }); }
  // redesign: rebuild/remove the context menu when its toggle flips.
  if ('contextMenu' in changes) createContextMenu();
  if (changed) {
    // refresh the manager's control widgets (e.g. after the options page edits)
    broadcast('settings', {
      url: settings.url, threads: settings.threads, maxitems: settings.maxitems, orderBy: settings.orderBy, colors: settings.colors,
      theme: settings.theme, density: settings.density, accent: settings.accent, soundComplete: settings.soundComplete
    });
    sendLoad({ reset: true });
  }
});

// Keep an open manager tab in sync with native (single-thread / fallback)
// downloads, whose progress and completion the engine ticker doesn't drive.
let nativeRefreshTimer = null;
chrome.downloads.onChanged.addListener(delta => {
  // F-9: free the scheduler slot when a scheduled native download finishes.
  if (delta && delta.state && nativeKeyById.has(delta.id)) {
    const cur = delta.state.current;
    if (cur === 'complete' || cur === 'interrupted') {
      const qid = nativeKeyById.get(delta.id);
      nativeKeyById.delete(delta.id);
      scheduler.complete(qid);
      if (cur === 'interrupted') notifyError(i18n('notification_failed'));
    }
  }
  if (nativeRefreshTimer) return;
  nativeRefreshTimer = setTimeout(() => { nativeRefreshTimer = null; sendLoad({ reset: false }); }, 500);
});

/* --------------------------- lifecycle + menus -------------------------- */
function createContextMenu() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    if (settings.contextMenu === false) return; // toggled off in settings
    chrome.contextMenus.create({
      id: 'odm-download',
      title: i18n('context_download'),
      contexts: ['link', 'image', 'video', 'audio']
    }, () => void chrome.runtime.lastError);
  });
}

chrome.contextMenus && chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.linkUrl || info.srcUrl || info.selectionText;
  if (url) startDownload({ url, threads: settings.threads, referrer: info.pageUrl });
});

chrome.runtime.onInstalled.addListener(async e => {
  await ready;
  createContextMenu(); // after ready so the contextMenu toggle is respected
  await ensureOffscreen();
  scheduler.tick(); // resume any downloads that were still queued before an update
  // F-14: open the local manager on install instead of a marketing page.
  if (e.reason === 'install') openManager();
});

chrome.runtime.onStartup.addListener(async () => {
  await ready;
  createContextMenu();
  await ensureOffscreen();
  scheduler.tick(); // resume any downloads that were still queued before restart
});

// Launch surface from the toolbar icon (redesign "Open manager in" setting).
function openManager() {
  const url = chrome.runtime.getURL(MANAGER_URL);
  if (settings.openIn === 'window') chrome.windows.create({ url, type: 'normal', width: 1180, height: 820 });
  else if (settings.openIn === 'popup') chrome.windows.create({ url, type: 'popup', width: 920, height: 720 });
  else chrome.tabs.create({ url });
}
chrome.action.onClicked.addListener(async () => { await ready; openManager(); });

// When the manager tab connects, make sure the engine is up and push fresh data.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'POPUP') return;
  ensureOffscreen().then(() => { scheduler.tick(); sendLoad({ reset: true, listener: true }); });
});
