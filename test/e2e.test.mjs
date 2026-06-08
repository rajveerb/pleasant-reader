// End-to-end tests: load the extension into Chromium and drive it through the
// service worker (the same messages the popup sends). Covers reader & restyle
// modes, light/dark theming, the keep-figures-light option, and that the reader
// stylesheet loads under a strict Content-Security-Policy.

import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  launchWithExtension, makeSend, activeTabId, setSettings, inspectPage,
  grantHost, injectInto
} from './helpers/extension.mjs';
import { startFixtureServer } from './helpers/server.mjs';

const CREAM = 'rgb(241, 233, 223)';
const DARK = 'rgb(26, 23, 20)';

let ctx, sw, send, server, page;

before(async () => {
  ({ ctx, sw } = await launchWithExtension());
  send = makeSend(sw);
  server = await startFixtureServer();
  // The extension has no standing host access; grant the fixture origin so the
  // content script can be injected (as a user's "Always" grant would).
  await grantHost(ctx, sw, server.origin);
  // No siteOverride => no auto-activation; tests drive state explicitly.
  await setSettings(sw, { theme: 'auto', defaultMode: 'reader', keepFiguresLight: false, siteOverrides: {} });
  page = await ctx.newPage();
});

after(async () => {
  await ctx?.close();
  await server?.close();
});

async function open(fixture) {
  await page.goto(`${server.origin}/${fixture}`, { waitUntil: 'load' });
  await page.waitForTimeout(200);
  const tid = await activeTabId(sw);
  await injectInto(sw, tid); // no declarative content script anymore
  await page.waitForTimeout(150);
  return tid;
}

describe('reader mode', () => {
  test('renders in light theme with cream background', async () => {
    const tid = await open('article-basic.html');
    await send(tid, { type: 'enable', mode: 'reader' });
    await send(tid, { type: 'setTheme', theme: 'light' });
    await page.waitForTimeout(300);
    const s = await inspectPage(page);
    assert.equal(s.reader, true);
    assert.equal(s.hostBg, CREAM);
    assert.ok(s.len > 600, `body length ${s.len}`);
    assert.match(s.title || '', /Quiet Art of Reading/);
    await send(tid, { type: 'disable' });
  });

  test('renders in dark theme with dark background', async () => {
    const tid = await open('article-basic.html');
    await send(tid, { type: 'enable', mode: 'reader' });
    await send(tid, { type: 'setTheme', theme: 'dark' });
    await page.waitForTimeout(300);
    const s = await inspectPage(page);
    assert.equal(s.reader, true);
    assert.equal(s.hostBg, DARK);
    await send(tid, { type: 'disable' });
  });

  test('figures invert in dark by default, stay light when option set', async () => {
    const tid = await open('article-basic.html');
    await send(tid, { type: 'setKeepFiguresLight', value: false });
    await send(tid, { type: 'enable', mode: 'reader' });
    await send(tid, { type: 'setTheme', theme: 'dark' });
    await page.waitForTimeout(300);
    let s = await inspectPage(page);
    assert.equal(s.figures, 'invert');
    assert.match(s.imgFilter, /invert/, 'image should be inverted by default in dark');

    await send(tid, { type: 'setKeepFiguresLight', value: true });
    await page.waitForTimeout(200);
    s = await inspectPage(page);
    assert.equal(s.figures, 'light');
    assert.equal(s.imgFilter, 'none', 'image should not be inverted when kept light');
    await send(tid, { type: 'disable' });
    await send(tid, { type: 'setKeepFiguresLight', value: false });
  });

  test('loads its stylesheet under a strict CSP (connect-src self)', async () => {
    const tid = await open('article-csp.html');
    await send(tid, { type: 'enable', mode: 'reader' });
    await send(tid, { type: 'setTheme', theme: 'dark' });
    await page.waitForTimeout(400);
    const s = await inspectPage(page);
    assert.equal(s.reader, true, 'reader should activate under strict CSP');
    // If the stylesheet failed to load, the host would not be themed dark.
    assert.equal(s.hostBg, DARK, 'reader CSS must apply despite strict CSP');
    await send(tid, { type: 'disable' });
  });
});

