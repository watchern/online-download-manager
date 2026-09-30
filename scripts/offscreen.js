'use strict';
/*
 * Online Download Manager — download engine (offscreen document).
 *
 * This is where the multi-threaded engine actually runs. An MV3 service worker
 * has no `window`, `localStorage`, `XMLHttpRequest` or `URL.createObjectURL`,
 * so the engine that used to live in background.js could never work there.
 * The offscreen document is a real DOM context, so all of those APIs exist.
 *
 * The service worker stays a thin coordinator: it owns the privileged chrome.*
 * APIs (downloads, notifications, contextMenus, badge) and relays commands here.
 *
 * Protocol:
 *   SW  -> offscreen : { path:'bg-offscreen', method, data }
 *   offscreen -> SW  : { path:'offscreen-bg', method, data }   (+ optional callback for RPC)
 */

/* ----------------------------------------------------------------------- *
 *  global bandwidth throttle (F-9)
 *  A single token bucket shared by every segment of every active download, so
 *  the COMBINED read rate stays under the user's limit. The SW pushes the limit
 *  via the 'config' command; 0 = unlimited.
 * ----------------------------------------------------------------------- */
const throttle = createRateLimiter();

/* ----------------------------------------------------------------------- *
 *  messaging bridge to the service worker
 * ----------------------------------------------------------------------- */
const bg = {
  send(method, data) {
    try {
      chrome.runtime.sendMessage({ path: 'offscreen-bg', method, data }, () => void chrome.runtime.lastError);
    } catch (e) { /* SW may be cycling; events are best-effort */ }
  },
  // request the SW to perform a privileged action and await its result
  request(method, data) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ path: 'offscreen-bg', method, data }, resp => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(resp || { ok: false, error: 'no response from background' });
        });
      } catch (e) { resolve({ ok: false, error: String(e) }); }
    });
  }
};

/* ----------------------------------------------------------------------- *
 *  get/file.js — a temporary IndexedDB-backed file
 * ----------------------------------------------------------------------- */
