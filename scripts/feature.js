'use strict';
/*
 * Download Manager — UI controller for the redesigned manager (ui/feature.html).
 *
 * Renders the new design and wires every control to the service worker through
 * the same message protocol the old UI used (path:'popup-to-background'), so the
 * background coordinator is unchanged. The engine/native/queued download shapes
 * coming back in the 'load' message are normalised into the design's row model.
 */

/* --------------------------- background bridge -------------------------- */
var background = (function () {
  var handlers = {};
  chrome.runtime.onMessage.addListener(function (req) {
    if (req && req.path === 'background-to-popup' && handlers[req.method]) handlers[req.method](req.data);
  });
  return {
    receive: function (id, cb) { handlers[id] = cb; },
    send: function (id, data) { chrome.runtime.sendMessage({ path: 'popup-to-background', method: id, data: data }, function () { void chrome.runtime.lastError; }); }
  };
})();

/* ------------------------------- helpers -------------------------------- */
var ICON = {
  pause: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"></rect><rect x="14" y="5" width="4" height="14" rx="1.2"></rect></svg>',
  play: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5z"></path></svg>',
  retry: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-1.5 5"></path><path d="M20 4v5h-5"></path></svg>',
  open: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"></path></svg>',
  close: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg>',
  dots: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle><circle cx="12" cy="19" r="1.7"></circle></svg>',
  inbox: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"></path><path d="M7 11l5 5 5-5"></path><path d="M5 20h14"></path></svg>'
};

function el(tag, cls, attrs) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (var k in attrs) {
    if (k === 'style') e.style.cssText = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (k === 'text') e.textContent = attrs[k];
    else if (k === 'on') for (var ev in attrs.on) e.addEventListener(ev, attrs.on[ev]);
    else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  }
  return e;
}

function fmtSize(s) {
  if (!s || s <= 0) return '0 B';
  var u = ['B', 'KB', 'MB', 'GB', 'TB'];
  var i = Math.min(4, Math.floor(Math.log(s) / Math.log(1024)));
  var v = s / Math.pow(1024, i);
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
}
function fmtSpeed(b) { return (!b || b <= 0) ? '0 KB/s' : fmtSize(b) + '/s'; }
function fmtEta(rem, bps) {
  if (!bps || bps <= 0 || rem <= 0) return '—';
  var s = Math.round(rem / bps);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}
function baseName(p) { return p ? p.substring(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1) : ''; }
function hostOf(u) { try { return new URL(u).host; } catch (e) { return u || ''; } }

var TYPE_COLORS = {
  iso: '#5b7488', dmg: '#5b7488', pkg: '#5b7488', exe: '#5b7488', msi: '#5b7488',
  zip: '#c0892c', gz: '#c0892c', rar: '#c0892c', tar: '#c0892c', '7z': '#c0892c',
  pdf: '#cf5852', doc: '#cf5852', docx: '#cf5852',
  mp4: '#8a5bd0', mov: '#8a5bd0', mkv: '#8a5bd0', avi: '#8a5bd0', mp3: '#8a5bd0',
  csv: '#2e9d6b', sql: '#2e9d6b', json: '#2e9d6b', xml: '#2e9d6b',
  fig: '#cf5fa0', png: '#cf5fa0', jpg: '#cf5fa0', jpeg: '#cf5fa0', gif: '#cf5fa0'
};
function fileType(name) {
  var m = /\.([a-z0-9]+)$/i.exec(name || '');
  var ext = m ? m[1].toLowerCase() : '';
  var c = TYPE_COLORS[ext] || '#7a8a96';
  return { label: ext ? ext.toUpperCase().slice(0, 4) : 'FILE', color: c };
}

/* ------------------------------- state ---------------------------------- */
var state = {
  raw: [],            // normalised download items
  filter: 'all',
  query: '',
  sort: 'recent',
  threads: 3,
  menu: null,
  settings: { soundComplete: false, clearOnClose: false },
  completedSeen: {}   // id -> true, to chime once per completion
};
var ui = {};
var wired = false;
var lastSig = '';
var sortInitialized = false;
var toastTimer = null;

