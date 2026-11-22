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
// Likewise the mobile browser while the phone stays in its chat screen.
const MOB_IDLE_MS = parseInt(process.env.MOB_IDLE_MIN || '2', 10) * 60000;
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

// Injected into every page (addInitScript): blocks inline
// video playback, hides "open the app" buttons and provides D-pad focus
// navigation (window.__fbc, used by op=move / op=activate / click).
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
  // Only m.facebook.com shows them. Run when the page changed, at most every
  // 700 ms: a plain interval re-read every button of every page (Messenger's
  // included) forever, which kept the CPU busy with nobody using it.
  if (/(^|\.)m\.facebook\.com$/.test(location.hostname)) {
    let due = false;
    const run = () => {
      due = false;
      hideAppButtons();
    };
    new MutationObserver(() => {
      if (!due) {
        due = true;
        setTimeout(run, 700);
      }
    }).observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', hideAppButtons);
  }

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

  // Page mode tap at (x, y), y from the top of the phone's view (CSS px):
  // the viewport y of a pinned (position: fixed) bar the phone draws there,
  // or null. pageDump puts top bars at their viewport y and bottom bars at
  // the bottom of the phone's view, while the viewport is taller
  // (overscan), so such taps don't land at view offset + y.
  const pinnedAt = (x, y, viewH) => {
    const fixedOf = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (getComputedStyle(n).position === 'fixed') return n;
      }
      return null;
    };
    const top = fixedOf(document.elementFromPoint(x, y));
    if (top && !atViewportBottom(top)) return y;
    const by = y + innerHeight - viewH;
    if (by < innerHeight) {
      const bottom = fixedOf(document.elementFromPoint(x, by));
      if (bottom && atViewportBottom(bottom)) return by;
    }
    return null;
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

  // ---- Feed view (the phone's own News Feed screen) ----
  //
  // m.facebook.com's feed is a Bloks "weblite" screen: each post is a block
  // with data-tracking-duration-id made of MContainer / TextArea / ImageArea
  // parts, with obfuscated or no class names. A post is read by its layout:
  // a round avatar and a bold title line at the top, small grey meta text
  // beside it, the body text, media (big images, videos) and a row of equal
  // buttons at the bottom (Like, Comment, Share), each with its count.
  const FEED_SEL = '[data-tracking-duration-id]';
  // Private-use characters: Facebook's icon font (privacy globe, verified
  // badge, button icons), BMP and planes 15/16.
  const PUA = /[-]|[\uDB80-\uDBFF][\uDC00-\uDFFF]/g;
  const MORE = /^(?:\.\.\.|…)?\s*(?:Xem thêm|See more)$/i;
  const flat = (s) => s.replace(PUA, '').replace(/\s+/g, ' ').trim();
  const feedBlocks = () => Array.from(document.querySelectorAll(FEED_SEL))
    .filter((el) => !(el.parentElement && el.parentElement.closest(FEED_SEL)));
  const feedBlock = (k) => feedBlocks().find((el) => {
    const s = readPost(el, null);
    return s && s.k === k;
  });
  const feedParts = (el) => {
    const R = el.getBoundingClientRect();
    const imgs = Array.from(el.querySelectorAll('img')).map((im) => ({ im, r: im.getBoundingClientRect() }))
      .filter((o) => o.r.width >= 2 && o.r.height >= 2);
    const avatar = imgs.find((o) => o.r.top - R.top < 90 && o.r.width >= 24 && o.r.width <= 64 &&
      Math.abs(o.r.width - o.r.height) < 4);
    const headBottom = avatar ? avatar.r.bottom - R.top + 6 : 64;
    // The bottom row: two or more wide buttons of the same height.
    const buttons = Array.from(el.querySelectorAll('[role="button"]'))
      .map((b) => ({ b, r: b.getBoundingClientRect() }))
      .filter((o) => o.r.height >= 26 && o.r.height <= 60 && o.r.width >= R.width / 5 && o.r.bottom > R.bottom - 80);
    const row = buttons.length ? buttons.filter((o) => Math.abs(o.r.top - buttons[buttons.length - 1].r.top) < 4) : [];
    row.sort((a, b) => a.r.left - b.r.left);
    const footTop = row.length >= 2 ? row[0].r.top - R.top : R.height;
    return { R, imgs, avatar, headBottom, footer: row.length >= 2 ? row.map((o) => o.b) : [], footTop };
  };
  const imgHtml = (im, round) => {
    const src = im.currentSrc || im.src || '';
    if (!src || /^data:image\/gif/.test(src)) return '';
    const tag = `<img src="${attr(src)}" style="display:block;width:100%;height:100%;object-fit:cover">`;
    return round ? `<div style="width:100%;height:100%;border-radius:50%;overflow:hidden">${tag}</div>` : tag;
  };
  // Big images and videos of a post below its header, above its buttons,
  // on screen sideways (not the rest of a carousel).
  const feedMedia = (p) => p.imgs.filter((o) => o !== p.avatar && o.r.width >= 100 && o.r.height >= 60 &&
    o.r.top - p.R.top >= p.headBottom - 8 && o.r.top - p.R.top < p.footTop &&
    o.r.left - p.R.left < p.R.width - 40 && o.r.right - p.R.left > 40).slice(0, 4);
  // One post, or null if el is not one. recipe(html, w, h, alpha) -> key
  // registers images; null when only the key (k) is needed. The key is made
  // from the content: data-tracking-duration-id changes as the feed scrolls.
  const readPost = (el, recipe) => {
    const p = feedParts(el);
    const { R } = p;
    if (R.height < 60 || R.width < 200) return null;
    // Text runs in DOM order, grouped by their TextArea.
    const runs = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.data.trim()) continue;
      const pe = n.parentElement;
      const cs = getComputedStyle(pe);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const r = pe.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const col = rgb(cs.color);
      runs.push({
        t: n.data, y: r.top - R.top, fs: parseFloat(cs.fontSize) || 14, bold: parseInt(cs.fontWeight, 10) >= 600,
        blue: !!col && ((col.v & 255) > 200 && (col.v >> 16 & 255) < 90),
        area: pe.closest('[data-mcomponent$="TextArea"]') || pe,
        btn: pe.closest('[role="button"]'),
        foot: p.footer.some((b) => b.contains(pe)),
      });
    }
    const head = runs.filter((r) => r.y < p.headBottom && !r.foot);
    const first = head.find((r) => r.bold);
    if (!first) return null; // not a post (stories tray, composer, suggestions)
    const join = (list) => flat(list.map((r) => r.t).join(''));
    const title = join(head.filter((r) => r.area === first.area));
    const meta = flat(head.filter((r) => r.area !== first.area && r.fs <= 13.5).map((r) => r.t).join(' '))
      .replace(/^·\s*|\s*·$/g, '');
    const media = feedMedia(p);
    const mediaTop = media.length ? Math.min(...media.map((o) => o.r.top)) - R.top : p.footTop;
    // Body: text between the header and the media; "Xem thêm" means cut.
    let more = false;
    const paragraphs = (list) => {
      const out = [];
      let area = null;
      for (const r of list) {
        if (MORE.test(flat(r.t))) {
          more = true;
          continue;
        }
        if (r.area !== area) out.push('');
        area = r.area;
        out[out.length - 1] += r.t;
      }
      return out.map((s) => s.replace(PUA, '').replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
    };
    const rest = runs.filter((r) => r.y >= p.headBottom - 2 && !r.foot && r.y < p.footTop);
    const body = paragraphs(rest.filter((r) => r.y < mediaTop && !r.btn && r.fs >= 13));
    // Under the media: a shared link's title, a page's name and so on.
    const card = paragraphs(rest.filter((r) => r.y >= mediaTop && !r.btn && r.area !== first.area)).slice(0, 4);
    if (!body.length && !media.length && !card.length) return null;
    // Key: the start of the text only, so unfolding "See more" (a tap on
    // the text) keeps it; the full first paragraph changed it, and taps
    // on that post then found nothing.
    const lead = (body[0] || '').replace(/(\.\.\.|…)\s*$/, '').slice(0, 40);
    const k = hashOf([title, lead, card[0] || ''].join('|'));
    if (!recipe) return { k };
    const count = (b) => {
      const m = b && flat(b.textContent || '').match(/\d[\d.,]*\s*(?:K|M|N|Tr)?/i);
      return m ? m[0].replace(/\s+/g, '') : '';
    };
    const liked = p.footer.length > 0 && runs.some((r) => r.foot && r.blue && p.footer[0].contains(r.btn || document.body));
    const av = p.avatar && imgHtml(p.avatar.im, true);
    return {
      k, title, meta, more, body, card, liked,
      avatar: av ? { k: recipe(av, p.avatar.r.width, p.avatar.r.height, true), w: p.avatar.r.width } : null,
      media: media.map((o) => {
        const h = imgHtml(o.im, false);
        return h && {
          k: recipe(h, o.r.width, o.r.height, false),
          x: o.r.left - R.left, y: o.r.top - R.top - mediaTop, w: o.r.width, h: o.r.height,
          video: !!o.im.closest('[data-video-id], [data-mcomponent="MVideo"]'),
        };
      }).filter(Boolean),
      likes: count(p.footer[0]), comments: count(p.footer[1]), shares: count(p.footer[2]),
    };
  };
  // Every post now in the page, in order, with the image recipes they use.
  const feedDump = () => {
    const recipes = {};
    const recipe = (html, w, h, alpha) => {
      const k = hashOf(html + '|' + Math.round(w) + 'x' + Math.round(h));
      recipes[k] = { html, w: Math.ceil(w), h: Math.ceil(h), alpha };
      return k;
    };
    const stories = [];
    for (const el of feedBlocks()) {
      const s = readPost(el, recipe);
      if (s && !stories.some((o) => o.k === s.k)) stories.push(s);
    }
    return { stories, recipes };
  };
  // Where to tap in post k (viewport CSS px) for: like, comment, share,
  // author (avatar), post (the body, else the meta line), media i.
  const feedTarget = (k, what, i) => {
    const el = feedBlock(k);
    if (!el) return null;
    const p = feedParts(el);
    let t = null;
    if (what === 'like' || what === 'comment' || what === 'share') {
      t = p.footer[{ like: 0, comment: 1, share: 2 }[what]];
    } else if (what === 'author') {
      t = p.avatar && p.avatar.im;
    } else if (what === 'media') {
      t = feedMedia(p)[i || 0];
      t = t && t.im;
    } else {
      // The post: its comment button opens it (with the comments) every
      // time; a tap on long text often only unfolds "See more". Without
      // one, the body text, or the meta line (time).
      t = p.footer[1];
      if (t) {
        t.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = t.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      const areas = Array.from(el.querySelectorAll('[data-mcomponent$="TextArea"]'))
        .filter((a) => {
          const r = a.getBoundingClientRect();
          return r.height > 0 && r.top - p.R.top >= p.headBottom - 2 && r.top - p.R.top < p.footTop;
        });
      t = areas[0] || el.querySelector('[data-action-id]');
    }
    if (!t) return null;
    t.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = t.getBoundingClientRect();
    return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2 };
  };

  // ---- Chat screen (Messenger in the desktop view) ----
  //
  // At phone width Messenger shows either the chat list ([role=grid] rows,
  // each a link to /messages/t/<id> or /messages/e2ee/t/<id>) or one thread:
  // [role=log] holding a virtualized list of [role=article] messages. Each
  // message's aria-label reads "... <time>, <sender>: <text>", so the text
  // needs no layout reading; whose it is comes from where it sits (own
  // messages hug the right, others' start after the avatar column and have
  // a grey bubble).
  const chatKey = (href) => {
    const m = /\/messages\/(e2ee\/)?t\/(\d+)/.exec(href || '');
    return m ? (m[1] ? 'e' : 't') + m[2] : '';
  };
  const chatRows = () => Array.from(document.querySelectorAll('[role="grid"] a[href*="/messages/"]'))
    .filter((a) => chatKey(a.getAttribute('href')) && a.getBoundingClientRect().height > 0);
  const chatLog = () => {
    const lg = document.querySelector('[role="log"]');
    return lg && lg.getBoundingClientRect().width > 100 ? lg : null;
  };
  const scrollerIn = (root) => Array.from(root.querySelectorAll('*'))
    .find((e) => e.scrollHeight > e.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
  const scrollerOf = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      if (e.scrollHeight > e.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) return e;
    }
    return null;
  };
  // Image of an <img>/<video> for a recipe: its URL, or (blob: URLs of
  // end-to-end encrypted media, which only this page can read) a JPEG of it
  // drawn here.
  // Drawn once per element and source (every dump would redraw them).
  const drawn = new WeakMap();
  const mediaSrc = (el, w, h) => {
    const src = el.tagName === 'VIDEO' ? (el.poster || '') : (el.currentSrc || el.src || '');
    if (/^https?:/.test(src)) return src;
    const key = src + '|' + Math.round(w) + 'x' + Math.round(h);
    const old = drawn.get(el);
    if (old && old.key === key) return old.url;
    try {
      const c = document.createElement('canvas');
      const s = Math.min(1, 240 / Math.max(w, h));
      c.width = Math.max(1, Math.round(w * s));
      c.height = Math.max(1, Math.round(h * s));
      c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/jpeg', 0.8);
      // A video not playing yet draws nothing useful: try again next time.
      if (el.tagName !== 'VIDEO' || el.readyState >= 2) drawn.set(el, { key, url });
      return url;
    } catch (e) {
      return '';
    }
  };
  const chatList = () => {
    const recipes = {};
    const items = [];
    for (const a of chatRows()) {
      const k = chatKey(a.getAttribute('href'));
      if (items.some((o) => o.k === k)) continue;
      let name = '';
      let bold = false;
      const snip = [];
      const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.data.trim() || n.parentElement.closest('abbr')) continue;
        const cs = getComputedStyle(n.parentElement);
        const fs = parseFloat(cs.fontSize) || 0;
        if (fs < 6) continue; // text for screen readers only
        if (!name && fs >= 14.5) {
          name = n.data;
          bold = parseInt(cs.fontWeight, 10) >= 600;
        } else if (name) {
          snip.push(n.data);
          if (parseInt(cs.fontWeight, 10) >= 600) bold = true;
        }
      }
      const abbr = a.querySelector('abbr');
      let unread = bold;
      let online = false;
      const R = a.getBoundingClientRect();
      for (const e of a.querySelectorAll('div, span')) {
        const r = e.getBoundingClientRect();
        if (r.width < 8 || r.width > 20 || Math.abs(r.width - r.height) > 2) continue;
        const c = rgb(getComputedStyle(e).backgroundColor);
        if (!c || c.a < 0.5) continue;
        const cr = c.v >> 16 & 255;
        const cg = c.v >> 8 & 255;
        const cb = c.v & 255;
        if (cg > cr + 40 && cg > cb + 20) online = true;
        else if (cb > 150 && cr < 60 && r.left - R.left > R.width / 2) unread = true;
      }
      const im = Array.from(a.querySelectorAll('img')).find((i) => i.getBoundingClientRect().width >= 30);
      let avatar = '';
      if (im) {
        const src = mediaSrc(im, 40, 40);
        if (src) {
          const html = `<div style="width:100%;height:100%;border-radius:50%;overflow:hidden"><img src="${attr(src)}" ` +
            'style="display:block;width:100%;height:100%;object-fit:cover"></div>';
          avatar = hashOf(html + '|40x40');
          recipes[avatar] = { html, w: 40, h: 40, alpha: true };
        }
      }
      items.push({
        k, name: flat(name), unread, online, avatar,
        snippet: flat(snip.join(' ')).replace(/^·\s*|\s*·$/g, ''),
        time: abbr ? flat(abbr.textContent) : '',
      });
    }
    const first = chatRows()[0];
    const sc = first && scrollerOf(first);
    return { items, recipes, top: !sc || sc.scrollTop <= 4 };
  };
  const chatThread = () => {
    const lg = chatLog();
    if (!lg) return null;
    const L = lg.getBoundingClientRect();
    const recipes = {};
    const msgs = [];
    for (const art of lg.querySelectorAll('[role="article"]')) {
      const m = art.querySelector('[aria-roledescription]') || art;
      const aria = (m.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const tm = /(\d{1,2}:\d{2})[^,]*,\s*([\s\S]*)$/.exec(aria);
      let sender = '';
      let text = '';
      let time = '';
      if (tm) {
        time = tm[1];
        const colon = tm[2].indexOf(':');
        sender = (colon >= 0 ? tm[2].slice(0, colon) : tm[2]).trim();
        text = colon >= 0 ? tm[2].slice(colon + 1).trim() : '';
      }
      // Where the content is: visible message text and media.
      let left = 1e9;
      let right = -1e9;
      let grey = false;
      const seen = [];
      const walker = document.createTreeWalker(m, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const pe = n.parentElement;
        if (!n.data.trim() || pe.closest('[role="toolbar"], [role="button"][aria-label*=";"]')) continue;
        const r = pe.getBoundingClientRect();
        const cs = getComputedStyle(pe);
        if (r.width <= 3 || parseFloat(cs.fontSize) < 14) continue;
        let bg = null;
        for (let b = pe, i = 0; b && b !== m && i < 10; b = b.parentElement, i++) {
          const c = rgb(getComputedStyle(b).backgroundColor);
          if (c && c.a > 0.5 && c.v !== 0xffffff) {
            bg = c;
            break;
          }
        }
        if (bg && bg.a > 0.7 && (bg.v >> 16 & 255) < 40) continue; // a dark tooltip
        if (bg && (bg.v >> 16 & 255) > 200 && (bg.v & 255) > 200) grey = true;
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
        seen.push(n.data);
      }
      const media = [];
      let av = '';
      for (const el of m.querySelectorAll('img, video')) {
        if (el.closest('[role="toolbar"]')) continue;
        const r = el.getBoundingClientRect();
        // The sender's avatar, beside the last message of a group.
        if (!av && el.tagName === 'IMG' && r.width >= 20 && r.width <= 40 && r.left - L.left < 50) {
          const src = mediaSrc(el, 28, 28);
          if (src) {
            const html = `<div style="width:100%;height:100%;border-radius:50%;overflow:hidden"><img src="${attr(src)}" ` +
              'style="display:block;width:100%;height:100%;object-fit:cover"></div>';
            av = hashOf(html + '|28x28');
            recipes[av] = { html, w: 28, h: 28, alpha: true };
          }
          continue;
        }
        if (r.width < 60 || r.height < 40) continue;
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
        if (media.length >= 4) continue;
        const w = Math.min(r.width, 200);
        const h = Math.round(r.height * w / r.width);
        const src = mediaSrc(el, r.width, r.height);
        const video = el.tagName === 'VIDEO';
        if (!src) {
          media.push({ k: '', w, h, video });
          continue;
        }
        const html = `<img src="${attr(src)}" style="display:block;width:100%;height:100%;object-fit:cover">`;
        const k = hashOf(html + '|' + w + 'x' + h);
        recipes[k] = { html, w: Math.ceil(w), h: Math.ceil(h), alpha: false };
        media.push({ k, w, h, video });
      }
      if (!text && !media.length) text = flat(seen.join(' '));
      if (!aria && !text && !media.length) continue;
      const mine = !grey && left < 1e9 && left - L.left > L.width * 0.2 && L.right - right < L.width * 0.25;
      msgs.push({ k: hashOf(aria + '|' + text + '|' + media.length), mine, sender, time, text, media, av: mine ? '' : av });
    }
    const sc = scrollerIn(lg);
    return { msgs, recipes, top: !sc || sc.scrollTop <= 4 };
  };
  // Where to tap: a chat row (k), the composer, the thread's Back button.
  const chatTarget = (what, k) => {
    let t = null;
    if (what === 'open') {
      t = chatRows().find((a) => chatKey(a.getAttribute('href')) === k);
    } else if (what === 'composer') {
      t = Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"]'))
        .find((e) => e.getBoundingClientRect().width > 20);
    } else if (what === 'back') {
      const main = document.querySelector('[role="main"]');
      t = main && Array.from(main.querySelectorAll('[role="button"][aria-label], a[aria-label]'))
        .find((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.left < 60 && r.top < 130;
        });
    }
    if (!t) return null;
    t.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  // Scroll the list down, or the thread up (most of a view, so no message
  // is skipped between two dumps) or to the bottom. Returns null if there
  // is nothing to scroll, else { top: the thread is at its top }.
  const chatScroll = (what) => {
    const lg = chatLog();
    if (what === 'list' || what === 'listtop') {
      const row = chatRows().pop();
      const sc = row && scrollerOf(row);
      if (sc) sc.scrollTop = what === 'listtop' ? 0 : sc.scrollTop + sc.clientHeight * 2;
      return sc ? { top: false } : null;
    }
    const sc = lg && scrollerIn(lg);
    if (!sc) return null;
    if (what === 'bottom') sc.scrollTop = sc.scrollHeight;
    else if (what === 'top') sc.scrollTop = 0;
    else sc.scrollTop -= sc.clientHeight * 0.8;
    return { top: sc.scrollTop <= 4 };
  };

  // ---- Reader (the phone's own screen for any other page) ----
  //
  // The page as rows of items in reading order, for the phone to lay out
  // and draw itself: text runs (size, weight, colour), images, inputs.
  // Items on the same line of the page share a row; nesting shows as the
  // row's indent. Whatever can be pressed gets a key (data-fbc-k on its
  // element), which the phone sends back to press it here.
  let fbcSeq = 0;
  const PRESS_SEL = 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
    '[role="checkbox"], [role="switch"], [role="option"], [data-action-id], label, select, summary';
  const EDIT_SEL = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]), ' +
    'textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]';
  const keyOf = (el) => {
    if (!el) return '';
    let k = el.getAttribute('data-fbc-k');
    if (!k) {
      k = 'k' + (++fbcSeq).toString(36);
      el.setAttribute('data-fbc-k', k);
    }
    return k;
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return null;
    return r;
  };
  const readerDump = () => {
    const recipes = {};
    const items = [];
    const sy = scrollY;
    const doneEdit = new Set();
    const imgSeen = new Set();
    const vw = innerWidth;
    // Bars pinned to the screen (position fixed/sticky): their document y
    // is wherever the view is, so they would land inside the content. Top
    // ones go first, bottom ones (a comment box) last. Memoized per element.
    const pinMemo = new Map();
    const pinOf = (el) => {
      if (!el || el === document.body || el === document.documentElement) return 0;
      if (pinMemo.has(el)) return pinMemo.get(el);
      const pos = getComputedStyle(el).position;
      let p;
      if (pos === 'fixed' || pos === 'sticky') {
        p = el.getBoundingClientRect().top < innerHeight / 2 ? -1 : 1;
      } else {
        p = pinOf(el.parentElement);
      }
      pinMemo.set(el, p);
      return p;
    };
    const push = (it, r, el) => {
      it.y = r.top + sy;
      it.b = r.bottom + sy;
      it.x = Math.max(0, r.left);
      it.pin = pinOf(el);
      // The page's own top bar (Back, title, Search): the phone has its own.
      if (it.pin < 0) return;
      if (it.pin) {
        // In order among the pinned ones, by their place on the screen.
        it.y = r.top + 1e7;
        it.b = r.bottom + 1e7;
      }
      items.push(it);
    };
    // A button that shows only an icon reads as its label, if short (long
    // ones are descriptions: "More options for <page name>").
    const iconLabel = (el) => {
      const lab = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
      return lab.length <= 18 ? lab : '';
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        // aria-hidden is kept: Facebook hides visible text from screen
        // readers (a commenter's name, counts) and labels the block instead.
        if (n.nodeType === 1) {
          const t = n.tagName;
          if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT' || t === 'TEMPLATE') {
            return NodeFilter.FILTER_REJECT;
          }
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const labelled = new Set();
    for (let n = walker.nextNode(); n && items.length < 1500; n = walker.nextNode()) {
      if (n.nodeType === 3) {
        const raw = n.data;
        if (!raw.trim()) continue;
        const pe = n.parentElement;
        if (pe.closest(EDIT_SEL)) continue;
        const r = shown(pe);
        // Text for screen readers only (1 px boxes, 1 px font) would repeat
        // what is shown.
        if (!r || r.width <= 2 || r.height <= 2 || parseFloat(getComputedStyle(pe).fontSize) < 6) continue;
        const text = raw.replace(PUA, '').replace(/\s+/g, ' ');
        const press = pe.closest(PRESS_SEL);
        if (!text.trim()) {
          // An icon-font glyph: a button with a label still shows (as text).
          if (press && !labelled.has(press)) {
            const lab = iconLabel(press);
            if (lab && !press.textContent.replace(PUA, '').trim()) {
              labelled.add(press);
              push({ t: 'T', s: lab, fs: 13, bold: false, col: 0x65676b, a: keyOf(press) }, r, pe);
            }
          }
          continue;
        }
        const cs = getComputedStyle(pe);
        const col = rgb(cs.color);
        // The colour behind it when not white (a button's fill).
        let bg = -1;
        for (let b = pe, i = 0; b && b !== document.body && i < 6; b = b.parentElement, i++) {
          const c = rgb(getComputedStyle(b).backgroundColor);
          if (c && c.a > 0.5) {
            bg = c.v === 0xffffff ? -1 : c.v;
            break;
          }
        }
        // (Emoji stay in the text: the server sends them as images, see emojify.)
        push({
          t: 'T', s: text, fs: parseFloat(cs.fontSize) || 14, bold: parseInt(cs.fontWeight, 10) >= 600,
          col: col ? col.v : 0, bg, a: press ? keyOf(press) : '',
        }, r, pe);
        continue;
      }
      const el = n;
      const tag = el.tagName;
      if (el.matches(EDIT_SEL) && !doneEdit.has(el)) {
        const r = shown(el);
        if (!r) continue;
        doneEdit.add(el);
        const ph = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || '';
        const val = 'value' in el && typeof el.value === 'string' ? el.value : (el.innerText || '');
        push({ t: 'E', s: ph.trim(), v: val.trim(), a: keyOf(el), pass: el.type === 'password' }, r, el);
        continue;
      }
      if (tag === 'IMG' || tag === 'VIDEO' || (tag === 'DIV' && el.getAttribute('data-mcomponent') === 'ImageArea' && !el.querySelector('img'))) {
        const r = shown(el);
        if (!r || r.width < 12 || r.height < 12 || imgSeen.has(el)) continue;
        imgSeen.add(el);
        const press = el.closest(PRESS_SEL);
        const video = tag === 'VIDEO' || !!el.closest('[data-video-id], [data-mcomponent="MVideo"]');
        const w = Math.min(r.width, vw);
        const h = r.height * w / r.width;
        let html = '';
        if (tag === 'DIV') {
          const cs = getComputedStyle(el);
          if (cs.backgroundImage === 'none') continue;
          html = `<div style="width:100%;height:100%;background-image:${attr(cs.backgroundImage)};` +
            `background-size:${cs.backgroundSize};background-position:${cs.backgroundPosition}"></div>`;
        } else {
          const src = mediaSrc(el, r.width, r.height);
          if (!src) continue;
          const cs = getComputedStyle(el);
          const round = parseFloat(cs.borderRadius) >= Math.min(r.width, r.height) / 2 - 1 ||
            (el.closest('[style*="border-radius"]') && r.width <= 80 && Math.abs(r.width - r.height) < 2);
          html = `<img src="${attr(src)}" style="display:block;width:100%;height:100%;object-fit:cover">`;
          if (round) html = `<div style="width:100%;height:100%;border-radius:50%;overflow:hidden">${html}</div>`;
        }
        const k = hashOf(html + '|' + Math.round(w) + 'x' + Math.round(h));
        recipes[k] = { html, w: Math.ceil(w), h: Math.ceil(h), alpha: w * h < 6400 };
        push({ t: 'I', k, w, h, video, a: press ? keyOf(press) : (video ? keyOf(el) : '') }, r, el);
        continue;
      }
      // A pressable element with no text or image inside: its label.
      if (el.matches(PRESS_SEL) && !labelled.has(el) && !el.textContent.trim() && !el.querySelector('img, svg image')) {
        const lab = iconLabel(el);
        const r = lab && shown(el);
        if (r && r.width >= 8 && r.height >= 8) {
          labelled.add(el);
          push({ t: 'T', s: lab, fs: 13, bold: false, col: 0x65676b, a: keyOf(el) }, r, el);
        }
      }
    }
    // Rows: items whose boxes overlap vertically, in document order within
    // a row (by x would shuffle a paragraph: a run spanning lines starts
    // at the left). nl: the item starts below the one before it (the page
    // breaks the line there, e.g. a commenter's name above the comment).
    items.forEach((it, i) => {
      it.i = i;
    });
    items.sort((p, q) => (p.y - q.y) || (p.i - q.i));
    const rows = [];
    let row = null;
    for (const it of items) {
      if (!row || it.y >= row.b - 2) {
        row = { b: it.b, x: it.x, items: [] };
        rows.push(row);
      }
      row.b = Math.max(row.b, it.b);
      row.x = Math.min(row.x, it.x);
      row.items.push(it);
    }
    for (const r of rows) {
      r.items.sort((p, q) => p.i - q.i);
      for (let j = 1; j < r.items.length; j++) {
        const p = r.items[j - 1];
        r.items[j].nl = r.items[j].y >= p.b - 3 && !(r.items[j].t === 'I' && p.t === 'I');
      }
    }
    const docH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    return { url: location.href, title: document.title, rows, recipes, end: sy + innerHeight >= docH - 4 };
  };
  // Where to press the element with key k (viewport CSS px), brought into view.
  const readerTarget = (k) => {
    const el = document.querySelector(`[data-fbc-k="${k}"]`);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: r.left + Math.min(r.width / 2, 60), y: r.top + r.height / 2, line: el.tagName === 'INPUT' };
  };
  const readerCount = () => document.body ? document.body.querySelectorAll('[data-mcomponent], p, li, article').length : 0;

  // What the page needs from the user before the phone's own screens can
  // work: 'login' (a login, checkpoint or 2FA page), 'pin' (Messenger's PIN
  // that restores end-to-end encrypted chats), or ''.
  const PIN_TEXT = /\bPIN\b/;
  const needs = () => {
    const href = location.href;
    if (/\/messages\/|messenger\.com/.test(href)) {
      const dialog = Array.from(document.querySelectorAll('[role="dialog"]'))
        .find((d) => d.getBoundingClientRect().width > 0 && PIN_TEXT.test(d.innerText || ''));
      if (dialog) return 'pin';
      if (!chatLog() && !chatRows().length && PIN_TEXT.test(document.body ? document.body.innerText : '')) return 'pin';
    }
    if (/\/(login|checkpoint|recover|two_step_verification|two_factor|auth_platform|device-based)/i.test(location.pathname)) {
      return 'login';
    }
    const pass = document.querySelector('input[type="password"], input[name="pass"]');
    if (pass && pass.getBoundingClientRect().width > 0 && !chatLog() && !feedBlocks().length) return 'login';
    return '';
  };

  window.__fbc = { move, target, reveal, videoAt, rect, scrollAt, textDump, pageDump, scrollPos, paneTo, dumpKey, pinnedAt,
    needs, readerDump, readerTarget, readerCount, feedDump, feedTarget, feedCount: () => feedBlocks().length,
    chatList, chatThread, chatTarget, chatScroll, chatKeys: () => chatRows().map((a) => chatKey(a.getAttribute('href'))), chatState: () => (chatLog() ? 'thread' : chatRows().length ? 'list' : ''),
    clear: () => mark(null) };
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

