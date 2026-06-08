// Enforces vendored-dependency integrity: recomputes the SHA-256 of every file
// listed in vendor/katex/PROVENANCE.sha256 and asserts it matches. This turns
// the (previously manual) checksum file into a load-bearing control — a tampered
// or silently-upgraded KaTeX blob now fails `npm test`. Offline, no browser.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { EXTENSION_DIR } from './helpers/extension.mjs';

const DIR = join(EXTENSION_DIR, 'vendor/katex');
const lines = readFileSync(join(DIR, 'PROVENANCE.sha256'), 'utf8')
  .split('\n').map((l) => l.trim()).filter(Boolean);

describe('vendored KaTeX integrity (PROVENANCE.sha256)', () => {
  for (const line of lines) {
    const m = line.match(/^([0-9a-f]{64})\s+(?:\*|\.\/)?(.+)$/);
    test(`sha256 matches: ${m ? m[2] : line}`, () => {
      assert.ok(m, `unparseable checksum line: ${line}`);
      const [, expected, rel] = m;
      const actual = createHash('sha256').update(readFileSync(join(DIR, rel))).digest('hex');
      assert.equal(actual, expected, `checksum mismatch for ${rel}`);
    });
  }

  test('checksum file covers the key blobs', () => {
    const text = lines.join('\n');
    for (const f of ['katex.mjs', 'auto-render.mjs', 'katex.min.css', 'LICENSE']) {
      assert.ok(text.includes(f), `${f} must be listed in PROVENANCE.sha256`);
    }
  });
});