var FILTER_DEFS = [
  { key: 'all', label: 'All files', dot: 'var(--ink-3)', match: function () { return true; } },
  { key: 'downloading', label: 'Downloading', dot: 'var(--accent)', match: function (i) { return i.st === 'downloading'; } },
  { key: 'paused', label: 'Paused', dot: 'var(--amber)', match: function (i) { return i.st === 'paused'; } },
  { key: 'queued', label: 'Queued', dot: 'var(--ink-3)', match: function (i) { return i.st === 'queued'; } },
  { key: 'completed', label: 'Completed', dot: 'var(--green)', match: function (i) { return i.st === 'completed'; } },
  { key: 'failed', label: 'Failed', dot: 'var(--red)', match: function (i) { return i.st === 'failed'; } }
];

/* ----------------------- normalise a backend item ----------------------- */
function mapState(it) {
  var s = it.state;
  if (s === 'queued') return 'queued';
  if (s === 'complete') return 'completed';
  if (s === 'in_progress') return it.paused ? 'paused' : 'downloading';
  if (s === 'interrupted') return (it.paused || it.canResume) ? 'paused' : 'failed';
  return 'downloading';
}
function normalize(it) {
  var st = mapState(it);
  var total = it.totalBytes || it.fileSize || 0;
  var received = it.bytesReceived || 0;
  var startTime = it._startTime || it.startTime || 0;
  var startMs = startTime ? new Date(startTime).getTime() : 0;
  var multi = ('sections' in it) && Array.isArray(it.sections);
  var threads = multi ? it.sections.length : 1;

  // instantaneous-ish speed
  var speed = 0;
  if (st === 'downloading') {
    if (it.estimatedEndTime) {
      var etaMs = new Date(it.estimatedEndTime).getTime() - Date.now();
      var rem = total - received;
      if (etaMs > 0 && rem > 0) speed = rem / (etaMs / 1000);
    }
    if (!speed && startMs) {
      var el2 = (Date.now() - startMs) / 1000;
      if (el2 > 0) speed = received / el2;
    }
  }
  return {
    id: it.id, name: baseName(it.filename) || it.filename || 'download',
    host: hostOf(it.finalUrl || it.url), url: it.finalUrl || it.url || '',
    referrer: it.referrer || '', st: st, total: total, received: received,
    speed: speed, threads: threads, multi: multi, sections: multi ? it.sections : null,
    error: it.error || '', startMs: startMs, exists: it.exists !== false
  };
}

/* ------------------------------ row meta -------------------------------- */
var PILL = {
  downloading: { l: 'Downloading', fg: 'var(--accent-ink)', bg: 'var(--accent-soft)' },
  paused: { l: 'Paused', fg: 'var(--amber)', bg: 'var(--amber-soft)' },
  queued: { l: 'Queued', fg: 'var(--ink-2)', bg: 'var(--surface-2)' },
  completed: { l: 'Done', fg: 'var(--green)', bg: 'var(--green-soft)' },
  failed: { l: 'Failed', fg: 'var(--red)', bg: 'var(--red-soft)' }
};
function segColor(st) {
  return st === 'paused' ? 'var(--amber)' : st === 'failed' ? 'var(--red)'
    : st === 'completed' ? 'var(--green)' : st === 'queued' ? 'var(--ink-3)' : 'var(--accent)';
}
function rowMeta(i) {
  var pct = i.st === 'completed' ? 1 : (i.total ? Math.min(1, i.received / i.total) : 0);
  var pctTxt = Math.round(pct * 100) + '%';
  if (i.st === 'downloading') {
    var rem = i.total - i.received;
    var m = pctTxt + ' · ' + fmtSpeed(i.speed) + ' · ' + fmtSize(i.received) + ' of ' + fmtSize(i.total) + ' · ' + fmtEta(rem, i.speed) + ' left';
    return i.threads > 1 ? (i.threads + ' threads · ' + m) : m;
  }
  if (i.st === 'paused') return pctTxt + ' · Paused · ' + fmtSize(i.received) + ' of ' + fmtSize(i.total);
  if (i.st === 'queued') return i.total > 0
    ? ('Queued · ' + fmtSize(i.total) + ' · ' + i.threads + ' threads ready')
    : ('Queued · waiting for a free slot · ' + i.threads + ' threads ready');
  if (i.st === 'completed') return fmtSize(i.total) + ' · Saved to Downloads';
  return 'Failed · ' + (i.error || 'Error') + ' · ' + fmtSize(i.received) + ' of ' + fmtSize(i.total);
}
function segFills(i) {
  var pct = i.st === 'completed' ? 1 : (i.total ? Math.min(1, i.received / i.total) : 0);
  var color = segColor(i.st);
  var out = [];
  if (i.multi && i.threads > 1 && i.st !== 'completed') {
    for (var k = 0; k < i.sections.length; k++) {
      var s = i.sections[k];
      var f = s.size ? Math.max(0, Math.min(1, s.fetched / s.size)) : 0;
      out.push({ fill: (f * 100).toFixed(1) + '%', color: color });
    }
  } else {
    out.push({ fill: (pct * 100).toFixed(1) + '%', color: color });
  }
  return out;
}

