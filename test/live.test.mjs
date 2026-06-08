// Opt-in live-site tests (network). These run the SAME control × mode matrix as
// ui.test.mjs but against the real URLs that drove the extractor work — a
// GitHub Pages blog, a Substack post, and a Framer-built page — driving every
// shared control by a real popup click in BOTH reader and restyle mode.
//
//   PR_LIVE=1 npm run test:live
//   PR_LIVE=1 PR_SHOTS=/tmp/pr-live npm run test:live   # + screenshot gallery
//
// They are slower and flakier than the fixture suites (real network, real
// hydration), so they only run when PR_LIVE=1. A failure here means
// "investigate" (the site may have changed), not necessarily a code regression.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { launchWithExtension, makeSend, activeTabId, setSettings, grantHost, injectInto } from './helpers/extension.mjs';
import { openPopupFor, snap, modeState } from './helpers/popup.mjs';

const DARK = 'rgb(26, 23, 20)';
const CREAM = 'rgb(241, 233, 223)';

const SITES = [
  { name: 'jalammar', url: 'https://jalammar.github.io/illustrated-retrieval-transformer/', minLen: 4000 },
  { name: 'substack', url: 'https://cameronrwolfe.substack.com/p/decoder-only-transformers-the-workhorse', minLen: 10000 },
  { name: 'perplexity', url: 'https://research.perplexity.ai/articles/rethinking-search-as-code-generation', minLen: 8000 }
];

const RUN = process.env.PR_LIVE === '1';

let ctx, sw, send, page, popup;

before(async () => {
  if (!RUN) return;
  ({ ctx, sw } = await launchWithExtension({ viewport: { width: 1000, height: 900 } }));
  send = makeSend(sw);
  await setSettings(sw, { theme: 'light', defaultMode: 'reader', keepFiguresLight: false, siteOverrides: {} });
  // No standing host access; grant each live origin so injection works.
  for (const s of SITES) await grantHost(ctx, sw, s.url);
  page = await ctx.newPage();
  page.setDefaultNavigationTimeout(40000);
});

after(async () => { await ctx?.close(); });

async function freshPopup() {
  if (popup && !popup.isClosed()) await popup.close();
  await page.bringToFront();
  popup = await openPopupFor(ctx, sw, page);
}

async function loadAndEnter(site, mode) {
  await page.goto(site.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500); // allow SPA hydration (Framer/Substack)
  const t = await activeTabId(sw);
  await injectInto(sw, t); // no declarative content script
  await page.waitForTimeout(200);
  await send(t, { type: 'disable' });
  await send(t, { type: 'setFontScale', value: 1 });
  await send(t, { type: 'setKeepFiguresLight', value: false });
  await send(t, { type: 'enable', mode });
  await page.waitForTimeout(900);
}

async function readerLength() {
  return page.evaluate(() => {
    const sr = document.getElementById('pleasant-reader-host')?.shadowRoot;
    const b = sr?.querySelector('.article-body');
    return b ? b.textContent.trim().length : 0;
  });
}

describe('live sites: control × mode matrix', { skip: RUN ? false : 'set PR_LIVE=1 to run live-site tests' }, () => {
  for (const site of SITES) {
    for (const mode of ['reader', 'restyle']) {
      test(`${site.name} [${mode}]: theme + size + figures via real popup clicks`, async () => {
        await loadAndEnter(site, mode);

        let st = await modeState(page, mode);
        assert.equal(st.active, true, `${site.name} ${mode}: transformation should be active`);
        if (mode === 'reader') {
          const len = await readerLength();
          assert.ok(len >= site.minLen, `${site.name} reader length ${len} < ${site.minLen}`);
        }

        await freshPopup();

        // Theme: Dark
        await popup.click('#theme-seg [data-theme="dark"]');
        await page.waitForTimeout(450);
        st = await modeState(page, mode);
        assert.equal(st.bg, DARK, `${site.name} ${mode}: Dark button should darken`);
        await snap(page, `live-${site.name}-${mode}-dark`);

        const hasImg = st.imgFilter !== 'no-img';
        if (hasImg) {
          assert.match(st.imgFilter, /invert/, `${site.name} ${mode}: figures invert in dark`);
          // Keep-figures-light switch
          await popup.locator('label.pr-switch:has(#keep-figures-light)').click();
          await page.waitForTimeout(450);
          assert.equal((await modeState(page, mode)).imgFilter, 'none', `${site.name} ${mode}: keep-figures-light stops inversion`);
          await snap(page, `live-${site.name}-${mode}-figlight`);
          await popup.locator('label.pr-switch:has(#keep-figures-light)').click(); // restore
          await page.waitForTimeout(300);
        }

        // Theme: Light
        await popup.click('#theme-seg [data-theme="light"]');
        await page.waitForTimeout(450);
        assert.equal((await modeState(page, mode)).bg, CREAM, `${site.name} ${mode}: Light button should lighten`);
        await snap(page, `live-${site.name}-${mode}-light`);

        // Text size: A+
        const s0 = (await modeState(page, mode)).size;
        await popup.click('#font-inc');
        await page.waitForTimeout(450);
        const s1 = (await modeState(page, mode)).size;
        assert.ok(s1 > s0, `${site.name} ${mode}: A+ should grow text (${s0} -> ${s1})`);

        await send(await activeTabId(sw), { type: 'disable' });
      });
    }
  }
});
