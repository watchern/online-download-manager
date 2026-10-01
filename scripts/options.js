'use strict';
/* Settings page (ui/options.html) for the redesign. Writes straight to
 * chrome.storage.local; the service worker watches chrome.storage.onChanged and
 * applies/broadcasts the changes live. Appearance is also mirrored to
 * localStorage (shared across extension pages) for a flash-free first paint. */

const DEFAULTS = {
  threads: 3, maxitems: 30, orderBy: 'recent',
  notifications: true, autoCapture: false, credentials: 'include',
  bandwidth: 0, maxConcurrent: 3,
  saveAs: false, clearOnClose: false, timeout: 30, retries: 10,
  contextMenu: true, notifyError: true, soundComplete: false, openIn: 'tab',
  theme: 'light', density: 'comfortable', accent: '#0a9bd4'
};

function store(obj) { chrome.storage.local.set(obj, () => void chrome.runtime.lastError); }
function clampNum(v, lo, hi) { v = parseInt(v, 10); if (isNaN(v)) v = lo; return Math.max(lo, Math.min(hi, v)); }
function stepLabel(fmt, v) { return fmt === 'sec' ? v + 's' : fmt === 'kbps' ? (v === 0 ? (chrome.i18n && chrome.i18n.getMessage ? chrome.i18n.getMessage('off') : 'Off') : String(v)) : String(v); }

function applyAppearance(d) {
  const root = document.documentElement;
  if (d.theme) {
    const t = d.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : d.theme;
    root.setAttribute('data-theme', t);
    try { localStorage.setItem('odm-theme', d.theme); } catch (e) {}
  }
  if (d.density) { root.setAttribute('data-density', d.density); try { localStorage.setItem('odm-density', d.density); } catch (e) {} }
  if (d.accent) { root.style.setProperty('--accent', d.accent); try { localStorage.setItem('odm-accent', d.accent); } catch (e) {} }
}
function drawDots(n) {
  const dots = document.getElementById('thread-dots');
  if (!dots) return;
  Array.prototype.forEach.call(dots.children, (s, i) => s.classList.toggle('on', i < n));
}

chrome.storage.local.get(null, stored => {
  const cfg = Object.assign({}, DEFAULTS, stored || {});

  try { document.getElementById('about-ver').textContent = (chrome.i18n.getMessage('version_prefix') || 'Version') + ' ' + chrome.runtime.getManifest().version; } catch (e) {}
  applyAppearance(cfg);

  // ---- steppers ----
  document.querySelectorAll('.box-stepper').forEach(box => {
    const key = box.dataset.key, min = +box.dataset.min, max = +box.dataset.max, step = +box.dataset.step, fmt = box.dataset.fmt;
    const valEl = box.querySelector('.val');
    let v = clampNum(cfg[key], min, max);
    const draw = () => { valEl.textContent = stepLabel(fmt, v); if (key === 'threads') drawDots(v); };
    draw();
    box.querySelector('[data-dec]').onclick = () => { v = clampNum(v - step, min, max); draw(); store({ [key]: v }); };
    box.querySelector('[data-inc]').onclick = () => { v = clampNum(v + step, min, max); draw(); store({ [key]: v }); };
  });

  // ---- toggles ----
  document.querySelectorAll('.switch[data-key]').forEach(sw => {
    const key = sw.dataset.key, type = sw.dataset.type;
    let on = type === 'cookies' ? (cfg.credentials !== 'omit') : !!cfg[key];
    const draw = () => sw.classList.toggle('on', on);
    draw();
    sw.onclick = () => { on = !on; draw(); store({ [key]: type === 'cookies' ? (on ? 'include' : 'omit') : on }); };
  });

  // ---- selects ----
  document.querySelectorAll('select[data-key]').forEach(sel => {
    const key = sel.dataset.key;
    if (cfg[key] != null) sel.value = cfg[key];
    sel.onchange = () => store({ [key]: sel.value });
  });
  // save behaviour maps the select to the boolean saveAs
  const sb = document.getElementById('saveBehavior');
  if (sb) { sb.value = cfg.saveAs ? 'ask' : 'auto'; sb.onchange = () => store({ saveAs: sb.value === 'ask' }); }

  // ---- segmented (theme / density) ----
  document.querySelectorAll('[data-seg]').forEach(group => {
    const seg = group.dataset.seg;
    const buttons = group.querySelectorAll('[data-val]');
    buttons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.val === cfg[seg]);
      btn.onclick = () => {
        const v = btn.dataset.val;
        buttons.forEach(b => b.classList.toggle('active', b === btn));
        store({ [seg]: v });
        applyAppearance({ [seg]: v });
      };
    });
  });

  // ---- accent swatches ----
  const ag = document.querySelector('[data-accent-group]');
  if (ag) {
    const swatches = ag.querySelectorAll('[data-accent]');
    const paint = sel => swatches.forEach(b => {
      const on = b === sel;
      b.classList.toggle('active', on);
      b.style.boxShadow = on ? '0 0 0 2px ' + b.dataset.accent : '';
    });
    let initial = null;
    swatches.forEach(b => { if (b.dataset.accent === cfg.accent) initial = b; });
    paint(initial);
    swatches.forEach(b => {
      b.onclick = () => { paint(b); store({ accent: b.dataset.accent }); applyAppearance({ accent: b.dataset.accent }); };
    });
  }

  // ---- navigation / about ----
  const back = document.getElementById('back');
  if (back) back.onclick = () => { location.href = chrome.runtime.getURL('ui/feature.html'); };
  const home = chrome.runtime.getManifest().homepage_url;
  const openHome = () => { try { chrome.tabs.create({ url: home }); } catch (e) { window.open(home, '_blank'); } };
  const drive = document.getElementById('drive');
  if (drive) drive.onclick = openHome;
  ['link-support', 'link-home'].forEach(id => { const a = document.getElementById(id); if (a) { a.href = home; a.target = '_blank'; } });
});
