// Extraction unit tests for src/readability.js.
//
// Each fixture is loaded in a plain Chromium page (no extension); readability.js
// is injected via addScriptTag and parse()/looksLikeArticle() are called in the
// page. These are offline and deterministic — they encode the extraction bugs
// found during development (Framer <header> wrapping, deep SPA trees, index
// pages, basic articles).

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { launchPlain, EXTENSION_DIR } from './helpers/extension.mjs';
import { startFixtureServer } from './helpers/server.mjs';

let browser, ctx, server;

before(async () => {
  ({ browser, ctx } = await launchPlain());
  server = await startFixtureServer();
});

after(async () => {
  await server?.close();
  await ctx?.close();
  await browser?.close();
});

const READABILITY = join(EXTENSION_DIR, 'src/readability.js');

// Load a fixture and return { parsed, looksLikeArticle } evaluated in-page.
async function analyze(fixture) {
  const page = await ctx.newPage();
  await page.goto(`${server.origin}/${fixture}`, { waitUntil: 'load' });
  await page.addScriptTag({ path: READABILITY });
  const result = await page.evaluate(() => {
    const parsed = window.PleasantReadability.parse();
    return {
      ok: parsed.ok,
      length: parsed.length,
      title: parsed.title,
      byline: parsed.byline,
      paras: parsed.content ? parsed.content.querySelectorAll('p').length : 0,
      hasCode: parsed.content ? parsed.content.querySelectorAll('pre, code').length > 0 : false,
      hasImg: parsed.content ? parsed.content.querySelectorAll('img').length : 0,
      text: parsed.content ? parsed.content.textContent : '',
      navLeft: parsed.content ? parsed.content.querySelectorAll('nav').length : 0,
      looksLikeArticle: window.PleasantReadability.looksLikeArticle()
    };
  });
  await page.close();
  return result;
}