// Requests the browser never needs to make: Facebook's and Google's
// tracking and ads, and feed videos that start downloading on their own
// (the server plays video through yt-dlp, never in the browser). Blocked
// per tab by Chrome itself (no round trip through Node per request).
const BLOCKED_URLS = [
  '*.fbcdn.net/*.mp4*', '*.fbcdn.net/*.m4a*', '*.fbcdn.net/*.webm*',
  '*/ajax/weblite_load_logging/*', '*/ajax/weblite_app_logging/*', '*/ajax/bz*', '*/ajax/bnzai*',
  '*/ajax/logging/*', '*/logging/falco*',
  '*fbsbx.com/paid_ads_pixel*', '*connect.facebook.net/*',
  '*google.com/ccm/*', '*google.com/rmkt/*', '*google.com/pagead/*', '*googleadservices.com/*',
  '*doubleclick.net/*', '*googlesyndication.com/*', '*google-analytics.com/*', '*googletagmanager.com/*',
];

// One Chrome per phone, on its mobile profile (<id>-mob): the mobile view is
// one tab, Messenger another (launchView), sharing the login and memory.
// (The <id>-desk profile of older versions is no longer used.)
async function launchBrowser(s) {
  if (s.ctx) return s.ctx;
  if (s.launching) return s.launching;
  s.launching = (async () => {
    const scale = s.zoom / 100;
    const hCss = Math.round(s.h / scale);
    // Overscan: render extra rows above and below the phone's view so it can
    // scroll locally without blank areas (mobile view; see launchView).
    const margin = Math.round(hCss * s.ov / 100);
    const opts = {
      headless: true,
      viewport: { width: Math.round(s.w / scale), height: hCss + 2 * margin },
      // Low resolution (r=1.5 or 2): the image has 1/r of the phone's pixels per
      // side and the phone scales it up. Coordinates in headers and requests
      // stay in phone px (view.scale), so only the image shrinks.
      deviceScaleFactor: scale / s.res,
      isMobile: true,
      hasTouch: false,
      userAgent: UA_MOBILE,
      locale: 'vi-VN',
      // The helpers draw images (emoji, encrypted media) into canvases and
      // read them back; keep Facebook's Content-Security-Policy out of it.
      bypassCSP: true,
      // Less memory and background work: no extensions, sync, translate,
      // component updates or audio, at most two renderers per browser.
      args: ['--disable-dev-shm-usage', '--deny-permission-prompts', '--disable-extensions', '--disable-sync',
        '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--no-first-run',
        '--mute-audio', '--renderer-process-limit=2', '--disable-features=Translate,MediaRouter,OptimizationHints'],
    };
    if (PROXY) opts.proxy = { server: PROXY };
    if (CHANNEL) opts.channel = CHANNEL;
    // Persistent profile: cookies and IndexedDB (Messenger E2EE keys).
    const dir = path.join(PROFILE_DIR, s.id + '-mob');
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
    // Keep the tabs we made: any other (a popup) replaces the active view's
    // page. newPage() fires 'page' before it resolves: s.opening covers it.
    ctx.on('page', async (pg) => {
      if (s.own.has(pg) || s.opening > 0) return;
      await pg.waitForLoadState('domcontentloaded').catch(() => {});
      const url = pg.url();
      await pg.close().catch(() => {});
      const v = active(s);
      if (v && url && url !== 'about:blank') await v.page.goto(url).catch(() => {});
    });
    s.ctx = ctx;
    return ctx;
  })().finally(() => {
    s.launching = null;
  });
  return s.launching;
}

