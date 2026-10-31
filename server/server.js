// Cloud-rendering backend: headless Chrome renders pages and streams
// screenshots to the J2ME thin client.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = parseInt(process.env.PORT || '8080', 10);
// Optional proxy for local runs (e.g. socks5://host:port where Facebook is
// blocked). Production (the Docker image, NODE_ENV=production) always
// connects directly.
const PROXY = process.env.NODE_ENV === 'production' ? '' : (process.env.PROXY || '');
const TOKEN = process.env.TOKEN || '';
const HOME = process.env.HOME_URL || 'https://m.facebook.com/';
const IDLE_MS = parseInt(process.env.IDLE_MIN || '5', 10) * 60000;
// The desktop (Messenger) browser closes after this long unused once the
// phone is back on Facebook (its profile keeps the login and E2EE keys).
const DESK_IDLE_MS = parseInt(process.env.DESK_IDLE_MIN || '2', 10) * 60000;
// Google Chrome has the H.264/AAC codecs Facebook videos need; bundled
// Chromium does not. Set CHANNEL= (empty) to use bundled Chromium.
const CHANNEL = process.env.CHANNEL === undefined ? 'chrome' : process.env.CHANNEL;
const YTDLP = process.env.YTDLP || 'yt-dlp';
// Extra yt-dlp arguments, space separated (e.g. "--limit-rate 2M").
const YTDLP_EXTRA_ARGS = (process.env.YTDLP_EXTRA_ARGS || '').split(/\s+/).filter(Boolean);
// Docker mounts the volume at /data (DATA_DIR); locally it is ./data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PROFILE_DIR = path.join(DATA_DIR, 'profiles');
const VIDEO_DIR = path.join(DATA_DIR, 'video');

const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
// m.facebook.com shows a "get the Messenger app" wall to mobile browsers,
// so messages are rendered with the desktop site instead, at the phone's own
// width: its layout adapts to narrow windows (single column, normal text).
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DESKTOP_URL = /^https?:\/\/([a-z0-9-]+\.)?(facebook\.com\/messages|messenger\.com|m\.me\/)/i;
const MESSENGER_URL = 'https://www.facebook.com/messages/';
// The Messenger tab on m.facebook.com opens an in-page "get the app" overlay
// without changing the URL; detect it by its text.
const MESSENGER_WALL = /T[aả]i (ứng dụng )?Messenger|Chuyển sang Messenger|Get (the )?Messenger|Switch to Messenger|Download Messenger/i;

for (const d of [DATA_DIR, PROFILE_DIR, VIDEO_DIR]) fs.mkdirSync(d, { recursive: true });