describe('extraction', () => {
  test('basic semantic article extracts cleanly', async () => {
    const r = await analyze('article-basic.html');
    assert.equal(r.ok, true, 'should extract');
    assert.ok(r.length > 600, `expected substantial body, got ${r.length}`);
    assert.equal(r.title, 'The Quiet Art of Reading');
    assert.equal(r.byline, 'Jane Doe');
    assert.ok(r.paras >= 4, `expected >=4 paragraphs, got ${r.paras}`);
    assert.ok(r.hasCode, 'code block should be preserved');
    assert.equal(r.hasImg, 1, 'figure should be preserved');
    assert.ok(r.looksLikeArticle, 'should look like an article');
    // chrome should be gone
    assert.ok(!/Ad one|Ad two/.test(r.text), 'sidebar ads should be stripped');
    assert.ok(!/Subscribe/.test(r.text), 'nav should be stripped');
  });

  test('Framer-style content wrapped in <header> survives', async () => {
    const r = await analyze('article-framer.html');
    assert.equal(r.ok, true, 'content inside <header> must be extracted');
    assert.ok(r.paras >= 4, `expected >=4 paragraphs, got ${r.paras}`);
    assert.ok(/Rethinking Layouts|core primitive/.test(r.text), 'prose should be present');
    // the link-only nav/footer should be removed
    assert.ok(!/We're Hiring/.test(r.text), 'link-only nav should be stripped');
  });

  test('deeply nested SPA content found via densest-container fallback', async () => {
    const r = await analyze('article-deep-spa.html');
    assert.equal(r.ok, true, 'deep SPA content should be extracted');
    assert.ok(r.paras >= 4, `expected >=4 paragraphs, got ${r.paras}`);
    assert.ok(/single-page applications/i.test(r.text), 'prose should be present');
  });

  test('index/listing page is NOT treated as an article', async () => {
    const r = await analyze('not-article.html');
    assert.equal(r.looksLikeArticle, false, 'listing pages should not auto-activate');
  });

  test('active URL schemes in extracted links/images are neutralized', async () => {
    const page = await ctx.newPage();
    await page.goto(`${server.origin}/article-xss.html`, { waitUntil: 'load' });
    await page.addScriptTag({ path: READABILITY });
    const r = await page.evaluate(() => {
      const c = window.PleasantReadability.parse().content;
      const links = [...c.querySelectorAll('a')].map((a) => a.getAttribute('href'));
      const imgs = [...c.querySelectorAll('img')].map((i) => i.getAttribute('src'));
      // src on EVERY element (img, video, audio, source, ...) and which tags
      // still carry href.
      const allSrc = [...c.querySelectorAll('[src]')].map((e) => e.getAttribute('src'));
      const hrefTags = [...c.querySelectorAll('[href]')].map((e) => e.tagName);
      // srcset must not survive on ANY element (img, source, etc.).
      const srcsets = [...c.querySelectorAll('[srcset], [data-srcset]')].length;
      // SVG/MathML (foreign-namespace) and any script/style must be hard-stripped
      // — their tagName is lowercase and must not slip past the strip.
      const dangerous = c.querySelectorAll('svg, script, style, math').length;
      // Any attribute value anywhere that still references the attacker host.
      const leaks = [...c.querySelectorAll('*')].flatMap((el) =>
        [...el.attributes].map((a) => a.value)).filter((v) => /evil\.example/i.test(v));
      return { links, imgs, allSrc, hrefTags, srcsets, dangerous, leaks };
    });
    await page.close();

    // No active scheme survives: javascript:/vbscript: on ANY src or link; data: on links.
    for (const s of r.allSrc.filter(Boolean).map((x) => x.toLowerCase())) {
      assert.ok(!s.startsWith('javascript:'), `javascript: src survived: ${s}`);
      assert.ok(!s.startsWith('vbscript:'), `vbscript: src survived: ${s}`);
    }
    for (const href of r.links.filter(Boolean).map((s) => s.toLowerCase())) {
      assert.ok(!href.startsWith('javascript:'), `javascript: link survived: ${href}`);
      assert.ok(!href.startsWith('vbscript:'), `vbscript: link survived: ${href}`);
      assert.ok(!href.startsWith('data:'), `data: link survived: ${href}`);
    }
    // href is only allowed on <a> (e.g. a <math href="javascript:"> sink is removed).
    assert.ok(r.hrefTags.every((t) => t === 'A'), `href survived on a non-anchor: ${r.hrefTags.join(',')}`);
    // srcset/data-srcset are stripped entirely (finding A) — no candidate URL
    // can bypass the src scheme filter, and the attacker host never leaks.
    assert.equal(r.srcsets, 0, 'no srcset/data-srcset attribute should survive');
    assert.equal(r.dangerous, 0, 'svg/script/style/math elements must be hard-stripped');
    assert.equal(r.leaks.length, 0, `attacker host leaked via an attribute: ${r.leaks.join(', ')}`);
    // Safe links/images kept; srcset-only image renders from its first candidate.
    assert.ok(r.links.some((h) => h && /^https?:\/\//.test(h)), 'a safe http(s) link should remain');
    assert.ok(r.imgs.some((s) => s && /^https?:\/\//.test(s)), 'safe image src should remain');
    assert.ok(r.imgs.includes('https://ok.example/c.png'),
      'srcset-only image should keep its first candidate as src');
    // data: image is allowed; a comma-bearing data: srcset candidate survives intact.
    assert.ok(r.imgs.some((s) => /^data:image\/png;base64,[A-Za-z0-9+/=]{20,}$/.test(s || '')),
      'a comma-bearing data: URL should survive intact (not truncated at the comma)');
    // a data: URL whose PAYLOAD contains commas survives whole (proves the
    // srcset parser splits on whitespace, not on the first comma).
    assert.ok(r.imgs.includes('data:text/plain,aa,bb,cc'),
      'payload-internal commas in a srcset data: URL must not truncate the src');
  });

  test('nested empty wrappers are removed; real content is kept', async () => {
    // Guards the single-pass (reverse-order) empty-element cleanup: nested empty
    // wrappers must collapse without dropping real prose (and without the old
    // O(n^2) re-scan loop).
    const p = await ctx.newPage();
    const para = 'A substantial paragraph with enough text to anchor the extractor and be kept. ';
    await p.setContent(`<!doctype html><html><body><article>
      <div><div><div></div></div></div>
      <p>${para.repeat(6)}</p>
      <div><div></div></div>
      <p>${para.repeat(6)}</p>
      <div></div>
    </article></body></html>`);
    await p.addScriptTag({ path: READABILITY });
    const r = await p.evaluate(() => {
      const c = window.PleasantReadability.parse().content;
      const empties = [...c.querySelectorAll('div')].filter(
        (d) => !d.textContent.trim() && !d.querySelector('img, pre, iframe, video, table')).length;
      return { paras: c.querySelectorAll('p').length, empties };
    });
    await p.close();
    assert.ok(r.paras >= 2, `real paragraphs should survive, got ${r.paras}`);
    assert.equal(r.empties, 0, 'nested empty wrapper divs should be removed');
  });
});
