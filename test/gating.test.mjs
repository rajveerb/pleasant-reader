// Injection-gating test against the SHIPPED manifest (no permissive copy).
//
// The behavior suites load a copy of the manifest with standing access so the
// reader can be exercised headlessly. This test does the opposite: it loads the
// real manifest (no host_permissions, no declarative content script) and proves
// the core security promise — without a runtime host grant, the extension holds
// no access and cannot inject its content script. This is the negative case the
// permissive suites structurally cannot cover.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { launchRawExtension, makeSend, activeTabId, injectInto, hostPattern } from './helpers/extension.mjs';
import { startFixtureServer } from './helpers/server.mjs';

let ctx, sw, server, page;

before(async () => {
  ({ ctx, sw } = await launchRawExtension());
  server = await startFixtureServer();
  page = await ctx.newPage();
});

after(async () => {
  await ctx?.close();
  await server?.close();
});

describe('injection gating (shipped manifest, no grant)', () => {
  test('holds no host permission and refuses injection without a grant', async () => {
    await page.goto(`${server.origin}/article-basic.html`, { waitUntil: 'load' });
    await page.waitForTimeout(200);

    // 1) No standing permission for the page's origin.
    const pattern = hostPattern(server.origin);
    const has = await sw.evaluate((p) => chrome.permissions.contains({ origins: [p] }), pattern);
    assert.equal(has, false, 'extension must hold no host permission by default');

    // 2) executeScript from the SW (no activeTab gesture, no grant) is refused —
    //    and refused specifically for lack of host access, not some other error.
    const tid = await activeTabId(sw);
    const res = await injectInto(sw, tid);
    assert.notEqual(res, true, 'executeScript must be refused without a host grant');
    assert.match(String(res), /cannot access contents|must request permission to access/i,
      `refusal should be the specific host-access error, got: ${res}`);

    // 3) Consequently there is no content script to talk to (connection error,
    //    i.e. no receiver — not some unrelated messaging failure).
    const send = makeSend(sw);
    const resp = await send(tid, { type: 'getState' });
    assert.ok(resp && resp.__err, 'no content script should be present without a grant');
    assert.match(String(resp.__err), /receiving end|establish connection/i,
      `should fail because there is no content script, got: ${resp.__err}`);
  });
});
