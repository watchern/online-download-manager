// Apply saved appearance before paint to avoid a flash of the wrong theme.
try {
  var t = localStorage.getItem('odm-theme') || 'light';
  var d = localStorage.getItem('odm-density') || 'comfortable';
  var a = localStorage.getItem('odm-accent');
  var de = document.documentElement;
  de.setAttribute('data-theme', t === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t);
  de.setAttribute('data-density', d);
  if (a) de.style.setProperty('--accent', a);
} catch (e) {}
