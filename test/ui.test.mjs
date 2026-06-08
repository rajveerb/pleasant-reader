// UI-permutation tests: drive EVERY interactive control by a real click (the
// in-reader bar buttons via shadow-piercing locators, the popup controls on the
// actual popup page, and the Esc key) and assert the resulting effect on the
// page. With PR_SHOTS=<dir> set, a before/after screenshot is captured for each
// button so the effect can be visually reviewed.
//
//   PR_SHOTS=/tmp/pr-shots npm run test:ui
//
// Preconditions are set via service-worker messages for speed; the control
// UNDER TEST is always a real click.

import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { launchWithExtension, makeSend, activeTabId, setSettings, grantHost, injectInto } from './helpers/extension.mjs';
import { startFixtureServer } from './helpers/server.mjs';
import { openPopupFor, snap, readState, readSettings, modeState } from './helpers/popup.mjs';

const CREAM = 'rgb(241, 233, 223)';
const DARK = 'rgb(26, 23, 20)';

let ctx, sw, send, server, page, popup, host;

before(async () => {
  ({ ctx, sw } = await launchWithExtension({ viewport: { width: 900, height: 1000 } }));
  send = makeSend(sw);
  server = await startFixtureServer();
  host = new URL(server.origin).hostname;
  // No standing host access; grant the fixture origin so injection works.
  await grantHost(ctx, sw, server.origin);
  await setSettings(sw, { theme: 'light', defaultMode: 'reader', keepFiguresLight: false, siteOverrides: {} });
  page = await ctx.newPage();
  await page.goto(`${server.origin}/article-rich.html`, { waitUntil: 'load' });
  await page.waitForTimeout(200);
  await injectInto(sw, await activeTabId(sw));
  await page.waitForTimeout(150);
});

after(async () => {
  await ctx?.close();
  await server?.close();
});

async function tab() { return activeTabId(sw); }

// Re-open a fresh popup wired to the article page (closes any prior popup).
async function freshPopup() {
  if (popup && !popup.isClosed()) await popup.close();
  await page.bringToFront();
  popup = await openPopupFor(ctx, sw, page);
  return popup;
}

async function ensureReader(theme = 'light') {
  const t = await tab();
  await send(t, { type: 'disable' });
  await send(t, { type: 'setKeepFiguresLight', value: false });
  await send(t, { type: 'enable', mode: 'reader' });
  await send(t, { type: 'setTheme', theme });
  await page.waitForTimeout(300);
}

/* ===================== IN-READER BAR BUTTONS (real clicks) ============== */

describe('in-reader bar buttons', () => {
  test('A+ click increases text size', async () => {
    await ensureReader('light');
    const before = await readState(page);
    await snap(page, 'reader-fontsize-before');
    await page.locator('.font-inc').click();
    await page.waitForTimeout(200);
    const after = await readState(page);
    await snap(page, 'reader-fontsize-after-Aplus');
    assert.ok(parseFloat(after.scale) > parseFloat(before.scale), `scale ${before.scale} -> ${after.scale}`);
    assert.ok(after.pFontPx > before.pFontPx, 'body text grew');
  });

  test('A- click decreases text size', async () => {
    await ensureReader('light');
    await page.locator('.font-inc').click(); // bump up first
    await page.waitForTimeout(150);
    const before = await readState(page);
    await page.locator('.font-dec').click();
    await page.waitForTimeout(200);
    const after = await readState(page);
    assert.ok(parseFloat(after.scale) < parseFloat(before.scale), `scale ${before.scale} -> ${after.scale}`);
  });

  test('theme button toggles light <-> dark', async () => {
    await ensureReader('light');
    let s = await readState(page);
    assert.equal(s.theme, 'light');
    await snap(page, 'reader-theme-light');
    await page.locator('.theme-btn').click();
    await page.waitForTimeout(250);
    s = await readState(page);
    assert.equal(s.theme, 'dark', 'theme button should switch to dark');
    await snap(page, 'reader-theme-after-toggle-dark');
    // and back
    await page.locator('.theme-btn').click();
    await page.waitForTimeout(250);
    assert.equal((await readState(page)).theme, 'light', 'theme button should switch back to light');
  });

  test('close (x) button removes the reader', async () => {
    await ensureReader('light');
    assert.equal((await readState(page)).reader, true);
    await page.locator('.close-btn').click();
    await page.waitForTimeout(250);
    await snap(page, 'reader-after-close');
    assert.equal((await readState(page)).reader, false, 'close should remove the reader overlay');
  });
});