// A tab of the session's browser, made (or the browser's first, unused one
// reused) without the popup handler closing it.
async function ownPage(s, reuseFirst) {
  const ctx = await launchBrowser(s);
  const first = reuseFirst && ctx.pages().find((pg) => !s.own.has(pg));
  if (first) {
    s.own.add(first);
    return first;
  }
  s.opening++;
  try {
    const pg = await ctx.newPage();
    s.own.add(pg);
    return pg;
  } finally {
    s.opening--;
  }
}

// mode 'mob': m.facebook.com as a phone. 'desk': Messenger, which shows
// mobile browsers a "get the app" wall, so this tab is emulated as a desktop
// browser (user agent, client hints, no touch) at the phone's width.
async function launchView(s, mode) {
  const desk = mode === 'desk';
  const scale = s.zoom / 100;
  const hCss = Math.round(s.h / scale);
  // No overscan for the desktop (Messenger) view: its 100vh layout would
  // push the composer out of sight.
  const margin = desk ? 0 : Math.round(hCss * s.ov / 100);
  const page = await ownPage(s, !desk);
  const cdp = await page.context().newCDPSession(page);
  if (desk) {
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: UA_DESKTOP, platform: 'Win32', acceptLanguage: 'vi-VN',
      userAgentMetadata: {
        brands: [{ brand: 'Chromium', version: '120' }, { brand: 'Google Chrome', version: '120' }],
        fullVersion: '120.0.0.0', platform: 'Windows', platformVersion: '10.0.0', architecture: 'x86', model: '', mobile: false,
      },
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: Math.round(s.w / scale), height: hCss, deviceScaleFactor: scale / s.res, mobile: false,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }
  await cdp.send('Network.enable').catch(() => {});
  await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URLS }).catch((e) => log('block', e.message));
  // oy: CSS offset of the phone's view inside the (taller) viewport.
  const view = { mode, ctx: s.ctx, page, cdp, scale, margin, oy: 0, lastUrl: '' };
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

