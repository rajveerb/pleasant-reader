// Helpers for driving the REAL popup UI and the in-reader bar via actual
// button clicks (not service-worker messages), plus a screenshot gallery.
//
// The popup queries the active tab in the current window. A popup opened as its
// own page would see itself as active, so we open it, bring the target tab to
// front, then reload the popup so its active-tab query resolves to the target.

import { mkdirSync } from 'node:fs';

// Open the real popup wired to `articlePage`. Returns the popup Page.
export async function openPopupFor(ctx, sw, articlePage) {
  const extId = new URL(sw.url()).host;
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/src/popup.html`, { waitUntil: 'load' });
  await articlePage.bringToFront();          // make the article the active tab
  await popup.waitForTimeout(150);
  await popup.reload({ waitUntil: 'load' });  // re-run init against the active tab
  await popup.waitForTimeout(500);
  return popup;
}

// Screenshot gallery: only writes when PR_SHOTS is set (a directory path).
const SHOTS_DIR = process.env.PR_SHOTS || null;
if (SHOTS_DIR) { try { mkdirSync(SHOTS_DIR, { recursive: true }); } catch {} }

export async function snap(page, name) {
  if (!SHOTS_DIR) return;
  try {
    await page.bringToFront();
    await page.waitForTimeout(120);
    // Headless capture can leave a stale composited layer for the fixed shadow
    // overlay after a live theme toggle (the live DOM is correct — assertions
    // read it directly — but the screenshot lags). A display off/on cycle forces
    // a full re-render so the gallery image reflects the real state. Image-heavy
    // readers need a beat for the re-composite to settle.
    await page.evaluate(() => {
      const h = document.getElementById('pleasant-reader-host');
      if (h) { h.style.display = 'none'; void h.offsetHeight; h.style.display = 'block'; }
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS_DIR}/${name}.png` });
  } catch {}
}

export const galleryEnabled = !!SHOTS_DIR;

// Read the reader/restyle state from the article page (mirrors inspectPage but
// also exposes the in-reader font scale so A+/A- clicks can be asserted).
export function readState(page) {
  return page.evaluate(() => {
    const h = document.getElementById('pleasant-reader-host');
    const sr = h && h.shadowRoot;
    if (!sr) {
      return {
        reader: false,
        restyle: document.documentElement.getAttribute('data-pleasant-restyle'),
        figures: document.documentElement.getAttribute('data-pleasant-figures')
      };
    }
    const p = sr.querySelector('.article-body p');
    const img = sr.querySelector('.article-body img');
    return {
      reader: true,
      theme: h.getAttribute('data-theme'),
      figures: h.getAttribute('data-figures'),
      scale: h.style.getPropertyValue('--reader-font-scale') || '1',
      pFontPx: p ? parseFloat(getComputedStyle(p).fontSize) : null,
      imgFilter: img ? getComputedStyle(img).filter : 'no-img'
    };
  });
}

// Read persisted settings straight from chrome.storage via the service worker.
export function readSettings(sw) {
  return sw.evaluate(() => new Promise((r) => chrome.storage.sync.get(null, r)));
}

// Read the visual state relevant to whichever transformation is active, so a
// single assertion works across modes: reader -> shadow host; restyle -> the
// page's <html>/<body>/<img>.
export function modeState(page, mode) {
  return page.evaluate((m) => {
    const html = document.documentElement;
    if (m === 'reader') {
      const h = document.getElementById('pleasant-reader-host');
      const sr = h && h.shadowRoot;
      if (!sr) return { active: false };
      const img = sr.querySelector('.article-body img');
      return {
        active: true,
        bg: getComputedStyle(h).backgroundColor,
        theme: h.getAttribute('data-theme'),
        size: parseFloat(h.style.getPropertyValue('--reader-font-scale') || '1'),
        imgFilter: img ? getComputedStyle(img).filter : 'no-img'
      };
    }
    const img = document.querySelector('article img, main img, img');
    return {
      active: !!html.getAttribute('data-pleasant-restyle'),
      bg: getComputedStyle(document.body).backgroundColor,
      theme: html.getAttribute('data-pleasant-restyle'),
      size: parseFloat(getComputedStyle(html).zoom || '1'),
      imgFilter: img ? getComputedStyle(img).filter : 'no-img'
    };
  }, mode);
}
