/*
 * Pleasant Reader — background service worker (MV3).
 * Handles the keyboard shortcut, keeps the toolbar badge in sync with the
 * active page's reader state, seeds default settings on install, and — only for
 * domains the user has explicitly granted a host permission to (the per-site
 * "Always" rule) — injects the content script on page load so it can auto-open.
 *
 * The extension holds NO standing host access. Everything runs either through
 * activeTab (the user invoked us on this tab) or an explicit per-domain grant.
 */

const DEFAULTS = {
  theme: 'auto',
  defaultMode: 'reader',
  fontScale: 1,
  keepFiguresLight: false,
  siteOverrides: {}
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULTS, (items) => {
    chrome.storage.sync.set({ ...DEFAULTS, ...items });
  });
});

// A scheme+host match pattern for a page URL (ports are ignored by match
// patterns), or null for non-web URLs we can never inject into.
function originPattern(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch (e) { return null; }
}

function injectContent(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/readability.js', 'src/content.js']
  });
}

// Send a message to a tab; if the content script isn't there yet, inject it on
// demand and retry. Used by the Alt+R command, which runs under activeTab.
async function sendOrInject(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    try {
      await injectContent(tabId);
      await new Promise((r) => setTimeout(r, 200));
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e2) {
      return null;
    }
  }
}

// Keyboard shortcut (Alt+R) toggles the reader on the active tab. Invoking a
// command grants activeTab, so injection is permitted even with no host grant.
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-reader') return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab && tab.id != null) sendOrInject(tab.id, { type: 'toggle' });
  });
});

// Reflect on/off state in the toolbar badge. The tab may have closed between the
// triggering event and these calls (e.g. onUpdated 'loading' for a tab that's
// already going away), in which case they reject with "No tab with id: N" —
// swallow that benign race rather than leak an uncaught rejection.
function setBadge(tabId, mode) {
  const on = mode && mode !== 'off';
  chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#89553E' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  // Defense-in-depth: only act on messages from our own extension contexts, and
  // only on a recognized mode value.
  if (sender.id !== chrome.runtime.id) return;
  if (!msg || msg.type !== 'stateChanged' || !sender.tab) return;
  const mode = ['reader', 'restyle'].includes(msg.mode) ? msg.mode : 'off';
  setBadge(sender.tab.id, mode);
});

// On navigation: clear the badge, and — only for an explicitly granted "Always"
// domain — inject the content script so it can auto-open. We re-check the live
// permission every time so a revoked grant stops injecting immediately.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === 'loading') { setBadge(tabId, 'off'); return; }
  if (info.status !== 'complete' || !tab || !tab.url) return;

  const pattern = originPattern(tab.url);
  if (!pattern) return;
  let host;
  try { host = new URL(tab.url).hostname; } catch (e) { return; }

  const { siteOverrides = {} } = await chrome.storage.sync.get('siteOverrides');
  if (siteOverrides[host] !== 'always') return;
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) return;

  // Re-validate immediately before injecting: the tab can navigate during the
  // awaits above, and executeScript targets the tab's CURRENT document — without
  // this re-check it could land on an origin the user never granted.
  let current;
  try { current = await chrome.tabs.get(tabId); } catch (e) { return; }
  if (!current || originPattern(current.url) !== pattern) return;

  // The content script's own re-entry guard makes a redundant inject a no-op.
  injectContent(tabId).catch(() => {});
});
