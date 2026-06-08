// Generates the README screenshots by driving the real extension in Chromium
// via the project's own Playwright harness (the same one the tests use, which
// loads the unpacked MV3 extension with its service worker + popup).
//
//   node scripts/screenshots.mjs
//
// Output: docs/images/*.png. Themes are PRESET before enabling (disable → set
// theme → enable) so each capture is a fresh render, avoiding the headless
// stale-composite caveat noted in test/README.md.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchWithExtension, makeSend, activeTabId, setSettings, injectInto, EXTENSION_DIR } from '../test/helpers/extension.mjs';
import { startFixtureServer } from '../test/helpers/server.mjs';
import { openPopupFor } from '../test/helpers/popup.mjs';

const OUT = join(EXTENSION_DIR, 'docs', 'images');
mkdirSync(OUT, { recursive: true });

const { ctx, sw } = await launchWithExtension({ viewport: { width: 1280, height: 820 } });
const send = makeSend(sw);
const server = await startFixtureServer();
await setSettings(sw, { theme: 'light', defaultMode: 'reader', keepFiguresLight: false, siteOverrides: {} });

const page = await ctx.newPage();
const wait = (ms) => page.waitForTimeout(ms);

async function load(fixture) {
  await page.goto(`${server.origin}/${fixture}`, { waitUntil: 'load' });
  await wait(300);
  const tid = await activeTabId(sw);
  await injectInto(sw, tid); // ensure the content script is present before messaging
  await wait(300);
  return tid;
}
async function enter(tid, mode, theme, settle = 600) {
  await send(tid, { type: 'disable' });
  await send(tid, { type: 'setTheme', theme });
  await send(tid, { type: 'enable', mode });
  await wait(settle);
}
async function snap(name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log('  ✓', name);
}

console.log('capturing…');

// 1) Before — the original cluttered page (nav, sidebar ads, footer).
let tid = await load('article-basic.html');
await snap('before');

// 2) Reader mode, light — the clean rebuilt column.
await enter(tid, 'reader', 'light');
await snap('reader-light');

// 3) Reader mode, dark.
await enter(tid, 'reader', 'dark');
await snap('reader-dark');

// 4) Restyle mode — page repainted in place (light).
await enter(tid, 'restyle', 'light');
await snap('restyle');
await send(tid, { type: 'disable' });

// 5) Reader on a rich article — syntax-highlighted code + KaTeX math (dark).
tid = await load('article-rich.html');
await enter(tid, 'reader', 'dark', 1600); // allow KaTeX module import + render
await snap('reader-code-math');
await send(tid, { type: 'disable' });

// 6) The popup controls.
await load('article-basic.html');
const popup = await openPopupFor(ctx, sw, page);
const el = await popup.$('.pr-popup');
await (el || popup).screenshot({ path: join(OUT, 'popup.png') });
console.log('  ✓ popup');

await ctx.close();
await server.close();
console.log('done →', OUT);