/* -------------------------------- actions ------------------------------- */
function showToast(msg) {
  var t = document.getElementById('odm-toast');
  if (!t) { t = el('div', 'toast', { id: 'odm-toast' }); document.body.appendChild(t); }
  t.textContent = msg;
  t.style.display = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { if (t) t.style.display = 'none'; }, 1700);
}
// chrome.downloads.open needs a user gesture; calling it here (in the click
// handler, in the tab context) keeps the gesture rather than losing it across a
// message to the service worker. Fall back to the SW if the direct call throws.
function dlOpen(id) {
  try {
    var r = chrome.downloads.open(id);
    if (r && typeof r.then === 'function') r.then(function () {}, function () { background.send('open', { id: id }); });
  } catch (e) { background.send('open', { id: id }); }
}
function dlShow(id) { try { chrome.downloads.show(id); } catch (e) { background.send('show', { id: id }); } }

function rowActions(i) {
  return {
    primary: function () {
      if (i.st === 'downloading') background.send('pause', { multi: i.multi, id: i.id });
      else if (i.st === 'paused') background.send('resume', { multi: i.multi, id: i.id });
      else if (i.st === 'queued') background.send('startNow', { id: i.id });
      else if (i.st === 'failed') background.send('resume', { multi: i.multi, id: i.id });
      else dlOpen(i.id);
    },
    secondary: function () {
      if (i.st === 'downloading' || i.st === 'paused' || i.st === 'queued') background.send('cancel', { multi: i.multi, id: i.id });
      else background.send('erase', { id: i.id });
    },
    copy: function () { try { navigator.clipboard.writeText(i.url); } catch (e) {} showToast('Link copied to clipboard'); state.menu = null; renderAll(); },
    referrer: function () { if (i.referrer) background.send('referrer', i.referrer); state.menu = null; renderAll(); },
    reveal: function () { dlShow(i.id); state.menu = null; renderAll(); },
    del: function () {
      state.menu = null;
      var go = function () { background.send('remove', { id: i.id }); showToast('Deleted from disk'); };
      if (window.mscConfirm) mscConfirm('Delete', 'Delete this file from disk?', go); else go();
      renderAll();
    }
  };
}

// Map the saved "Default sort order" setting to the manager's client-side sort.
// Legacy values (the old download-API sort keys) degrade to the closest match.
function sortFromSetting(v) {
  if (v === 'recent' || v === 'name' || v === 'size') return v;
  if (v === 'totalBytes') return 'size';
  if (v === 'mime' || v === 'url') return 'name';
  return 'recent'; // startTime / endTime / state / unknown
}

/* -------------------------------- render -------------------------------- */
function visibleRows() {
  var def = FILTER_DEFS.filter(function (f) { return f.key === state.filter; })[0] || FILTER_DEFS[0];
  var q = state.query.trim().toLowerCase();
  var list = state.raw.filter(def.match);
  if (q) list = list.filter(function (i) { return (i.name + ' ' + i.host + ' ' + i.url).toLowerCase().indexOf(q) !== -1; });
  list = list.slice().sort(function (a, b) {
    if (state.sort === 'name') return a.name.localeCompare(b.name);
    if (state.sort === 'size') return (b.total || 0) - (a.total || 0);
    return (b.startMs || 0) - (a.startMs || 0);
  });
  return list;
}

function renderFilters() {
  ui.filters.textContent = '';
  FILTER_DEFS.forEach(function (f) {
    var count = state.raw.filter(f.match).length;
    var active = state.filter === f.key;
    var b = el('button', 'filter-btn' + (active ? ' active' : ''), { on: { click: function () { state.filter = f.key; state.menu = null; renderAll(); } } });
    b.appendChild(el('span', 'filter-dot', { style: 'background:' + f.dot }));
    b.appendChild(el('span', null, { style: 'flex:1', text: f.label }));
    b.appendChild(el('span', 'filter-count', { text: String(count) }));
    ui.filters.appendChild(b);
  });
}