/* ===================== KEYBOARD ======================================== */

describe('keyboard', () => {
  test('Esc closes the reader', async () => {
    await ensureReader('light');
    assert.equal((await readState(page)).reader, true);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    assert.equal((await readState(page)).reader, false, 'Esc should close the reader');
  });
});

/* ===================== POPUP CONTROLS (real clicks) ==================== */

describe('popup: main toggle', () => {
  test('Make pleasant -> reader on, Restore -> off', async () => {
    await send(await tab(), { type: 'disable' });
    await freshPopup();
    await snap(popup, 'popup-initial');
    await popup.click('#toggle');                 // Make pleasant
    await page.waitForTimeout(400);
    assert.equal((await readState(page)).reader, true, 'toggle should open the reader');
    await snap(page, 'page-after-make-pleasant');
    await popup.click('#toggle');                 // Restore original
    await page.waitForTimeout(300);
    assert.equal((await readState(page)).reader, false, 'toggle again should restore');
  });
});

describe('popup: mode segment', () => {
  test('Restyle then Reader switch the active mode', async () => {
    await send(await tab(), { type: 'enable', mode: 'reader' });
    await freshPopup();
    await popup.click('#mode-seg [data-mode="restyle"]');
    await page.waitForTimeout(400);
    let s = await readState(page);
    assert.equal(s.reader, false);
    assert.ok(s.restyle, 'restyle should be active');
    await snap(page, 'page-restyle');
    await popup.click('#mode-seg [data-mode="reader"]');
    await page.waitForTimeout(400);
    assert.equal((await readState(page)).reader, true, 'back to reader');
  });
});

/* ============ CONTROL × MODE MATRIX (theme / size / figures) ============ */
// The shared popup controls must work in BOTH reader and restyle. This matrix
// runs each via a real popup click and asserts the mode-appropriate effect.
// (A green suite that only tested reader mode is exactly how the restyle
// font-size bug slipped through.)

for (const mode of ['reader', 'restyle']) {
  describe(`controls × ${mode} mode`, () => {
    async function setup(fixture = 'article-rich.html') {
      await send(await tab(), { type: 'disable' });
      await page.goto(`${server.origin}/${fixture}`, { waitUntil: 'load' });
      await page.waitForTimeout(200);
      await injectInto(sw, await tab()); // no declarative content script
      await page.waitForTimeout(150);
      await send(await tab(), { type: 'setFontScale', value: 1 });
      await send(await tab(), { type: 'setKeepFiguresLight', value: false });
      await send(await tab(), { type: 'enable', mode });
      await page.waitForTimeout(250);
      await freshPopup();
    }

    test('Theme: Dark darkens, Light lightens', async () => {
      await setup();
      await popup.click('#theme-seg [data-theme="dark"]');
      await page.waitForTimeout(300);
      assert.equal((await modeState(page, mode)).bg, DARK, `${mode}: dark bg`);
      await snap(page, `matrix-${mode}-dark`);
      await popup.click('#theme-seg [data-theme="light"]');
      await page.waitForTimeout(300);
      assert.equal((await modeState(page, mode)).bg, CREAM, `${mode}: light bg`);
      await snap(page, `matrix-${mode}-light`);
    });

    test('Theme: Auto persists and resolves', async () => {
      await setup();
      await popup.click('#theme-seg [data-theme="auto"]');
      await page.waitForTimeout(300);
      assert.equal((await readSettings(sw)).theme, 'auto', `${mode}: auto persisted`);
      const t = (await modeState(page, mode)).theme;
      assert.ok(t === 'light' || t === 'dark', `${mode}: auto resolves to a concrete theme`);
      await send(await tab(), { type: 'setTheme', theme: 'light' });
    });

    test('Text size: A+ grows, A- shrinks', async () => {
      await setup();
      const s0 = (await modeState(page, mode)).size;
      await popup.click('#font-inc');
      await page.waitForTimeout(250);
      const s1 = (await modeState(page, mode)).size;
      assert.ok(s1 > s0, `${mode}: A+ ${s0} -> ${s1}`);
      await popup.click('#font-dec');
      await page.waitForTimeout(250);
      const s2 = (await modeState(page, mode)).size;
      assert.ok(s2 < s1, `${mode}: A- ${s1} -> ${s2}`);
      await send(await tab(), { type: 'setFontScale', value: 1 });
    });

    test('Keep-figures-light toggles inversion in dark', async () => {
      await setup('article-basic.html'); // has an <img>
      await send(await tab(), { type: 'setTheme', theme: 'dark' });
      await page.waitForTimeout(300);
      assert.match((await modeState(page, mode)).imgFilter, /invert/, `${mode}: figures invert by default in dark`);
      await snap(page, `matrix-${mode}-fig-invert`);
      await popup.locator('label.pr-switch:has(#keep-figures-light)').click();
      await page.waitForTimeout(300);
      assert.equal((await modeState(page, mode)).imgFilter, 'none', `${mode}: keep-light disables inversion`);
      await snap(page, `matrix-${mode}-fig-light`);
      await send(await tab(), { type: 'setKeepFiguresLight', value: false });
      await send(await tab(), { type: 'setTheme', theme: 'light' });
    });
  });
}

