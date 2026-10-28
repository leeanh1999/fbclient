// Cloud-rendering backend: headless Chrome renders pages through a SOCKS5
// proxy and streams screenshots to the J2ME thin client.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = parseInt(process.env.PORT || '8080', 10);
const PROXY = process.env.PROXY || 'socks5://host:port';
const TOKEN = process.env.TOKEN || '';
const HOME = process.env.HOME_URL || 'https://m.facebook.com/';
const IDLE_MS = parseInt(process.env.IDLE_MIN || '30', 10) * 60000;
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
// so messages are rendered with the desktop site instead.
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DESKTOP_MIN_WIDTH = 900;
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
      n.style.setProperty('display', 'none', 'important');
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
  const videoAt = (x, y) => {
    for (const v of document.querySelectorAll('video, [data-video-id]')) {
      const r = v.getBoundingClientRect();
      if (r.width < 40 || r.height < 40 || x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const hit = document.elementFromPoint(x, y);
      const ctl = hit && hit.closest('a[href], button, [role="button"], input, textarea');
      if (ctl && !ctl.contains(v)) return null;
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

  window.__fbc = { move, target, reveal, videoAt, rect, clear: () => mark(null) };
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
  const scale = desk ? Math.min(s.zoom / 100, s.w / DESKTOP_MIN_WIDTH) : s.zoom / 100;
  const hCss = Math.round(s.h / scale);
  // Overscan: render extra rows above and below the phone's view so it can
  // scroll locally without blank areas. Off for the desktop (Messenger)
  // view, whose 100vh layout would push the composer out of sight.
  const margin = desk ? 0 : Math.round(hCss * s.ov / 100);
  const opts = {
    headless: true,
    proxy: { server: PROXY },
    viewport: { width: Math.round(s.w / scale), height: hCss + 2 * margin },
    deviceScaleFactor: scale,
    isMobile: !desk,
    hasTouch: false,
    userAgent: desk ? UA_DESKTOP : UA_MOBILE,
    locale: 'vi-VN',
    args: ['--disable-dev-shm-usage', '--deny-permission-prompts'],
  };
  if (CHANNEL) opts.channel = CHANNEL;
  // Persistent profiles keep cookies and IndexedDB (Messenger E2EE keys).
  const dir = path.join(PROFILE_DIR, `${s.id}-${mode}`);
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(dir, opts);
  } catch (e) {
    if (!opts.channel) throw e;
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
    if (p === view.page) return;
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

async function closeSession(s) {
  // The phone reconnects its live stream to the new session.
  if (s.live) s.live.sock.destroy();
  await detachCast(s);
  for (const m of ['mob', 'desk']) {
    if (s[m]) await s[m].ctx.close().catch(() => {});
    s[m] = null;
  }
}

async function createSession(id, w, h, zoom, ov) {
  const s = { id, w, h, zoom, ov, mode: 'mob', mob: null, desk: null, chain: Promise.resolve(), last: Date.now() };
  const v = await getView(s, 'mob');
  if (v.page.url() === 'about:blank') {
    await v.page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('goto', e.message));
  }
  log('session created', id, `${w}x${h}@${zoom}%`);
  return s;
}

async function getSession(id, w, h, zoom, ov) {
  let s = sessions.get(id);
  if (s && (s.w !== w || s.h !== h || s.zoom !== zoom || s.ov !== ov)) {
    // Viewport changed: relaunch; profiles on disk keep the login.
    const url = active(s).page.url();
    sessions.delete(id);
    await closeSession(s);
    s = await createSession(id, w, h, zoom, ov);
    if (/^https?:/.test(url)) {
      s.pendingSwitch = null;
      if (wantMode(url) === 'desk') await switchMode(s, url);
      else await s.mob.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }
  if (!s) s = await createSession(id, w, h, zoom, ov);
  sessions.set(id, s);
  s.last = Date.now();
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

async function goBack(s) {
  const v = active(s);
  const before = v.page.url();
  await v.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
  // The URL can change only after goBack resolves (e.g. into about:blank).
  await settle(v.page, 300);
  const noHistory = v.page.url() === before || !/^https?:/.test(v.page.url());
  if (noHistory && s.mode === 'desk' && s.mob) {
    // Leaving Messenger: return to the mobile view where we came from.
    await s.mob.ctx.addCookies(await v.ctx.cookies()).catch(() => {});
    s.mode = 'mob';
    s.pendingSwitch = null;
    const mp = s.mob.page;
    if (wantMode(mp.url()) === 'desk') {
      await mp.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      if (wantMode(mp.url()) === 'desk') await mp.goto(HOME).catch(() => {});
    }
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
  // Client coordinates are device pixels within its view; Playwright wants
  // CSS pixels within the (overscanned) viewport.
  const x = parseInt(q.get('x') || '0', 10) / v.scale;
  const y = v.oy + parseInt(q.get('y') || '0', 10) / v.scale;
  const out = {};
  switch (op) {
    case 'click':
      // A tap on a video doesn't touch the page: the phone shows its own
      // play button instead (force=1 taps anyway).
      out.offer = q.get('force') ? null : await videoOffer(v, x, y);
      if (out.offer) break;
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
      out.offer = await videoOffer(v, t.x, t.y);
      if (out.offer) break;
      await page.mouse.click(t.x, t.y);
      s.clickAt = Date.now();
      await settle(page, 500);
      break;
    }
    case 'nextvideo':
      out.video = await nextVideo(s);
      break;
    case 'scroll': {
      const dx = parseInt(q.get('dx') || '0', 10) / v.scale;
      let wheelDy = parseInt(q.get('dy') || '0', 10) / v.scale;
      if (v.margin > 0 && wheelDy && await scrollView(v, wheelDy)) wheelDy = 0;
      // Wheel for sideways scrolling, the desktop view, and inner scroll
      // areas that the window scroll can't move.
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
        await switchMode(s, u);
      } else {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('nav', e.message));
        await settle(page, 500);
      }
      break;
    }
    case 'back':
      await goBack(s);
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
      if (s.mode !== 'mob') await switchMode(s, HOME);
      else await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await settle(active(s).page, 500);
      break;
    case 'video':
      out.video = await startVideo(s, q.has('x') ? x : -1, q.has('y') ? y : -1);
      break;
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
  if (s.pendingSwitch) await switchMode(s, s.pendingSwitch);
  syncView(active(s));
  // Keep the live stream on whichever view is now active.
  if (s.live) await attachCast(s);
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
      return downloadVideo(s, next.url);
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

// ---- Live view stream ----
//
// Instead of one HTTP request per frame, /live keeps a single connection
// open and pushes Chrome screencast JPEGs as they are produced (only when
// the page changes). Each frame is "F <oy> <length>\n" + JPEG bytes. The
// next frame is requested from Chrome only after the socket has taken the
// previous one, so the phone's download speed sets the frame rate.

const LIVE_MAX_QUALITY = 65;

function startLive(req, s, quality) {
  const sock = req.socket;
  if (s.live) s.live.sock.destroy(); // one stream per phone
  sock.setNoDelay(true);
  // Raw HTTP/1.0 response without length: no chunked encoding for the
  // phone's HTTP stack to buffer; the body runs until the socket closes.
  sock.write('HTTP/1.0 200 OK\r\nContent-Type: application/octet-stream\r\n' +
    'Cache-Control: no-store\r\nConnection: close\r\n\r\n');
  const client = { sock, quality };
  s.live = client;
  sock.on('close', () => {
    if (s.live === client) {
      s.live = null;
      detachCast(s);
    }
  });
  log('live start', s.id);
  // Restart the screencast so the new connection gets a frame right away
  // (Chrome only sends one on start or when the page changes).
  return s.chain.then(async () => {
    await detachCast(s);
    await attachCast(s);
  });
}

async function attachCast(s) {
  const v = active(s);
  if (!s.live || (s.cast && s.cast.view === v)) return;
  await detachCast(s);
  let cdp;
  try {
    cdp = await v.ctx.newCDPSession(v.page);
  } catch (e) {
    log('cast', e.message);
    return;
  }
  const cast = { view: v, cdp };
  s.cast = cast;
  cdp.on('Page.screencastFrame', (ev) => {
    const ack = () => cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
    const c = s.live;
    if (!c || s.cast !== cast || c.sock.destroyed) return ack();
    s.last = Date.now();
    const jpg = Buffer.from(ev.data, 'base64');
    const oy = Math.round(v.oy * v.scale);
    c.sock.write(Buffer.concat([Buffer.from(`F ${oy} ${jpg.length}\n`), jpg]), ack);
  });
  const vp = v.page.viewportSize() || { width: s.w, height: s.h };
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: s.live ? s.live.quality : LIVE_MAX_QUALITY,
    maxWidth: s.w,
    maxHeight: Math.ceil(vp.height * v.scale) + 2,
    everyNthFrame: 1,
  }).catch((e) => log('screencast', e.message));
}

async function detachCast(s) {
  const cast = s.cast;
  s.cast = null;
  if (!cast) return;
  await cast.cdp.send('Page.stopScreencast').catch(() => {});
  await cast.cdp.detach().catch(() => {});
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
  const page = v.page;
  const m = v.margin;
  const st = await page.evaluate(() => ({
    sy: window.scrollY,
    max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  })).catch(() => null);
  if (!st) return false;
  const viewTop = st.sy + v.oy + dy;
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
  if (!info.src && !info.link && !info.page && x >= 0) {
    // Feed videos often load their source only after being tapped.
    await v.page.mouse.click(x, y);
    await settle(v.page, 1500);
    info = await findVideo(active(s).page, x, y);
  }
  // A tapped video's own MP4/link beats the page URL (a video page lists
  // others). The direct MP4 is what Facebook itself plays on mobile.
  const url = info.hit ? (info.src || info.link || info.page) : (info.page || info.src || info.link);
  if (!url) return { err: 'No video found here' };
  if (info.docY != null) s.lastVideoDocY = info.docY;
  if (info.id) (s.played || (s.played = new Set())).add(info.id);
  return downloadVideo(s, url);
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
    '--proxy', PROXY, '--cookies', cookies, '--no-playlist', '--newline', '--no-part',
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
  if (u.pathname === '/vs') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end(videoStatus(q.get('k') || ''));
  }
  if (u.pathname !== '/a' && u.pathname !== '/live') {
    res.writeHead(404);
    return res.end();
  }
  const id = (q.get('id') || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) {
    res.writeHead(400);
    return res.end('missing id');
  }
  const w = Math.min(Math.max(parseInt(q.get('w') || '240', 10), 96), 1080);
  const h = Math.min(Math.max(parseInt(q.get('h') || '320', 10), 96), 1920);
  const zoom = Math.min(Math.max(parseInt(q.get('z') || '100', 10), 25), 200);
  const fmt = q.get('f') === 'png' ? 'png' : 'jpeg';
  const quality = Math.min(Math.max(parseInt(q.get('q') || '75', 10), 10), 95);
  // Overscan % of the view height added above and below (0 = old clients).
  const ov = Math.min(Math.max(parseInt(q.get('ov') || '0', 10), 0), 100);
  const lastHash = q.get('hash') || '';

  const s = await getSession(id, w, h, zoom, ov);
  if (u.pathname === '/live') return startLive(req, s, Math.min(quality, LIVE_MAX_QUALITY));
  // Serialize actions per session.
  const job = s.chain.then(async () => {
    const out = await runAction(s, q);
    const v = active(s);
    const page = v.page;
    // D-pad focus rect in image (tall viewport) device px; the phone draws it.
    const fr = await page.evaluate(() => (window.__fbc ? window.__fbc.rect() : null)).catch(() => null);
    const focus = fr ? [fr.x, fr.y, fr.w, fr.h].map((n) => Math.round(n * v.scale)).join(',') : '';
    // A focus move that didn't scroll changes nothing on screen: skip the
    // screenshot (the slowest part, especially on a NAS).
    let img = null;
    if (q.get('op') !== 'move' || out.scrolled) {
      const opts = { type: fmt, timeout: 15000 };
      if (fmt === 'jpeg') opts.quality = quality;
      img = await page.screenshot(opts);
    }
    const pressed = (q.get('op') === 'click' || q.get('op') === 'activate') && !out.offer;
    const input = pressed ? await focusedInput(page) : null;
    return { img, input, out, focus, url: page.url(), oy: Math.round(v.oy * v.scale) };
  });
  s.chain = job.catch(() => {});
  const { img, input, out, focus, url, oy } = await job;

  const hash = img ? crypto.createHash('md5').update(img).update(String(oy)).digest('hex').slice(0, 12) : lastHash;
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
  // Tap landed on a video: phone shows a play button over this rect.
  if (out.offer) headers['X-Video-Offer'] = out.offer;
  if (out.video) {
    if (out.video.key) headers['X-Video'] = out.video.key;
    else headers['X-Video-Err'] = encodeURIComponent(out.video.err);
  }
  if (!img || hash === lastHash) {
    res.writeHead(204, headers);
    return res.end();
  }
  headers['Content-Type'] = 'image/' + fmt;
  headers['Content-Length'] = img.length;
  res.writeHead(200, headers);
  res.end(img);
}

async function reapIdle() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.last > IDLE_MS) {
      sessions.delete(id);
      await closeSession(s);
      log('session closed (idle)', id);
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
}).listen(PORT, '0.0.0.0', () => log(`listening on :${PORT}, proxy ${PROXY}, channel ${CHANNEL || 'chromium'}`));