function renderActivity() {
  var dl = state.raw.filter(function (i) { return i.st === 'downloading'; });
  var totalSpeed = dl.reduce(function (s, i) { return s + (i.speed || 0); }, 0);
  ui.totalSpeed.textContent = fmtSpeed(totalSpeed);
  if (dl.length) {
    var th = dl.reduce(function (s, i) { return s + (i.threads || 1); }, 0);
    ui.activeSummary.textContent = dl.length + ' active · ' + th + ' threads';
  } else ui.activeSummary.textContent = 'No active downloads';
}

function renderRow(i) {
  var row = el('div', 'row', { 'data-id': i.id });
  var ft = fileType(i.name);
  // tile
  var tile = el('div', 'tile', { style: 'background:color-mix(in srgb,' + ft.color + ' 12%,var(--surface));border:1px solid color-mix(in srgb,' + ft.color + ' 22%,var(--surface))' });
  tile.appendChild(el('span', null, { style: 'color:' + ft.color, text: ft.label }));
  row.appendChild(tile);
  // main
  var main = el('div', 'row-main');
  var top = el('div', 'row-top');
  top.appendChild(el('span', 'row-name', { title: i.name, text: i.name }));
  var pill = PILL[i.st];
  top.appendChild(el('span', 'pill', { style: 'color:' + pill.fg + ';background:' + pill.bg, text: pill.l }));
  top.appendChild(el('span', 'row-host', { text: i.host }));
  main.appendChild(top);
  var segs = el('div', 'segs');
  segFills(i).forEach(function (sf) {
    var seg = el('div', 'seg');
    seg.appendChild(el('div', 'seg-fill', { style: 'width:' + sf.fill + ';background:' + sf.color }));
    segs.appendChild(seg);
  });
  main.appendChild(segs);
  main.appendChild(el('div', 'row-meta', { text: rowMeta(i) }));
  row.appendChild(main);
  // actions
  var acts = rowActions(i);
  var actions = el('div', 'row-actions');
  var primary, withLabel = (i.st === 'failed' || i.st === 'completed');
  var pIcon = i.st === 'downloading' ? ICON.pause : i.st === 'completed' ? ICON.open
    : i.st === 'failed' ? ICON.retry : ICON.play;
  var pLabel = i.st === 'failed' ? 'Retry' : i.st === 'completed' ? 'Open' : '';
  var pTitle = i.st === 'downloading' ? 'Pause' : i.st === 'paused' ? 'Resume'
    : i.st === 'queued' ? 'Start now' : i.st === 'failed' ? 'Retry' : 'Open file';
  primary = el('button', 'act-primary' + (withLabel ? '' : ' tight'), { title: pTitle, html: pIcon + (pLabel ? '<span>' + pLabel + '</span>' : ''), on: { click: acts.primary } });
  actions.appendChild(primary);

  var secTitle = (i.st === 'downloading' || i.st === 'paused') ? 'Cancel'
    : i.st === 'queued' ? 'Remove from queue' : i.st === 'completed' ? 'Clear from list' : 'Remove';
  actions.appendChild(el('button', 'act-icon', { title: secTitle, html: ICON.close, on: { click: acts.secondary } }));

  var menuBtn = el('button', 'act-icon', { title: 'More actions', html: ICON.dots, on: { click: function (e) { e.stopPropagation(); state.menu = (state.menu === i.id ? null : i.id); renderAll(); } } });
  actions.appendChild(menuBtn);

  if (state.menu === i.id) {
    var menu = el('div', 'menu');
    menu.appendChild(el('button', 'menu-item', { text: 'Copy link', on: { click: acts.copy } }));
    menu.appendChild(el('button', 'menu-item', i.referrer ? { text: 'Open referrer', on: { click: acts.referrer } } : { text: 'Open referrer', disabled: 'true' }));
    menu.appendChild(el('button', 'menu-item', { text: 'Show in folder', on: { click: acts.reveal } }));
    menu.appendChild(el('div', 'menu-sep'));
    menu.appendChild(el('button', 'menu-item danger', { text: 'Delete from disk', on: { click: acts.del } }));
    actions.appendChild(menu);
  }
  row.appendChild(actions);
  return row;
}

