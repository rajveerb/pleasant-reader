// Guards the security posture of the SHIPPED manifest: the extension must hold
// no standing access to the user's browsing. It runs on demand (activeTab) or on
// domains the user explicitly granted at runtime (optional_host_permissions) —
// never via a declarative <all_urls> content script or standing host_permissions.
//
// (The behavior suites load a permissive *copy* of this manifest because
// headless Chromium can't answer the runtime permission prompt; this test reads
// the real, shipped file.)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from './helpers/extension.mjs';

const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8'));

describe('shipped manifest: no standing host access', () => {
  test('declares no host_permissions', () => {
    assert.equal(manifest.host_permissions, undefined,
      'host_permissions must not be declared (no standing access)');
  });

  test('declares no declarative content_scripts', () => {
    assert.equal(manifest.content_scripts, undefined,
      'content_scripts must not be declared (no auto-injection on every page)');
  });

  test('uses optional_host_permissions for runtime grants', () => {
    assert.deepEqual(manifest.optional_host_permissions, ['*://*/*'],
      'optional_host_permissions must be exactly the broad runtime opt-in pattern');
  });

  test('requests only the minimal API permissions', () => {
    assert.deepEqual([...manifest.permissions].sort(),
      ['activeTab', 'scripting', 'storage'],
      'permissions should be exactly storage + activeTab + scripting');
  });

  test('declares no unexpected top-level keys (catches re-added standing access)', () => {
    // Allowlist every key the shipped manifest is supposed to have. A regression
    // that re-introduces standing access in a different shape (content_scripts,
    // host_permissions, declarative_net_request, a "<all_urls>" elsewhere, etc.)
    // adds a key not in this set and fails here — closing the gap that simple
    // "key === undefined" checks miss.
    const allowed = new Set([
      'manifest_version', 'name', 'version', 'description', 'icons', 'action',
      'background', 'permissions', 'optional_host_permissions', 'commands',
      'web_accessible_resources', 'content_security_policy'
    ]);
    const unexpected = Object.keys(manifest).filter((k) => !allowed.has(k));
    assert.deepEqual(unexpected, [], `unexpected manifest keys: ${unexpected.join(', ')}`);
  });

  test('no permission grants <all_urls>-style standing access', () => {
    const all = [...(manifest.permissions || []), ...(manifest.optional_host_permissions || [])];
    assert.ok(!all.includes('<all_urls>'), 'must not request <all_urls> as a (non-optional) permission');
    for (const danger of ['tabs', 'webNavigation', 'declarativeNetRequest', 'cookies', 'history']) {
      assert.ok(!manifest.permissions.includes(danger), `should not request "${danger}"`);
    }
  });

  test('no web page can message the extension (externally_connectable absent)', () => {
    assert.equal(manifest.externally_connectable, undefined,
      'externally_connectable must be absent so web pages cannot message the extension');
  });

  test('only static assets are web-accessible (no script/html exposed)', () => {
    const resources = (manifest.web_accessible_resources || []).flatMap((w) => w.resources || []);
    for (const r of resources) {
      assert.ok(!/\.(js|mjs|html)$/i.test(r) || r === 'vendor/katex/katex.mjs' || r === 'vendor/katex/auto-render.mjs',
        `unexpected executable/page resource exposed: ${r}`);
    }
    // The two katex modules are intentionally web-accessible (loaded via import);
    // assert nothing under src/ that is a page or script is exposed.
    assert.ok(!resources.some((r) => /^src\/.*\.(js|html)$/i.test(r)),
      'no src/*.js or src/*.html should be web-accessible');
  });
});