const File = function (name) {
  this.name = name || 'file:' + Math.random();
};
File.prototype.open = function ({ size, truncate = false }) {
  return new Promise(async (resolve, reject) => {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota - usage >= size) {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('objects', { autoIncrement: true });
      request.onerror = reject;
      request.onsuccess = () => {
        this.db = request.result;
        localStorage.setItem(this.name, '');
        if (truncate) {
          const transaction = this.db.transaction('objects', 'readwrite');
          const objectStore = transaction.objectStore('objects');
          const r = objectStore.clear();
          r.onsuccess = resolve;
          r.onerror = reject;
        } else {
          resolve();
        }
      };
    } else {
      reject(new Error(`fatal: requested filesize is "${size}", but granted filesize is "${quota - usage}"`));
    }
  });
};
File.prototype.meta = function (obj) {
  return new Promise((resolve, reject) => {
    const transaction = this.db.transaction('objects', 'readwrite');
    transaction.oncomplete = resolve;
    transaction.onerror = reject;
    transaction.objectStore('objects').add(obj);
  });
};
File.prototype.write = function ({ blob, offset = 0 }) {
  return new Promise((resolve, reject) => {
    const transaction = this.db.transaction('objects', 'readwrite');
    transaction.oncomplete = resolve;
    transaction.onerror = reject;
    transaction.objectStore('objects').add({ offset, blob });
  });
};
File.prototype.chunks = function () {
  return new Promise((resolve, reject) => {
    const transaction = this.db.transaction('objects', 'readonly');
    const chunks = [];
    transaction.objectStore('objects').openCursor().onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) { chunks.push(cursor.value); cursor.continue(); }
    };
    transaction.onerror = reject;
    transaction.oncomplete = () => resolve(chunks);
  });
};
File.prototype.read = function (type) {
  return this.chunks().then(chunks => {
    chunks = chunks.filter(c => c.blob);
    chunks.sort((a, b) => a.offset - b.offset);
    // The per-chunk Blobs live in IndexedDB (disk-backed); concatenating them
    // produces a Blob that references those parts rather than copying every
    // byte onto the JS heap, so peak memory stays bounded for large files.
    return new Blob(chunks.map(c => c.blob), { type });
  });
};
// Assemble the file and hand it to the service worker to be written to disk.
// `meta` carries the original URL + start time so the SW can present the
// finished item correctly (real source URL, true elapsed time).
File.prototype.download = function (filename, mime, meta = {}, started = () => {}) {
  return new Promise((resolve, reject) => this.read(mime).then(async blob => {
    // F-10: optional integrity check. Only runs when the user supplied a hash,
    // since digesting requires reading the whole file into memory.
    let verified = false;
    if (meta.sha256) {
      try {
        const expected = String(meta.sha256).toLowerCase().replace(/[^a-f0-9]/g, '');
        if (expected.length === 64) {
          const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
          const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
          if (hex !== expected) { this.db.close(); reject(Error('fatal: checksum mismatch (' + hex.slice(0, 12) + '…)')); return; }
          verified = true;
        }
      } catch (e) { /* hashing failure shouldn't block a finished download */ }
    }
    this.db.close();
    const url = URL.createObjectURL(blob);
    const resp = await bg.request('commit', {
      url, filename, mime, verified,
      originalUrl: meta.originalUrl,
      startTime: meta.startTime
    });
    URL.revokeObjectURL(url);
    if (resp && resp.ok) {
      started({ id: resp.id, filename: resp.filename, exists: resp.exists !== false });
      resolve(resp);
    } else {
      reject(Error((resp && resp.error) || 'fatal: could not save the assembled file'));
    }
  }).catch(reject));
};
File.prototype.remove = function () {
  if (this.db) this.db.close();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(this.name);
    request.onsuccess = () => { localStorage.removeItem(this.name); resolve(); };
    request.onerror = reject;
  });
};

/* ----------------------------------------------------------------------- *
 *  get/get.js — a single streaming fetch with timeout + abort
 * ----------------------------------------------------------------------- */
const Get = function () {
  this.active = true;
  this.id = null;
  this.done = false;
};
Get.prototype.timeout = function (period, msg) {
  clearTimeout(this.id);
  return new Promise((resolve, reject) => {
    this.id = setTimeout(() => reject(msg), period);
  });
};
Get.prototype.abort = function () {
  clearTimeout(this.id);
  this.active = false;
  if (this.controller) this.controller.abort();
  if (this.reader) this.reader.cancel().catch(() => {});
};
Get.prototype.fetch = async function (url, props = {}, progress = () => {}) {
  props.timeout = props.timeout || 30000;
  props.credentials = props.credentials || 'include';
  this.controller = new AbortController();
  props.signal = this.controller.signal;
  const response = await Promise.race([
    fetch(url, props),
    this.timeout(props.timeout, 'noresponse timeout')
  ]);
  if (response.ok === false) {
    return Promise.reject(Error('fatal: ' + response.status + ' ' + response.statusText));
  }
  if (this.active === false) return 'aborted';
  this.reader = response.body.getReader();
  const segment = () => Promise.race([
    (async () => {
      const { done, value } = await this.reader.read();
      const got = value && value.byteLength;
      if (got) progress({ buffer: value });
      clearTimeout(this.id);
      if (done) { this.done = true; return true; }
      else if (this.active === false) return 'aborted';
      // F-9: pace the next read against the global bandwidth limit. Done AFTER
      // clearing the read timeout (and only while still active) so a long
      // throttle wait can never be mistaken for a stalled connection.
      if (got) await throttle.consume(value.byteLength);
      if (this.active === false) return 'aborted';
      return segment();
    })(),
    this.timeout(props.timeout, 'nobody timeout')
  ]);
  return segment();
};

