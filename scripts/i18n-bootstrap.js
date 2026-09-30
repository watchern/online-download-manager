/* i18n bootstrap — resolves [data-i18n] attributes before the page paints.
 * Supports:
 *   data-i18n="key"            → textContent
 *   data-i18n-title="key"      → title attribute
 *   data-i18n-placeholder="key" → placeholder attribute
 *   data-i18n-html="key"       → innerHTML (rare; use for static HTML snippets)
 * Missing messages fall back to the key itself so development stays sane. */
(function () {
  'use strict';
  if (typeof chrome === 'undefined' || !chrome.i18n || typeof chrome.i18n.getMessage !== 'function') return;

  function resolve(key) {
    return chrome.i18n.getMessage(key) || key;
  }

  function apply(node) {
    if (node.hasAttribute('data-i18n')) {
      node.textContent = resolve(node.getAttribute('data-i18n'));
    }
    if (node.hasAttribute('data-i18n-title')) {
      node.setAttribute('title', resolve(node.getAttribute('data-i18n-title')));
    }
    if (node.hasAttribute('data-i18n-placeholder')) {
      node.setAttribute('placeholder', resolve(node.getAttribute('data-i18n-placeholder')));
    }
    if (node.hasAttribute('data-i18n-html')) {
      node.innerHTML = resolve(node.getAttribute('data-i18n-html'));
    }
  }

  function walk(root) {
    apply(root);
    var nodes = root.querySelectorAll ? root.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-html]') : [];
    for (var i = 0; i < nodes.length; i++) apply(nodes[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { walk(document.body); });
  } else {
    walk(document.body);
  }
})();