const sessions = new Map();
const videoJobs = new Map();

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Injected into every page (addInitScript): blocks inline video playback,
// hides "open the app" buttons and provides D-pad focus navigation
// (window.__fbc, used by op=move / op=activate / click).
function pageHelpers() {
  if (window.__fbc) return;

  // Videos play in the phone's native player, never inside the page.
  document.addEventListener('play', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') e.target.pause();
  }, true);

  const APP_LABEL = /^(mở ứng dụng|tải ứng dụng|dùng ứng dụng|open app|get app|get the app|use app|use the app)$/i;
  const hideAppButtons = () => {
    for (const el of document.querySelectorAll('a, button, [role="button"]')) {
      const text = (el.textContent || '').trim().normalize('NFC');
      if (!APP_LABEL.test(text)) continue;
      // Hide the largest wrapper that holds nothing but this button.
      let n = el;
      while (n.parentElement && n.parentElement !== document.body &&
        (n.parentElement.textContent || '').trim().normalize('NFC') === text) {
        n = n.parentElement;
      }
      // Only once: rewriting the style would count as a page change.
      if (n.style.getPropertyValue('display') !== 'none') n.style.setProperty('display', 'none', 'important');
    }
  };
  setInterval(hideAppButtons, 700);
  document.addEventListener('DOMContentLoaded', hideAppButtons);

  // ---- D-pad focus ----
  const SEL = 'a[href], button, input:not([type="hidden"]), textarea, select, [role="button"], ' +
    '[role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], ' +
    '[contenteditable="true"], video';
  // The highlight is drawn by the phone (X-Focus), not in the page, so a
  // focus move needs no new screenshot.
  let cur = null;
  const mark = (el) => {
    cur = el;
  };

  const candidates = () => {
    const vw = innerWidth;
    const vh = innerHeight;
    const visible = [];
    for (const el of document.querySelectorAll(SEL)) {
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
      if (el.tagName !== 'VIDEO' && r.width * r.height > vw * vh * 0.5) continue; // page-sized wrappers
      visible.push({ el, r });
    }
    // Focus the inner control, not a wrapper around it: drop candidates that
    // contain another visible one (walk up from each instead of searching
    // every subtree, which is slow on big pages).
    const set = new Set(visible.map((it) => it.el));
    const wrappers = new Set();
    for (const it of visible) {
      for (let p = it.el.parentElement, d = 0; p && d < 30; p = p.parentElement, d++) {
        if (set.has(p)) wrappers.add(p);
      }
    }
    return visible.filter((it) => it.el.tagName === 'VIDEO' || !wrappers.has(it.el));
  };

  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };

  // Spatial navigation: nearest element in direction d (u/d/l/r). With no
  // current focus, start at the first element inside the phone's view
  // (top..bottom, viewport CSS px).
  const move = (d, top, bottom) => {
    const list = candidates();
    let c = cur && cur.isConnected ? cur.getBoundingClientRect() : null;
    if (c && c.width === 0) c = null;
    let best = null;
    let bestScore = Infinity;
    for (const it of list) {
      const r = it.r;
      let score;
      if (!c) {
        if (r.top < top - 1 || r.top > bottom) continue;
        score = r.top * 4 + r.left;
      } else {
        if (it.el === cur || it.el.contains(cur) || cur.contains(it.el)) continue;
        const cx = (c.left + c.right) / 2;
        const cy = (c.top + c.bottom) / 2;
        const rx = (r.left + r.right) / 2;
        const ry = (r.top + r.bottom) / 2;
        const offX = Math.max(0, r.left - c.right, c.left - r.right);
        const offY = Math.max(0, r.top - c.bottom, c.top - r.bottom);
        if (d === 'd') {
          if (ry <= cy + 1 || r.bottom <= c.bottom) continue;
          score = Math.max(0, r.top - c.bottom) + offX * 2 + Math.abs(rx - cx) * 0.05;
        } else if (d === 'u') {
          if (ry >= cy - 1 || r.top >= c.top) continue;
          score = Math.max(0, c.top - r.bottom) + offX * 2 + Math.abs(rx - cx) * 0.05;
        } else if (d === 'r') {
          if (rx <= cx + 1 || r.right <= c.right) continue;
          score = Math.max(0, r.left - c.right) + offY * 3;
        } else {
          if (rx >= cx - 1 || r.left >= c.left) continue;
          score = Math.max(0, c.left - r.right) + offY * 3;
        }
      }
      if (score < bestScore) {
        bestScore = score;
        best = it.el;
      }
    }
    if (!best) return null;
    mark(best);
    return rectOf(best);
  };

  // What 5/FIRE should press: centre of the focused element.
  const target = () => {
    if (!cur || !cur.isConnected) return null;
    const r = cur.getBoundingClientRect();
    if (r.width === 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  // Desktop view: let the browser scroll inner panes to the focus.
  const reveal = () => {
    if (cur && cur.isConnected) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  // A tap at (x, y) that lands on a video (or a feed video's player wrapper,
  // [data-video-id], which m.facebook.com shows until the video is active)
  // rather than on a control drawn over it (like/share on reels): its rect.
  // Also reel posts in the feed: a button labelled as a video ("Xem video
  // thước phim của ...") or a link to a reel/video, with only a thumbnail
  // inside; pressing one would open the reel page.
  const VIDEO_LABEL = /video|thước phim|reel/i;
  const VIDEO_LINK = /\/(reel|videos)\/|\/watch\b|video\.php/;
  const PLAY_LABEL = /^(play|phát)/i;
  const videoAt = (x, y) => {
    const sel = 'video, [data-video-id], [role="button"][aria-label], a[href*="/reel/"], a[href*="/videos/"]';
    for (const v of document.querySelectorAll(sel)) {
      const r = v.getBoundingClientRect();
      if (r.width < 40 || r.height < 40 || x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      if (v.tagName !== 'VIDEO' && !v.hasAttribute('data-video-id')) {
        const label = v.getAttribute('aria-label') || '';
        const video = v.tagName === 'A' ? VIDEO_LINK.test(v.href) : VIDEO_LABEL.test(label) && !PLAY_LABEL.test(label);
        if (!video || r.width < 80 || r.height < 80) continue;
      }
      const hit = document.elementFromPoint(x, y);
      const ctl = hit && hit.closest('a[href], button, [role="button"], input, textarea');
      // A control drawn over the video (like/share on reels) is pressed as
      // usual; its own play button plays it here.
      if (ctl && !ctl.contains(v) && !PLAY_LABEL.test(ctl.getAttribute('aria-label') || '')) return null;
      return rectOf(v);
    }
    return null;
  };

  // Focused element's rect (viewport CSS px), or null.
  const rect = () => {
    if (!cur || !cur.isConnected) return null;
    const r = rectOf(cur);
    return r.w > 0 && r.h > 0 ? r : null;
  };

  // Scroll whatever is scrollable under (x, y) by dy CSS px, instantly: the
  // innermost scrolling pane (Messenger's chat list / message list), else the
  // window. Returns false if nothing moved. Much faster than a mouse wheel,
  // which Chrome animates.
  const scrollAt = (x, y, dy) => {
    for (let el = document.elementFromPoint(x, y); el && el !== document.documentElement; el = el.parentElement) {
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) continue;
      const before = el.scrollTop;
      el.scrollBy({ top: dy, behavior: 'instant' });
      if (el.scrollTop !== before) return true;
    }
    const before = scrollY;
    window.scrollBy({ top: dy, behavior: 'instant' });
    return scrollY !== before;
  };

  // ---- Text mode ----
  // Every visible line of text in the viewport (CSS px), so the phone can
  // draw it with its own fonts over a screenshot taken without text (much
  // smaller JPEG: text edges are what makes it big). null = page not suited
  // (a large video in view, or a desktop-width page shrunk to fit, whose
  // text would be far smaller than any phone font): the phone then gets a
  // normal screenshot.
  const rgb = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).map(parseFloat);
    return { v: ((p[0] & 255) << 16) | ((p[1] & 255) << 8) | (p[2] & 255), a: p.length > 3 ? p[3] : 1 };
  };
  // Splits text node n into the lines the browser laid out (one rect per
  // word): cb(text, left, top, width, height, start, end) per line,
  // viewport CSS px; start..end is the line's part of n.data.
  const range = document.createRange();
  const textLines = (n, pre, cb) => {
    let line = null;
    const flush = () => {
      if (!line) return;
      let t = n.data.slice(line.s, line.e);
      t = pre ? t.replace(/[\t\r\n]/g, ' ') : t.replace(/\s+/g, ' ');
      cb(t, line.l, line.t, line.r - line.l, line.b - line.t, line.s, line.e);
      line = null;
    };
    const re = /\S+/g;
    for (let m = re.exec(n.data); m; m = re.exec(n.data)) {
      range.setStart(n, m.index);
      range.setEnd(n, m.index + m[0].length);
      const r = range.getBoundingClientRect();
      if (!r.width) continue;
      if (line && Math.abs(r.top - line.t) < (line.b - line.t) / 2) {
        line.e = m.index + m[0].length;
        line.l = Math.min(line.l, r.left);
        line.r = Math.max(line.r, r.right);
        line.b = Math.max(line.b, r.bottom);
      } else {
        flush();
        line = { s: m.index, e: m.index + m[0].length, l: r.left, t: r.top, r: r.right, b: r.bottom };
      }
    }
    flush();
  };
  const SKIP_TEXT = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|OPTION|TITLE)$/;

  // Text shown by a form field or value button (outside the DOM tree):
  // { t, col, x, y, w, h (content box, viewport px), flags } or null.
  const fieldText = (el, cs) => {
    const type = (el.type || '').toLowerCase();
    if (/^(hidden|checkbox|radio|file|image|range|color)$/.test(type)) return null;
    const button = /^(button|submit|reset)$/.test(type);
    let t = button ? el.value : (type === 'password' ? el.value.replace(/./g, '•') : el.value);
    let col = rgb(cs.color);
    if (!t && !button) {
      t = el.placeholder || '';
      col = rgb(getComputedStyle(el, '::placeholder').color) || col;
    }
    if (!t || !col) return null;
    const r = el.getBoundingClientRect();
    if (!r.width) return null;
    const pl = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
    const pt = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
    const pr = parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth);
    const pb = parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth);
    return {
      t: t.replace(/\s+/g, ' '),
      col,
      x: r.left + pl,
      y: r.top + pt,
      w: r.width - pl - pr,
      h: r.height - pt - pb,
      flags: button ? 6 : (el.tagName === 'TEXTAREA' ? 10 : 2),
    };
  };

  const textDump = () => {
    // Rects are in layout px; a page without a mobile viewport tag is shown
    // scaled down by this factor.
    const z = window.visualViewport ? visualViewport.scale : 1;
    if (z < 0.6) return null;
    const vw = innerWidth;
    const vh = innerHeight;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const w = Math.min(r.right, vw) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      if (w > 0 && h > 0 && w * h > vw * vh / 6) return null;
    }
    const styles = new Map();
    const style = (el) => {
      let cs = styles.get(el);
      if (!cs) {
        cs = getComputedStyle(el);
        styles.set(el, cs);
      }
      return cs;
    };
    // Visible area of an element: the viewport cut by every ancestor that
    // clips its overflow (Messenger's scrolling lists).
    const clips = new Map();
    const clipOf = (el) => {
      if (!el || el === document.documentElement) return { l: 0, t: 0, r: vw, b: vh };
      let c = clips.get(el);
      if (c) return c;
      c = clipOf(el.parentElement);
      const cs = style(el);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const r = el.getBoundingClientRect();
        c = { l: Math.max(c.l, r.left), t: Math.max(c.t, r.top), r: Math.min(c.r, r.right), b: Math.min(c.b, r.bottom) };
      }
      clips.set(el, c);
      return c;
    };
    // Covered by an unrelated element with a background (dialog, sheet)?
    const covered = (el, x, y) => {
      const hit = document.elementFromPoint(x, y);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return false;
      for (let n = hit; n && !n.contains(el); n = n.parentElement) {
        const bg = rgb(style(n).backgroundColor);
        if (bg && bg.a > 0.5) return true;
      }
      return false;
    };
    const out = [];
    // flags: 1 bold, 2 clip to the box, 4 centre in the box, 8 top of the box
    const push = (el, x, y, w, h, text, flags, color) => {
      const c = clipOf(el);
      const cx = x + w / 2;
      const cy = y + h / 2;
      if (cx < c.l || cx > c.r || cy < c.t || cy > c.b || covered(el, Math.min(cx, vw - 1), cy)) return;
      const cs = style(el);
      if (parseInt(cs.fontWeight, 10) >= 600) flags |= 1;
      out.push([x * z, y * z, w * z, h * z, (parseFloat(cs.fontSize) || 14) * z, flags, color, text]);
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !/\S/.test(n.data) || SKIP_TEXT.test(el.tagName)) continue;
      range.selectNodeContents(n);
      const all = range.getBoundingClientRect();
      if (all.bottom < 0 || all.top > vh || all.right < 0 || all.left > vw || !all.width) continue;
      const cs = style(el);
      if (cs.visibility !== 'visible' || cs.opacity === '0') continue;
      const col = rgb(cs.color);
      if (!col || col.a < 0.1) continue;
      textLines(n, /^pre/.test(cs.whiteSpace), (t, x, y, w, h) => push(el, x, y, w, h, t, 0, col.v));
    }
    for (const el of document.querySelectorAll('input, textarea')) {
      const f = fieldText(el, style(el));
      if (!f || f.y + f.h < 0 || f.y > vh) continue;
      push(el, f.x, f.y, f.w, f.h, f.t, f.flags, f.col.v);
    }
    return out;
  };

  // ---- Page mode ----
  // A long stretch of the page (2 views above the phone's view to 6 below)
  // as drawing commands in document CSS px, so the phone scrolls through it
  // on its own:
  //   ['T', x, y, w, h, fontSize, flags, color, text]  text line
  //   ['B', x, y, w, h, radius, flags, color]           filled box
  //   ['R', x, y, w, h, radius, flags, color]           box outline (border)
  //   ['I', x, y, w, h, 0, flags, key]                  image, fetched by key
  //   ['C', x, y, w, h, 0, flags]                       clip for what follows (w=0: none)
  // flags as in textDump, plus 16: pinned to the screen (position: fixed),
  // y relative to the phone's view. Images go out as recipes (HTML that
  // draws them alone: <img>, CSS background or inlined SVG) for the server
  // to render on demand, each recipe once per document.
  const sentRecipes = new Set();
  const hexOf = (c) => {
    const ch = (sh) => Math.round(((c.v >> sh) & 255) * c.a + 255 * (1 - c.a));
    return ((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16);
  };
  const hashOf = (s) => {
    let a = 5381;
    let b = 52711;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = Math.imul(a, 33) ^ c;
      b = Math.imul(b, 31) ^ c;
    }
    return (a >>> 0).toString(36) + (b >>> 0).toString(36);
  };
  const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  // An SVG with the styles it gets from the page inlined (Facebook colours
  // icons through classes and CSS variables) and <use> references resolved.
  const svgMarkup = (el) => {
    const clone = el.cloneNode(true);
    const src = [el, ...el.querySelectorAll('*')];
    const dst = [clone, ...clone.querySelectorAll('*')];
    for (let i = 0; i < src.length; i++) {
      const cs = getComputedStyle(src[i]);
      dst[i].removeAttribute('class');
      dst[i].setAttribute('style', `fill:${cs.fill};fill-opacity:${cs.fillOpacity};fill-rule:${cs.fillRule};` +
        `stroke:${cs.stroke};stroke-width:${cs.strokeWidth};opacity:${cs.opacity};color:${cs.color}`);
    }
    for (const u of clone.querySelectorAll('use')) {
      const ref = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
      const t = ref[0] === '#' ? document.getElementById(ref.slice(1)) : null;
      if (!t) continue;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      for (const ch of t.childNodes) g.appendChild(ch.cloneNode(true));
      g.setAttribute('style', u.getAttribute('style') || '');
      u.replaceWith(g);
    }
    clone.setAttribute('width', '100%');
    clone.setAttribute('height', '100%');
    clone.style.display = 'block';
    return new XMLSerializer().serializeToString(clone);
  };

  // Characters phone fonts don't have: private-use (icon fonts), symbols
  // and emoji.
  const SPECIAL = /[\uE000-\uF8FF\u2190-\u2BFF\uFE0F]|[\uD800-\uDBFF][\uDC00-\uDFFF]/;
  // text drawn with the element's font into a PNG data URL (canvases use
  // the page's loaded web fonts), w x h CSS px at the page's pixel ratio.
  const glyphs = (text, cs, w, h) => {
    const k = devicePixelRatio || 1;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.ceil(w * k));
    cv.height = Math.max(1, Math.ceil(h * k));
    const g = cv.getContext('2d');
    if (!g) return null;
    g.scale(k, k);
    g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    g.fillStyle = cs.color;
    const m = g.measureText(text);
    const asc = m.fontBoundingBoxAscent || parseFloat(cs.fontSize) * 0.8;
    const desc = m.fontBoundingBoxDescent || parseFloat(cs.fontSize) * 0.2;
    g.fillText(text, 0, (h - asc - desc) / 2 + asc);
    return cv.toDataURL();
  };

  // Desktop view (Messenger): the page itself doesn't scroll, an inner
  // pane does (chat list, message list). Page mode then treats that pane as
  // the document: the phone scrolls its content, everything else is pinned.
  let pane = null;
  const scrollable = (el) => el.scrollHeight > el.clientHeight + 20 &&
    /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY);
  const findPane = () => {
    const vw = innerWidth;
    const vh = innerHeight;
    const big = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > vw / 2 && r.height > vh / 3 && r.bottom > 0 && r.top < vh ? r.width * r.height : 0;
    };
    if (pane && pane.isConnected && scrollable(pane) && big(pane)) return pane;
    let best = null;
    let bestArea = 0;
    for (const el of document.body.querySelectorAll('div, ul, main, section')) {
      if (el.scrollHeight <= el.clientHeight + 20) continue;
      const a = big(el);
      if (a > bestArea && scrollable(el)) {
        best = el;
        bestArea = a;
      }
    }
    return best;
  };
  // Page mode position: the pane's scroll, else the window's.
  const scrollPos = () => (pane && pane.isConnected ? pane.scrollTop : scrollY);
  // Scrolls the pane to y (CSS px); returns where it ended up, or null.
  const paneTo = (y) => {
    if (!pane || !pane.isConnected) return null;
    pane.scrollTop = y;
    return pane.scrollTop;
  };

  // A position: fixed bar at the bottom of the viewport? (Computed top and
  // bottom are both resolved to px, so this goes by geometry.)
  const atViewportBottom = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom >= innerHeight - 1 && r.top > innerHeight / 2;
  };

  const pageDump = (oy, viewH, desk) => {
    const z = window.visualViewport ? visualViewport.scale : 1;
    const doc = document.documentElement;
    const body = document.body;
    if (z < 0.6 || !body) return null;
    const vh = innerHeight;
    pane = desk ? findPane() : null;
    const pr = pane && pane.getBoundingClientRect();
    const sy = pane ? pane.scrollTop : scrollY;
    // With a pane, document y = viewport y + pane scroll, and the largest
    // scroll the phone may use is the pane's.
    const height = pane ? pane.scrollHeight - pane.clientHeight + viewH : Math.max(doc.scrollHeight, body.scrollHeight);
    // Pinned items before the pane's content are drawn under it (32),
    // later ones and position: fixed over it (16).
    let afterPane = !pane;
    const viewTop = sy + oy;
    const top = Math.max(0, viewTop - 2 * viewH);
    const bottom = Math.min(height, viewTop + 6 * viewH);
    // Items in DOM order with their clip and z-index; sorted by z-index at
    // the end (a header's background can come after its logo in the DOM
    // but sit under it), then clips become 'C' lines.
    const items = [];
    const recipes = {};
    const emit = (c, item) => {
      const cl = c.clip;
      if (cl && (cl.r <= cl.l || cl.b <= cl.t)) return; // clipped away
      const layer = !c.fixed ? 0 : (c.top || afterPane ? 16 : 32);
      item[6] |= layer;
      items.push({ item, cl, layer, zk: (c.zk || []).concat([c.tier || 0]) });
    };
    const image = (c, x, y, w, h, html, alpha) => {
      if (w < 2 || h < 2) return;
      // Filling a rounded clip (avatar in a round frame): round the image
      // itself, as the phone only clips to rectangles.
      const cl = c.clip;
      if (cl && cl.rad > 1 && Math.abs(x - cl.l) < 2 && Math.abs(y - cl.t) < 2 &&
          Math.abs(x + w - cl.r) < 2 && Math.abs(y + h - cl.b) < 2) {
        html = `<div style="width:100%;height:100%;border-radius:${cl.rad}px;overflow:hidden">${html}</div>`;
        alpha = true;
      }
      const k = hashOf(html + '|' + Math.round(w) + 'x' + Math.round(h));
      if (!sentRecipes.has(k)) {
        sentRecipes.add(k);
        recipes[k] = { html, w: Math.ceil(w), h: Math.ceil(h), alpha };
      }
      emit(c, ['I', x, y, w, h, 0, 0, k]);
    };
    const radius = (cs, w, h) => {
      const r = cs.borderTopLeftRadius;
      const v = parseFloat(r) || 0;
      return Math.min(/%/.test(r) ? Math.min(w, h) * v / 100 : v, Math.min(w, h) / 2);
    };
    const text = (c, n, cs) => {
      const col = rgb(cs.color);
      if (!col || col.a < 0.1) return;
      range.selectNodeContents(n);
      const all = range.getBoundingClientRect();
      if (!all.width || (!c.fixed && (all.bottom + c.dy < top || all.top + c.dy > bottom))) return;
      const size = parseFloat(cs.fontSize) || 14;
      const bold = parseInt(cs.fontWeight, 10) >= 600 ? 1 : 0;
      const color = hexOf(col);
      textLines(n, /^pre/.test(cs.whiteSpace), (t, x, y, w, h, s, e) => {
        if (!SPECIAL.test(n.data.slice(s, e))) {
          emit(c, ['T', x + c.dx, y + c.dy, w, h, size, bold, color, t]);
          return;
        }
        // Icon-font glyphs and emoji, which phone fonts lack: drawn here
        // with the page's font and sent as images; the rest stays text.
        const runs = /((?:[\uE000-\uF8FF\u2190-\u2BFF\uFE0F\u200D]|[\uD800-\uDBFF][\uDC00-\uDFFF])+)|[^\uE000-\uF8FF\u2190-\u2BFF\uFE0F\u200D\uD800-\uDFFF]+/g;
        const part = n.data.slice(s, e);
        for (let m = runs.exec(part); m; m = runs.exec(part)) {
          range.setStart(n, s + m.index);
          range.setEnd(n, s + m.index + m[0].length);
          const r = range.getBoundingClientRect();
          if (!r.width) continue;
          if (m[1]) {
            const src = glyphs(m[0], cs, r.width, r.height);
            if (src) {
              image(c, r.left + c.dx, r.top + c.dy, r.width, r.height,
                `<img src="${src}" style="display:block;width:100%;height:100%">`, true);
            }
          } else if (/\S/.test(m[0])) {
            emit(c, ['T', r.left + c.dx, r.top + c.dy, r.width, r.height, size, bold, color, m[0].replace(/\s+/g, ' ').trim()]);
          }
        }
      });
    };
    const box = (el, cs, c, x, y, w, h) => {
      const mask = cs.webkitMaskImage || cs.maskImage;
      if (mask && mask !== 'none') {
        // Icon drawn as a colour through a mask image: render it whole.
        image(c, x, y, w, h, `<div style="width:100%;height:100%;background-color:${cs.backgroundColor};` +
          `background-image:${attr(cs.backgroundImage)};-webkit-mask-image:${attr(mask)};` +
          `-webkit-mask-size:${cs.webkitMaskSize};-webkit-mask-position:${cs.webkitMaskPosition};` +
          `-webkit-mask-repeat:${cs.webkitMaskRepeat}"></div>`, true);
        return;
      }
      if (el !== body) {
        const bg = rgb(cs.backgroundColor);
        if (bg && bg.a > 0.05) emit(c, ['B', x, y, w, h, radius(cs, w, h), 0, hexOf(bg)]);
      }
      if (cs.backgroundImage !== 'none') {
        image(c, x, y, w, h, `<div style="width:100%;height:100%;background-image:${attr(cs.backgroundImage)};` +
          `background-size:${cs.backgroundSize};background-position:${cs.backgroundPosition};` +
          `background-repeat:${cs.backgroundRepeat};border-radius:${cs.borderRadius}"></div>`,
        w * h < 6400 || radius(cs, w, h) > 0);
      }
      // Backgrounds Facebook draws with absolutely placed ::before/::after
      // (button pills, badges, round icon backdrops).
      for (const ps of ['::before', '::after']) {
        const pcs = getComputedStyle(el, ps);
        if (pcs.content === 'none' || pcs.position !== 'absolute' || pcs.display === 'none' ||
          pcs.visibility !== 'visible' || parseFloat(pcs.opacity) === 0) continue;
        const bg = rgb(pcs.backgroundColor);
        if (!bg || bg.a <= 0.05) continue;
        const pw = parseFloat(pcs.width);
        const ph = parseFloat(pcs.height);
        if (!(pw > 0 && ph > 0)) continue;
        const px = pcs.left !== 'auto' ? x + parseFloat(pcs.left) : x + w - parseFloat(pcs.right) - pw;
        const py = pcs.top !== 'auto' ? y + parseFloat(pcs.top) : y + h - parseFloat(pcs.bottom) - ph;
        if (Number.isFinite(px) && Number.isFinite(py)) {
          // Positioned, so it stacks like a positioned child.
          emit(positioned(c, pcs.zIndex), ['B', px, py, pw, ph, radius(pcs, pw, ph), 0, hexOf(bg)]);
        }
      }
      // Borders: one outline if all four sides match, else a strip per side.
      const side = (s) => {
        const bw = parseFloat(cs['border' + s + 'Width']) || 0;
        const col = cs['border' + s + 'Style'] === 'none' ? null : rgb(cs['border' + s + 'Color']);
        return bw > 0 && col && col.a > 0.05 ? { bw, col: hexOf(col) } : null;
      };
      const t = side('Top');
      const r = side('Right');
      const b = side('Bottom');
      const l = side('Left');
      if (t && r && b && l && t.col === r.col && t.col === b.col && t.col === l.col) {
        emit(c, ['R', x, y, w, h, radius(cs, w, h), 0, t.col]);
      } else {
        if (t) emit(c, ['B', x, y, w, t.bw, 0, 0, t.col]);
        if (b) emit(c, ['B', x, y + h - b.bw, w, b.bw, 0, 0, b.col]);
        if (l) emit(c, ['B', x, y, l.bw, h, 0, 0, l.col]);
        if (r) emit(c, ['B', x + w - r.bw, y, r.bw, h, 0, 0, r.col]);
      }
    };
    // Replaced elements (images, fields...): drawn here, returns true.
    const replaced = (el, cs, c, x, y, w, h) => {
      const tag = el.tagName;
      if (tag === 'IMG') {
        const src = el.currentSrc || el.src;
        if (src) {
          image(c, x, y, w, h, `<img src="${attr(src)}" style="display:block;width:100%;height:100%;` +
            `object-fit:${cs.objectFit};object-position:${cs.objectPosition};border-radius:${cs.borderRadius}">`,
          w * h < 6400);
        }
        return true;
      }
      if (el instanceof SVGSVGElement) {
        image(c, x, y, w, h, svgMarkup(el), true);
        return true;
      }
      if (tag === 'VIDEO') {
        if (el.poster) {
          image(c, x, y, w, h, `<img src="${attr(el.poster)}" style="display:block;width:100%;height:100%;` +
            'object-fit:contain">', false);
        }
        return true;
      }
      if (tag === 'CANVAS') {
        try {
          image(c, x, y, w, h, `<img src="${el.toDataURL()}" style="display:block;width:100%;height:100%">`, true);
        } catch (e) {
          // Tainted canvas: left out.
        }
        return true;
      }
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const f = fieldText(el, cs);
        if (f) {
          emit(c, ['T', f.x + c.dx, f.y + c.dy, f.w, f.h, parseFloat(cs.fontSize) || 14,
            f.flags | (parseInt(cs.fontWeight, 10) >= 600 ? 1 : 0), hexOf(f.col), f.t]);
        }
        return true;
      }
      if (tag === 'SELECT') {
        const o = el.options[el.selectedIndex];
        const col = rgb(cs.color);
        if (o && col) emit(c, ['T', x + 4, y, w - 8, h, parseFloat(cs.fontSize) || 14, 2, hexOf(col), o.text]);
        return true;
      }
      return false;
    };
    const REPLACED = /^(IMG|VIDEO|CANVAS|INPUT|TEXTAREA|SELECT)$/;
    // c with its clip narrowed to box (rad: corner radius, for images that
    // fill it).
    // Paint order (CSS stacking, simplified). Within a stacking context:
    // negative z-index, plain blocks (tier 0), positioned with z auto (1,
    // tree order), positive z-index. An item's key is the tier of each
    // enclosing context in its parent, then its own tier; keys compare
    // level by level.
    const positioned = (c, zIndex) => {
      if (zIndex === 'auto') return c.tier === 1 ? c : { ...c, tier: 1 };
      const zi = parseInt(zIndex, 10) || 0;
      return { ...c, zk: (c.zk || []).concat([zi < 0 ? zi : zi + 1]), tier: 0 };
    };
    const withClip = (c, box, rad) => {
      const p = c.clip;
      return {
        ...c,
        clip: {
          rad,
          l: Math.max(p ? p.l : -1e9, box.l),
          t: Math.max(p ? p.t : -1e9, box.t),
          r: Math.min(p ? p.r : 1e9, box.r),
          b: Math.min(p ? p.b : 1e9, box.b),
        },
      };
    };
    const visit = (el, c) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || parseFloat(cs.opacity) === 0) return;
      if (cs.position === 'fixed' && !c.top) {
        // Pinned to the screen; bars at the bottom of the (taller) viewport
        // go to the bottom of the phone's view.
        c = { fixed: true, top: true, zk: c.zk, tier: c.tier, dx: 0, dy: atViewportBottom(el) ? viewH - vh : 0, clip: null };
      }
      if (cs.position !== 'static') c = positioned(c, cs.zIndex);
      // Legacy clip: rect(0 0 0 0) hides an element ("visually hidden").
      if (/^rect\(/.test(cs.clip || '')) {
        const q = cs.clip.match(/-?[\d.]+/g) || [];
        if (q.length === 4 && (q[1] - q[3] < 2 || q[2] - q[0] < 2)) return;
      }
      const r = el.getBoundingClientRect();
      const x = r.left + c.dx;
      const y = r.top + c.dy;
      const w = r.width;
      const h = r.height;
      // clip-path cuts the element itself and its children (Facebook rounds
      // cards with "inset(0px round 18px)" and hides things with
      // "inset(50%)"; other shapes are taken as the box).
      const cp = cs.clipPath;
      if (cp && cp !== 'none') {
        const ins = /^inset\(([^)]*?)(?: round ([^)]*))?\)$/.exec(cp);
        const v = ins ? ins[1].trim().split(/\s+/) : ['0'];
        const len = (t, size) => (/%$/.test(t) ? size * parseFloat(t) / 100 : parseFloat(t) || 0);
        const [it, ir = it, ib = it, il = ir] = v;
        const area = { l: x + len(il, w), t: y + len(it, h), r: x + w - len(ir, w), b: y + h - len(ib, h) };
        if (area.r - area.l < 1 || area.b - area.t < 1) return;
        c = withClip(c, area, ins && ins[2] ? parseFloat(ins[2]) || 0 : 0);
      }
      // Far outside the stretch sent (or, pinned, the screen): skip the
      // whole subtree.
      if (h > 0 && (c.fixed ? y + h < -viewH || y > 2 * viewH : y + h < top - viewH || y > bottom + viewH)) return;
      const shown = cs.visibility === 'visible';
      if (shown && w > 0 && h > 0 && (c.fixed || (y + h >= top && y <= bottom))) {
        box(el, cs, c, x, y, w, h);
        if (replaced(el, cs, c, x, y, w, h)) return;
      } else if (el instanceof SVGSVGElement || REPLACED.test(el.tagName)) {
        return;
      }
      // Children are also clipped by overflow.
      let cc = c;
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        cc = withClip(c, { l: x, t: y, r: x + w, b: y + h }, radius(cs, w, h));
      }
      if (el === pane) {
        // The scrolling content, clipped to the pane by the phone.
        cc = { fixed: false, top: false, zk: [], tier: 0, dx: 0, dy: sy, clip: null };
      }
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 1) visit(n, cc);
        else if (n.nodeType === 3 && shown && /\S/.test(n.data) && !SKIP_TEXT.test(el.tagName)) text(cc, n, cs);
      }
      if (el === pane) afterPane = true;
    };
    visit(body, pane ? { fixed: true, top: false, dx: 0, dy: 0, clip: null }
      : { fixed: false, top: false, dx: scrollX, dy: sy, clip: null });
    items.forEach((it, i) => {
      it.i = i;
    });
    items.sort((a, b) => {
      for (let i = 0; i < a.zk.length || i < b.zk.length; i++) {
        const d = (a.zk[i] || 0) - (b.zk[i] || 0);
        if (d) return d;
      }
      return a.i - b.i;
    });
    const lines = [];
    const curClip = {}; // per layer: the phone tracks clips per layer
    for (const { item, cl, layer } of items) {
      const key = cl ? [cl.l, cl.t, cl.r, cl.b].join() : '';
      if (curClip[layer] !== key) {
        curClip[layer] = key;
        lines.push(cl ? ['C', cl.l, cl.t, cl.r - cl.l, cl.b - cl.t, 0, layer] : ['C', 0, 0, 0, 0, 0, layer]);
      }
      lines.push(item);
    }
    // What the D-pad can focus, so the phone moves the focus itself:
    // ['F', x, y, w, h, radius, flags] (flags 16 = pinned). Inner controls
    // only, as in candidates().
    const vw = innerWidth;
    // The position: fixed element el is in (or null).
    const fixedOf = new Map();
    const fixedRoot = (el) => {
      if (!el || el === body) return null;
      let f = fixedOf.get(el);
      if (f === undefined) {
        f = getComputedStyle(el).position === 'fixed' ? el : fixedRoot(el.parentElement);
        fixedOf.set(el, f);
      }
      return f;
    };
    const found = [];
    for (const el of document.querySelectorAll(SEL)) {
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6 || r.right <= 0 || r.left >= vw) continue;
      if (el.tagName !== 'VIDEO' && r.width * r.height > vw * viewH * 0.5) continue; // page-sized wrappers
      const root = pane ? null : fixedRoot(el);
      const pinned = pane ? !pane.contains(el) : !!root;
      // Pinned: placed as the dump places them (bottom bars at the bottom
      // of the phone's view).
      let y = r.top + sy;
      if (pinned) y = r.top + (root && atViewportBottom(root) ? viewH - vh : 0);
      if (pinned ? r.bottom <= 0 || r.top >= vh : y + r.height < top || y > bottom) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility !== 'visible') continue;
      // Rounded corners often belong to an inner box of the same size.
      let rad = radius(cs, r.width, r.height);
      for (let q = el.firstElementChild, d = 0; q && !rad && d < 4; q = q.firstElementChild, d++) {
        const qr = q.getBoundingClientRect();
        if (Math.abs(qr.width - r.width) > 2 || Math.abs(qr.height - r.height) > 2) break;
        rad = radius(getComputedStyle(q), qr.width, qr.height);
      }
      found.push({ el, item: ['F', r.left, y, r.width, r.height, rad, pinned ? 16 : 0] });
    }
    const set = new Set(found.map((f) => f.el));
    const wrappers = new Set();
    for (const f of found) {
      for (let q = f.el.parentElement, d = 0; q && d < 30; q = q.parentElement, d++) {
        if (set.has(q)) wrappers.add(q);
      }
    }
    for (const f of found) {
      if (f.el.tagName === 'VIDEO' || !wrappers.has(f.el)) lines.push(f.item);
    }
    let bg = rgb(getComputedStyle(body).backgroundColor);
    if (!bg || bg.a < 0.05) bg = rgb(getComputedStyle(doc).backgroundColor);
    if (z !== 1) {
      for (const l of lines) for (let i = 1; i <= 5; i++) l[i] *= z;
    }
    return {
      lines,
      recipes,
      sy,
      top: top * z,
      bottom: bottom * z,
      height: height * z,
      bg: bg && bg.a > 0.05 ? hexOf(bg) : 'ffffff',
      // The pane's box on screen: the phone clips the scrolling content to it.
      pane: pr ? [pr.left, Math.max(0, pr.top), pr.width, Math.min(pr.bottom, vh) - Math.max(0, pr.top)].map((n) => n * z) : null,
    };
  };

  // Page mode: anything that may change the dump bumps this, so the server
  // can skip dumping an unchanged page (most requests are follow-up polls).
  const docId = Math.random().toString(36).slice(2);
  let version = 0;
  const bump = () => {
    version++;
  };
  new MutationObserver(bump).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  for (const ev of ['load', 'error', 'transitionend', 'animationend', 'resize']) addEventListener(ev, bump, true);
  if (document.fonts) document.fonts.addEventListener('loadingdone', bump);
  const dumpKey = () => [docId, version, scrollPos(), innerWidth, innerHeight].join(':');

  window.__fbc = { move, target, reveal, videoAt, rect, scrollAt, textDump, pageDump, scrollPos, paneTo, dumpKey, clear: () => mark(null) };
}