function renderList() {
  var rows = visibleRows();
  ui.listTitle.textContent = (FILTER_DEFS.filter(function (f) { return f.key === state.filter; })[0] || {}).label || 'All files';
  ui.listCount.textContent = String(rows.length);
  ui.rows.textContent = '';
  if (rows.length === 0) {
    var empty = el('div', 'empty');
    empty.appendChild(el('div', 'empty-icon', { html: ICON.inbox }));
    var q = state.query.trim();
    empty.appendChild(el('div', 'empty-title', { text: q ? ('No matches for “' + q + '”') : 'Nothing here yet' }));
    empty.appendChild(el('div', 'empty-sub', { text: q ? 'Try a different search term or filter.' : 'Add a link above to start an accelerated download.' }));
    ui.rows.appendChild(empty);
    return;
  }
  var frag = document.createDocumentFragment();
  rows.forEach(function (i) { frag.appendChild(renderRow(i)); });
  ui.rows.appendChild(frag);
}

function renderAll() { if (!ui.rows) return; renderFilters(); renderActivity(); renderList(); }

// Lightweight in-place update during pure progress ticks (no structural change),
// so progress bars animate and an open menu / focus is preserved.
function updateProgress() {
  renderActivity();
  var rows = visibleRows();
  var byId = {};
  rows.forEach(function (i) { byId[i.id] = i; });
  var nodes = ui.rows.querySelectorAll('.row');
  for (var n = 0; n < nodes.length; n++) {
    var node = nodes[n];
    var i = byId[node.getAttribute('data-id')];
    if (!i) continue;
    var fills = segFills(i);
    var segNodes = node.querySelectorAll('.seg-fill');
    if (segNodes.length === fills.length) {
      for (var s = 0; s < fills.length; s++) segNodes[s].style.width = fills[s].fill;
    }
    var meta = node.querySelector('.row-meta');
    if (meta) meta.textContent = rowMeta(i);
  }
}

/* ------------------------------- chime ---------------------------------- */
function chime() {
  try {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    var ctx = new Ctx();
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.32);
    o.start(); o.stop(ctx.currentTime + 0.34);
    o.onended = function () { try { ctx.close(); } catch (e) {} };
  } catch (e) {}
}
function detectCompletions(items) {
  var seen = state.completedSeen;
  items.forEach(function (i) {
    if (i.st === 'completed') {
      if (!seen[i.id]) { if (state.settings.soundComplete && window.__odmReady) chime(); seen[i.id] = true; }
    }
  });
}

/* ------------------------------ appearance ------------------------------ */
function applyAppearance(d) {
  var root = document.documentElement;
  if (d.theme) {
    var t = d.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : d.theme;
    root.setAttribute('data-theme', t);
    try { localStorage.setItem('odm-theme', d.theme); } catch (e) {}
    syncThemeButtons(d.theme);
  }
  if (d.density) { root.setAttribute('data-density', d.density); try { localStorage.setItem('odm-density', d.density); } catch (e) {} }
  if (d.accent) { root.style.setProperty('--accent', d.accent); try { localStorage.setItem('odm-accent', d.accent); } catch (e) {} }
}
function syncThemeButtons(theme) {
  if (!ui.light) return;
  var eff = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
  ui.light.classList.toggle('active', eff === 'light');
  ui.dark.classList.toggle('active', eff === 'dark');
}