// Headless Chrome never hides a tab, so idle ones keep running Facebook's
// scripts. Views unused for FREEZE_MS are frozen (no scripts, no timers);
// the next request thaws them (openSession).
const FREEZE_MS = 20000;

async function setFrozen(v, frozen) {
  if (!v || !v.cdp || !!v.frozen === frozen) return;
  v.frozen = frozen;
  try {
    await v.cdp.send('Page.setWebLifecycleState', { state: frozen ? 'frozen' : 'active' });
  } catch (e) {
    v.frozen = false;
    log('freeze', e.message.split('\n')[0]);
  }
}

async function thaw(s) {
  await setFrozen(s.mob, false);
  await setFrozen(s.desk, false);
}

// Between requests (s.chain), and only if still unused by then.
function freezeIdle() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.last < FREEZE_MS || s.switching) continue;
    if ((!s.mob || s.mob.frozen) && (!s.desk || s.desk.frozen)) continue;
    s.chain = s.chain.then(async () => {
      if (Date.now() - s.last < FREEZE_MS || s.switching) return;
      await setFrozen(s.mob, true);
      await setFrozen(s.desk, true);
    }).catch(() => {});
  }
}

// Closes one view's tab (idle); the browser stays for the other.
async function closeView(s, mode) {
  const v = s[mode];
  if (!v) return;
  s[mode] = null;
  s.own.delete(v.page);
  await v.page.close().catch(() => {});
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
  if (s.launching) await s.launching.catch(() => {});
  const ctx = s.ctx;
  s.ctx = null;
  s.mob = null;
  s.desk = null;
  s.img = null;
  if (ctx) await ctx.close().catch(() => {});
}

