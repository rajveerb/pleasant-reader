// Locate playwright-core and a Chromium binary without hard-coding machine
// paths. Resolution order (each overridable by env var):
//   playwright-core : $PW_CORE → local node_modules → global @playwright/cli
//   chromium binary : $PW_CHROME → ~/.cache/ms-playwright/chromium-* → system
//
// If no bundled Chromium is found, we fall back to Playwright's `channel`
// (defaults to 'chrome'), which uses the system Google Chrome / Chromium.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function firstExisting(paths) {
  return paths.filter(Boolean).find((p) => existsSync(p));
}

function globalCliCore() {
  // Scan common global node_modules roots for @playwright/cli's bundled core.
  const roots = [];
  const nvm = join(homedir(), '.nvm/versions/node');
  if (existsSync(nvm)) {
    for (const v of readdirSync(nvm)) {
      roots.push(join(nvm, v, 'lib/node_modules'));
    }
  }
  roots.push('/usr/lib/node_modules', '/usr/local/lib/node_modules');
  for (const root of roots) {
    const p = join(root, '@playwright/cli/node_modules/playwright-core/index.mjs');
    if (existsSync(p)) return p;
  }
  return null;
}

export async function loadPlaywright() {
  // 1) explicit override
  const candidates = [process.env.PW_CORE, globalCliCore()];
  const direct = firstExisting(candidates);
  if (direct) {
    return import(pathToFileURL(direct).href);
  }
  // 2) local install (npm i -D playwright-core)
  try {
    const resolved = require.resolve('playwright-core');
    return import(pathToFileURL(resolved).href);
  } catch {
    throw new Error(
      'playwright-core not found. Set PW_CORE to its index.mjs, or run ' +
      '`npm i -D playwright-core`, or install playwright-cli globally.'
    );
  }
}

export function findChromium() {
  if (process.env.PW_CHROME && existsSync(process.env.PW_CHROME)) {
    return { executablePath: process.env.PW_CHROME };
  }
  const cache = join(homedir(), '.cache/ms-playwright');
  if (existsSync(cache)) {
    const builds = readdirSync(cache)
      .filter((d) => d.startsWith('chromium-') && !d.includes('headless'))
      .sort()
      .reverse();
    for (const b of builds) {
      const exe = firstExisting([
        join(cache, b, 'chrome-linux64/chrome'),
        join(cache, b, 'chrome-linux/chrome'),
        join(cache, b, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
        join(cache, b, 'chrome-win/chrome.exe')
      ]);
      if (exe) return { executablePath: exe };
    }
  }
  // Fall back to system Chrome via Playwright channel.
  return { channel: process.env.PW_CHANNEL || 'chrome' };
}

export const EXTENSION_DIR = (() => {
  // test/helpers/paths.mjs → repo root is two levels up.
  const here = new URL('.', import.meta.url).pathname;
  return join(here, '..', '..');
})();

// Sanity: confirm the extension manifest is where we expect.
export function assertExtension() {
  const mani = join(EXTENSION_DIR, 'manifest.json');
  if (!existsSync(mani)) throw new Error('manifest.json not found at ' + mani);
  return EXTENSION_DIR;
}