function wantMode(url) {
  return DESKTOP_URL.test(url) ? 'desk' : 'mob';
}

function toModeUrl(url, mode) {
  return mode === 'desk'
    ? url.replace('://m.facebook.com', '://www.facebook.com')
    : url.replace('://www.facebook.com', '://m.facebook.com');
}

// ---- Browser contexts ----

async function launchView(s, mode) {
  const desk = mode === 'desk';
  const scale = s.zoom / 100;
  const hCss = Math.round(s.h / scale);
  // Overscan: render extra rows above and below the phone's view so it can
  // scroll locally without blank areas. Off for the desktop (Messenger)
  // view, whose 100vh layout would push the composer out of sight.
  const margin = desk ? 0 : Math.round(hCss * s.ov / 100);
  const opts = {
    headless: true,
    viewport: { width: Math.round(s.w / scale), height: hCss + 2 * margin },
    // Low resolution (r=1.5 or 2): the image has 1/r of the phone's pixels per
    // side and the phone scales it up. Coordinates in headers and requests
    // stay in phone px (view.scale), so only the image shrinks.
    deviceScaleFactor: scale / s.res,
    isMobile: !desk,
    hasTouch: false,
    userAgent: desk ? UA_DESKTOP : UA_MOBILE,
    locale: 'vi-VN',
    args: ['--disable-dev-shm-usage', '--deny-permission-prompts'],
  };
  if (PROXY) opts.proxy = { server: PROXY };
  if (CHANNEL) opts.channel = CHANNEL;
  // Persistent profiles keep cookies and IndexedDB (Messenger E2EE keys).
  const dir = path.join(PROFILE_DIR, `${s.id}-${mode}`);
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(dir, opts);
  } catch (e) {
    // Fall back only when Chrome is not installed. Any other failure (e.g.
    // the profile is locked) must not open the profile with Chromium: it
    // cannot decrypt Chrome's cookies on Windows, so the login is lost.
    if (!opts.channel || !/is not found|not installed|ENOENT/i.test(e.message)) throw e;
    log('channel', opts.channel, 'unavailable, using bundled chromium:', e.message.split('\n')[0]);
    delete opts.channel;
    ctx = await chromium.launchPersistentContext(dir, opts);
  }
  await ctx.addInitScript(pageHelpers);
  const page = ctx.pages()[0] || await ctx.newPage();
  // oy: CSS offset of the phone's view inside the (taller) viewport.
  const view = { mode, ctx, page, scale, margin, oy: 0, lastUrl: '' };

  // Keep a single tab: popups replace the current page.
  ctx.on('page', async (p) => {
    if (p === view.page || p === view.helper || view.opening) return;
    await p.waitForLoadState('domcontentloaded').catch(() => {});
    const url = p.url();
    await p.close().catch(() => {});
    if (url && url !== 'about:blank') await view.page.goto(url).catch(() => {});
  });
  // A freshly loaded document starts scrolled to the top.
  page.on('domcontentloaded', () => {
    view.oy = 0;
  });
  // Notice when the active view lands on a page meant for the other view.
  page.on('framenavigated', (f) => {
    if (f !== page.mainFrame() || s.mode !== mode) return;
    const u = f.url();
    if (/^https?:/.test(u) && wantMode(u) !== mode) s.pendingSwitch = u;
  });
  return view;
}