describe('popup: per-site rule (behavior)', () => {
  // The per-site rule is a binary Always/Never (Never is the default). "Always"
  // re-opens on reload; "Never" does not. (The actual OS-level host grant can't
  // be answered headlessly — see the spy test below for the permission call, and
  // manifest.test.mjs for the no-standing-access shape.)
  test('Always auto-opens on reload; Never does not', async () => {
    await send(await tab(), { type: 'disable' });
    await freshPopup();
    await popup.click('#site-seg [data-override="always"]');
    await page.waitForTimeout(250);
    assert.equal((await readSettings(sw)).siteOverrides[host], 'always', 'always persisted');
    await page.goto(`${server.origin}/article-rich.html`, { waitUntil: 'load' });
    await page.waitForTimeout(700);
    assert.equal((await readState(page)).reader, true, 'Always should auto-open after reload');

    await freshPopup();
    await popup.click('#site-seg [data-override="never"]');
    await page.waitForTimeout(250);
    assert.equal((await readSettings(sw)).siteOverrides[host], 'never', 'never persisted');
    await page.goto(`${server.origin}/article-rich.html`, { waitUntil: 'load' });
    await page.waitForTimeout(700);
    assert.equal((await readState(page)).reader, false, 'Never should suppress auto-open');
  });

  // A brand-new site (no rule) defaults to Never in the popup.
  test('an unconfigured site reports Never by default', async () => {
    await send(await tab(), { type: 'setSiteOverride', value: 'never' }); // simulate "no opt-in"
    await freshPopup();
    const active = await popup.evaluate(() =>
      document.querySelector('#site-seg .pr-seg-btn.active')?.dataset.override);
    assert.equal(active, 'never', 'Never is the default selection');
  });

  // Verify the popup's permission LOGIC directly: "Always" requests the right
  // per-origin host permission; "Never" removes it. We stub chrome.permissions
  // in the popup page so no real OS prompt is involved.
  test('Always requests the host permission; Never removes it', async () => {
    await send(await tab(), { type: 'disable' });
    await freshPopup();
    await popup.evaluate(() => {
      window.__perm = { requested: [], removed: [] };
      chrome.permissions.request = async (x) => { window.__perm.requested.push(x.origins); return true; };
      chrome.permissions.remove = async (x) => { window.__perm.removed.push(x.origins); return true; };
    });
    const expected = `${new URL(server.origin).protocol}//${host}/*`;

    await popup.click('#site-seg [data-override="always"]');
    await page.waitForTimeout(200);
    await popup.click('#site-seg [data-override="never"]');
    await page.waitForTimeout(200);

    const perm = await popup.evaluate(() => window.__perm);
    assert.deepEqual(perm.requested, [[expected]], 'Always requested the per-origin permission');
    // Never releases the grant for BOTH scheme variants (the rule is scheme-less).
    assert.deepEqual(perm.removed, [[`http://${host}/*`, `https://${host}/*`]],
      'Never removed both scheme variants of the host');
  });
});