/* -------------------------------- wiring -------------------------------- */
function submit() {
  var raw = (ui.addurl.value || '');
  var sha = ui.sha256 ? (ui.sha256.value || '').trim() : '';
  var urls = raw.split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(function (s) { return /^https?:\/\//i.test(s); });
  if (urls.length === 0) {
    if (raw.trim()) background.send('download', raw.trim());
    else showToast('Enter a download URL');
    return;
  }
  for (var i = 0; i < urls.length; i++) background.send('download', { url: urls[i], sha256: (urls.length === 1 ? sha : '') });
  ui.addurl.value = '';
  if (ui.sha256 && urls.length === 1) ui.sha256.value = '';
  showToast(urls.length > 1 ? ('Added ' + urls.length + ' downloads') : ('Added · accelerating with ' + state.threads + ' thread' + (state.threads > 1 ? 's' : '')));
}

function setThreads(v) {
  v = Math.max(1, Math.min(5, v));
  state.threads = v;
  ui.threadVal.textContent = String(v);
  background.send('thread', v);
}

function wireOnce() {
  if (wired) return;
  wired = true;
  ui.search = document.getElementById('search');
  ui.addurl = document.getElementById('addurl');
  ui.sha256 = document.getElementById('sha256');
  ui.shaRow = document.getElementById('sha-row');
  ui.btnSha = document.getElementById('btn-sha');
  ui.threadVal = document.getElementById('thread-val');
  ui.filters = document.getElementById('filters');
  ui.totalSpeed = document.getElementById('total-speed');
  ui.activeSummary = document.getElementById('active-summary');
  ui.listTitle = document.getElementById('list-title');
  ui.listCount = document.getElementById('list-count');
  ui.rows = document.getElementById('rows');
  ui.sort = document.getElementById('sort');
  ui.light = document.getElementById('btn-light');
  ui.dark = document.getElementById('btn-dark');

  ui.search.addEventListener('input', function () { state.query = ui.search.value; state.menu = null; renderAll(); });
  ui.addurl.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  document.getElementById('btn-add').addEventListener('click', submit);
  document.getElementById('thread-inc').addEventListener('click', function () { setThreads(state.threads + 1); });
  document.getElementById('thread-dec').addEventListener('click', function () { setThreads(state.threads - 1); });
  ui.btnSha.addEventListener('click', function () {
    var open = ui.shaRow.style.display === 'none';
    ui.shaRow.style.display = open ? '' : 'none';
    ui.btnSha.classList.toggle('active', open);
    if (open && ui.sha256) ui.sha256.focus();
  });
  document.getElementById('btn-folder').addEventListener('click', function () {
    try { chrome.downloads.showDefaultFolder(); } catch (e) { background.send('folder'); }
  });
  document.getElementById('btn-clear').addEventListener('click', function () { background.send('erase'); });
  document.getElementById('btn-settings').addEventListener('click', function () { background.send('options'); });
  ui.light.addEventListener('click', function () { applyAppearance({ theme: 'light' }); persistAppearance('theme', 'light'); });
  ui.dark.addEventListener('click', function () { applyAppearance({ theme: 'dark' }); persistAppearance('theme', 'dark'); });
  ui.sort.addEventListener('change', function () { state.sort = ui.sort.value; renderAll(); });

  // drag a link onto the window -> fill the URL box (F-12)
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    var dt = e.dataTransfer;
    var url = ((dt.getData('text/uri-list') || dt.getData('text/plain') || '').split('\n')[0] || '').trim();
    if (/^https?:\/\//i.test(url)) { ui.addurl.value = url; ui.addurl.focus(); }
  });
  // close any open row menu when clicking elsewhere
  document.addEventListener('click', function () { if (state.menu !== null) { state.menu = null; renderAll(); } });
  // clear completed items when the manager closes, if enabled
  window.addEventListener('pagehide', function () { if (state.settings.clearOnClose) background.send('erase'); });

  background.send('appui', 'tab');
}

function persistAppearance(key, val) {
  var o = {}; o[key] = val;
  try { chrome.storage.local.set(o, function () { void chrome.runtime.lastError; }); } catch (e) {}
}

/* ------------------------------ messages -------------------------------- */
background.receive('load', function (e) {
  wireOnce(); // ensure element refs exist before the first render (idempotent)
  var d = e.data || {};
  if (d.threads != null) { state.threads = d.threads; if (ui.threadVal) ui.threadVal.textContent = String(d.threads); }
  if (d.soundComplete != null) state.settings.soundComplete = !!d.soundComplete;
  if (d.clearOnClose != null) state.settings.clearOnClose = !!d.clearOnClose;
  applyAppearance(d);

  // Apply the saved default sort once; after that the manager owns it via #sort.
  if (!sortInitialized && d.orderBy != null) {
    state.sort = sortFromSetting(d.orderBy);
    if (ui.sort) ui.sort.value = state.sort;
    sortInitialized = true;
  }

  var items = (d.downloads || []).map(normalize);
  detectCompletions(items);
  state.raw = items;

  var sig = items.map(function (i) { return i.id + ':' + i.st + ':' + i.threads; }).join('|') + '#' + state.filter + state.query + state.sort;
  if (sig !== lastSig) { lastSig = sig; renderAll(); }
  else updateProgress();
});

background.receive('settings', function (d) { applyAppearance(d || {}); if (d && d.threads != null) { state.threads = d.threads; if (ui.threadVal) ui.threadVal.textContent = String(d.threads); } });
background.receive('thread', function (v) { state.threads = v; if (ui.threadVal) ui.threadVal.textContent = String(v); });

window.addEventListener('load', function () {
  wireOnce();
  background.send('load');
  // let one render settle before audible chimes (avoid chiming the initial list)
  setTimeout(function () { window.__odmReady = true; }, 1200);
});
chrome.runtime.connect({ name: 'POPUP' });