async function importLegacyCookies(s, ctx) {
  // Sessions from older server versions stored cookies in data/<id>.json.
  const legacy = path.join(DATA_DIR, s.id + '.json');
  if (!fs.existsSync(legacy)) return;
  try {
    const st = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    if (st.cookies && st.cookies.length) await ctx.addCookies(st.cookies);
    fs.renameSync(legacy, legacy + '.imported');
    log('imported legacy cookies', s.id);
  } catch (e) {
    log('legacy import failed', s.id, e.message);
  }
}

async function getView(s, mode) {
  if (!s[mode]) {
    s[mode] = await launchView(s, mode);
    if (mode === 'mob') await importLegacyCookies(s, s.mob.ctx);
  }
  return s[mode];
}

function active(s) {
  return s[s.mode];
}

async function switchMode(s, url) {
  const to = wantMode(url);
  const from = active(s);
  const target = await getView(s, to);
  await target.ctx.addCookies(await from.ctx.cookies()).catch(() => {});
  s.mode = to;
  s.pendingSwitch = null;
  log('switch', s.id, '->', to, url);
  target.oy = 0;
  if (to === 'desk' && wantMode(from.page.url()) === 'mob') {
    // Left via the in-page app wall: clear it so Back lands on a clean page.
    from.page.reload().catch(() => {});
  }
  await target.page.goto(toModeUrl(url, to), { waitUntil: 'domcontentloaded', timeout: 30000 })
    .catch((e) => log('switch goto', e.message));
  await sleep(800);
}

// Moving between Facebook (mobile view) and Messenger (desktop view) takes
// seconds (a browser may have to start, a page to load). Answer at once with
// X-Loading (the phone shows a splash) and switch in the background; the
// session's next request waits for it (s.chain).
function switchSoon(s, url, out) {
  if (wantMode(url) === s.mode) return switchMode(s, url);
  out.loading = wantMode(url) === 'desk' ? 'messenger' : 'facebook';
  s.pendingSwitch = null;
  inBackground(s, switchMode(s, url));
  return Promise.resolve();
}

function inBackground(s, work) {
  s.switching = work.then(() => {
    syncView(active(s));
  }).catch((e) => log('switch', e.message)).then(() => {
    s.switching = null;
  });
}

async function closeSession(s) {
  for (const m of ['mob', 'desk']) {
    if (s[m]) await s[m].ctx.close().catch(() => {});
    s[m] = null;
  }
}