describe('restyle mode', () => {
  test('applies light then dark in place', async () => {
    const tid = await open('article-basic.html');
    await send(tid, { type: 'enable', mode: 'restyle' });
    await send(tid, { type: 'setTheme', theme: 'light' });
    await page.waitForTimeout(300);
    let s = await inspectPage(page);
    assert.equal(s.reader, false);
    assert.equal(s.restyle, 'light');
    assert.equal(s.bodyBg, CREAM);

    await send(tid, { type: 'setTheme', theme: 'dark' });
    await page.waitForTimeout(300);
    s = await inspectPage(page);
    assert.equal(s.restyle, 'dark');
    assert.equal(s.bodyBg, DARK);
    await send(tid, { type: 'disable' });
  });

  test('figures invert in dark by default and follow keep-figures-light', async () => {
    const tid = await open('article-basic.html');
    await send(tid, { type: 'setKeepFiguresLight', value: false });
    await send(tid, { type: 'enable', mode: 'restyle' });
    await send(tid, { type: 'setTheme', theme: 'dark' });
    await page.waitForTimeout(300);
    const imgFilter = () => page.evaluate(() => {
      const img = document.querySelector('article img');
      return img ? getComputedStyle(img).filter : 'no-img';
    });
    assert.match(await imgFilter(), /invert/, 'restyle dark should invert figures by default');

    await send(tid, { type: 'setKeepFiguresLight', value: true });
    await page.waitForTimeout(200);
    assert.equal(await imgFilter(), 'none', 'keep-figures-light should stop inversion in restyle');
    await send(tid, { type: 'disable' });
    await send(tid, { type: 'setKeepFiguresLight', value: false });
  });
});

describe('mode switching', () => {
  test('reader <-> restyle swap cleanly', async () => {
    const tid = await open('article-basic.html');
    await send(tid, { type: 'enable', mode: 'reader' });
    await page.waitForTimeout(200);
    assert.equal((await inspectPage(page)).reader, true);

    await send(tid, { type: 'enable', mode: 'restyle' });
    await page.waitForTimeout(200);
    let s = await inspectPage(page);
    assert.equal(s.reader, false);
    assert.ok(s.restyle, 'restyle attribute present');

    await send(tid, { type: 'enable', mode: 'reader' });
    await page.waitForTimeout(200);
    assert.equal((await inspectPage(page)).reader, true);

    await send(tid, { type: 'disable' });
    await page.waitForTimeout(200);
    const off = await inspectPage(page);
    assert.equal(off.reader, false);
    assert.equal(off.restyle, null);
  });
});

