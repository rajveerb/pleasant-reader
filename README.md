# Pleasant Reader

A browser extension for **Chrome** and **Brave** that turns any blog or article
into a calm, soothing read — warm earthy colors, fluid typography, and a
comfortable reading column instead of cramped fonts, glaring whites, and
cluttered layouts.

## Features

- **Reader mode** — extracts the article and rebuilds it in a clean, centered
  column with elegant typography (fully isolated from the page via Shadow DOM,
  including its own font sizing — unaffected by the site's root font-size).
- **Code syntax highlighting** — reader code blocks are re-highlighted in a warm
  Monokai palette.
- **Math rendering** — LaTeX/`$…$` math is rendered with bundled KaTeX.
- **Restyle mode** — a lighter touch that keeps the page's structure but
  repaints it with the warm palette and fonts in place.
- **Runs only where you allow it** — the extension holds no standing access to
  your browsing. It activates on a page only when you invoke it (toolbar icon /
  `Alt+R`), or auto-opens on a site after you explicitly grant that site
  permission via the **Always** rule.
- **Light / Dark / Auto theme** — *Auto* follows your operating system.
- **Adjustable text size** — scale the reading size to taste.
- **Per-site rule** — *Always* (grant this site permission to auto-open) or
  *Never* (the default — only opens when you ask).
- **Keyboard shortcut** — `Alt+R` toggles the reader on the current page.
- **Self-hosted fonts** — National Park, Fragment Mono, and Playfair Display are
  bundled, so the look is identical even on sites with strict content security
  policies and works offline.

## Install (unpacked, for development)

1. Open `chrome://extensions` (Chrome) or `brave://extensions` (Brave).
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder
   (`extension-pleasant`).
4. Pin the **Pleasant Reader** icon to your toolbar.

## Usage

- Click the toolbar icon to open the popup, then **Make this page pleasant**.
- Or press **Alt+R** to toggle instantly.
- In reader mode, use the in-view bar to change theme, resize text, or close
  (`Esc` also closes).
- Use the popup to pick the default **Mode** (Reader / Restyle), the **Theme**,
  and set a per-site rule. Choosing **Always** asks for permission to run on that
  site automatically; **Never** (the default) revokes it and leaves the site to
  on-demand use.

## Project structure

```
extension-pleasant/
├── manifest.json          # MV3 manifest
├── icons/                 # toolbar icons (16/32/48/128) + source SVG
├── fonts/                 # bundled woff2 subsets (latin + latin-ext)
└── src/
    ├── background.js      # service worker: shortcut + toolbar badge
    ├── content.js         # orchestrates reader / restyle, theming, messaging
    ├── readability.js     # dependency-free article extractor
    ├── reader.css         # reader-view theme (loaded into Shadow DOM)
    ├── restyle.css        # in-place restyle theme (injected into the page)
    ├── popup.html
    ├── popup.css
    └── popup.js
```

## How extraction works

`readability.js` is a compact, self-contained extractor inspired by the
Readability scoring approach: it scores block elements by text length,
punctuation, and link density, picks the densest prose cluster, pulls in
content-rich siblings, then strips chrome (nav, ads, sidebars), tracking
attributes, and empty nodes. If it can't confidently find an article, reader
mode gracefully falls back to restyle mode.

## Notes

- Reader mode renders inside an open Shadow DOM so the page's CSS can't leak in
  and the reader's CSS can't leak out.
- Settings sync via `chrome.storage.sync` across signed-in browsers. **Note:**
  this includes your per-site **Always**/**Never** list, which is a list of
  hostnames. Because `chrome.storage.sync` is replicated by the browser to your
  other signed-in devices (via Google/Brave sync), that list of sites leaves the
  local machine the same way your bookmarks do. If you'd rather keep it on this
  device only, the rule list can be moved to `chrome.storage.local`.
- **Permissions.** The extension declares no standing host access. It uses
  `activeTab` (temporary access to the current tab, only when you invoke it) and
  requests a per-site host permission at runtime only when you choose **Always**
  for a site. It makes no network requests of its own and sends no page content
  anywhere — all processing is local. (The one nuance is the synced settings
  above, which the browser — not the extension — replicates.)