async function createSession(id, w, h, zoom, ov, res) {
  const s = { id, w, h, zoom, ov, res, mode: 'mob', mob: null, desk: null, chain: Promise.resolve(), last: Date.now() };
  const v = await getView(s, 'mob');
  if (v.page.url() === 'about:blank') {
    await v.page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('goto', e.message));
  }
  log('session created', id, `${w}x${h}@${zoom}%`, res > 1 ? `res 1/${res}` : '');
  return s;
}

// Creating or relaunching a session is serialized per phone: requests can
// arrive together, and two browsers on one profile broke the login.
const sessionLocks = new Map();

function getSession(id, w, h, zoom, ov, res) {
  const prev = sessionLocks.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => openSession(id, w, h, zoom, ov, res));
  sessionLocks.set(id, next);
  next.catch(() => {}).then(() => {
    if (sessionLocks.get(id) === next) sessionLocks.delete(id);
  });
  return next;
}

async function openSession(id, w, h, zoom, ov, res) {
  let s = sessions.get(id);
  if (s && (s.w !== w || s.h !== h || s.zoom !== zoom || s.ov !== ov || s.res !== res)) {
    // Viewport changed: relaunch; profiles on disk keep the login.
    const url = active(s).page.url();
    sessions.delete(id);
    await closeSession(s);
    s = await createSession(id, w, h, zoom, ov, res);
    if (/^https?:/.test(url)) {
      s.pendingSwitch = null;
      if (wantMode(url) === 'desk') await switchMode(s, url);
      else await s.mob.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }
  if (!s) s = await createSession(id, w, h, zoom, ov, res);
  sessions.set(id, s);
  s.last = Date.now();
  if (s.mode === 'desk') s.deskUsed = s.last;
  return s;
}

// ---- Actions ----

// Wait briefly for any navigation/rendering triggered by an action.
async function settle(page, ms) {
  await Promise.race([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    sleep(4000),
  ]);
  await sleep(ms);
}

async function focusedInput(page) {
  try {
    return await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const tag = el.tagName;
      const editable = el.isContentEditable ||
        tag === 'TEXTAREA' ||
        (tag === 'INPUT' && !/^(button|submit|checkbox|radio|file|image|reset|hidden|range|color)$/i.test(el.type));
      if (!editable) return null;
      return {
        value: el.isContentEditable ? el.innerText : el.value,
        password: tag === 'INPUT' && el.type === 'password',
      };
    });
  } catch (e) {
    return null;
  }
}

async function goBack(s, out) {
  const v = active(s);
  const before = v.page.url();
  await v.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
  // The URL can change only after goBack resolves (e.g. into about:blank).
  await settle(v.page, 300);
  const noHistory = v.page.url() === before || !/^https?:/.test(v.page.url());
  if (noHistory && s.mode === 'desk' && s.mob) {
    // Leaving Messenger: return to the mobile view where we came from,
    // behind a splash.
    out.loading = 'facebook';
    s.pendingSwitch = null;
    inBackground(s, (async () => {
      await s.mob.ctx.addCookies(await v.ctx.cookies()).catch(() => {});
      s.mode = 'mob';
      const mp = s.mob.page;
      if (wantMode(mp.url()) === 'desk') {
        await mp.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        if (wantMode(mp.url()) === 'desk') await mp.goto(HOME).catch(() => {});
      }
      await settle(mp, 400);
    })());
    return;
  } else if (noHistory && !/^https?:/.test(v.page.url())) {
    // Walked back into the profile's initial about:blank.
    await v.page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }
  await settle(active(s).page, 400);
}

async function runAction(s, q) {
  const op = q.get('op') || '';
  const v = active(s);
  const page = v.page;
  // Page mode: the phone scrolls on its own; put the view where the phone's
  // is first, so its coordinates mean the same here.
  if (q.get('m') === 'p' && q.has('sy')) {
    const sy = parseInt(q.get('sy'), 10) / v.scale;
    if (s.mode === 'mob') await placeView(v, sy);
    else await page.evaluate((y) => window.__fbc && window.__fbc.paneTo(y), sy).catch(() => {});
  }
  // Client coordinates are device pixels within its view; Playwright wants
  // CSS pixels within the (overscanned) viewport.
  const x = parseInt(q.get('x') || '0', 10) / v.scale;
  const y = v.oy + parseInt(q.get('y') || '0', 10) / v.scale;
  const out = {};
  switch (op) {
    case 'click':
      // A tap on a video doesn't touch the page: the phone shows its own
      // play button instead (force=1 taps anyway).
      // A tap on a video plays it in the phone's player right away (force=1
      // taps the page anyway).
      if (!q.get('force') && await videoOffer(v, x, y)) {
        out.video = await startVideo(s, x, y);
        break;
      }
      await page.evaluate(() => window.__fbc && window.__fbc.clear()).catch(() => {});
      await page.mouse.click(x, y);
      s.clickAt = Date.now();
      await settle(page, 500);
      break;
    case 'move':
      out.scrolled = await moveFocus(v, q.get('d') || 'd');
      break;
    case 'activate': {
      // 5/FIRE: press the focused element (or offer its video).
      const t = await page.evaluate(() => (window.__fbc ? window.__fbc.target() : null)).catch(() => null);
      if (!t) break;
      if (await videoOffer(v, t.x, t.y)) {
        out.video = await startVideo(s, t.x, t.y);
        break;
      }
      await page.mouse.click(t.x, t.y);
      s.clickAt = Date.now();
      await settle(page, 500);
      break;
    }
    case 'nextvideo':
      out.video = await nextVideo(s);
      break;
    case 'prevvideo':
      out.video = await prevVideo(s);
      break;
    case 'scroll': {
      const dx = parseInt(q.get('dx') || '0', 10) / v.scale;
      let wheelDy = parseInt(q.get('dy') || '0', 10) / v.scale;
      if (v.margin > 0 && wheelDy && await scrollView(v, wheelDy)) wheelDy = 0;
      // Inner panes (Messenger lists) and the desktop view: scroll the pane
      // under the finger directly, no animation to wait for.
      if (wheelDy && await page.evaluate(([px, py, d]) => !!(window.__fbc && window.__fbc.scrollAt(px, py, d)),
        [x, y, wheelDy]).catch(() => false)) {
        wheelDy = 0;
        await sleep(40); // let lazy lists render the newly visible rows
      }
      // Wheel for sideways scrolling and scrollers that only react to wheel
      // events.
      if (dx || wheelDy) {
        await page.mouse.move(x, y);
        await page.mouse.wheel(dx, wheelDy);
        await sleep(200);
      }
      break;
    }
    case 'type': {
      // Replace the focused field's content with the given text.
      const t = q.get('t') || '';
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      if (t) await page.keyboard.insertText(t);
      await sleep(300);
      break;
    }
    case 'key':
      await page.keyboard.press(q.get('k') || 'Enter');
      await settle(page, 500);
      break;
    case 'nav': {
      let u = (q.get('u') || HOME).trim();
      if (!/^[a-z]+:\/\//i.test(u)) u = 'https://' + u;
      if (wantMode(u) !== s.mode) {
        await switchSoon(s, u, out);
      } else {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('nav', e.message));
        await settle(page, 500);
      }
      break;
    }
    case 'back':
      await goBack(s, out);
      break;
    case 'fwd':
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await settle(page, 400);
      break;
    case 'reload':
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await settle(page, 500);
      break;
    case 'home':
      if (s.mode !== 'mob') await switchSoon(s, HOME, out);
      else await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await settle(active(s).page, 500);
      break;
    case 'video':
      out.video = await startVideo(s, q.has('x') ? x : -1, q.has('y') ? y : -1);
      break;
    case 'more': {
      // Page mode, the phone is near the end of the page: scroll to the
      // bottom so infinite lists (the feed) load more, then come back.
      // Desktop view: the pane instead; top=1 for lists that load older
      // items at the top (a Messenger thread), keeping the same items in
      // view once they arrive.
      if (s.mode === 'desk') {
        // Pane position and scroll height (null without a pane).
        const state = () => page.evaluate(() => {
          const f = window.__fbc;
          const y = f ? f.scrollPos() : null;
          return f && f.paneTo(y) !== null ? { y, max: f.paneTo(1e9), back: f.paneTo(y) } : null;
        }).catch(() => null);
        const st = await state();
        if (!st) break;
        await page.evaluate((top) => window.__fbc.paneTo(top ? 0 : 1e9), !!q.get('top')).catch(() => {});
        await sleep(1500);
        const now = q.get('top') ? await state() : null;
        const grown = now ? Math.max(0, now.max - st.max) : 0;
        await page.evaluate((y) => window.__fbc.paneTo(y), st.y + grown).catch(() => {});
        break;
      }
      const top = await page.evaluate(() => scrollY).catch(() => 0) + v.oy;
      await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
        .catch(() => {});
      await sleep(1500);
      await placeView(v, top);
      break;
    }
    default:
      break; // plain screenshot
  }
  // The Messenger app wall renders a moment after the tap, so keep looking
  // for it on the frames that follow a click.
  if (!s.pendingSwitch && s.mode === 'mob' && Date.now() - (s.clickAt || 0) < 8000 &&
      await isMessengerWall(active(s).page)) {
    s.pendingSwitch = MESSENGER_URL;
  }
  // At most one view switch per request to avoid ping-pong redirects.
  if (s.pendingSwitch) await switchSoon(s, s.pendingSwitch, out);
  syncView(active(s));
  return out;
}

// ---- D-pad focus and video offers ----

// Height of the phone's view in viewport CSS px.
function viewHeightCss(v) {
  const vp = v.page.viewportSize();
  return vp ? vp.height - 2 * v.margin : 0;
}

// Scroll the phone's view by dy CSS px (overscan buffer on the mobile view,
// mouse wheel on the desktop view).
async function scrollBy(v, dy) {
  if (v.margin > 0 && await scrollView(v, dy)) return;
  const vp = v.page.viewportSize();
  await v.page.mouse.move(vp.width / 2, v.oy + viewHeightCss(v) / 2);
  await v.page.mouse.wheel(0, dy);
  await sleep(250);
}

// Returns true if the page scrolled (the phone then needs a new frame;
// otherwise only the highlight moved and no screenshot is sent).
async function moveFocus(v, d) {
  const hView = viewHeightCss(v);
  const tryMove = () => v.page.evaluate(([dd, t, b]) => (window.__fbc ? window.__fbc.move(dd, t, b) : null),
    [d, v.oy, v.oy + hView]).catch(() => null);
  let scrolled = false;
  let r = await tryMove();
  if (!r && (d === 'd' || d === 'u')) {
    // Nothing further that way in the rendered area: scroll, then retry.
    await scrollBy(v, (d === 'd' ? 1 : -1) * hView * 2 / 3);
    scrolled = true;
    r = await tryMove();
  }
  if (!r) return scrolled;
  if (v.margin === 0) {
    // Desktop view (Messenger): inner panes scroll, let the browser do it.
    await v.page.evaluate(() => window.__fbc && window.__fbc.reveal()).catch(() => {});
    const after = await v.page.evaluate(() => window.__fbc && window.__fbc.rect()).catch(() => null);
    return scrolled || !after || Math.abs(after.y - r.y) >= 1;
  }
  // Bring the focused element into the phone's view.
  const pad = 12;
  const top = v.oy;
  const bottom = v.oy + hView;
  let dy = 0;
  if (r.y < top + pad) {
    dy = r.y - top - pad;
  } else if (r.y + r.h > bottom - pad) {
    // Taller than the view: align its top instead of its bottom.
    dy = Math.min(r.y + r.h - bottom + pad, r.y - top - pad);
  }
  if (dy) {
    await scrollBy(v, dy);
    scrolled = true;
  }
  return scrolled;
}