// start 'desk': the phone opened Messenger first (its chat screen): only
// the Messenger tab opens.
async function createSession(id, w, h, zoom, ov, res, start) {
  const s = {
    id, w, h, zoom, ov, res, mode: 'mob', mob: null, desk: null, chain: Promise.resolve(), last: Date.now(),
    ctx: null, own: new WeakSet(), opening: 0,
  };
  if (start === 'desk') {
    s.mode = 'desk';
    await getView(s, 'desk');
    log('session created', id, `${w}x${h}@${zoom}%`, 'desk');
    return s;
  }
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

function getSession(id, w, h, zoom, ov, res, start) {
  const prev = sessionLocks.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => openSession(id, w, h, zoom, ov, res, start));
  sessionLocks.set(id, next);
  next.catch(() => {}).then(() => {
    if (sessionLocks.get(id) === next) sessionLocks.delete(id);
  });
  return next;
}

async function openSession(id, w, h, zoom, ov, res, start) {
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
  if (!s) s = await createSession(id, w, h, zoom, ov, res, start);
  sessions.set(id, s);
  s.last = Date.now();
  if (s.mode === 'desk') s.deskUsed = s.last;
  else s.mobUsed = s.last;
  await thaw(s); // frozen while idle (freezeIdle)
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
  let y = v.oy + parseInt(q.get('y') || '0', 10) / v.scale;
  // Page mode: a tap on a pinned bar (header, comment box) goes to the bar.
  if (q.get('m') === 'p' && s.mode === 'mob' && q.has('y')) {
    const py = await page.evaluate(([px, ty, vh]) => (window.__fbc ? window.__fbc.pinnedAt(px, ty, vh) : null),
      [x, parseInt(q.get('y'), 10) / v.scale, viewHeightCss(v)]).catch(() => null);
    if (typeof py === 'number') y = py;
  }
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

// A tab of the session's browser for rendering images.
async function imgPage(s) {
  if (!s.img) {
    const ip = { page: null, chain: Promise.resolve() };
    s.img = ip;
    ip.ready = ownPage(s, false).then((pg) => {
      ip.page = pg;
    });
    ip.ready.catch(() => {
      if (s.img === ip) s.img = null;
    });
  }
  const ip = s.img;
  await ip.ready;
  return ip;
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
  const scale = active(s).scale;
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
  const items = s && s.recipes && active(s)
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

// ---- Feed view (/f) ----
//
// The phone's own News Feed screen: the posts of m.facebook.com's feed as
// data (__fbc.feedDump), which the phone lays out and draws itself. Posts
// are kept per session in feed order, since the page drops the media of
// posts scrolled far away. Taps on a post (like, open, author...) go to the
// same spot in the real page.

const FEED_MAX = 120;
// Actions that open another page: the phone goes back to the browser view.
const FEED_OPEN = new Set(['post', 'author', 'comment', 'share', 'media']);

function atFeed(page) {
  try {
    const u = new URL(page.url());
    return /(^|\.)facebook\.com$/.test(u.hostname) && (u.pathname === '/' || u.pathname === '/home.php');
  } catch (e) {
    return false;
  }
}

async function dumpFeed(v) {
  const t0 = Date.now();
  const d = await v.page.evaluate(() => (window.__fbc ? window.__fbc.feedDump() : null)).catch(() => null);
  if (Date.now() - t0 > 300) log('feedDump', Date.now() - t0, 'ms', d ? d.stories.length : 0, 'posts');
  return d || { stories: [], recipes: {} };
}

// Post blocks in the page (cheap: no layout reading).
function feedCount(v) {
  return v.page.evaluate(() => (window.__fbc ? window.__fbc.feedCount() : 0)).catch(() => 0);
}

// Waits until the page has at least min post blocks, at most ms.
async function waitPosts(v, min, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && await feedCount(v) < min) await sleep(250);
}

// Merge a dump into s.feed (ordered posts). New posts go after the post that
// precedes them in the dump; a known post keeps its media if the page has
// dropped it meanwhile.
function mergeFeed(s, stories) {
  const list = s.feed || (s.feed = []);
  let at = -1;
  for (const p of stories) {
    const i = list.findIndex((o) => o.k === p.k);
    if (i >= 0) {
      if (!p.media.length && list[i].media.length) p.media = list[i].media;
      if (!p.avatar && list[i].avatar) p.avatar = list[i].avatar;
      list[i] = p;
      at = i;
    } else {
      list.splice(++at, 0, p);
    }
  }
  if (list.length > FEED_MAX) list.splice(0, list.length - FEED_MAX);
}

// Posts -> lines for the phone, tab separated (sizes in phone px):
//   P key flags avatarKey avatarSize title meta likes comments shares
//   T text            body paragraph
//   S text            text under the media (link title, page name)
//   I key x y w h v   image; x, y within the post's media block; v = 1 video
// flags: 1 liked, 2 the text is cut ("See more").
function encodeFeed(s, list, scale) {
  const r = (n) => Math.round(n * scale);
  const em = emojiText(s);
  const txt = (t) => em.text(String(t).replace(/[\t\r]/g, ' '));
  const out = [];
  for (const p of list) {
    out.push(['P', p.k, (p.liked ? 1 : 0) | (p.more ? 2 : 0), p.avatar ? p.avatar.k : '', p.avatar ? r(p.avatar.w) : 0,
      txt(p.title), txt(p.meta), p.likes, p.comments, p.shares].join('\t'));
    for (const b of p.body) for (const line of txt(b).split('\n')) if (line.trim()) out.push('T\t' + line.trim());
    for (const c of p.card) out.push('S\t' + txt(c).replace(/\n/g, ' '));
    for (const m of p.media) out.push(['I', m.k, r(m.x), r(m.y), r(m.w), r(m.h), m.video ? 1 : 0].join('\t'));
  }
  return em.lines(scale).concat(out).join('\n');
}

// Logged in: the browser has Facebook's session cookie (c_user). Pages
// on the way to it (checkpoints, codes, approvals, "save login") have many
// shapes, so this is what says the login is done, not the page.
async function loggedIn(v) {
  const cookies = await v.ctx.cookies('https://www.facebook.com').catch(() => []);
  return cookies.some((c) => c.name === 'c_user' && c.value);
}

// What the page of view v waits for: 'login', 'pin' or ''.
async function pageNeeds(v) {
  const need = await v.page.evaluate(() => (window.__fbc ? window.__fbc.needs() : '')).catch(() => '');
  if (need) return need;
  return await loggedIn(v) ? '' : 'login';
}

async function feedAction(s, q) {
  const op = q.get('op') || 'load';
  if (s.mode !== 'mob') {
    if (s.mob && /^https:\/\/m\.facebook\.com\//.test(s.mob.page.url())) {
      // Back from Messenger: the feed tab is still open where it was.
      s.mode = 'mob';
      s.pendingSwitch = null;
      log('switch', s.id, '-> mob (kept)');
    } else {
      await switchMode(s, HOME);
    }
  }
  const v = s.mob;
  const page = v.page;
  const out = {};
  // Logged out: the phone shows this page (the browser view) to log in.
  if (await pageNeeds(v) === 'login') {
    out.need = 'login';
    return out;
  }
  if (op === 'load') {
    // Back from a post or profile opened from the feed: back through the
    // history, so the feed is where it was (no reload, same posts).
    for (let i = 0; i < 4 && !atFeed(page) && !q.get('fresh'); i++) {
      const before = page.url();
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
      if (page.url() === before) break;
      await sleep(200);
    }
    // Already on the feed: answer with what is there right away.
    if (!atFeed(page) || q.get('fresh')) {
      s.feed = null;
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('feed', e.message));
      await settle(page, 300);
      // Sent somewhere else than the feed (a checkpoint, a code, "save your
      // login"): the user has to see it, in the browser view.
      if (await pageNeeds(v) === 'login' || !atFeed(page)) {
        out.need = 'login';
        return out;
      }
    }
    // The feed renders a moment after the document, a few posts at a time
    // (also on a page that was just opened for a new session).
    if (await feedCount(v) < 2) await waitPosts(v, 4, 6000);
  } else if (op === 'more') {
    // To the bottom (one step on the way, for lazy images), then answer as
    // soon as new posts are in.
    const before = await feedCount(v);
    await page.evaluate(() => window.scrollBy(0, innerHeight)).catch(() => {});
    await sleep(150);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {});
    await waitPosts(v, before + 1, 3000);
    await sleep(200); // the rest of that batch
  } else {
    // Back from a post, the feed is drawn again a moment later: wait for
    // the post (at most 3 s) rather than answer "not found".
    const target = () => page.evaluate(([k, w, i]) => (window.__fbc ? window.__fbc.feedTarget(k, w, i) : null),
      [q.get('k') || '', op, parseInt(q.get('i') || '0', 10)]).catch(() => null);
    let t = await target();
    for (let end = Date.now() + 3000; !t && Date.now() < end;) {
      await sleep(250);
      t = await target();
    }
    if (!t) {
      out.err = 'Post not found, reload the feed';
    } else {
      const before = page.url();
      await page.mouse.click(t.x, t.y);
      s.clickAt = Date.now();
      if (FEED_OPEN.has(op)) {
        // Only once the page really changed: otherwise the reader showed
        // the feed itself. (Share opens a sheet on the same page.)
        const opened = async (ms) => {
          for (let end = Date.now() + ms; page.url() === before && Date.now() < end;) await sleep(150);
          return page.url() !== before;
        };
        let ok = op === 'share' || await opened(op === 'media' ? 3000 : 5000);
        if (!ok && op === 'media') {
          // A photo that opens nothing at this width: open its post.
          await page.keyboard.press('Escape').catch(() => {});
          const p2 = await page.evaluate((k) => (window.__fbc ? window.__fbc.feedTarget(k, 'post', 0) : null), q.get('k') || '')
            .catch(() => null);
          if (p2) {
            await page.mouse.click(p2.x, p2.y);
            ok = await opened(5000);
          }
        }
        if (ok) {
          out.exit = true;
          await settle(page, 800);
          syncView(v);
          return out;
        }
        out.err = 'Could not open it, try again';
      } else {
        await sleep(800); // like: the button turns blue
      }
    }
  }
  const d = await dumpFeed(v);
  addRecipes(s, d.recipes);
  mergeFeed(s, d.stories);
  out.body = Buffer.from(encodeFeed(s, s.feed || [], v.scale), 'utf8');
  return out;
}

