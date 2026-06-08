# Tests

Automated tests for Pleasant Reader, built with Node's built-in test runner
(`node:test`) and Playwright driving a real Chromium with the extension loaded.
No test framework to install.

## Layout

```
test/
├── fixtures/            local HTML pages (+ diagram.png) covering each case
│   ├── article-basic.html       normal semantic <article> + chrome to strip
│   ├── article-framer.html      content wrapped in <header> (Framer-style)
│   ├── article-deep-spa.html    paragraphs buried deep, no landmarks
│   ├── not-article.html         index/listing page (should NOT auto-activate)
│   ├── article-csp.html(+.csp)  served with a strict Content-Security-Policy
│   ├── article-rem.html         page using html{font-size:40%} (rem isolation)
│   ├── article-rich.html        code block + LaTeX math (+ a prose "$5")
│   └── diagram.png              a light figure for dark-mode/invert tests
├── helpers/
│   ├── paths.mjs        locates playwright-core + a Chromium binary
│   ├── server.mjs       tiny static server for fixtures (honors *.csp files)
│   └── extension.mjs    launch helpers + message/inspect utilities
├── manifest.test.mjs    shipped manifest has no standing host access (offline)
├── extraction.test.mjs  src/readability.js parsing (offline, fast)
├── e2e.test.mjs         reader/restyle modes, theming, figures, CSP (loads ext)
├── ui.test.mjs          every control driven by a REAL click + Esc key
└── live.test.mjs        opt-in real-site tests (network; PR_LIVE=1)
```

## Permissions & the test manifest

The shipped extension declares **no standing host access**: it runs on a page
only via `activeTab` (you invoked it) or on a domain you granted at runtime
(`optional_host_permissions`, surfaced by the popup's **Always** rule). There is
no declarative `<all_urls>` content script.

Headless Chromium can't answer the runtime permission prompt (it has no UI), so
`chrome.permissions.request` hangs and `executeScript` would be refused. To
exercise the **reader behavior**, the launch helper therefore loads a *copy* of
the extension whose manifest re-adds `host_permissions` + the declarative content
script (`buildTestExtension` in `helpers/extension.mjs`). The reader code path is
identical regardless of how it was injected.

The **security posture itself** is tested directly, without that copy:
- `manifest.test.mjs` reads the real, shipped `manifest.json` and asserts it has
  no `host_permissions`, no `content_scripts`, and uses `optional_host_permissions`
  with only `storage`/`activeTab`/`scripting`.
- the per-site **spy test** in `ui.test.mjs` stubs `chrome.permissions` in the
  popup and asserts **Always** requests the correct per-origin pattern and
  **Never** removes it.

## What's covered

**Extraction** (`extraction.test.mjs`) — runs `src/readability.js` against the
fixtures in a plain page. Encodes the bugs found during development:
- basic semantic article extracts; chrome (nav/aside/footer/ads) is stripped;
  code block and figure are preserved; title/byline parsed
- content wrapped in `<header>`/`<footer>` (Framer) survives instead of being
  deleted as chrome
- deeply nested SPA content (no `<article>`/`<main>`) is found via the
  densest-container fallback
- an index/listing page is **not** treated as an article (no auto-activation)

**End-to-end** (`e2e.test.mjs`) — loads the extension and drives it through the
service worker (the same messages the popup sends):
- reader mode renders; light = cream background, dark = dark background
- figures invert in dark by default and stay light when "keep figures light" is on
- reader stylesheet loads under a strict CSP (`connect-src 'self'`)
- restyle mode applies light/dark in place; figures follow the same option
- reader ↔ restyle switching and disable are clean
- reader typography is isolated from the page's root font-size, and A+/A−
  scales both body text and headings
- code blocks get Monokai syntax highlighting
- LaTeX math renders via KaTeX, while a prose "$5" is left as text

**UI permutations** (`ui.test.mjs`) — drives every interactive control by an
actual click and asserts the resulting effect on the page:
- in-reader bar: A+, A−, theme toggle, close (×) — clicked via shadow-piercing
  locators
- popup: main toggle, Reader/Restyle, the keep-figures-light switch, and the
  per-site Always/Never rule (Never is the default) — both its behavior (Always
  auto-opens on reload, Never doesn't) and its permission logic (Always requests
  the per-origin host permission; Never removes it — verified with a spy)
- **control × mode matrix**: theme (Dark/Light/Auto), text size (A+/A−) and
  keep-figures-light are each run in **both reader and restyle** mode, asserting
  the mode-appropriate effect (reader → shadow host; restyle → page zoom /
  `data-pleasant-restyle`). This is the coverage that was missing when the
  restyle font-size bug slipped through a green suite.
- keyboard: Esc closes the reader

Run with `PR_SHOTS=<dir>` to also capture a before/after screenshot per button
for visual review:

```bash
PR_SHOTS=/tmp/pr-shots npm run test:ui
```

> Note: the **Alt+R** global shortcut is a browser-level command that Playwright
> can't synthesise headlessly, so it isn't covered here; the underlying toggle
> path it invokes is covered by the popup main-toggle test.

**Live** (`live.test.mjs`, opt-in) — runs the **same control × mode matrix** as
ui.test.mjs but against the real URLs that drove the extractor work (a GitHub
Pages blog, a Substack post, a Framer page), in both reader and restyle:
- reader extraction succeeds (min length) per site
- theme Dark/Light via real popup clicks (mode-appropriate background)
- keep-figures-light toggles image inversion in dark (where the content has an
  image)
- text size A+ scales (reader font scale / restyle page zoom)

Network-dependent and slower; a failure means "investigate" (the site may have
changed), not necessarily a code regression.

```bash
PR_LIVE=1 npm run test:live
PR_LIVE=1 PR_SHOTS=/tmp/pr-live npm run test:live   # + screenshot gallery
```

> **Screenshot caveat.** The assertions read the live DOM (authoritative). The
> opt-in gallery is best-effort: in headless Chromium, capturing the fixed
> shadow-DOM reader overlay right after a *live theme toggle* can occasionally
> show a stale (pre-toggle) frame on image-heavy pages, even though the DOM and a
> real browser are correct. `snap()` forces a re-composite to mitigate this;
> when in doubt, trust the assertions, not the image.

## Running

```bash
npm test            # manifest + extraction + e2e + ui
npm run test:manifest
npm run test:extraction
npm run test:e2e
npm run test:live   # network; hits real sites
npm run test:all    # everything
```

## Requirements

Needs `playwright-core` and a Chromium binary. Resolution is automatic, with env
overrides:

- **playwright-core**: a local install (`npm i -D playwright-core`), a globally
  installed `@playwright/cli`, or `PW_CORE=/path/to/playwright-core/index.mjs`.
- **Chromium**: a Playwright-managed build under `~/.cache/ms-playwright`, or set
  `PW_CHROME=/path/to/chrome`. If none is found, it falls back to the system
  Chrome via Playwright's channel (override with `PW_CHANNEL`, e.g. `msedge`).

Tests run headless. Each launch uses a throwaway profile under the OS temp dir
and is torn down on completion (the static server destroys lingering sockets so
teardown never hangs).