// Video under (x, y) (viewport CSS px) as a rect in the phone's view, device px.
async function videoOffer(v, x, y) {
  const r = await v.page.evaluate(([px, py]) => (window.__fbc ? window.__fbc.videoAt(px, py) : null), [x, y])
    .catch(() => null);
  if (!r) return null;
  const k = v.scale;
  return [r.x * k, (r.y - v.oy) * k, r.w * k, r.h * k].map(Math.round).join(',');
}

// "Next" in the phone's video player: the first player on the page below the
// one played last that hasn't been played yet (by data-video-id). Its own MP4
// URL is downloaded directly, so it needn't be tapped or even on screen.
// Reel pages swipe to the next reel when the page has no other player.
async function nextVideo(s) {
  const v = active(s);
  const page = v.page;
  const vp = page.viewportSize();
  // Went back with Previous: Next replays the history first.
  const again = historyVideo(s, 1);
  if (again) return again;
  const played = s.played || (s.played = new Set());
  for (let attempt = 0; attempt < 8; attempt++) {
    const list = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('video, [data-video-id]')) {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) continue;
        const wrap = el.closest('[data-video-id]') || el.querySelector('[data-video-id]');
        const id = wrap ? wrap.getAttribute('data-video-id') : '';
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        const holder = el.closest('[data-video-url]') || el.querySelector('[data-video-url]');
        let url = holder ? holder.getAttribute('data-video-url') || '' : '';
        if (!/^https?:/.test(url)) url = /^\d+$/.test(id) ? 'https://www.facebook.com/watch/?v=' + id : '';
        out.push({ y: r.top + scrollY, id, url });
      }
      return out.sort((a, b) => a.y - b.y);
    }).catch(() => []);
    const after = s.lastVideoDocY == null ? -Infinity : s.lastVideoDocY;
    const fresh = list.filter((p) => p.url && !(p.id && played.has(p.id)));
    // Below the last one; or, for players stacked at the same place (reels),
    // any unplayed one that isn't above it.
    const next = fresh.find((p) => p.y > after + 10) || fresh.find((p) => p.id && p.y >= after - 10);
    log('nextvideo', s.id, 'players', list.length, 'unplayed', fresh.length, '->', next ? next.id || 'url' : 'none');
    if (next) {
      if (next.id) played.add(next.id);
      s.lastVideoDocY = next.y;
      // Scroll the page to it too, so closing the player shows where we are.
      const sy = await page.evaluate(() => scrollY).catch(() => 0);
      await scrollBy(v, next.y - (sy + v.oy) - 20);
      return playVideo(s, next.url, next.y);
    }
    const before = page.url();
    if (/\/reel\//.test(before)) {
      // Swipe to the next reel.
      await page.mouse.move(vp.width / 2, v.oy + viewHeightCss(v) / 2);
      await page.mouse.wheel(0, viewHeightCss(v));
      await sleep(1500);
      if (page.url() === before) {
        await page.keyboard.press('ArrowDown');
        await sleep(1500);
      }
      if (page.url() !== before) return startVideo(s, -1, -1);
    } else {
      // Feed videos are created as they come near: look further down
      // (Facebook loads more posts as the page scrolls).
      await scrollBy(v, viewHeightCss(v) * 2);
      await sleep(1000);
    }
  }
  return { err: 'No next video' };
}

// Low-resolution frames (2/3, 1/2) are scaled up on the phone, which
// magnifies JPEG artifacts; they have far fewer pixels, so a higher quality
// is cheap.
const HALF_RES_MIN_QUALITY = 80;

// Text mode (m=t): the screenshot is taken with text glyphs hidden and the
// lines from __fbc.textDump go alongside, for the phone to draw. Only the
// glyph fill: SVG icons drawn with currentColor and pseudo-element icons
// keep their colour.
const HIDE_TEXT_CSS = '*, ::placeholder { -webkit-text-fill-color: transparent !important; ' +
  'text-shadow: none !important; caret-color: transparent !important; } ' +
  '*::before, *::after { -webkit-text-fill-color: currentColor !important; }';

// Text lines (viewport CSS px) -> "x y w h size flags rrggbb text" per line,
// tab separated, in image (phone) px.
function encodeText(lines, scale) {
  return lines.map((l) => {
    const n = l.slice(0, 5).map((v) => Math.round(v * scale));
    return [...n, l[5], l[6].toString(16), String(l[7]).normalize('NFC').replace(/[\t\r\n]/g, ' ')].join('\t');
  }).join('\n');
}

// Page mode commands (see pageDump) -> one tab-separated line each; fields
// 1-5 are lengths, scaled to phone px.
function encodePage(lines, scale) {
  return lines.map((l) => l.map((f, i) => {
    if (i >= 1 && i <= 5) return Math.round(f * scale);
    // NFC: the phone's bitmap fonts have precomposed Vietnamese letters,
    // not combining accents.
    return typeof f === 'string' ? f.normalize('NFC').replace(/[\t\r\n]/g, ' ') : f;
  }).join('\t')).join('\n');
}

// Image recipes from pageDump by key, for /img. Oldest dropped first.
const MAX_RECIPES = 4000;
function addRecipes(s, recipes) {
  if (!s.recipes) s.recipes = new Map();
  for (const k of Object.keys(recipes)) {
    s.recipes.delete(k);
    s.recipes.set(k, recipes[k]);
  }
  while (s.recipes.size > MAX_RECIPES) s.recipes.delete(s.recipes.keys().next().value);
}

// ---- Page mode images ----
//
// The phone asks for the images near its view by key (/img?k=a,b,c). A tab
// of the phone's own mobile browser (one more renderer, not another
// browser) draws each recipe alone at its size and the phone's scale,
// packed into two sheets: PNG with transparency (icons, avatars, SVG) and
// JPEG (photos). The phone cuts them apart and caches them, so an icon or
// avatar crosses the network once.

// Sheet size limit in phone px: what an old phone can decode at once.
const SHEET_MAX_PX = 400000;

async function imgPage(s) {
  const v = s.mob;
  if (!v.img) {
    const ip = { page: null, chain: Promise.resolve() };
    v.img = ip;
    v.opening = true; // the popup handler must leave this tab alone
    ip.ready = v.ctx.newPage().then((p) => {
      ip.page = p;
      v.helper = p;
    }).finally(() => {
      v.opening = false;
    });
    ip.ready.catch(() => {
      if (v.img === ip) v.img = null;
    });
  }
  await v.img.ready;
  return v.img;
}

// Shelf packing from y0: sets it.px/it.py (CSS px) and stops before the
// sheet would exceed SHEET_MAX_PX (the phone asks for the rest later).
function packSheet(items, width, y0, scale) {
  let x = 0;
  let y = y0;
  let rowH = 0;
  const placed = [];
  for (const it of items) {
    if (x > 0 && x + it.w > width) {
      x = 0;
      y += rowH + 1;
      rowH = 0;
    }
    if ((y - y0 + it.h) * width * scale * scale > SHEET_MAX_PX && placed.length) break;
    it.px = x;
    it.py = y;
    x += it.w + 1;
    rowH = Math.max(rowH, it.h);
    placed.push(it);
  }
  return { placed, bottom: y + rowH };
}

async function renderImages(s, items, allPng, quality) {
  const ip = await imgPage(s);
  const scale = s.mob.scale;
  // The tab renders at scale / res device px per CSS px; zoom makes up for
  // the lower resolution, so images still come out at phone px.
  const z = s.res;
  const job = ip.chain.then(async () => {
    const width = Math.max(320, ...items.map((it) => it.w));
    const png = packSheet(items.filter((it) => allPng || it.alpha), width, 0, scale);
    const jpgTop = png.bottom + 2;
    const jpg = packSheet(items.filter((it) => !allPng && !it.alpha), width, jpgTop, scale);
    const all = png.placed.concat(jpg.placed);
    if (!all.length) return null;
    const html = all.map((it) => `<div style="position:absolute;left:${it.px}px;top:${it.py}px;` +
      `width:${it.w}px;height:${it.h}px;overflow:hidden">${it.html}</div>`).join('');
    await ip.page.setViewportSize({ width: Math.ceil(width * z), height: Math.max(1, Math.ceil((jpg.bottom + 1) * z)) });
    // The tab is a mobile one: without a viewport tag it would lay out
    // 980 px wide and shrink to fit.
    await ip.page.setContent(`<html style="zoom:${z}"><head><meta name="viewport" ` +
      `content="width=device-width,initial-scale=1"></head><body style="margin:0;background:transparent">${html}</body></html>`,
      { waitUntil: 'load', timeout: 8000 }).catch(() => {});
    const shot = async (list, top, bottom, type) => {
      if (!list.length) return Buffer.alloc(0);
      const opts = { type, clip: { x: 0, y: top * z, width: width * z, height: (bottom - top) * z }, timeout: 15000 };
      if (type === 'png') opts.omitBackground = true;
      else opts.quality = quality;
      return ip.page.screenshot(opts);
    };
    const pngBuf = await shot(png.placed, 0, png.bottom, 'png');
    const jpgBuf = await shot(jpg.placed, jpgTop, jpg.bottom, 'jpeg');
    // "key sheet x y w h" (phone px within the sheet), sheet 0 = PNG, 1 = JPEG.
    const r = (n) => Math.round(n * scale);
    const lines = png.placed.map((it) => [it.k, 0, r(it.px), r(it.py), r(it.w), r(it.h)])
      .concat(jpg.placed.map((it) => [it.k, 1, r(it.px), r(it.py - jpgTop), r(it.w), r(it.h)]));
    return { text: Buffer.from(lines.map((l) => l.join('\t')).join('\n'), 'utf8'), pngBuf, jpgBuf };
  });
  ip.chain = job.catch(() => {});
  return job;
}

