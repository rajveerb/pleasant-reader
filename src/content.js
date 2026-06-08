/*
 * Pleasant Reader — content script.
 *
 * Orchestrates the two transformation modes on a page:
 *   - "reader"  : extract the article (readability.js) and render it in an
 *                 isolated Shadow DOM overlay using the reader theme.
 *   - "restyle" : keep the page DOM and inject restyle.css to repaint it.
 *
 * Reads settings from chrome.storage, auto-activates on article-like pages
 * when enabled, and responds to commands from the popup / keyboard shortcut.
 */
(function () {
  'use strict';

  if (window.__pleasantReaderLoaded) return;
  window.__pleasantReaderLoaded = true;

  const HOST_ID = 'pleasant-reader-host';
  const FONT_STYLE_ID = 'pleasant-reader-fonts';
  const RESTYLE_LINK_ID = 'pleasant-reader-restyle';
  // Reader background per theme (mirrors reader.css --cream). Pinned inline on
  // the host so page CSS can't force it transparent to see/click through.
  const THEME_BG = { light: '#F1E9DF', dark: '#1a1714' };

  const DEFAULTS = {
    theme: 'auto',          // 'auto' | 'light' | 'dark'
    defaultMode: 'reader',  // 'reader' | 'restyle'
    fontScale: 1,
    keepFiguresLight: false, // in dark mode, leave figures un-inverted (light)
    siteOverrides: {}       // { hostname: 'always' | 'never' } — 'always' is
                            // backed by an explicit host-permission grant
  };

  const state = {
    mode: 'off',            // 'off' | 'reader' | 'restyle'
    settings: { ...DEFAULTS },
    shadowRoot: null,
    parsed: null,
    scrollY: 0,
    mql: null,
    onMqlChange: null
  };

  const host = () => location.hostname;

  /* ----------------------------- settings ----------------------------- */

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, (items) => {
        state.settings = { ...DEFAULTS, ...items };
        // Clamp fontScale at the boundary so a malformed/extreme stored value
        // can never reach the enable-path CSS writers unbounded.
        const fs = Number(state.settings.fontScale);
        state.settings.fontScale = Number.isFinite(fs) ? Math.min(1.6, Math.max(0.8, fs)) : 1;
        resolve(state.settings);
      });
    });
  }

  function saveSettings(patch) {
    Object.assign(state.settings, patch);
    chrome.storage.sync.set(patch);
  }

  function resolvedTheme() {
    const t = state.settings.theme;
    if (t === 'light' || t === 'dark') return t;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /* ------------------------- document-level fonts --------------------- */

  function injectFonts() {
    if (document.getElementById(FONT_STYLE_ID)) return;
    const url = (f) => chrome.runtime.getURL('fonts/' + f);
    const css = `
@font-face{font-family:'National Park';font-style:normal;font-weight:400 700;font-display:swap;
  src:url('${url('nationalpark-latin.woff2')}') format('woff2');
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
@font-face{font-family:'National Park';font-style:normal;font-weight:400 700;font-display:swap;
  src:url('${url('nationalpark-latinext.woff2')}') format('woff2');
  unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;}
@font-face{font-family:'Fragment Mono';font-style:normal;font-weight:400;font-display:swap;
  src:url('${url('fragmentmono-latin.woff2')}') format('woff2');
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
@font-face{font-family:'Fragment Mono';font-style:normal;font-weight:400;font-display:swap;
  src:url('${url('fragmentmono-latinext.woff2')}') format('woff2');
  unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;}
@font-face{font-family:'Playfair Display';font-style:normal;font-weight:400;font-display:swap;
  src:url('${url('playfair-latin.woff2')}') format('woff2');
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}`;
    const el = document.createElement('style');
    el.id = FONT_STYLE_ID;
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  /* ----------------------------- reader mode -------------------------- */

  const ICONS = {
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    type: '<svg viewBox="0 0 24 24"><path d="M4 7V5h16v2M9 19h6M12 5v14"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  async function enableReader() {
    if (state.mode === 'restyle') removeRestyle();
    if (state.mode === 'reader') return true;

    const parsed = window.PleasantReadability.parse();
    if (!parsed.ok) {
      // Fall back to restyle if we can't confidently extract an article.
      return enableRestyle(true);
    }
    state.parsed = parsed;
    injectFonts();

    state.scrollY = window.scrollY;

    const hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    // Pin the overlay's critical layout/stacking properties inline with
    // !important. The host lives in the (untrusted) page DOM under a fixed,
    // known id, so page CSS could otherwise hide, collapse, de-stack, or
    // click-disable the reader (`#pleasant-reader-host{display:none!important}`)
    // to defeat or spoof it. Inline !important outranks any external page rule.
    const guard = {
      position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
      width: 'auto', height: 'auto',
      'max-width': 'none', 'max-height': 'none', 'min-width': '0', 'min-height': '0',
      margin: '0', 'z-index': '2147483647', display: 'block',
      opacity: '1', 'pointer-events': 'auto',
      // Cover every way page CSS could visually nullify the overlay: legacy
      // transform AND the independent transform props, clipping, compositing,
      // and rendering-skip toggles.
      transform: 'none', scale: 'none', rotate: 'none', translate: 'none',
      filter: 'none', 'mix-blend-mode': 'normal', mask: 'none', '-webkit-mask': 'none',
      clip: 'auto', 'clip-path': 'none', contain: 'none', 'content-visibility': 'visible'
    };
    for (const k in guard) hostEl.style.setProperty(k, guard[k], 'important');
    const shadow = hostEl.attachShadow({ mode: 'open' });
    state.shadowRoot = shadow;

    // Load the reader stylesheet via a <link>, NOT fetch(). A content-script
    // fetch() is governed by the page's CSP connect-src, which strict sites
    // (e.g. connect-src 'self') block — leaving the reader unstyled. A <link>
    // to an extension resource bypasses page CSP, the same way restyle mode
    // already loads its CSS. We hide the host until the sheet loads to avoid a
    // flash of unstyled content.
    hostEl.style.setProperty('visibility', 'hidden', 'important');
    const linkEl = document.createElement('link');
    linkEl.rel = 'stylesheet';
    linkEl.href = chrome.runtime.getURL('src/reader.css');
    const reveal = () => { hostEl.style.setProperty('visibility', 'visible', 'important'); };
    linkEl.addEventListener('load', reveal);
    linkEl.addEventListener('error', reveal);
    setTimeout(reveal, 800); // safety net if neither event fires
    shadow.appendChild(linkEl);

    shadow.host.setAttribute('data-theme', resolvedTheme());
    hostEl.style.setProperty('background-color', THEME_BG[resolvedTheme()] || THEME_BG.light, 'important');
    shadow.host.setAttribute('data-figures', state.settings.keepFiguresLight ? 'light' : 'invert');
    shadow.host.style.setProperty('--reader-font-scale', String(state.settings.fontScale));

    shadow.appendChild(buildReaderDOM(parsed));

    highlightCodeBlocks(shadow);
    renderMath(shadow); // async, fire-and-forget so the reader shows immediately

    document.documentElement.appendChild(hostEl);
    document.documentElement.style.overflow = 'hidden';

    bindReaderEvents(shadow);
    watchSystemTheme();
    state.mode = 'reader';
    notifyBackground();
    return true;
  }

  function buildReaderDOM(parsed) {
    const frag = document.createDocumentFragment();

    // Top bar
    const bar = document.createElement('div');
    bar.className = 'reader-bar';
    bar.innerHTML = `
      <span class="reader-logo"><span class="dot"></span> Pleasant Reader</span>
      <button class="font-dec" title="Smaller text">A−</button>
      <button class="font-inc" title="Larger text">A+</button>
      <button class="theme-btn" title="Toggle theme"></button>
      <button class="close-btn" title="Close reader (Esc)">${ICONS.close}<span class="label">Close</span></button>
    `;
    frag.appendChild(bar);

    // Header box
    const header = document.createElement('div');
    header.className = 'article-header';
    const metaBits = [];
    if (parsed.byline) metaBits.push(`<span class="author-name">${escapeHtml(parsed.byline)}</span>`);
    if (parsed.published) metaBits.push(`<span class="date">${escapeHtml(parsed.published)}</span>`);
    header.innerHTML = `
      <h1>${escapeHtml(parsed.title || document.title)}</h1>
      <div class="article-meta">
        ${metaBits.join('')}
        <a class="source-link" href="${escapeHtml(location.href)}" target="_blank" rel="noopener">View original</a>
      </div>
    `;
    frag.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'article-body';
    body.appendChild(parsed.content);
    frag.appendChild(body);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'reader-footer';
    footer.innerHTML = `Reformatted by Pleasant Reader · <a href="${escapeHtml(location.href)}" target="_blank" rel="noopener">${escapeHtml(host())}</a>`;
    frag.appendChild(footer);

    return frag;
  }

  /* --------------------- code syntax highlighting --------------------- */

  // A compact, language-agnostic tokenizer. Source sites' highlight classes are
  // stripped during extraction, so reader code blocks would otherwise be a
  // single flat colour. This re-colours them with the Monokai palette already
  // used by the reader's code theme. It's best-effort (no per-language grammar)
  // but covers comments, strings, numbers, keywords, builtins and call names
  // across the common languages.
  const CODE_KEYWORDS = new Set((
    'const let var function def lambda return if elif else for while do switch ' +
    'case default break continue new delete class struct enum interface trait ' +
    'impl extends implements super this self import from export package using ' +
    'namespace public private protected static final abstract async await yield ' +
    'try catch except finally throw raise with as in of is not and or typeof ' +
    'instanceof void sizeof typedef template type func fn go defer chan select ' +
    'map range mut pub use mod where match when then begin end pass global ' +
    'nonlocal del unsafe move ref dyn box union goto extern volatile register'
  ).split(' '));
  const CODE_BUILTINS = new Set((
    'true false null undefined None True False nil NaN Infinity void bool int ' +
    'float double char str string long short byte uint usize isize i32 i64 u32 ' +
    'u64 f32 f64 vec list dict set tuple object number boolean symbol bigint'
  ).split(' '));

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlightCode(src) {
    const rules = [
      ['comment', /^(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[\s\S]*?-->|#(?=[ \t!])[^\n]*)/],
      ['string', /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/],
      ['number', /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\d+\.?\d*(?:[eE][+-]?\d+)?)/],
      ['word', /^[A-Za-z_$][\w$]*/],
      ['operator', /^[+\-*/%=<>!&|^~?:]+/],
      ['space', /^\s+/],
      ['any', /^[\s\S]/]
    ];
    let out = '';
    let s = src;
    while (s.length) {
      let advanced = false;
      for (const [type, re] of rules) {
        const m = re.exec(s);
        if (!m) continue;
        const text = m[0];
        if (type === 'word') {
          if (CODE_KEYWORDS.has(text)) out += `<span class="pr-tok-keyword">${escHtml(text)}</span>`;
          else if (CODE_BUILTINS.has(text)) out += `<span class="pr-tok-builtin">${escHtml(text)}</span>`;
          else if (/^\s*\(/.test(s.slice(text.length))) out += `<span class="pr-tok-function">${escHtml(text)}</span>`;
          else out += escHtml(text);
        } else if (type === 'space' || type === 'any') {
          out += escHtml(text);
        } else {
          out += `<span class="pr-tok-${type}">${escHtml(text)}</span>`;
        }
        s = s.slice(text.length);
        advanced = true;
        break;
      }
      if (!advanced) { out += escHtml(s[0]); s = s.slice(1); }
    }
    return out;
  }

  function highlightCodeBlocks(shadow) {
    shadow.querySelectorAll('.article-body pre').forEach((pre) => {
      const target = pre.querySelector('code') || pre;
      const text = target.textContent || '';
      if (!text.trim() || text.length > 20000) return; // skip empty / huge dumps
      target.innerHTML = highlightCode(text);
    });
  }

  /* ----------------------------- math (KaTeX) ------------------------- */

  // Heuristic: does the body contain LaTeX worth loading KaTeX (~600KB) for?
  // \(...\) / \[...\] / $$...$$ are unambiguous; a bare $...$ must contain a
  // math-ish character so prose prices like "$5" don't trigger a render.
  function bodyHasMath(el) {
    const t = el.textContent || '';
    if (/\\\(|\\\[|\$\$/.test(t)) return true;
    if (/\$[^$\n]*[\\^_{}][^$\n]*\$/.test(t)) return true;
    if (el.querySelector('annotation, mjx-container, math')) return true;
    return false;
  }

  function ensureKatexCSS(shadow) {
    // Document-level link registers KaTeX's @font-face fonts globally (font
    // @font-face inside a shadow root is ignored). Its url(fonts/...) resolve
    // relative to the stylesheet's own extension URL, so no rewriting is needed.
    if (!document.getElementById('pleasant-katex-css')) {
      const l = document.createElement('link');
      l.id = 'pleasant-katex-css';
      l.rel = 'stylesheet';
      l.href = chrome.runtime.getURL('vendor/katex/katex.min.css');
      (document.head || document.documentElement).appendChild(l);
    }
    // Shadow-level link styles the rendered .katex markup inside the reader.
    // Guard against duplicates so repeated renders don't pile up <link>s.
    if (!shadow.querySelector('link[data-pr-katex]')) {
      const sl = document.createElement('link');
      sl.rel = 'stylesheet';
      sl.dataset.prKatex = '';
      sl.href = chrome.runtime.getURL('vendor/katex/katex.min.css');
      shadow.appendChild(sl);
    }
  }

  async function renderMath(shadow) {
    const body = shadow.querySelector('.article-body');
    if (!body || !bodyHasMath(body)) return;
    ensureKatexCSS(shadow);
    try {
      const mod = await import(chrome.runtime.getURL('vendor/katex/auto-render.mjs'));
      const render = mod.default || mod.renderMathInElement;
      render(body, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false }
        ],
        throwOnError: false,
        // Bound attacker-controlled math: cap element sizes (\rule etc.) and
        // macro expansion so a crafted payload can't hang the tab.
        maxSize: 100,
        maxExpand: 1000,
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
      });
    } catch (e) { /* math rendering is best-effort */ }
  }

  function setThemeButtonIcon(shadow) {
    const btn = shadow.querySelector('.theme-btn');
    if (!btn) return;
    const dark = shadow.host.getAttribute('data-theme') === 'dark';
    btn.innerHTML = dark ? ICONS.sun : ICONS.moon;
  }

  function bindReaderEvents(shadow) {
    setThemeButtonIcon(shadow);

    shadow.querySelector('.close-btn').addEventListener('click', disable);

    shadow.querySelector('.theme-btn').addEventListener('click', () => {
      // Route through setTheme() so the system-theme watcher stays in sync
      // (manually setting the attribute here would leak the matchMedia listener).
      const next = shadow.host.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      setTheme(next);
    });

    shadow.querySelector('.font-inc').addEventListener('click', () => bumpFont(0.1));
    shadow.querySelector('.font-dec').addEventListener('click', () => bumpFont(-0.1));

    document.addEventListener('keydown', onKeydown, true);
  }

  function bumpFont(delta) {
    const next = Math.min(1.6, Math.max(0.8, Math.round((state.settings.fontScale + delta) * 10) / 10));
    saveSettings({ fontScale: next });
    if (state.shadowRoot) {
      state.shadowRoot.host.style.setProperty('--reader-font-scale', String(next));
    }
  }

  function onKeydown(e) {
    if (e.key === 'Escape' && state.mode === 'reader') {
      e.preventDefault();
      e.stopPropagation();
      disable();
    }
  }

  function removeReader() {
    const el = document.getElementById(HOST_ID);
    if (el) el.remove();
    document.documentElement.style.overflow = '';
    document.removeEventListener('keydown', onKeydown, true);
    unwatchSystemTheme();
    state.shadowRoot = null;
    if (state.parsed) { window.scrollTo(0, state.scrollY); state.parsed = null; }
  }

  /* ---------------------------- restyle mode -------------------------- */

  async function enableRestyle(silentFallback) {
    if (state.mode === 'reader') removeReader();
    if (state.mode === 'restyle') return true;
    injectFonts();

    if (!document.getElementById(RESTYLE_LINK_ID)) {
      const link = document.createElement('link');
      link.id = RESTYLE_LINK_ID;
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('src/restyle.css');
      (document.head || document.documentElement).appendChild(link);
    }
    document.documentElement.setAttribute('data-pleasant-restyle', resolvedTheme());
    document.documentElement.setAttribute('data-pleasant-figures', state.settings.keepFiguresLight ? 'light' : 'invert');
    document.documentElement.style.setProperty('--pr-font-scale', String(state.settings.fontScale));
    watchSystemTheme();
    state.mode = 'restyle';
    notifyBackground();
    return silentFallback ? 'restyle' : true;
  }

  function removeRestyle() {
    const link = document.getElementById(RESTYLE_LINK_ID);
    if (link) link.remove();
    document.documentElement.removeAttribute('data-pleasant-restyle');
    document.documentElement.removeAttribute('data-pleasant-figures');
    document.documentElement.style.removeProperty('--pr-font-scale');
    unwatchSystemTheme();
  }

  /* ----------------------------- theme sync --------------------------- */

  function applyResolvedTheme() {
    const t = resolvedTheme();
    if (state.mode === 'reader' && state.shadowRoot) {
      state.shadowRoot.host.setAttribute('data-theme', t);
      state.shadowRoot.host.style.setProperty('background-color', THEME_BG[t] || THEME_BG.light, 'important');
      setThemeButtonIcon(state.shadowRoot);
    } else if (state.mode === 'restyle') {
      document.documentElement.setAttribute('data-pleasant-restyle', t);
    }
  }

  function watchSystemTheme() {
    if (state.mql || state.settings.theme !== 'auto') return;
    state.mql = window.matchMedia('(prefers-color-scheme: dark)');
    state.onMqlChange = () => applyResolvedTheme();
    state.mql.addEventListener('change', state.onMqlChange);
  }

  function unwatchSystemTheme() {
    if (state.mql && state.onMqlChange) state.mql.removeEventListener('change', state.onMqlChange);
    state.mql = null;
    state.onMqlChange = null;
  }

  /* ------------------------------ control ----------------------------- */

  function disable() {
    if (state.mode === 'reader') removeReader();
    else if (state.mode === 'restyle') removeRestyle();
    state.mode = 'off';
    notifyBackground();
  }

  async function enable(mode) {
    return mode === 'restyle' ? enableRestyle() : enableReader();
  }

  async function toggle(mode) {
    if (state.mode !== 'off') { disable(); return state.mode; }
    return enable(mode || state.settings.defaultMode);
  }

  function setTheme(theme) {
    saveSettings({ theme });
    unwatchSystemTheme();
    // Only watch the system theme while a mode is active — otherwise a popup
    // theme change while off would register (and leak) an unused mql listener.
    if (theme === 'auto' && state.mode !== 'off') watchSystemTheme();
    applyResolvedTheme();
  }

  function notifyBackground() {
    try {
      chrome.runtime.sendMessage({ type: 'stateChanged', mode: state.mode });
    } catch (e) {}
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /* --------------------------- auto-activate -------------------------- */

  // The content script now only runs where the user explicitly invoked it
  // (toolbar / Alt+R, via activeTab) or where they granted this domain a
  // standing host permission (the per-site "Always" rule). There is no longer
  // any ambient activation on arbitrary pages, so auto-activation is limited to
  // the "always" case — the page builder injected us here precisely because the
  // user opted this domain in.
  async function maybeAutoActivate() {
    if (window.self !== window.top) return; // top frame only
    if (state.settings.siteOverrides[host()] === 'always') {
      enable(state.settings.defaultMode);
    }
  }

  /* ----------------------------- messaging ---------------------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      // Defense-in-depth parity with the background listener: only act on
      // messages from our own extension contexts (popup/background).
      if (sender.id !== chrome.runtime.id) { sendResponse({ ok: false }); return; }
      if (!msg || typeof msg !== 'object') { sendResponse({ ok: false }); return; }
      switch (msg.type) {
        case 'getState':
          sendResponse({
            mode: state.mode,
            host: host(),
            origin: location.origin,
            settings: state.settings,
            // 'always' or 'never' — Never is the implicit default for any site
            // the user hasn't opted into.
            override: state.settings.siteOverrides[host()] === 'always' ? 'always' : 'never',
            canRead: true
          });
          break;
        case 'toggle':
          await toggle(msg.mode);
          sendResponse({ mode: state.mode });
          break;
        case 'enable':
          await enable(msg.mode);
          sendResponse({ mode: state.mode });
          break;
        case 'disable':
          disable();
          sendResponse({ mode: state.mode });
          break;
        case 'setTheme':
          if (!['auto', 'light', 'dark'].includes(msg.theme)) { sendResponse({ ok: false }); break; }
          setTheme(msg.theme);
          sendResponse({ ok: true });
          break;
        case 'setDefaultMode':
          if (!['reader', 'restyle'].includes(msg.mode)) { sendResponse({ ok: false }); break; }
          saveSettings({ defaultMode: msg.mode });
          sendResponse({ ok: true });
          break;
        case 'setFontScale': {
          // Re-validate here, not just in the popup: a sender could persist a
          // junk value into synced storage otherwise. Clamp to the same range
          // the popup/in-reader controls use.
          const v = Number(msg.value);
          if (!Number.isFinite(v)) { sendResponse({ ok: false }); break; }
          const scale = Math.min(1.6, Math.max(0.8, v));
          saveSettings({ fontScale: scale });
          if (state.shadowRoot) state.shadowRoot.host.style.setProperty('--reader-font-scale', String(scale));
          if (state.mode === 'restyle') document.documentElement.style.setProperty('--pr-font-scale', String(scale));
          sendResponse({ ok: true });
          break;
        }
        case 'setKeepFiguresLight':
          saveSettings({ keepFiguresLight: !!msg.value });
          if (state.shadowRoot) {
            state.shadowRoot.host.setAttribute('data-figures', msg.value ? 'light' : 'invert');
          }
          if (state.mode === 'restyle') {
            document.documentElement.setAttribute('data-pleasant-figures', msg.value ? 'light' : 'invert');
          }
          sendResponse({ ok: true });
          break;
        case 'setSiteOverride': {
          if (!['always', 'never', 'default'].includes(msg.value)) { sendResponse({ ok: false }); break; }
          const o = { ...state.settings.siteOverrides };
          if (msg.value === 'default') delete o[host()];
          else o[host()] = msg.value;
          saveSettings({ siteOverrides: o });
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false });
      }
    })().catch(() => { try { sendResponse({ ok: false }); } catch (e) {} });
    return true; // async response
  });

  /* ------------------------------- init ------------------------------- */

  loadSettings().then(maybeAutoActivate);
})();