async function serveFeed(res, q) {
  const p = viewParams(q);
  if (!p.id) {
    res.writeHead(400);
    return res.end('missing id');
  }
  const s = await getSession(p.id, p.w, p.h, p.zoom, p.ov, p.rs);
  const job = s.chain.then(() => feedAction(s, q));
  s.chain = job.catch(() => {}).then(() => s.switching);
  const out = await job.catch((e) => {
    log('feed', e.message);
    return { err: e.message.split('\n')[0] };
  });
  const headers = { 'Cache-Control': 'no-store' };
  if (out.err) headers['X-Feed-Err'] = encodeURIComponent(out.err);
  if (out.exit) headers['X-Feed-Exit'] = '1';
  if (out.need) headers['X-Need'] = out.need;
  if (!out.body) {
    res.writeHead(204, headers);
    return res.end();
  }
  const hash = crypto.createHash('md5').update(out.body).digest('hex').slice(0, 12);
  headers['X-Hash'] = hash;
  headers['X-Count'] = String((s.feed || []).length);
  if (hash === q.get('hash')) {
    res.writeHead(204, headers);
    return res.end();
  }
  headers['Content-Type'] = 'text/plain; charset=utf-8';
  headers['Content-Length'] = out.body.length;
  res.writeHead(200, headers);
  res.end(out.body);
}

// ---- Emoji ----
//
// Phone fonts have no emoji. Each emoji (one grapheme: ZWJ sequences, flags,
// keycaps included) gets a character of the Private Use Area (U+E000-U+F8FF)
// for the session; the phone draws that character as a small image from
// /img. A reply starts with "X char imgKey w h" lines for the ones it uses.
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;
const EMOJI_PX = 18; // CSS px, square
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

function emojiText(s) {
  const used = new Set();
  return {
    // NFC text (the phone's fonts have precomposed Vietnamese letters) with
    // emoji swapped for their characters.
    text(t) {
      t = t.normalize('NFC');
      if (!EMOJI_RE.test(t)) return t;
      const map = s.emoji || (s.emoji = new Map());
      let out = '';
      for (const { segment: g } of GRAPHEMES.segment(t)) {
        if (!EMOJI_RE.test(g)) {
          out += g;
          continue;
        }
        let e = map.get(g);
        if (!e) {
          if (map.size >= 0x1900) {
            out += g;
            continue;
          }
          e = {
            ch: String.fromCharCode(0xE000 + map.size),
            k: 'e' + crypto.createHash('md5').update(g).digest('hex').slice(0, 11),
            html: '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;' +
              `font:${EMOJI_PX - 3}px/1 'Noto Color Emoji','Segoe UI Emoji','Apple Color Emoji',sans-serif">${g}</div>`,
          };
          map.set(g, e);
        }
        // The recipe again each time: old ones are dropped (MAX_RECIPES).
        addRecipes(s, { [e.k]: { html: e.html, w: EMOJI_PX, h: EMOJI_PX, alpha: true } });
        used.add(e);
        out += e.ch;
      }
      return out;
    },
    lines(scale) {
      const px = Math.round(EMOJI_PX * scale);
      return [...used].map((e) => ['X', e.ch, e.k, px, px].join('\t'));
    },
  };
}

// ---- Reader (/p) ----
//
// The phone's own screen for every other page (a post and its comments,
// profiles, notifications, groups, search, menus...): __fbc.readerDump's
// rows in the mobile view, laid out by the phone. Presses and typing go to
// the element with the item's key.

// Rows -> lines (tab separated; sizes in phone px):
//   U url title
//   R indent                      a new row (items on one line of the page)
//   T key size flags color bg text  text run; flags: 1 bold, 2 starts a new line; bg: the
//                                   fill behind it ('' = none); key: what pressing it presses
//   I img key w h flags           image (img: /img key); flags: 1 video, 2 starts a new line
//   E key flags hint value        input; flags: 1 password, 2 starts a new line
function encodeReader(s, d, scale) {
  const r = (n) => Math.round(n * scale);
  const em = emojiText(s);
  const txt = (t) => em.text(String(t || '').replace(/[\t\r\n]/g, ' '));
  const out = ['U\t' + txt(d.url) + '\t' + txt(d.title)];
  for (const row of d.rows) {
    out.push('R\t' + r(row.x));
    for (const it of row.items) {
      const nl = it.nl ? 2 : 0;
      if (it.t === 'T') {
        out.push(['T', it.a, r(it.fs), (it.bold ? 1 : 0) | nl, (it.col & 0xffffff).toString(16),
          it.bg >= 0 ? it.bg.toString(16) : '', txt(it.s)].join('\t'));
      } else if (it.t === 'I') {
        out.push(['I', it.k, it.a, r(it.w), r(it.h), (it.video ? 1 : 0) | nl].join('\t'));
      } else {
        out.push(['E', it.a, (it.pass ? 1 : 0) | nl, txt(it.s), txt(it.v)].join('\t'));
      }
    }
  }
  return em.lines(scale).concat(out).join('\n');
}

const readerEval = (v, fn, arg) => v.page.evaluate(fn, arg).catch(() => null);

