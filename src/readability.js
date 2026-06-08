/*
 * Pleasant Reader — article extractor
 *
 * A compact, dependency-free content extractor inspired by Mozilla's
 * Readability scoring algorithm. It scans the page for the densest block of
 * real prose, scores candidates by text length / punctuation / link-density,
 * cleans the winner, and returns structured { title, byline, content } where
 * `content` is a sanitized DOM element ready to drop into the reader view.
 *
 * Exposed as window.PleasantReadability so content.js can call it.
 */
(function () {
  'use strict';

  // Tags that never hold article prose — always safe to remove.
  const HARD_STRIP = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
    'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SVG', 'CANVAS', 'DIALOG',
    'LINK', 'META', 'BASE'
  ]);

  // Structural tags that are USUALLY chrome (nav, footers, sidebars) but which
  // some page builders (e.g. Framer) abuse to wrap real content. Remove them
  // only when they don't actually contain prose — see isRemovableChrome().
  const SOFT_CHROME = new Set(['FORM', 'NAV', 'ASIDE', 'HEADER', 'FOOTER']);

  // Minimum non-link text for a soft-chrome / unlikely element to be KEPT as
  // content rather than stripped as chrome.
  const KEEP_PROSE_CHARS = 200;

  // Tags that count as block-level candidates worth scoring.
  const BLOCK_TAGS = new Set([
    'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'TD', 'PRE', 'BLOCKQUOTE'
  ]);

  // Regexes (lifted from Readability's heuristics) that hint at chrome vs body.
  const RE_UNLIKELY = /-ad-|ai2html|banner|breadcrumb|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote|nav|masthead|subscribe|newsletter|share|promo|cookie/i;
  const RE_MAYBE = /and|article|body|column|content|main|shadow|post|entry|text|story/i;
  const RE_POSITIVE = /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i;
  const RE_NEGATIVE = /-ad-|hidden|^hid$|hid$|hid|^hidden|banner|combx|comment|com-|contact|foot|footer|footnote|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget|popup|nav|menu|breadcrumb/i;

  function textLen(node) {
    return (node.textContent || '').trim().length;
  }

  function linkDensity(node) {
    const total = textLen(node);
    if (!total) return 0;
    let linkChars = 0;
    node.querySelectorAll('a').forEach((a) => { linkChars += textLen(a); });
    return linkChars / total;
  }

  // Text length excluding hyperlink text — a proxy for "real prose". Nav bars
  // and footers are mostly links (low value); article bodies are mostly prose.
  function nonLinkTextLen(node) {
    let linkChars = 0;
    node.querySelectorAll('a').forEach((a) => { linkChars += textLen(a); });
    return textLen(node) - linkChars;
  }

  // Should this element be removed as chrome? Hard-strip tags always go.
  // Soft-chrome tags (header/footer/nav/aside/form) and class/id "unlikely"
  // elements go ONLY when they don't hold real prose — so page builders that
  // wrap article content in <header>/<footer> (Framer) don't get gutted.
  function isRemovableChrome(el) {
    if (!el.tagName) return false;
    // Uppercase the tag for comparison: SVG/MathML elements report a LOWERCASE
    // tagName (e.g. 'svg', 'script', 'style'), which would otherwise slip past
    // the uppercase HARD_STRIP set and survive into the reader.
    const tag = el.tagName.toUpperCase();
    if (HARD_STRIP.has(tag)) return true;
    // Any non-HTML-namespace element (SVG, MathML foreignObject, etc.) is chrome
    // we never want — strip it wholesale.
    if (el.namespaceURI && el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return true;
    if (tag === 'BODY' || tag === 'ARTICLE') return false;
    if (!SOFT_CHROME.has(tag) && !isUnlikely(el)) return false;
    return nonLinkTextLen(el) < KEEP_PROSE_CHARS;
  }

  function classAndId(node) {
    return ((node.className && typeof node.className === 'string' ? node.className : '') + ' ' + (node.id || '')).toLowerCase();
  }

  // Base score by tag — articles/divs start higher, lists/quotes lower.
  function tagScore(node) {
    switch (node.tagName) {
      case 'ARTICLE': return 10;
      case 'MAIN': return 8;
      case 'SECTION': return 5;
      case 'DIV': return 5;
      case 'PRE':
      case 'BLOCKQUOTE': return 3;
      case 'TD': return 3;
      case 'ADDRESS':
      case 'OL':
      case 'UL':
      case 'DL':
      case 'DD':
      case 'DT':
      case 'LI':
      case 'FORM': return -3;
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
      case 'TH': return -5;
      default: return 0;
    }
  }

  function classScore(node) {
    let s = 0;
    const str = classAndId(node);
    if (!str.trim()) return 0;
    if (RE_NEGATIVE.test(str)) s -= 25;
    if (RE_POSITIVE.test(str)) s += 25;
    return s;
  }

  function initScore(node) {
    return tagScore(node) + classScore(node);
  }

  // Detect whether a node is "unlikely" content chrome.
  function isUnlikely(node) {
    const str = classAndId(node);
    if (!str) return false;
    if (node.tagName === 'BODY' || node.tagName === 'ARTICLE') return false;
    return RE_UNLIKELY.test(str) && !RE_MAYBE.test(str);
  }

  function getTitle(doc) {
    const metaKeys = [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
      'meta[name="title"]'
    ];
    for (const sel of metaKeys) {
      const m = doc.querySelector(sel);
      if (m && m.content && m.content.trim()) return m.content.trim();
    }
    const h1 = doc.querySelector('article h1, main h1, h1');
    if (h1 && textLen(h1) > 0) return h1.textContent.trim();
    // Fall back to <title>, trimmed of trailing "| Site Name" segments.
    let t = (doc.title || '').trim();
    const parts = t.split(/ [|–—\-] /);
    if (parts.length > 1 && parts[0].length > 15) t = parts[0].trim();
    return t;
  }

  function getByline(doc) {
    const sels = [
      'meta[name="author"]',
      'meta[property="article:author"]',
      'meta[name="twitter:creator"]'
    ];
    for (const sel of sels) {
      const m = doc.querySelector(sel);
      if (m && m.content && m.content.trim() && m.content.length < 100) return m.content.trim();
    }
    const el = doc.querySelector('[rel="author"], .author, .byline, [itemprop="author"]');
    if (el) {
      const t = el.textContent.replace(/\s+/g, ' ').trim();
      if (t && t.length < 100) return t.replace(/^by\s+/i, '');
    }
    return '';
  }

  function getPublished(doc) {
    const t = doc.querySelector('meta[property="article:published_time"], meta[name="date"], time[datetime]');
    if (!t) return '';
    const raw = t.getAttribute('content') || t.getAttribute('datetime') || t.textContent;
    if (!raw) return '';
    const d = new Date(raw);
    if (isNaN(d.getTime())) return (t.textContent || '').trim();
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  // Core scoring pass over a working clone of the document body.
  function grabArticle(root) {
    const scores = new Map();
    const paragraphs = root.querySelectorAll('p, td, pre, blockquote');
    const candidates = new Set();

    paragraphs.forEach((p) => {
      const inner = (p.textContent || '').trim();
      if (inner.length < 25) return;

      const ancestors = [];
      let a = p.parentElement;
      let depth = 0;
      while (a && depth < 4) { ancestors.push(a); a = a.parentElement; depth++; }
      if (!ancestors.length) return;

      let contentScore = 1;
      contentScore += inner.split(',').length;            // commas ~ real sentences
      contentScore += Math.min(Math.floor(inner.length / 100), 3);

      ancestors.forEach((anc, level) => {
        if (!anc.tagName) return;
        if (!scores.has(anc)) {
          scores.set(anc, initScore(anc));
          candidates.add(anc);
        }
        const divider = level === 0 ? 1 : level === 1 ? 2 : level * 3;
        scores.set(anc, scores.get(anc) + contentScore / divider);
      });
    });

    // Scale by inverse link density, pick the top candidate.
    let top = null;
    let topScore = 0;
    candidates.forEach((c) => {
      const s = scores.get(c) * (1 - linkDensity(c));
      scores.set(c, s);
      if (s > topScore) { topScore = s; top = c; }
    });

    if (!top) return null;

    // Pull in sibling blocks that are themselves content-rich (multi-section posts).
    const container = root.ownerDocument.createElement('div');
    const threshold = Math.max(10, topScore * 0.2);
    const parent = top.parentElement;
    const siblings = parent ? Array.from(parent.children) : [top];

    siblings.forEach((sib) => {
      let append = false;
      if (sib === top) {
        append = true;
      } else {
        const sScore = scores.get(sib) || 0;
        if (sScore >= threshold) {
          append = true;
        } else if (sib.tagName === 'P') {
          const len = textLen(sib);
          const ld = linkDensity(sib);
          if (len > 80 && ld < 0.25) append = true;
          else if (len < 80 && ld === 0 && /\.( |$)/.test(sib.textContent)) append = true;
        }
      }
      if (append) container.appendChild(sib.cloneNode(true));
    });

    return container;
  }

  // Remove chrome, junk attributes, empties from the chosen content node.
  function cleanContent(node, pageTitle) {
    // Drop chrome subtrees (junk tags, and prose-less nav/footer/unlikely bits).
    node.querySelectorAll('*').forEach((el) => {
      if (el.tagName && isRemovableChrome(el)) el.remove();
    });

    // Strip presentational / tracking attributes but keep a minimal set. We do
    // NOT keep `srcset`/`data-srcset`: those carry their own URLs and the browser
    // may fetch a candidate other than `src`, which would bypass the scheme
    // allow-list below (a tracking/exfil vector). Instead we collapse images to a
    // single `src` (derived from a lazy/srcset source when needed) so every
    // fetched URL passes through sanitization.
    const KEEP_ATTRS = new Set([
      'href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'datetime'
    ]);
    // The first candidate URL in a srcset (the leading whitespace-delimited
    // token; safe even when the URL is a comma-bearing data: URI).
    const firstSrcsetUrl = (set) => set ? set.trim().split(/\s+/)[0].replace(/,+$/, '') : '';
    node.querySelectorAll('*').forEach((el) => {
      // Derive a src for images from lazy/srcset attributes BEFORE stripping
      // them (the result is scheme-checked in the img[src] pass below).
      if (el.tagName === 'IMG' && !el.getAttribute('src')) {
        const src = el.getAttribute('data-src') ||
          firstSrcsetUrl(el.getAttribute('srcset') || el.getAttribute('data-srcset'));
        if (src) el.setAttribute('src', src);
      }
      Array.from(el.attributes).forEach((attr) => {
        const n = attr.name.toLowerCase();
        if (!KEEP_ATTRS.has(n)) el.removeAttribute(attr.name);
      });
    });

    // Resolve relative URLs to absolute against the live document, and drop
    // active URL schemes. The page's own content is untrusted here: a
    // `javascript:` (or `vbscript:`) href would otherwise survive into the
    // reader's shadow DOM and run script in the page origin on click. Only
    // navigational schemes are allowed for links; only fetchable schemes for
    // image sources.
    const base = document.baseURI;
    const resolved = (raw) => { try { return new URL(raw, base); } catch (e) { return null; } };
    const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);
    const IMG_SCHEMES = new Set(['http:', 'https:', 'data:', 'blob:']);

    // href is navigational and only meaningful on <a>: sanitize it there and
    // remove it everywhere else (e.g. a `javascript:` on <math href> would be a
    // click sink). src is checked on EVERY element — not just <img> — so
    // <video>/<audio>/<source>/<track> can't fetch an unsanitized URL.
    node.querySelectorAll('[href]').forEach((el) => {
      const u = el.tagName === 'A' ? resolved(el.getAttribute('href')) : null;
      if (u && LINK_SCHEMES.has(u.protocol)) {
        el.setAttribute('href', u.href); el.target = '_blank'; el.rel = 'noopener';
      } else {
        el.removeAttribute('href'); // non-anchor href, or javascript:/data:/unparseable
      }
    });
    node.querySelectorAll('[src]').forEach((el) => {
      const u = resolved(el.getAttribute('src'));
      if (u && IMG_SCHEMES.has(u.protocol)) el.setAttribute('src', u.href);
      else el.removeAttribute('src');
    });

    // Remove empty block elements left behind by cleaning. A single pass in
    // REVERSE document order collapses nested empties in one go (a child is
    // visited before its parent, so removing it lets the now-empty parent be
    // removed when we reach it) — avoiding the O(n^2) "re-scan the whole subtree
    // until nothing changes" loop, which a deeply-nested empty tree could hang.
    const blocks = node.querySelectorAll('div, span, section, p');
    for (let i = blocks.length - 1; i >= 0; i--) {
      const el = blocks[i];
      if (textLen(el) === 0 && !el.querySelector('img, pre, iframe, video, table')) {
        el.remove();
      }
    }

    // Drop a leading H1 that just repeats the title (reader adds its own header).
    const firstHeading = node.querySelector('h1');
    if (firstHeading && pageTitle) {
      const a = firstHeading.textContent.trim().toLowerCase();
      const b = pageTitle.trim().toLowerCase();
      if (a && (a === b || (a.length > 10 && b.includes(a)))) firstHeading.remove();
    }

    return node;
  }

  // Fallback for deep SPA trees (React/Next.js, etc.) where there's no
  // <article>/<main> and paragraphs sit many levels below their real
  // container, so ancestor-score propagation never reaches it. Sum each <p>'s
  // text into ALL its ancestors, then pick the TIGHTEST element that still
  // holds the bulk (>=80%) of the paragraph text — i.e. the deepest common
  // wrapper of the main text cluster.
  function densestContainer(root) {
    const sums = new Map();
    let total = 0;
    root.querySelectorAll('p').forEach((p) => {
      const len = (p.textContent || '').trim().length;
      if (len < 25) return;
      total += len;
      let a = p.parentElement;
      while (a) {
        if (a.tagName !== 'BODY' && a.tagName !== 'HTML') {
          sums.set(a, (sums.get(a) || 0) + len);
        }
        a = a.parentElement;
      }
    });
    if (total < 200) return null;

    const threshold = total * 0.8;
    let best = null;
    let bestLen = Infinity;
    sums.forEach((sum, el) => {
      if (sum < threshold) return;
      const elLen = textLen(el);          // prefer the container with the least
      if (elLen < bestLen) {              // surrounding chrome (the tightest fit)
        bestLen = elLen;
        best = el;
      }
    });
    if (!best) return null;

    const container = root.ownerDocument.createElement('div');
    container.appendChild(best.cloneNode(true));
    return container;
  }

  /**
   * Parse the current document into a clean article.
   * @returns {{title, byline, published, content, length, ok}}
   */
  function parse() {
    const doc = document;
    const title = getTitle(doc);
    const byline = getByline(doc);
    const published = getPublished(doc);

    // Work on a clone of <body> so we never mutate the live page.
    const workingRoot = doc.body.cloneNode(true);

    // Pre-strip chrome to keep scoring honest — but preserve nav/header/footer
    // that actually wrap prose (some builders abuse those tags for content).
    workingRoot.querySelectorAll('*').forEach((el) => {
      if (el.tagName && isRemovableChrome(el)) el.remove();
    });

    // Gather candidate content nodes from three strategies, in priority order:
    //   1. score-based extraction (best for normal article markup)
    //   2. an explicit <article>/<main>/[role=main] landmark
    //   3. densest paragraph container (deep SPA trees with no landmarks)
    // We don't short-circuit on the first non-empty result: a weak score-based
    // result can have >250 raw chars yet clean down to nothing, which would
    // otherwise hide a much better fallback. Instead we CLEAN every candidate
    // and choose by cleaned length, preferring the focused score-based result
    // whenever it captures most of the available text.
    const candidates = [];
    const ga = grabArticle(workingRoot);
    if (ga) candidates.push(ga);

    const explicit = doc.querySelector('article') || doc.querySelector('main') ||
      doc.querySelector('[role="main"]');
    if (explicit) {
      const c = doc.createElement('div');
      c.appendChild(explicit.cloneNode(true));
      candidates.push(c);
    }

    const dense = densestContainer(workingRoot);
    if (dense) candidates.push(dense);

    if (!candidates.length) return { ok: false };

    const cleaned = candidates.map((n) => {
      const node = cleanContent(n, title);
      return { node, len: textLen(node) };
    });
    const maxLen = cleaned.reduce((m, c) => Math.max(m, c.len), 0);

    // Highest-priority candidate that still holds >=60% of the best wins;
    // otherwise fall back to the longest candidate outright.
    const pick = cleaned.find((c) => c.len >= Math.max(250, maxLen * 0.6)) ||
      cleaned.reduce((a, b) => (b.len > a.len ? b : a));

    return {
      ok: pick.len >= 200,
      title,
      byline,
      published,
      content: pick.node,   // DOM element
      length: pick.len
    };
  }

  // Lightweight check used for auto-activation: is this page article-like?
  function looksLikeArticle() {
    if (document.querySelector('article')) {
      const a = document.querySelector('article');
      if (textLen(a) > 600) return true;
    }
    const og = document.querySelector('meta[property="og:type"]');
    if (og && /article/i.test(og.content) && textLen(document.body) > 800) return true;

    // Heuristic: a dominant paragraph cluster.
    let pTextMax = 0;
    const seen = new Map();
    document.querySelectorAll('p').forEach((p) => {
      const len = textLen(p);
      if (len < 40) return;
      const parent = p.parentElement;
      if (!parent) return;
      seen.set(parent, (seen.get(parent) || 0) + len);
    });
    seen.forEach((v) => { if (v > pTextMax) pTextMax = v; });
    return pTextMax > 1200;
  }

  window.PleasantReadability = { parse, looksLikeArticle };
})();
