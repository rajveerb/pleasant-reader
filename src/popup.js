/* Pleasant Reader — popup controller. Talks to the active tab's content script. */

const $ = (sel) => document.querySelector(sel);

let tabId = null;
let tabUrl = null; // the active tab's URL, for deriving its host-permission pattern
let st = null;     // last known state from the content script

const el = {
  toggle: $('#toggle'),
  unavailable: $('#unavailable'),
  modeSeg: $('#mode-seg'),
  modeHint: $('#mode-hint'),
  themeSeg: $('#theme-seg'),
  siteSeg: $('#site-seg'),
  siteHost: $('#site-host'),
  keepFiguresLight: $('#keep-figures-light'),
  fontRange: $('#font-range'),
  fontVal: $('#font-val'),
  fontInc: $('#font-inc'),
  fontDec: $('#font-dec')
};

// A scheme+host match pattern for the active tab (ports are ignored by match
// patterns). Prefers the content script's reported origin, falling back to the
// tab URL captured at init. Returns null for pages we can't request access to.
function originPattern() {
  const src = (st && st.origin) || tabUrl;
  try {
    const u = new URL(src);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch (e) { return null; }
}

// The active tab's hostname (for releasing host permissions across schemes).
function currentHost() {
  const src = (st && st.origin) || tabUrl;
  try {
    const u = new URL(src);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.hostname : null;
  } catch (e) { return null; }
}

const MODE_HINTS = {
  reader: 'Reader rebuilds the article in a clean column.',
  restyle: 'Restyle repaints the page in place (lighter touch).'
};

function send(msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
}

function markUnavailable() {
  el.unavailable.hidden = false;
  el.toggle.disabled = true;
  el.toggle.textContent = 'Unavailable here';
  document.querySelectorAll('.pr-section, .pr-foot').forEach((s) => { s.style.opacity = '0.4'; s.style.pointerEvents = 'none'; });
}

function setActive(container, attr, value) {
  container.querySelectorAll('.pr-seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset[attr] === value);
  });
}

function render() {
  if (!st) { markUnavailable(); return; }

  const on = st.mode && st.mode !== 'off';
  el.toggle.classList.toggle('is-on', on);
  el.toggle.textContent = on ? 'Restore original page' : 'Make this page pleasant';
  el.toggle.disabled = false;

  const activeMode = on ? st.mode : st.settings.defaultMode;
  setActive(el.modeSeg, 'mode', activeMode);
  el.modeHint.textContent = MODE_HINTS[activeMode] || '';

  setActive(el.themeSeg, 'theme', st.settings.theme);
  setActive(el.siteSeg, 'override', st.override);

  el.siteHost.textContent = st.host || 'this site';
  el.keepFiguresLight.checked = !!st.settings.keepFiguresLight;

  const scale = st.settings.fontScale || 1;
  el.fontRange.value = String(scale);
  el.fontVal.textContent = Math.round(scale * 100) + '%';
}

/* ----------------------------- interactions ----------------------------- */

el.toggle.addEventListener('click', async () => {
  const on = st && st.mode !== 'off';
  if (on) {
    st = await send({ type: 'disable' }).then((r) => r ? refresh() : st);
  } else {
    const mode = st.settings.defaultMode;
    await send({ type: 'enable', mode });
    await refresh();
  }
});

el.modeSeg.addEventListener('click', async (e) => {
  const btn = e.target.closest('.pr-seg-btn');
  if (!btn) return;
  const mode = btn.dataset.mode;
  await send({ type: 'setDefaultMode', mode });
  // If currently on, switch live to the new mode.
  if (st && st.mode !== 'off') await send({ type: 'enable', mode });
  await refresh();
});

el.themeSeg.addEventListener('click', async (e) => {
  const btn = e.target.closest('.pr-seg-btn');
  if (!btn) return;
  await send({ type: 'setTheme', theme: btn.dataset.theme });
  await refresh();
});

// Per-site rule — a binary choice; "Never" is the default. "Always" needs a
// standing host permission for the domain (so the background can auto-open it on
// future visits); requesting it here, in the popup, is what surfaces Chrome's
// native per-site permission prompt. "Never" drops that grant again so we hold
// no access we don't need.
el.siteSeg.addEventListener('click', async (e) => {
  const btn = e.target.closest('.pr-seg-btn');
  if (!btn) return;
  const choice = btn.dataset.override;
  const pattern = originPattern();

  if (choice === 'always') {
    if (pattern) {
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) { await refresh(); return; } // denied — leave the rule unchanged
    }
    await send({ type: 'setSiteOverride', value: 'always' });
    await ensureLoaded();
    await send({ type: 'enable', mode: st.settings.defaultMode });
  } else {
    // 'never' (the default): stop auto-opening here and release the grant. The
    // rule is keyed by host (scheme-less), so drop BOTH scheme variants — a
    // grant made on https must not survive a revoke issued while on http.
    await send({ type: 'setSiteOverride', value: 'never' });
    await send({ type: 'disable' });
    const h = currentHost();
    if (h) { try { await chrome.permissions.remove({ origins: [`http://${h}/*`, `https://${h}/*`] }); } catch (e2) {} }
  }
  await refresh();
});

el.keepFiguresLight.addEventListener('change', async () => {
  await send({ type: 'setKeepFiguresLight', value: el.keepFiguresLight.checked });
  await refresh();
});

function clampScale(v) { return Math.min(1.6, Math.max(0.8, Math.round(v * 10) / 10)); }

async function applyFont(scale) {
  scale = clampScale(scale);
  el.fontRange.value = String(scale);
  el.fontVal.textContent = Math.round(scale * 100) + '%';
  await send({ type: 'setFontScale', value: scale });
}

el.fontRange.addEventListener('input', () => applyFont(parseFloat(el.fontRange.value)));
el.fontInc.addEventListener('click', () => applyFont(parseFloat(el.fontRange.value) + 0.1));
el.fontDec.addEventListener('click', () => applyFont(parseFloat(el.fontRange.value) - 0.1));

/* -------------------------------- init -------------------------------- */

async function refresh() {
  st = await send({ type: 'getState' });
  render();
  return st;
}

// Ensure the content script is present in the target tab. Tabs that were open
// *before* the extension was installed/reloaded don't get the declared content
// script, so the first getState comes back null — inject on demand and retry.
async function ensureLoaded() {
  let resp = await send({ type: 'getState' });
  if (resp) return resp;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/readability.js', 'src/content.js']
    });
  } catch (e) {
    return null;
  }
  // Give the freshly injected script a moment to register its listener.
  await new Promise((r) => setTimeout(r, 200));
  return send({ type: 'getState' });
}

chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
  if (!tab || tab.id == null || /^(chrome|edge|about|chrome-extension|brave|view-source|devtools):/.test(tab.url || '')) {
    markUnavailable();
    return;
  }
  tabId = tab.id;
  tabUrl = tab.url || null;
  st = await ensureLoaded();
  render();
});