/* ----------------------------------------------------------------------- *
 *  get/wget.js — download one byte range into the file
 * ----------------------------------------------------------------------- */
const Wget = function ({
  filename, url, timeout = 30000, chunkSize = 1 * 1024 * 1024, file, range, headers = {}, credentials = 'include'
}, observer = () => {}) {
  this.filename = filename;
  this.url = url;
  this.timeout = timeout;
  this.chunkSize = chunkSize;
  this.observer = observer;
  this.file = file;
  this.headers = headers;
  this.range = range;
  this.credentials = credentials;
};
// Discover size + range support using fetch (XHR does not exist even here for
// streaming; fetch is the modern path). Falls back to a 1-byte ranged GET when
// the server answers HEAD without the headers we need.
Wget.prototype.inspect = async function () {
  const { url, timeout, credentials } = this;
  const out = {
    'Content-Length': null, 'Content-Encoding': null, 'Length-Computable': null,
    'Content-Type': null, 'Content-Disposition': null, 'Accept-Ranges': null, 'Response-URL': url
  };
  const readFrom = res => {
    const h = res.headers;
    out['Content-Length'] = out['Content-Length'] || h.get('Content-Length');
    out['Content-Encoding'] = out['Content-Encoding'] || h.get('Content-Encoding');
    out['Content-Type'] = out['Content-Type'] || h.get('Content-Type');
    out['Content-Disposition'] = out['Content-Disposition'] || h.get('Content-Disposition');
    out['Accept-Ranges'] = out['Accept-Ranges'] || h.get('Accept-Ranges');
    out['Response-URL'] = res.url || out['Response-URL'];
  };
  const withTimeout = p => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(Error('fatal: inspect timeout')), timeout))
  ]);
  // 1) HEAD
  try {
    const res = await withTimeout(fetch(url, { method: 'HEAD', credentials, headers: this.headers }));
    if (res.ok) readFrom(res);
  } catch (e) { /* some servers reject HEAD; fall through */ }
  // 2) probe a single byte to learn the total size and confirm range support
  if (!out['Content-Length'] || out['Accept-Ranges'] !== 'bytes') {
    try {
      const res = await withTimeout(fetch(url, {
        method: 'GET', credentials,
        headers: Object.assign({}, this.headers, { Range: 'bytes=0-0' })
      }));
      readFrom(res);
      const cr = res.headers.get('Content-Range'); // e.g. "bytes 0-0/123456"
      if (cr) {
        const m = /\/(\d+)\s*$/.exec(cr);
        if (m) { out['Content-Length'] = m[1]; out['Accept-Ranges'] = 'bytes'; }
      }
      if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
    } catch (e) { /* leave fields null -> caller will fall back to native */ }
  }
  return out;
};
Wget.prototype.guess = function (headers) {
  const disposition = headers['Content-Disposition'];
  let name = '';
  if (!name && disposition) {
    const tmp = /filename\*=UTF-8''([^;]*)/.exec(disposition);
    if (tmp && tmp.length) { name = tmp[1].replace(/["']$/, '').replace(/^["']/, ''); name = decodeURIComponent(name); }
  }
  if (!name && disposition) {
    const tmp = /filename=([^;]*)/.exec(disposition);
    if (tmp && tmp.length) name = tmp[1].replace(/["']$/, '').replace(/^["']/, '');
  }
  if (disposition && name) {
    const arr = [...name].map(v => v.charCodeAt(0)).filter(v => v <= 255);
    name = (new TextDecoder('UTF-8')).decode(Uint8Array.from(arr));
  }
  if (!name) {
    const url = this.url.replace(/\/$/, '');
    const tmp = /(title|filename)=([^&]+)/.exec(url);
    if (tmp && tmp.length) name = tmp[2];
    else name = url.substring(url.lastIndexOf('/') + 1);
    name = decodeURIComponent(name.split('?')[0].split('&')[0]) || 'unknown-name';
    return name;
  }
  const se = /\.\w{2,}$/.exec(name);
  if (se && se.length) name = name.replace(se[0], '');
  name = name.replace(/[\\/:*?"<>|"]/g, '-').trim();
  if (se && se.length) return name + se[0];
  return name;
};
Wget.prototype.download = async function () {
  const { url, timeout, observer } = this;
  let { headers, range, file } = this;
  let resolve;
  const next = file => {
    this.get = new Get({ file });
    let buffers = [];
    const write = async (mandatory = false) => {
      if (write.busy) return;
      if (buffers.length === 0) {
        if (this.get.done) { observer('done'); resolve(); }
        return;
      }
      if (mandatory === false && this.get.done === false &&
          buffers.reduce((p, c) => p + c.byteLength, 0) < this.chunkSize) return;
      write.busy = true;
      const blob = new Blob(buffers, { type: 'application/octet-stream' });
      buffers = [];
      await file.write({ blob, offset: write.offset });
      observer('disk', blob.size);
      write.offset += blob.size;
      write.busy = false;
      return write();
    };
    write.offset = range ? range.start : 0;
    if (range) {
      const { start, end } = range;
      Object.assign(this.headers, { Range: `bytes=${start}-${end}` });
    }
    return new Promise((r, reject) => {
      resolve = r;
      this.get.fetch(headers['Response-URL'] || url, {
        timeout, headers: this.headers, credentials: this.credentials
      }, ({ buffer }) => {
        buffers.push(buffer);
        observer('network', buffer.byteLength);
        write().catch(reject);
      }).then(() => write(true)).catch(reject);
    });
  };
  if (file) return next(file); // imported / resumed download
  // new download
  headers = await this.inspect();
  const size = Number(headers['Content-Length']);
  observer('filesize', size);
  if (!size) return Promise.reject(Error('fallback: server does not report a size'));
  if (headers['Accept-Ranges'] !== 'bytes') return Promise.reject(Error('fallback: server does not support ranged requests'));
  range = range || observer('headers', headers);
  file = file || new File();
  this.observer('filename', this.filename || this.guess(headers));
  await file.open({ size, truncate: true });
  this.observer('file', file);
  return next(file);
};
Wget.prototype.abort = function () { if (this.get) this.get.abort(); };

/* ----------------------------------------------------------------------- *
 *  get/mwget.js — orchestrate N parallel Wget segments
 * ----------------------------------------------------------------------- */
const mwget = ({
  threads = 2, filename, url, timeout = 30000, headers = {}, id = 0,
  sections = [], fileSize = 0, file, paused = false, referrer = '', credentials = 'include', sha256 = '', key = null
}, props = {
  'segment-min': 50 * 1024, 'segment-max': 1024 * 1024 * 1024, 'retry-max': 30, 'speed-cache': 10
}) => {
  let stats = [];
  const info = {
    id, key, startTime: (new Date()).toISOString(), url, finalUrl: url, referrer,
    get filename() { return filename || 'unknown'; },
    mime: 'NA', endTime: '',
    get estimatedEndTime() {
      if (info.endTime) return info.endTime;
      const len = stats.length;
      if (len < 2 || fileSize === 0) return 'NA';
      const dt = stats[len - 1].time - stats[0].time;
      const fetched = stats.map(o => o.value).reduce((p, c) => p += c, 0);
      const rm = (fileSize - info.bytesReceived) / fetched * dt;
      return (new Date(Date.now() + rm)).toISOString();
    },
    state: 'in_progress', paused,
    get canResume() { return info.state === 'in_progress' && info.paused === true; },
    get bytesReceived() { return sections.map(s => s.fetched).reduce((p, c) => p + c, 0); },
    get totalBytes() { return fileSize; },
    get fileSize() { return fileSize; },
    get file() { return file; },
    exists: true, multi: true, sections, props
  };
  let report = () => {};
  const map = new WeakMap();
  const split = () => {
    let len = Math.floor(fileSize / threads);
    len = Math.max(len, props['segment-min']);
    len = Math.min(len, props['segment-max']);
    len = Math.min(fileSize, len);
    threads = Math.max(1, Math.floor(fileSize / len));
    const arr = Array.from(new Array(threads), (x, i) => i);
    arr.map((a, i, l) => sections.push({
      start: a * len, end: l.length === i + 1 ? fileSize - 1 : (a + 1) * len - 1, wrote: 0, fetched: 0
    }));
    sections.forEach(s => s.size = s.end - s.start + 1);
  };
  let first;
  let setup = Boolean(fileSize && sections.length);
  let count = 0;
  let policy;
  const finalize = (state, error) => {
    try { file.remove(); } catch (e) { error = error || e; }
    // Always store a string — the UI calls .toLowerCase() on info.error.
    if (error) info.error = typeof error === 'string' ? error : (error && error.message) || String(error);
    info.state = state;
    info.endTime = (new Date()).toISOString();
    // Notify the SW of genuine failures (not user cancels) for the error toast.
    if (state === 'interrupted' && info.error && !/cancel/i.test(info.error)) {
      bg.send('notify-error', { message: (info.filename ? info.filename + ' — ' : '') + 'download failed' });
    }
    report('state', info.state);
  };
  const fallbackToNative = () => {
    // Server cannot be accelerated. Hand the job to the browser's native
    // downloader exactly once (no double download), and drop our entry.
    bg.send('native', { url: info.finalUrl || url, filename, originalUrl: url });
    // The native path can't run the integrity check — tell the user so they
    // don't assume verification happened. (F-7 / F-10 honesty)
    if (sha256) bg.send('notify', { message: chrome.i18n.getMessage('notification_unverified') || 'Downloaded normally; integrity could not be verified.' });
    try { if (file) file.remove(); } catch (e) {}
    info.state = 'interrupted';
    info.fallback = true;
    info.endTime = (new Date()).toISOString();
    report('state', info.state);
  };
  const hold = () => {
    info.paused = true;
    sections.filter(s => s.wrote !== s.size).forEach(s => {
      const wget = map.get(s);
      if (wget) { wget.abort(); map.delete(s); }
    });
  };
  const pause = () => { hold(); report('paused'); };
  const cancel = () => { hold(); finalize('interrupted', 'download is canceled by user'); };
  const resume = () => {
    info.paused = false;
    count = 0;
    if (info.bytesReceived === info.totalBytes) observer(0, 'disk', 0);
    else {
      sections.forEach(s => s.fetched = s.wrote);
      sections.forEach((s, i) => { if (s.size !== s.wrote) policy('resume', i, true); });
      info.error = '';
      report('resumed');
    }
  };
  const validate = i => {
    const { fetched, size } = sections[i];
    if (fetched !== size) throw Error('fatal: segment size mismatched');
  };
  const observer = (index, key, value) => {
    if (setup === false && index === 0) {
      if (key === 'headers') {
        info.finalUrl = value['Response-URL'];
        info.mime = value['Content-Type'];
        split();
        map.set(sections[0], first);
        return sections[0];
      } else if (key === 'filename') { filename = value; report('filename', value); }
      else if (key === 'filesize') { fileSize = value; report('filesize', value); }
      else if (key === 'file') {
        file = value;
        file.meta({
          options: { threads: sections.length, filename: info.filename, fileSize, url: info.url, timeout, headers, referrer, credentials, sha256 },
          props, extra: { startTime: info.startTime, mime: info.mime }
        });
        report('file', value);
        sections.slice(1).forEach((range, i) => {
          const wget = new Wget({ filename, url, timeout, headers, range, file, credentials }, (key, value) => observer(i + 1, key, value));
          map.set(sections[i + 1], wget);
          if (info.paused === false) wget.download().then(() => validate(i + 1)).catch(e => policy(e, i + 1));
        });
        setup = true;
      }
    } else if (key === 'disk') {
      sections[index].wrote += value;
      const { wrote, size } = sections[index];
      if (wrote === size) {
        if (info.paused === false && sections.filter(s => s.wrote === s.size).length === sections.length) {
          file.download(filename, info.mime, { originalUrl: info.url, startTime: info.startTime, sha256 }, d => {
            info.id = d.id;
            filename = d.filename;
            Object.defineProperty(info, 'exists', { configurable: true, get() { return d.exists; } });
            report('native', info);
          }).then(() => finalize('complete')).catch(e => finalize('interrupted', e.message));
        }
      }
    } else if (key === 'network') {
      sections[index].fetched += value;
      stats.push({ value, time: Date.now() });
      stats = stats.slice(-1 * props['speed-cache']);
    }
  };
  policy = (e, index, silent = false) => {
    if (info.paused) return;
    if (silent !== true) count += 1;
    const msg = e && e.message ? e.message : String(e);
    if (msg.startsWith && msg.startsWith('fallback:')) { fallbackToNative(); return; }
    if (count > props['retry-max']) { pause(); return; }
    if ((msg.startsWith && msg.startsWith('fatal:')) || e instanceof DOMException) {
      finalize('interrupted', msg);
    } else {
      const wget = new Wget({ filename, url, timeout, headers, range: {
        start: sections[index].start + sections[index].wrote, end: sections[index].end
      }, file, credentials }, (key, value) => observer(index, key, value));
      map.set(sections[index], wget);
      if (info.paused === false) wget.download().catch(e => policy(e, index));
      report('retrying', index);
    }
  };
  if (sections.length === 0) {
    first = new Wget({ filename, url, timeout, headers, file, credentials }, (key, value) => observer(0, key, value));
    first.download().then(() => validate(0)).catch(e => policy(e, 0));
  } else if (paused === false) {
    resume();
  }
  return {
    cancel, resume, pause,
    object: () => ({ sections, file, fileSize, filename, map }),
    info, report: c => report = c
  };
};

/* ----------------------------------------------------------------------- *
 *  get/restore.js — find interrupted files and rebuild their section maps
 * ----------------------------------------------------------------------- */
const restore = {};
// FIX (B-6): the original enumerated chrome.storage.local as if it were a plain
// object, so resume never found anything. File.open tracks names in localStorage.
restore.list = function () {
  return Object.keys(localStorage).filter(k => k.startsWith('file:'));
};
restore.file = name => {
  const file = new File(name);
  return file.open({ size: 0 }).then(() => file.chunks().then(chunks => {
    const meta = chunks.filter(o => o.options).shift();
    if (!meta) throw new Error('no metadata for ' + name);
    let sections = [{ start: 0, end: meta.options.fileSize - 1, wrote: 0, original: true }];
    chunks.filter(o => o.blob).forEach(o => {
      const section = sections.filter(r => r.start <= o.offset && r.end >= o.offset + o.blob.size - 1).shift();
      if (section) {
        const index = sections.indexOf(section);
        sections.splice(index, 1);
        sections.push(
          { start: section.start, end: o.offset - 1, wrote: 0 },
          { start: o.offset, end: o.offset + o.blob.size - 1, wrote: o.blob.size },
          { start: o.offset + o.blob.size, end: section.end, wrote: 0 }
        );
      } else throw new Error('out of range chunk');
    });
    sections = sections.filter(s => s.end - s.start > 0).map(s => Object.assign(s, { size: s.end - s.start + 1, fetched: s.wrote }));
    sections.sort((a, b) => a.start - b.start);
    sections.forEach((section, index) => {
      if (index) { const p = sections[index - 1]; if (p.wrote === p.size) section.merge = p.end + 1 === section.start; }
    });
    for (let i = sections.length - 1; i >= 0; i -= 1) {
      const section = sections[i];
      if (section.merge) {
        sections[i - 1].end = section.end;
        sections[i - 1].fetched += section.fetched;
        sections[i - 1].wrote += section.wrote;
        sections[i - 1].size += section.size;
      }
    }
    sections = sections.filter(s => s.merge !== true).map(section => { delete section.merge; return section; });
    return {
      options: Object.assign({
        sections: sections.length === 1 && sections[0].start === 0 && sections[0].wrote === 0 ? [] : sections,
        file, paused: true
      }, meta.options),
      props: meta.props, extra: meta.extra
    };
  }));
};

/* ----------------------------------------------------------------------- *
 *  downloads manager — owns the active jobs and pushes snapshots to the SW
 * ----------------------------------------------------------------------- */
// IDs start at a high base so engine ids can never collide with the small,
// monotonically increasing ids chrome.downloads hands out (the UI keys rows by id).
const downloads = { cache: {}, index: 2000000000 };
downloads.download = (options, callback = () => {}, props) => {
  options.id = downloads.index;
  const d = downloads.cache[downloads.index] = mwget(options, props);
  d.report((key, value) => {
    if (key === 'native') {
      delete downloads.cache[options.id];
    } else if (key === 'state') {
      if (value === 'interrupted') delete downloads.cache[options.id];
    }
    emitSnapshot();
  });
  callback(downloads.index);
  downloads.index += 1;
  emitSnapshot();
};
downloads.pause = id => { const d = downloads.cache[id]; if (d) { d.pause(); emitSnapshot(); } };
downloads.resume = id => { const d = downloads.cache[id]; if (d) { d.resume(); emitSnapshot(); } };
downloads.cancel = id => { const d = downloads.cache[id]; if (d) { d.cancel(); emitSnapshot(); } };

async function restoreIncomplete() {
  const used = Object.values(downloads.cache).filter(({ info }) => info.file).map(({ info }) => info.file.name);
  const unused = restore.list().filter(name => used.indexOf(name) === -1);
  for (const name of unused) {
    try {
      const { options, props, extra } = await restore.file(name);
      downloads.download(options, id => { downloads.cache[id].info.mime = extra.mime; }, props);
    } catch (e) {
      try { new File(name).remove(); } catch (_) {}
    }
  }
  emitSnapshot();
}

/* ----------------------------------------------------------------------- *
 *  snapshots — strip non-serializable fields and push to the SW. A light
 *  ticker keeps speed/ETA fresh while something is actively downloading.
 * ----------------------------------------------------------------------- */
let ticker = null;
function buildItems() {
  return Object.values(downloads.cache).map(({ info }) => {
    const o = Object.assign({}, info); // evaluates getters into plain values
    delete o.file;
    delete o.props;
    return o;
  });
}
function emitSnapshot() {
  const items = buildItems();
  bg.send('snapshot', { items });
  const active = items.some(i => i.state === 'in_progress' && i.paused === false);
  if (active && !ticker) ticker = setInterval(emitSnapshot, 700);
  else if (!active && ticker) { clearInterval(ticker); ticker = null; }
}

/* ----------------------------------------------------------------------- *
 *  command bridge (SW -> offscreen)
 * ----------------------------------------------------------------------- */
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (!req || req.path !== 'bg-offscreen') return;
  const { method, data } = req;
  switch (method) {
    case 'config': if (data && 'bandwidth' in data) throttle.setLimit(data.bandwidth || 0); break;
    case 'download': downloads.download(data.options, () => {}, data.props); break;
    case 'pause': downloads.pause(data.id); break;
    case 'resume': downloads.resume(data.id); break;
    case 'cancel': downloads.cancel(data.id); break;
    case 'restore': restoreIncomplete(); break;
    case 'ping': sendResponse({ ok: true }); return true;
  }
});

// Announce readiness so the SW knows it can start sending commands.
bg.send('offscreen-ready', {});