async function readerAction(s, q) {
  const op = q.get('op') || 'load';
  const out = {};
  if (s.mode !== 'mob') await switchMode(s, HOME);
  const v = s.mob;
  const page = v.page;
  const before = page.url();
  // A new page renders a moment after its document, then fills in (the
  // comments of a post come after the post): wait until the page stops
  // growing, at most 4 s.
  const count = async () => (await readerEval(v, () => (window.__fbc ? window.__fbc.readerCount() : 0))) || 0;
  const settleNew = async () => {
    await settle(page, 300);
    const end = Date.now() + 4000;
    let last = -1;
    let same = 0;
    while (Date.now() < end) {
      const n = await count();
      same = n === last && n >= 3 ? same + 1 : 0;
      if (same >= 2) break;
      last = n;
      await sleep(250);
    }
  };
  // The feed just opened this page (a post, its comments): it may still
  // be loading.
  if (op === 'load' && Date.now() - (s.clickAt || 0) < 5000) await settleNew();
  if (op === 'open') {
    let u = (q.get('u') || HOME).trim();
    if (!/^[a-z]+:\/\//i.test(u)) u = 'https://' + u;
    if (wantMode(u) === 'desk') {
      out.open = 'chats';
      return out;
    }
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('reader', e.message));
    await settleNew();
  } else if (op === 'press' || op === 'type' || op === 'video') {
    const t = await readerEval(v, (k) => (window.__fbc ? window.__fbc.readerTarget(k) : null), q.get('k') || '');
    if (!t) {
      out.err = 'Not found, reload the page';
    } else if (op === 'video') {
      out.video = await startVideo(s, t.x, t.y);
    } else {
      await page.mouse.click(t.x, t.y);
      s.clickAt = Date.now();
      if (op === 'type') {
        await sleep(150);
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        const text = q.get('t') || '';
        if (text) await page.keyboard.insertText(text);
        // A one-line field (search) submits with Enter; a comment box has
        // its own Send button.
        if (q.get('enter') || t.line) await page.keyboard.press('Enter');
      }
      await settleNew();
    }
  } else if (op === 'back') {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    if (page.url() === before) {
      out.open = 'home'; // nothing to go back to
      return out;
    }
    await settleNew();
  } else if (op === 'more') {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {});
    await sleep(1200);
  }
  // Pages the phone has its own screens for, or that wait for the user.
  if (DESKTOP_URL.test(page.url()) || await isMessengerWall(page)) {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    out.open = 'chats';
    return out;
  }
  if (atFeed(page) && op !== 'load') {
    out.open = 'home';
    return out;
  }
  const need = await pageNeeds(v);
  if (need) {
    out.need = need;
    return out;
  }
  const d = await readerEval(v, () => (window.__fbc ? window.__fbc.readerDump() : null));
  if (!d) {
    out.err = out.err || 'Page not readable';
    return out;
  }
  addRecipes(s, d.recipes);
  out.body = Buffer.from(encodeReader(s, d, v.scale), 'utf8');
  out.end = d.end;
  return out;
}

async function serveReader(res, q) {
  const p = viewParams(q);
  if (!p.id) {
    res.writeHead(400);
    return res.end('missing id');
  }
  const s = await getSession(p.id, p.w, p.h, p.zoom, p.ov, p.rs);
  const job = s.chain.then(() => readerAction(s, q));
  s.chain = job.catch(() => {}).then(() => s.switching);
  const out = await job.catch((e) => {
    log('reader', e.message);
    return { err: e.message.split('\n')[0] };
  });
  const headers = { 'Cache-Control': 'no-store' };
  if (out.err) headers['X-Err'] = encodeURIComponent(out.err);
  if (out.need) headers['X-Need'] = out.need;
  if (out.open) headers['X-Open'] = out.open;
  if (out.video) {
    if (out.video.key) headers['X-Video'] = out.video.key;
    else headers['X-Video-Err'] = encodeURIComponent(out.video.err || 'no video');
  }
  if (!out.body) {
    res.writeHead(204, headers);
    return res.end();
  }
  if (out.end) headers['X-End'] = '1';
  const hash = crypto.createHash('md5').update(out.body).digest('hex').slice(0, 12);
  headers['X-Hash'] = hash;
  if (hash === q.get('hash')) {
    res.writeHead(204, headers);
    return res.end();
  }
  headers['Content-Type'] = 'text/plain; charset=utf-8';
  headers['Content-Length'] = out.body.length;
  res.writeHead(200, headers);
  res.end(out.body);
}

// ---- Chat screen (/m) ----
//
// The phone's own Messenger screen: the chat list and one thread as data
// from the desktop view (__fbc.chatList / chatThread). A thread's messages
// are kept per session in order, since the page keeps only those near its
// view; opening a thread also scrolls up a little to bring in earlier ones.

const CHAT_MAX = 300;

function chatEval(v, fn, arg) {
  return v.page.evaluate(fn, arg).catch(() => null);
}

const chatState = (v) => chatEval(v, () => (window.__fbc ? window.__fbc.chatState() : ''));

// Until Messenger shows its list or a thread, or the page waits for the
// user (login, PIN), at most ms. A slow phone/NAS needs seconds to render it.
async function chatReady(v, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const st = await chatState(v);
    if (st || Date.now() >= end) return st;
    const need = await v.page.evaluate(() => (window.__fbc ? window.__fbc.needs() : '')).catch(() => '');
    if (need) return '';
    await sleep(250);
  }
}

async function waitChat(v, want, ms) {
  const end = Date.now() + ms;
  let st = await chatState(v);
  while (st !== want && Date.now() < end) {
    await sleep(250);
    st = await chatState(v);
  }
  return st;
}

async function chatTap(v, what, k) {
  const t = await chatEval(v, ([w, key]) => (window.__fbc ? window.__fbc.chatTarget(w, key) : null), [what, k]);
  if (!t) return false;
  await v.page.mouse.click(t.x, t.y);
  return true;
}

async function dumpThread(s, v) {
  const d = await chatEval(v, () => (window.__fbc ? window.__fbc.chatThread() : null));
  if (!d) return null;
  addRecipes(s, d.recipes);
  const list = s.chat || (s.chat = []);
  let at = -1;
  for (const m of d.msgs) {
    const i = list.findIndex((o) => o.k === m.k);
    if (i >= 0) {
      if (!m.media.some((x) => x.k) && list[i].media.some((x) => x.k)) m.media = list[i].media;
      list[i] = m;
      at = i;
    } else {
      list.splice(++at, 0, m);
    }
  }
  if (list.length > CHAT_MAX) list.splice(0, list.length - CHAT_MAX);
  return d;
}

// The chat list is virtualized too: rows far above the view leave the page.
// Kept per session: a dump from the top of the list gives the newest chats
// in order (a chat with a new message moves up) followed by the older ones
// kept before; a dump further down is merged in place.
function mergeChats(s, d) {
  const old = s.chatRows || [];
  if (d.top) {
    const have = new Set(d.items.map((c) => c.k));
    s.chatRows = d.items.concat(old.filter((c) => !have.has(c.k)));
  } else {
    const list = old.slice();
    let at = -1;
    for (const c of d.items) {
      const i = list.findIndex((o) => o.k === c.k);
      if (i >= 0) {
        list[i] = c;
        at = i;
      } else {
        list.splice(++at, 0, c);
      }
    }
    s.chatRows = list;
  }
  if (s.chatRows.length > CHAT_MAX) s.chatRows.length = CHAT_MAX;
  return { items: s.chatRows };
}

// Scrolls the thread up step by step, keeping every message passed, until
// `want` more messages are kept or `steps` steps are done. At the top
// Messenger loads earlier ones: wait for them.
// Once the top was reached, every message down to the bottom has been kept,
// so later calls start at the top (a poll may have scrolled to the bottom).
async function olderMessages(s, v, want, steps) {
  const before = (s.chat || []).length;
  let what = s.chatTop ? 'top' : 'older';
  for (let i = 0; i < steps && (s.chat || []).length - before < want; i++) {
    const r = await chatEval(v, (w) => (window.__fbc ? window.__fbc.chatScroll(w) : null), what);
    if (!r) break;
    what = 'older';
    if (r.top) s.chatTop = true;
    const n = (s.chat || []).length;
    await sleep(r.top ? 1200 : 300);
    await dumpThread(s, v);
    // At the top with nothing new: Messenger is still loading (or this is
    // the start of the chat). The phone asks again later.
    if (r.top && (s.chat || []).length === n) break;
  }
}

// List -> lines (tab separated):
//   C key flags avatarKey name snippet time    flags: 1 unread, 2 online
// Thread -> lines:
//   H title
//   M key flags time sender text               flags: 1 mine; more lines of
//   L text                                     the text follow as L
//   A key                                      the sender's avatar beside it
//   I key w h video                            an image (phone px; key may be empty)
function encodeChat(s, list, scale) {
  const em = emojiText(s);
  const txt = (t) => em.text(String(t || '').replace(/[\t\r]/g, ' '));
  const out = [];
  if (list) {
    for (const c of list.items) {
      out.push(['C', c.k, (c.unread ? 1 : 0) | (c.online ? 2 : 0), c.avatar, txt(c.name), txt(c.snippet), txt(c.time)].join('\t'));
    }
    return em.lines(scale).concat(out).join('\n');
  }
  out.push('H\t' + txt(s.chatTitle));
  for (const m of s.chat || []) {
    const lines = txt(m.text).split('\n');
    out.push(['M', m.k, m.mine ? 1 : 0, txt(m.time), txt(m.sender), lines[0]].join('\t'));
    for (const l of lines.slice(1)) out.push('L\t' + l);
    if (m.av) out.push('A\t' + m.av);
    for (const x of m.media) out.push(['I', x.k, Math.round(x.w * scale), Math.round(x.h * scale), x.video ? 1 : 0].join('\t'));
  }
  return em.lines(scale).concat(out).join('\n');
}