describe('typography & rich content', () => {
  test('reader base font is isolated from the page root font-size', async () => {
    const tid = await open('article-rem.html'); // page sets html { font-size: 40% }
    await send(tid, { type: 'setFontScale', value: 1 });
    await send(tid, { type: 'enable', mode: 'reader' });
    await page.waitForTimeout(300);
    const sizes = await page.evaluate(() => {
      const sr = document.getElementById('pleasant-reader-host').shadowRoot;
      return {
        root: getComputedStyle(document.documentElement).fontSize,
        p: getComputedStyle(sr.querySelector('.article-body p')).fontSize
      };
    });
    assert.notEqual(sizes.root, '18px', 'page root should be shrunk (40%)');
    assert.equal(sizes.p, '18px', 'reader body should stay at its 18px base');
    await send(tid, { type: 'disable' });
  });

  test('A+/A- scales both body and headings', async () => {
    const tid = await open('article-rich.html');
    await send(tid, { type: 'enable', mode: 'reader' });
    await send(tid, { type: 'setFontScale', value: 1 });
    await page.waitForTimeout(200);
    const read = () => page.evaluate(() => {
      const sr = document.getElementById('pleasant-reader-host').shadowRoot;
      return {
        p: parseFloat(getComputedStyle(sr.querySelector('.article-body p')).fontSize),
        h1: parseFloat(getComputedStyle(sr.querySelector('.article-header h1')).fontSize)
      };
    });
    const base = await read();
    await send(tid, { type: 'setFontScale', value: 1.4 });
    await page.waitForTimeout(200);
    const big = await read();
    assert.ok(big.p > base.p, 'body text should grow');
    assert.ok(big.h1 > base.h1, 'heading should grow too');
    await send(tid, { type: 'setFontScale', value: 1 });
    await send(tid, { type: 'disable' });
  });

  test('code blocks get syntax highlighting', async () => {
    const tid = await open('article-rich.html');
    await send(tid, { type: 'enable', mode: 'reader' });
    await page.waitForTimeout(300);
    const tok = await page.evaluate(() => {
      const sr = document.getElementById('pleasant-reader-host').shadowRoot;
      const spans = [...sr.querySelectorAll('.article-body pre [class^=pr-tok-]')];
      return { count: spans.length, kinds: [...new Set(spans.map((e) => e.className))] };
    });
    assert.ok(tok.count >= 5, `expected highlighted tokens, got ${tok.count}`);
    assert.ok(tok.kinds.includes('pr-tok-keyword'), 'keywords highlighted');
    assert.ok(tok.kinds.includes('pr-tok-string'), 'strings highlighted');
    await send(tid, { type: 'disable' });
  });

  test('overlay survives hostile page CSS targeting the host id', async () => {
    const tid = await open('article-hostile-css.html');
    await send(tid, { type: 'enable', mode: 'reader' });
    await send(tid, { type: 'setTheme', theme: 'light' });
    await page.waitForTimeout(300);
    const cs = await page.evaluate(() => {
      const h = document.getElementById('pleasant-reader-host');
      const s = getComputedStyle(h);
      return {
        exists: !!h, display: s.display, visibility: s.visibility, opacity: s.opacity,
        zIndex: s.zIndex, pointerEvents: s.pointerEvents, transform: s.transform,
        scale: s.scale, translate: s.translate, clipPath: s.clipPath, bg: s.backgroundColor
      };
    });
    await send(tid, { type: 'disable' });
    // Inline !important on the host must beat the page's #id !important rules.
    assert.equal(cs.exists, true, 'overlay host should exist');
    assert.equal(cs.display, 'block', 'page display:none must not win');
    assert.equal(cs.visibility, 'visible', 'page visibility:hidden must not win');
    assert.equal(cs.opacity, '1', 'page opacity:0 must not win');
    assert.equal(cs.zIndex, '2147483647', 'page z-index:0 must not win');
    assert.equal(cs.pointerEvents, 'auto', 'page pointer-events:none must not win');
    assert.equal(cs.transform, 'none', 'page transform:scale(0) must not win');
    assert.equal(cs.scale, 'none', 'page scale:0 must not win');
    assert.equal(cs.translate, 'none', 'page translate must not win');
    assert.equal(cs.clipPath, 'none', 'page clip-path must not win');
    assert.equal(cs.bg, CREAM, 'page background:transparent must not win');
  });

  test('hostile math is bounded (no hang, sizes capped)', async () => {
    const tid = await open('article-mathbomb.html');
    await send(tid, { type: 'enable', mode: 'reader' });
    await page.waitForTimeout(1500); // render must COMPLETE (a hang fails the test)
    const r = await page.evaluate(() => {
      const sr = document.getElementById('pleasant-reader-host').shadowRoot;
      const body = sr.querySelector('.article-body');
      let maxW = 0;
      body.querySelectorAll('*').forEach((el) => {
        const w = el.getBoundingClientRect().width;
        if (Number.isFinite(w)) maxW = Math.max(maxW, w);
      });
      return { reader: !!body, maxW };
    });
    await send(tid, { type: 'disable' });
    assert.equal(r.reader, true, 'reader should still render with hostile math');
    // \rule{100000em} would be ~1.8M px uncapped; maxSize:100 caps it to ~1800px.
    assert.ok(r.maxW < 5000, `rendered math should be size-bounded, got ${r.maxW}px`);
  });

  test('math renders via KaTeX; prose prices are not treated as math', async () => {
    const tid = await open('article-rich.html');
    await send(tid, { type: 'enable', mode: 'reader' });
    await page.waitForTimeout(1500); // allow KaTeX module import + render
    const math = await page.evaluate(() => {
      const sr = document.getElementById('pleasant-reader-host').shadowRoot;
      const body = sr.querySelector('.article-body');
      return { katex: body.querySelectorAll('.katex').length, hasPrice: /\$5/.test(body.textContent) };
    });
    assert.equal(math.katex, 3, `expected 3 rendered equations, got ${math.katex}`);
    assert.equal(math.hasPrice, true, 'the bare "$5" should remain as text');
    await send(tid, { type: 'disable' });
  });
});
