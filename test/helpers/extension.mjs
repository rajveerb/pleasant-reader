// Helpers to drive the extension in a real Chromium via Playwright.
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaywright, findChromium, assertExtension, EXTENSION_DIR } from './paths.mjs';

export { EXTENSION_DIR };

const LAUNCH_ARGS = (extDir) => [
  `--disable-extensions-except=${extDir}`,
  `--load-extension=${extDir}`,
  '--no-sandbox'
];

// Build a test copy of the extension whose manifest grants STANDING access.
//
// The shipped manifest declares no host access and no declarative content
// script — by design (the user grants each site at runtime). But headless
// Chromium cannot answer the optional-permission prompt, so a runtime grant
// hangs and `executeScript` would be refused. To exercise the *reader* behavior
// we therefore load a copy that re-adds `host_permissions: <all_urls>` and the
// declarative content script. The reader code path is identical regardless of
// how it was injected; the secure manifest shape and the popup's permission
// logic are verified separately (manifest.test.mjs + the per-site spy test).
function buildTestExtension() {
  const src = assertExtension();
  const dir = mkdtempSync(join(tmpdir(), 'pr-ext-'));
  for (const entry of readdirSync(src)) {
    if (entry === 'manifest.json') continue;
    symlinkSync(join(src, entry), join(dir, entry)); // dirs + loose files
  }
  const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
  delete manifest.optional_host_permissions;
  manifest.host_permissions = ['<all_urls>'];
  manifest.content_scripts = [{
    matches: ['<all_urls>'],
    js: ['src/readability.js', 'src/content.js'],
    run_at: 'document_idle',
    all_frames: false
  }];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

// Launch a persistent context with the extension loaded.
// Returns { ctx, sw, chromium, profileDir }.
export async function launchWithExtension({ viewport } = {}) {
  const extDir = buildTestExtension();
  const { chromium } = await loadPlaywright();
  const launcher = findChromium();
  const profileDir = mkdtempSync(join(tmpdir(), 'pr-test-'));

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: viewport || { width: 1000, height: 900 },
    args: LAUNCH_ARGS(extDir),
    ...launcher
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });

  return { ctx, sw, chromium, profileDir };
}

// Launch with the REAL shipped extension dir (unpatched manifest: no standing
// host access, no declarative content script). Used to test that injection is
// refused without a runtime grant — the security model the permissive copy
// above deliberately can't exercise.
export async function launchRawExtension({ viewport } = {}) {
  const extDir = assertExtension();
  const { chromium } = await loadPlaywright();
  const launcher = findChromium();
  const profileDir = mkdtempSync(join(tmpdir(), 'pr-raw-'));
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: viewport || { width: 900, height: 700 },
    args: LAUNCH_ARGS(extDir),
    ...launcher
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  return { ctx, sw };
}

// Launch a plain context (no extension) — used for extraction unit tests that
// inject readability.js directly via addScriptTag.
export async function launchPlain({ viewport } = {}) {
  const { chromium } = await loadPlaywright();
  const launcher = findChromium();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...launcher });
  const ctx = await browser.newContext({ viewport: viewport || { width: 1000, height: 900 } });
  return { browser, ctx };
}

// A scheme+host match pattern for an origin/URL (ports are ignored).
export function hostPattern(urlOrOrigin) {
  const u = new URL(urlOrOrigin);
  return `${u.protocol}//${u.hostname}/*`;
}

// Grant the extension a host permission for an origin. The manifest declares no
// standing host access, so tests must explicitly grant the origins they drive —
// exactly as a user would via the popup's "Always". chrome.permissions.request
// needs a user gesture, so we call it from a real button click inside the popup
// page (a Playwright click is a trusted gesture; headless Chromium auto-grants).
export async function grantHost(ctx, sw, urlOrOrigin) {
  const pattern = hostPattern(urlOrOrigin);
  // Under the test manifest the origin is already covered by <all_urls>, so the
  // grant is a no-op and request() resolves without a prompt. Short-circuit to
  // avoid even opening the popup when access is already held.
  if (await sw.evaluate((p) => chrome.permissions.contains({ origins: [p] }), pattern)) return true;
  const extId = new URL(sw.url()).host;
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/src/popup.html`, { waitUntil: 'load' });
  await p.evaluate((pat) => {
    const b = document.createElement('button');
    b.id = '__pr_grant';
    b.addEventListener('click', async () => {
      try { window.__pr_granted = await chrome.permissions.request({ origins: [pat] }); }
      catch (e) { window.__pr_granted = 'ERR:' + e.message; }
    });
    document.body.appendChild(b);
  }, pattern);
  await p.click('#__pr_grant');
  await p.waitForFunction(() => window.__pr_granted !== undefined, { timeout: 8000 });
  const res = await p.evaluate(() => window.__pr_granted);
  await p.close();
  return res;
}

// Inject the content script into a tab via the service worker. Requires a host
// permission for the tab's origin (granted above) — mirrors how the background
// injects into granted "Always" domains.
export function injectInto(sw, tabId) {
  return sw.evaluate((t) => chrome.scripting.executeScript({
    target: { tabId: t }, files: ['src/readability.js', 'src/content.js']
  }).then(() => true, (e) => String(e)), tabId);
}

// Send a runtime message to a tab via the service worker (mirrors the popup).
export function makeSend(sw) {
  return (tabId, msg) =>
    sw.evaluate(async ([t, m]) => {
      try { return await chrome.tabs.sendMessage(t, m); }
      catch (e) { return { __err: String(e) }; }
    }, [tabId, msg]);
}

// Resolve the tab id for the currently active tab.
export function activeTabId(sw) {
  return sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
}

// Seed extension settings, avoiding the onInstalled race by waiting first.
export async function setSettings(sw, patch) {
  await new Promise((r) => setTimeout(r, 800));
  await sw.evaluate((p) => chrome.storage.sync.set(p), patch);
}

// Read the reader/restyle state of the page from the DOM.
export function inspectPage(page) {
  return page.evaluate(() => {
    const h = document.getElementById('pleasant-reader-host');
    const sr = h && h.shadowRoot;
    if (!sr) {
      return {
        reader: false,
        restyle: document.documentElement.getAttribute('data-pleasant-restyle'),
        bodyBg: getComputedStyle(document.body).backgroundColor
      };
    }
    const body = sr.querySelector('.article-body');
    const img = sr.querySelector('.article-body img');
    return {
      reader: true,
      theme: h.getAttribute('data-theme'),
      figures: h.getAttribute('data-figures'),
      hostBg: getComputedStyle(h).backgroundColor,
      len: body ? body.textContent.trim().length : 0,
      paras: body ? body.querySelectorAll('p').length : 0,
      title: sr.querySelector('.article-header h1')?.textContent || null,
      imgFilter: img ? getComputedStyle(img).filter : 'no-img'
    };
  });
}