async function chatAction(s, q) {
  const op = q.get('op') || 'list';
  if (s.mode !== 'desk') {
    if (s.desk && /\/messages\//.test(s.desk.page.url())) {
      // Back from the feed: Messenger is still open (and kept itself up to
      // date), no need to load it again.
      s.mode = 'desk';
      s.pendingSwitch = null;
      log('switch', s.id, '-> desk (kept)');
    } else {
      await switchMode(s, MESSENGER_URL);
    }
  }
  const v = s.desk;
  const page = v.page;
  const out = {};
  // Logged out or Messenger's PIN: the phone shows this page to the user.
  const waitsForUser = async () => {
    const need = await pageNeeds(v);
    if (need) out.need = need;
    return !!need;
  };
  if (!/\/messages\//.test(page.url())) {
    await page.goto(MESSENGER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('chat', e.message));
  }
  // Just switched or loaded: let it render (a reload here started over).
  await chatReady(v, 15000);
  if (await waitsForUser()) return out;
  const toList = async () => {
    if (await chatState(v) === 'thread' && await chatTap(v, 'back')) {
      if (await waitChat(v, 'list', 3000) === 'list') return;
    }
    if (await chatState(v) !== 'list') {
      await page.goto(MESSENGER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('chat', e.message));
      await waitChat(v, 'list', 8000);
    }
  };
  if (op === 'list') {
    await toList();
    s.chat = null;
  } else if (op === 'more') {
    // Down the list until chats not kept yet show up (Messenger loads more
    // as its list reaches the end), at most 3 s.
    const kept = new Set((s.chatRows || []).map((c) => c.k));
    const fresh = () => chatEval(v, (keys) => (window.__fbc ? window.__fbc.chatKeys().filter((k) => !keys.includes(k)).length : 0),
      Array.from(kept));
    const end = Date.now() + 3000;
    do {
      await chatEval(v, () => window.__fbc && window.__fbc.chatScroll('list'));
      await sleep(300);
    } while (Date.now() < end && !await fresh());
  } else if (op === 'open') {
    const k = q.get('k') || '';
    if (await chatState(v) === 'thread') await toList();
    // Threads open by a tap on their row: loaded by URL at this width,
    // Messenger shows the list. A row far down may have left the page:
    // look for it from the top.
    const hasRow = () => chatEval(v, (key) => !!window.__fbc && window.__fbc.chatKeys().includes(key), k);
    if (!await hasRow()) {
      await chatEval(v, () => window.__fbc && window.__fbc.chatScroll('listtop'));
      await sleep(300);
      for (let i = 0; i < 15 && !await hasRow(); i++) {
        await chatEval(v, () => window.__fbc && window.__fbc.chatScroll('list'));
        await sleep(400);
      }
    }
    if (!await chatTap(v, 'open', k)) {
      out.err = 'Chat not found, reload the list';
    } else {
      s.chat = [];
      s.chatTop = false;
      s.chatKey = k;
      s.chatTitle = q.get('t') || '';
      await waitChat(v, 'thread', 8000);
      await sleep(600);
      await dumpThread(s, v);
      // Bring in some earlier messages, then back to the newest.
      await olderMessages(s, v, 10, 4);
      await chatEval(v, () => window.__fbc && window.__fbc.chatScroll('bottom'));
      await sleep(300);
    }
  } else if (op === 'older') {
    await olderMessages(s, v, 15, 10);
  } else if (op === 'send') {
    const t = q.get('t') || '';
    if (t && await chatTap(v, 'composer')) {
      await page.keyboard.insertText(t);
      await page.keyboard.press('Enter');
      await sleep(900);
      await chatEval(v, () => window.__fbc && window.__fbc.chatScroll('bottom'));
    } else if (t) {
      out.err = 'No message box';
    }
  }
  if (await waitsForUser()) return out;
  // op=poll and everything else: the screen as it is now. The phone at the
  // newest messages (b=1): the page too, so new ones are rendered.
  if (op === 'poll' && q.get('b') && s.chat) {
    await chatEval(v, () => window.__fbc && window.__fbc.chatScroll('bottom'));
    await sleep(100);
  }
  const st = await chatState(v);
  if (st === 'thread' && s.chat) {
    await dumpThread(s, v);
    out.screen = 'thread';
    out.body = Buffer.from(encodeChat(s, null, v.scale), 'utf8');
  } else {
    const d = await chatEval(v, () => (window.__fbc ? window.__fbc.chatList() : null)) || { items: [], recipes: {}, top: false };
    addRecipes(s, d.recipes);
    out.screen = 'list';
    out.body = Buffer.from(encodeChat(s, mergeChats(s, d), v.scale), 'utf8');
  }
  return out;
}

async function serveChat(res, q) {
  const p = viewParams(q);
  if (!p.id) {
    res.writeHead(400);
    return res.end('missing id');
  }
  const s = await getSession(p.id, p.w, p.h, p.zoom, p.ov, p.rs, 'desk');
  const job = s.chain.then(() => chatAction(s, q));
  s.chain = job.catch(() => {}).then(() => s.switching);
  const out = await job.catch((e) => {
    log('chat', e.message);
    return { err: e.message.split('\n')[0] };
  });
  const headers = { 'Cache-Control': 'no-store' };
  if (out.err) headers['X-Chat-Err'] = encodeURIComponent(out.err);
  if (out.need) headers['X-Need'] = out.need;
  if (!out.body) {
    res.writeHead(204, headers);
    return res.end();
  }
  headers['X-Chat'] = out.screen;
  const hash = crypto.createHash('md5').update(out.screen).update(out.body).digest('hex').slice(0, 12);
  headers['X-Hash'] = hash;
  if (hash === q.get('hash')) {
    res.writeHead(204, headers);
    return res.end();
  }
  headers['Content-Type'] = 'text/plain; charset=utf-8';
  headers['Content-Length'] = out.body.length;
  res.writeHead(200, headers);
  res.end(out.body);
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

// The phone and its view, from the query of /a and /f.
function viewParams(q) {
  return {
    id: (q.get('id') || '').replace(/[^A-Za-z0-9_-]/g, ''),
    w: Math.min(Math.max(parseInt(q.get('w') || '240', 10), 96), 1080),
    h: Math.min(Math.max(parseInt(q.get('h') || '320', 10), 96), 1920),
    zoom: Math.min(Math.max(parseInt(q.get('z') || '100', 10), 25), 200),
    // Overscan % of the view height added above and below (0 = old clients).
    ov: Math.min(Math.max(parseInt(q.get('ov') || '0', 10), 0), 100),
    // Render resolution divisor: 1 = full, 1.5 = 2/3, 2 = half per side
    // (slow phones; the phone scales the image back up).
    rs: { 2: 2, 1.5: 1.5 }[q.get('r')] || 1,
  };
}

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
  if (u.pathname === '/f') return serveFeed(res, q);
  if (u.pathname === '/m') return serveChat(res, q);
  if (u.pathname === '/p') return serveReader(res, q);
  if (u.pathname === '/vs') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end(videoStatus(q.get('k') || ''));
  }
  if (u.pathname !== '/a') {
    res.writeHead(404);
    return res.end();
  }
  const { id, w, h, zoom, ov, rs } = viewParams(q);
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
  const fmt = q.get('f') === 'png' ? 'png' : 'jpeg';
  const quality = Math.min(Math.max(parseInt(q.get('q') || '75', 10), 10), 95);
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
    const state = await pageNeeds(v);
    // The feed shows posts: logging in is really over (the phone goes back
    // to its own feed only then, not on some page on the way).
    const feedReady = !state && s.mode === 'mob' && atFeed(page) && await feedCount(v) >= 1;
    return { img, text, pg, input, out, focus, state, feedReady, url: page.url(), oy: Math.round(v.oy * v.scale) };
  });
  // A view switch started by this request finishes before the next one.
  s.chain = job.catch(() => {}).then(() => s.switching);
  const { img, text, pg, input, out, focus, state, feedReady, url, oy } = await job;

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
    // 'login' / 'pin': the page waits for the user (the phone's own screens
    // send it here for that), 'ok' otherwise.
    'X-State': state || 'ok',
    // 1: the mobile view is on the feed and it has posts.
    'X-Feed-Ready': feedReady ? '1' : '0',
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
        await closeView(s, 'desk');
        log('messenger tab closed (idle)', id);
      }).catch(() => {});
    } else if (s.mob && s.mode === 'desk' && !s.switching && now - (s.mobUsed || 0) > MOB_IDLE_MS) {
      s.chain = s.chain.then(async () => {
        if (!s.mob || s.mode !== 'desk' || s.switching || Date.now() - (s.mobUsed || 0) <= MOB_IDLE_MS) return;
        s.feed = null;
        await closeView(s, 'mob');
        log('facebook tab closed (idle)', id);
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
setInterval(freezeIdle, 5000);
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