async function serveImages(res, q) {
  const s = sessions.get((q.get('id') || '').replace(/[^A-Za-z0-9_-]/g, ''));
  const keys = (q.get('k') || '').split(',').filter(Boolean).slice(0, 24);
  const items = s && s.recipes && s.mob
    ? keys.map((k) => s.recipes.get(k) && { k, ...s.recipes.get(k) }).filter(Boolean) : [];
  if (s) s.last = Date.now();
  // Keys the server has no recipe for (expired, other session): the phone
  // stops asking. Known ones left out of a full sheet come next time.
  const unknown = keys.filter((k) => !(s && s.recipes && s.recipes.has(k))).join(',');
  const quality = Math.min(Math.max(parseInt(q.get('q') || '75', 10), 10), 95);
  const r = items.length ? await renderImages(s, items, q.get('f') === 'png', quality).catch((e) => {
    log('img', e.message);
    return null;
  }) : null;
  if (!r) {
    res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Unknown': unknown });
    return res.end();
  }
  const body = Buffer.concat([r.text, r.pngBuf, r.jpgBuf]);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': body.length,
    // Byte lengths of the index text, the PNG sheet and the JPEG sheet.
    'X-Sheets': [r.text.length, r.pngBuf.length, r.jpgBuf.length].join(','),
    'X-Unknown': unknown,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function isMessengerWall(page) {
  return page.evaluate((re) => new RegExp(re, 'i').test(
    document.body ? document.body.innerText.normalize('NFC') : ''), MESSENGER_WALL.source.normalize('NFC'))
    .catch(() => false);
}

// A new page starts with the phone's view at the top of the viewport.
function syncView(v) {
  const u = v.page.url();
  if (u !== v.lastUrl) {
    v.lastUrl = u;
    v.oy = 0;
  }
  v.oy = Math.max(0, Math.min(v.oy, 2 * v.margin));
}

// Move the phone's view by dy CSS px: shift it inside the overscan buffer,
// then scroll the window so the view is centred in the buffer again.
// Returns false if nothing moved.
async function scrollView(v, dy) {
  const st = await scrollState(v.page);
  return st ? placeView(v, st.sy + v.oy + dy, st) : false;
}

function scrollState(page) {
  return page.evaluate(() => ({
    sy: window.scrollY,
    max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  })).catch(() => null);
}

// Put the phone's view at document y viewTop (CSS px), centred in the
// overscan buffer where the page allows. Returns false if nothing moved.
async function placeView(v, viewTop, st) {
  const page = v.page;
  const m = v.margin;
  if (!st) st = await scrollState(page);
  if (!st) return false;
  const target = Math.max(0, Math.min(st.max, viewTop - m));
  if (Math.abs(target - st.sy) >= 1) {
    await page.evaluate((t) => window.scrollTo({ top: t, behavior: 'instant' }), target).catch(() => {});
    await sleep(120);
  }
  const sy = await page.evaluate(() => window.scrollY).catch(() => st.sy);
  const oy = Math.max(0, Math.min(viewTop - sy, 2 * m));
  const moved = (sy + oy) - (st.sy + v.oy);
  v.oy = oy;
  return Math.abs(moved) >= 1;
}

// ---- Video ----

// Find the video under (x, y) or the most visible one; returns a URL that
// yt-dlp can download (direct MP4 or a Facebook video permalink).
async function findVideo(page, x, y) {
  return page.evaluate(([px, py]) => {
    const vids = Array.from(document.querySelectorAll('video, [data-video-id]'));
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let best = null;
    let bestScore = -1;
    let bestHit = false;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      const visible = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)) *
        Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      if (visible <= 0) continue;
      const hit = px >= 0 && px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
      const score = (hit ? 1e9 : 0) + visible;
      if (score > bestScore) {
        bestScore = score;
        best = v;
        bestHit = hit;
      }
    }
    const linkRe = /\/(videos|watch|reel|story\.php|video\.php)/;
    let link = null;
    let el = best || (px >= 0 ? document.elementFromPoint(px, py) : null);
    for (let n = el; n && !link; n = n.parentElement) {
      if (n.tagName === 'A' && linkRe.test(n.href)) link = n.href;
      if (!link && n.querySelector) {
        const a = n.querySelector('a[href*="/videos/"], a[href*="/watch"], a[href*="/reel/"]');
        if (a && n !== document.body) link = a.href;
      }
    }
    // m.facebook.com puts the progressive MP4 and the video id on the player
    // wrapper (data-video-url / data-video-id); the <video> itself has a blob.
    let dataUrl = '';
    let videoId = '';
    for (let n = best, d = 0; n && d < 8 && !dataUrl; n = n.parentElement, d++) {
      const u = n.getAttribute && n.getAttribute('data-video-url');
      const id = n.getAttribute && n.getAttribute('data-video-id');
      if (u && /^https?:/.test(u)) dataUrl = u;
      if (id && !videoId) videoId = id;
      if (!link && id && /^\d+$/.test(id)) link = 'https://www.facebook.com/watch/?v=' + id;
    }
    let src = best ? (best.currentSrc || best.src || '') : '';
    if (!/^https?:/.test(src)) src = dataUrl;
    return {
      src,
      link,
      page: linkRe.test(location.href) ? location.href : '',
      hit: bestHit,
      id: videoId,
      docY: best ? best.getBoundingClientRect().top + scrollY : null,
    };
  }, [x, y]).catch(() => ({}));
}

