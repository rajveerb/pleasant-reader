# Vendored dependency provenance

These files are a copy of **KaTeX 0.16.11** (https://github.com/KaTeX/KaTeX),
distributed under the MIT License (see `LICENSE`). They are vendored — served
locally from `chrome-extension://` URLs — so the extension never loads code or
fonts from a remote CDN.

## Why this file exists

`katex.mjs` is a ~600 KB minified blob that nobody reviews line by line. Pinning
the version and recording a checksum per file means any future change (an
upgrade, or a tampered copy slipped in via a bad PR) is diffable and verifiable
instead of invisible.

## Verifying integrity

From the repository root:

```bash
sha256sum -c vendor/katex/PROVENANCE.sha256
```

(or `shasum -a 256 -c` on macOS). All files must report `OK`.

## Updating KaTeX

1. Download the matching release artifacts from the official KaTeX release page.
2. Replace the files under `vendor/katex/` (keep the same layout).
3. In `auto-render.mjs`, ensure the import still points to `./katex.mjs`
   (the official artifact imports from `katex.mjs`; we keep it relative/local).
4. Bump the version above and regenerate the checksums:
   ```bash
   cd vendor/katex
   find . -type f ! -name 'PROVENANCE.md' ! -name 'PROVENANCE.sha256' \
     | sort | xargs sha256sum > PROVENANCE.sha256
   ```
5. Run the test suite (`npm test`) — `article-rich` covers math rendering.