// Top-level boxes of a (possibly still downloading) MP4: where moov ends and
// the video size, or null if moov isn't complete yet or comes after mdat
// (then the file can't be played before it is complete).
function mp4Head(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const hdr = Buffer.alloc(16);
    let pos = 0;
    for (let i = 0; i < 32 && pos + 8 <= size; i++) {
      fs.readSync(fd, hdr, 0, 16, pos);
      let len = hdr.readUInt32BE(0);
      const type = hdr.toString('latin1', 4, 8);
      if (len === 1) len = Number(hdr.readBigUInt64BE(8));
      if (len === 0) len = size - pos;
      if (len < 8) return null;
      if (type === 'mdat') return null;
      if (type === 'moov') {
        if (pos + len > size || len > 32 << 20) return null;
        const moov = Buffer.alloc(len);
        fs.readSync(fd, moov, 0, len, pos);
        const wh = tkhdSize(moov);
        return { size, moovEnd: pos + len, w: wh ? wh[0] : 0, h: wh ? wh[1] : 0 };
      }
      pos += len;
    }
  } catch (e) {
    // unreadable / incomplete
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

// First video track size (tkhd box) found in buffer b, or null.
function tkhdSize(b) {
  let i = 3;
  while ((i = b.indexOf('tkhd', i + 1)) > 3) {
    const end = i - 4 + b.readUInt32BE(i - 4);
    if (end > b.length || end - i < 80) continue;
    const w = b.readUInt32BE(end - 8) >>> 16;
    const h = b.readUInt32BE(end - 4) >>> 16;
    if (w && h) return [w, h];
  }
  return null;
}

// Width and height of an MP4's video track (tkhd box), or null. The phone
// uses them to fit the video to the screen with the right aspect ratio.
function mp4Size(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const chunk = 2 << 20;
    // moov is usually at the front (progressive), else at the end.
    for (const pos of [0, Math.max(0, size - chunk)]) {
      const b = Buffer.alloc(Math.min(chunk, size - pos));
      fs.readSync(fd, b, 0, b.length, pos);
      const wh = tkhdSize(b);
      if (wh) return wh;
    }
  } catch (e) {
    // unreadable: no size
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

async function writeCookieFile(ctx, file) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of await ctx.cookies()) {
    const domain = c.domain;
    lines.push([
      domain, domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path, c.secure ? 'TRUE' : 'FALSE',
      Math.max(0, Math.round(c.expires || 0)), c.name, c.value,
    ].join('\t'));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

async function startVideo(s, x, y) {
  const v = active(s);
  let info = await findVideo(v.page, x, y);
  let opened = false;
  if (!info.src && !info.link && !info.page && x >= 0) {
    // Feed videos often load their source only after being tapped (a reel
    // post opens the reel page).
    const before = v.page.url();
    await v.page.mouse.click(x, y);
    await settle(v.page, 1500);
    info = await findVideo(active(s).page, x, y);
    opened = active(s).page.url() !== before && /\/reel\//.test(active(s).page.url()) && !/\/reel\//.test(before);
  }
  // A tapped video's own MP4/link beats the page URL (a video page lists
  // others). The direct MP4 is what Facebook itself plays on mobile.
  const url = info.hit ? (info.src || info.link || info.page) : (info.page || info.src || info.link);
  if (opened) {
    // Back to the feed, which stays where it was under the player.
    await active(s).page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await settle(active(s).page, 300);
  }
  if (!url) return { err: 'No video found here' };
  if (info.docY != null && !opened) s.lastVideoDocY = info.docY;
  if (info.id) (s.played || (s.played = new Set())).add(info.id);
  return playVideo(s, url, opened ? null : info.docY);
}

// Plays url and records it in the session's history (s.history, s.histPos:
// the one playing), so the player's Previous/Next can walk back and forth.
function playVideo(s, url, docY) {
  const h = s.history || (s.history = []);
  s.history = h.slice(0, (s.histPos == null ? -1 : s.histPos) + 1);
  s.history.push({ url, docY });
  if (s.history.length > 50) s.history.shift();
  s.histPos = s.history.length - 1;
  return downloadVideo(s, url);
}

// Previous / Next within the history (downloads are cached for a day).
function historyVideo(s, step) {
  const pos = (s.histPos == null ? -1 : s.histPos) + step;
  if (!s.history || pos < 0 || pos >= s.history.length) return null;
  s.histPos = pos;
  const it = s.history[pos];
  if (it.docY != null) s.lastVideoDocY = it.docY;
  return downloadVideo(s, it.url);
}

async function prevVideo(s) {
  return historyVideo(s, -1) || { err: 'No previous video' };
}

// Starts (or reuses) the yt-dlp download of url. The file is written in
// place, so the phone can start playing it while it downloads; a ".done"
// marker is written once it is complete.
async function downloadVideo(s, url) {
  const key = crypto.createHash('md5').update(url.replace(/[?&](_rdr|refsrc|ref)=[^&]*/g, '')).digest('hex').slice(0, 16);
  const file = path.join(VIDEO_DIR, key + '.mp4');
  if (fs.existsSync(file + '.done')) return { key };
  const running = videoJobs.get(key);
  if (running && running.state !== 'err') return { key };

  const job = { state: 'dl', pct: 0, msg: '', url };
  videoJobs.set(key, job);
  fs.rmSync(file, { force: true }); // leftover of an interrupted download
  const cookies = path.join(VIDEO_DIR, key + '.cookies.txt');
  await writeCookieFile(active(s).ctx, cookies);
  // Prefer the progressive SD stream (H.264 + AAC in one file, no ffmpeg needed).
  const args = [
    ...(PROXY ? ['--proxy', PROXY] : []),
    '--cookies', cookies, '--no-playlist', '--newline', '--no-part',
    '-f', 'sd/b[height<=?480][ext=mp4]/b[ext=mp4]/b',
    ...YTDLP_EXTRA_ARGS,
    '-o', file, url,
  ];
  log('video', key, url);
  const p = spawn(YTDLP, args, { windowsHide: true });
  let errText = '';
  // Keep the tail of both streams: the reason for a failure can be on either.
  p.stdout.on('data', (d) => {
    const text = d.toString();
    const m = /\[download\]\s+([\d.]+)%/.exec(text);
    if (m) job.pct = Math.floor(parseFloat(m[1]));
    errText = (errText + text).slice(-600);
  });
  p.stderr.on('data', (d) => {
    errText = (errText + d.toString()).slice(-600);
  });
  p.on('error', (e) => {
    job.state = 'err';
    job.msg = 'yt-dlp: ' + e.message;
  });
  p.on('close', (code) => {
    fs.rm(cookies, () => {});
    if (code === 0 && fs.existsSync(file)) {
      fs.writeFileSync(file + '.done', '');
      job.state = 'ready';
      job.pct = 100;
      log('video ready', key, fs.statSync(file).size, 'bytes');
    } else {
      job.state = 'err';
      const lines = errText.split('\n').map((l) => l.trim()).filter(Boolean);
      job.msg = (lines.filter((l) => /ERROR/.test(l)).pop() || lines.pop() || `yt-dlp exit ${code}`).slice(0, 160);
      log('video failed', key, `exit ${code}:`, job.msg);
    }
  });
  return { key };
}

// Bytes after the MP4 header that must be downloaded before playback starts.
const STREAM_START = 128 * 1024;

function videoStatus(key) {
  const file = path.join(VIDEO_DIR, key + '.mp4');
  if (fs.existsSync(file + '.done')) {
    const wh = mp4Size(file);
    return wh ? `ready ${wh[0]} ${wh[1]}` : 'ready';
  }
  const j = videoJobs.get(key);
  if (!j) return 'err unknown video';
  if (j.state === 'dl') {
    // Playable while downloading once the header (moov) is complete:
    // Facebook's progressive MP4s have it at the front.
    const head = mp4Head(file);
    if (head && head.size >= head.moovEnd + STREAM_START) {
      log('video streamable', key, head.size, 'bytes');
      return head.w ? `ready ${head.w} ${head.h}` : 'ready';
    }
    return 'dl ' + j.pct;
  }
  return 'err ' + j.msg;
}

// While the download runs, send the file as it grows: HTTP/1.0 without a
// length (the body ends when the socket closes), so playback starts right
// away. Seeking works once the download is complete (Range below).
function streamGrowingVideo(req, file, job) {
  const sock = req.socket;
  sock.setNoDelay(true);
  sock.write('HTTP/1.0 200 OK\r\nContent-Type: video/mp4\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n');
  if (req.method === 'HEAD') return sock.end();
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(64 * 1024);
  let pos = 0;
  let finished = false;
  const finish = (endSocket) => {
    if (finished) return;
    finished = true;
    fs.close(fd, () => {});
    if (endSocket) sock.end();
  };
  sock.on('close', () => finish(false));
  const pump = () => {
    if (finished) return;
    let n = 0;
    try {
      n = fs.readSync(fd, buf, 0, buf.length, pos);
    } catch (e) {
      return finish(true);
    }
    if (n > 0) {
      pos += n;
      // Copy: buf is reused while the socket may still hold the data.
      if (sock.write(Buffer.from(buf.subarray(0, n)))) setImmediate(pump);
      else sock.once('drain', pump);
    } else if (job.state === 'dl') {
      setTimeout(pump, 200); // wait for more data
    } else {
      finish(true); // download finished (or failed)
    }
  };
  pump();
}

// Serve a downloaded MP4 with Range support (needed by phone media players).
function serveVideo(req, res, key) {
  const file = path.join(VIDEO_DIR, key + '.mp4');
  if (!/^[0-9a-f]{16}$/.test(key) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  if (!fs.existsSync(file + '.done')) {
    const job = videoJobs.get(key);
    if (job && job.state === 'dl') return streamGrowingVideo(req, file, job);
    res.writeHead(404);
    return res.end();
  }
  const size = fs.statSync(file).size;
  let start = 0;
  let end = size - 1;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };
  if (m) {
    if (m[1]) start = parseInt(m[1], 10);
    if (m[2]) end = Math.min(parseInt(m[2], 10), size - 1);
    if (!m[1] && m[2]) start = Math.max(0, size - parseInt(m[2], 10));
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(m ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

// ---- HTTP ----

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const q = u.searchParams;
  if (u.pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (TOKEN && q.get('key') !== TOKEN) {
    res.writeHead(403);
    return res.end('bad key');
  }
  const vm = /^\/v\/([0-9a-f]+)\.mp4$/.exec(u.pathname);
  if (vm) return serveVideo(req, res, vm[1]);
  if (u.pathname === '/img') return serveImages(res, q);
  if (u.pathname === '/vs') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end(videoStatus(q.get('k') || ''));
  }
  if (u.pathname !== '/a') {
    res.writeHead(404);
    return res.end();
  }
  const id = (q.get('id') || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) {
    res.writeHead(400);
    return res.end('missing id');
  }
  if (q.get('op') === 'bye') {
    // The phone's app is exiting: free its browsers now rather than after
    // IDLE_MIN (the login stays in its profile on disk).
    await closeSessionNow(id);
    res.writeHead(204);
    return res.end();
  }
  const w = Math.min(Math.max(parseInt(q.get('w') || '240', 10), 96), 1080);
  const h = Math.min(Math.max(parseInt(q.get('h') || '320', 10), 96), 1920);
  const zoom = Math.min(Math.max(parseInt(q.get('z') || '100', 10), 25), 200);
  const fmt = q.get('f') === 'png' ? 'png' : 'jpeg';
  const quality = Math.min(Math.max(parseInt(q.get('q') || '75', 10), 10), 95);
  // Overscan % of the view height added above and below (0 = old clients).
  const ov = Math.min(Math.max(parseInt(q.get('ov') || '0', 10), 0), 100);
  // Render resolution divisor: 1 = full, 1.5 = 2/3, 2 = half per side
  // (slow phones; the phone scales the image back up).
  const rs = { 2: 2, 1.5: 1.5 }[q.get('r')] || 1;
  const lastHash = q.get('hash') || '';

  const s = await getSession(id, w, h, zoom, ov, rs);
  // Serialize actions per session.
  const job = s.chain.then(async () => {
    const out = await runAction(s, q);
    const v = active(s);
    const page = v.page;
    const pageMode = q.get('m') === 'p';
    // D-pad focus rect in image (tall viewport) device px, or in document
    // px in page mode; the phone draws it.
    const fr = await page.evaluate(() => {
      const r = window.__fbc ? window.__fbc.rect() : null;
      return r && { ...r, sy: window.__fbc.scrollPos() };
    }).catch(() => null);
    const focus = fr ? [fr.x, pageMode ? fr.y + fr.sy : fr.y, fr.w, fr.h].map((n) => Math.round(n * v.scale)).join(',') : '';
    // A focus move that didn't scroll changes nothing on screen: skip the
    // screenshot (the slowest part, especially on a NAS).
    let img = null;
    let text = null;
    let pg = null;
    let same = false;
    let dumpKey = null;
    if (pageMode && (q.get('op') !== 'move' || out.scrolled)) {
      // Nothing changed since the dump the phone has: no need to dump again.
      const key = await page.evaluate(() => (window.__fbc ? window.__fbc.dumpKey() : null)).catch(() => null);
      dumpKey = key && [v.mode, key, v.oy, viewHeightCss(v)].join(':');
      same = !!dumpKey && dumpKey === s.dumpKey && !!lastHash && lastHash === s.dumpHash;
    }
    if (pageMode && !same && (q.get('op') !== 'move' || out.scrolled)) {
      const d = await page.evaluate(([oy, vh, desk]) => (window.__fbc ? window.__fbc.pageDump(oy, vh, desk) : null),
        [v.oy, viewHeightCss(v), v.mode === 'desk']).catch((e) => log('pageDump', e.message));
      if (d) {
        s.dumpKey = dumpKey;
        const k = v.scale;
        addRecipes(s, d.recipes);
        pg = {
          body: Buffer.from(encodePage(d.lines, k), 'utf8'),
          range: [d.top, d.bottom, d.height].map((n) => Math.round(n * k)).join(',') + ',' + d.bg +
            (d.pane ? ',' + d.pane.map((n) => Math.round(n * k)).join(',') : ''),
          sy: Math.round((d.sy + v.oy) * k),
        };
      }
    }
    if (!pg && !same && (q.get('op') !== 'move' || out.scrolled)) {
      const opts = { type: fmt, timeout: 15000 };
      if (fmt === 'jpeg') opts.quality = s.res > 1 ? Math.max(quality, HALF_RES_MIN_QUALITY) : quality;
      // Text mode, also where page mode couldn't dump the page.
      if (q.get('m') === 't' || pageMode) {
        const lines = await page.evaluate(() => (window.__fbc ? window.__fbc.textDump() : null)).catch(() => null);
        if (lines) {
          text = Buffer.from(encodeText(lines, v.scale), 'utf8');
          opts.style = HIDE_TEXT_CSS;
        }
      }
      // The page may be reloading under a background view switch.
      img = await page.screenshot(opts).catch((e) => log('screenshot', e.message));
    }
    const pressed = (q.get('op') === 'click' || q.get('op') === 'activate') && !out.offer;
    const input = pressed ? await focusedInput(page) : null;
    return { img, text, pg, input, out, focus, url: page.url(), oy: Math.round(v.oy * v.scale) };
  });
  // A view switch started by this request finishes before the next one.
  s.chain = job.catch(() => {}).then(() => s.switching);
  const { img, text, pg, input, out, focus, url, oy } = await job;

  let hash = lastHash;
  if (pg) {
    hash = crypto.createHash('md5').update(pg.body).update(pg.range + ':' + pg.sy).digest('hex').slice(0, 12);
    s.dumpHash = hash;
  }
  else if (img) hash = crypto.createHash('md5').update(img).update(String(oy)).update(text || '-').digest('hex').slice(0, 12);
  const headers = {
    'X-Url': encodeURIComponent(url),
    'X-Hash': hash,
    // Where the phone's view starts inside the (taller) image, device px.
    'X-Oy': String(oy),
    // "x,y,w,h" of the D-pad focus in the image, device px ("" = none).
    'X-Focus': focus,
    'Cache-Control': 'no-store',
  };
  if (input) {
    headers['X-Input'] = input.password ? 'p' : '1';
    headers['X-Value'] = encodeURIComponent(input.value || '');
  }
  // Messenger is opening in the background: the phone shows a splash.
  if (out.loading) headers['X-Loading'] = out.loading;
  // Tap landed on a video: phone shows a play button over this rect.
  if (out.offer) headers['X-Video-Offer'] = out.offer;
  if (out.video) {
    if (out.video.key) headers['X-Video'] = out.video.key;
    else headers['X-Video-Err'] = encodeURIComponent(out.video.err);
  }
  if (pg) {
    // Page mode: "top,bottom,height,bg" of the stretch sent (document px)
    // and where the phone's view is now.
    headers['X-Page'] = pg.range;
    headers['X-Sy'] = String(pg.sy);
  }
  if ((!img && !pg) || hash === lastHash) {
    res.writeHead(204, headers);
    return res.end();
  }
  if (pg) {
    headers['Content-Type'] = 'text/plain; charset=utf-8';
    headers['Content-Length'] = pg.body.length;
    res.writeHead(200, headers);
    return res.end(pg.body);
  }
  let body = img;
  if (text) {
    // Text mode: the text lines (UTF-8) come first, then the image.
    headers['X-Text'] = String(text.length);
    body = Buffer.concat([text, img]);
  }
  headers['Content-Type'] = text ? 'application/octet-stream' : 'image/' + fmt;
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(body);
}

async function closeSessionNow(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  await s.chain.catch(() => {}); // let a running action finish first
  await closeSession(s);
  log('session closed (bye)', id);
}

async function reapIdle() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.last > IDLE_MS) {
      sessions.delete(id);
      await closeSession(s);
      log('session closed (idle)', id);
    } else if (s.desk && s.mode === 'mob' && !s.switching && now - (s.deskUsed || 0) > DESK_IDLE_MS) {
      // Between requests (s.chain), and only if still unused by then.
      s.chain = s.chain.then(async () => {
        if (!s.desk || s.mode !== 'mob' || s.switching || Date.now() - (s.deskUsed || 0) <= DESK_IDLE_MS) return;
        const d = s.desk;
        s.desk = null;
        await d.ctx.close().catch(() => {});
        log('messenger browser closed (idle)', id);
      }).catch(() => {});
    }
  }
  // Drop cached videos older than a day.
  for (const f of fs.readdirSync(VIDEO_DIR)) {
    const p = path.join(VIDEO_DIR, f);
    if (now - fs.statSync(p).mtimeMs > 86400000) fs.rm(p, () => {});
  }
}

async function shutdown() {
  log('shutting down');
  for (const s of sessions.values()) await closeSession(s);
  process.exit(0);
}

setInterval(() => reapIdle().catch((e) => log('reap', e.message)), 60000);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
http.createServer((req, res) => {
  const t0 = Date.now();
  handle(req, res)
    .then(() => log(req.method, req.url.slice(0, 120), res.statusCode, Date.now() - t0 + 'ms'))
    .catch((e) => {
      log('error', e.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('error: ' + e.message);
    });
}).listen(PORT, '0.0.0.0', () => log(`listening on :${PORT}, proxy ${PROXY || 'none (direct)'}, channel ${CHANNEL || 'chromium'}`));
