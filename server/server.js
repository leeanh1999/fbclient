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
    args: ['--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--deny-permission-prompts'],
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
      await page.mouse.click(x, y);
      s.clickAt = Date.now();
      await settle(page, 500);
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
  await autoplayVideos(active(s));
  // Keep the live stream on whichever view is now active.
  if (s.live) await attachCast(s);
  return out;
}

// Facebook videos often wait behind their own play button. Start any paused
// video that is at least half inside the phone's view; each video only once,
// so one the user paused stays paused.
async function autoplayVideos(v) {
  const vp = v.page.viewportSize();
  if (!vp) return;
  const top = v.oy;
  const bottom = v.oy + vp.height - 2 * v.margin;
  const started = await v.page.evaluate(([t, b]) => {
    let n = 0;
    for (const el of document.querySelectorAll('video')) {
      const r = el.getBoundingClientRect();
      const visible = Math.min(r.bottom, b) - Math.max(r.top, t);
      if (r.height < 40 || visible < r.height / 2) continue;
      if (!el.paused || el.ended || el.dataset.fbcAuto) continue;
      el.dataset.fbcAuto = '1';
      // The phone gets no page audio anyway; muted playback is always allowed.
      el.muted = true;
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
      n++;
    }
    return n;
  }, [top, bottom]).catch(() => 0);
  if (!started) return;
  await sleep(500);
  // Players whose UI ignored play(): tap the video like the user would.
  const taps = await v.page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('video[data-fbc-auto="1"]')) {
      if (!el.paused || el.ended || el.dataset.fbcTapped) continue;
      el.dataset.fbcTapped = '1';
      const r = el.getBoundingClientRect();
      out.push({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    }
    return out;
  }).catch(() => []);
  for (const p of taps) await v.page.mouse.click(p.x, p.y);
  if (taps.length) await sleep(300);
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
    const vids = Array.from(document.querySelectorAll('video'));
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let best = null;
    let bestScore = -1;
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
    const src = best ? (best.currentSrc || best.src || '') : '';
    return {
      src: /^https?:/.test(src) ? src : '',
      link,
      page: linkRe.test(location.href) ? location.href : '',
    };
  }, [x, y]).catch(() => ({}));
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
  const url = info.page || info.link || info.src;
  if (!url) return { err: 'No video found here' };

  const key = crypto.createHash('md5').update(url.replace(/[?&](_rdr|refsrc|ref)=[^&]*/g, '')).digest('hex').slice(0, 16);
  const file = path.join(VIDEO_DIR, key + '.mp4');
  if (fs.existsSync(file)) return { key };
  if (videoJobs.has(key) && videoJobs.get(key).state !== 'err') return { key };

  const job = { state: 'dl', pct: 0, msg: '', url };
  videoJobs.set(key, job);
  const cookies = path.join(VIDEO_DIR, key + '.cookies.txt');
  await writeCookieFile(active(s).ctx, cookies);
  const tmp = path.join(VIDEO_DIR, key + '.part.mp4');
  // Prefer the progressive SD stream (H.264 + AAC in one file, no ffmpeg needed).
  const args = [
    '--proxy', PROXY, '--cookies', cookies, '--no-playlist', '--newline', '--no-part',
    '-f', 'sd/b[height<=?480][ext=mp4]/b[ext=mp4]/b',
    '-o', tmp, url,
  ];
  log('video', key, url);
  const p = spawn(YTDLP, args, { windowsHide: true });
  let errText = '';
  p.stdout.on('data', (d) => {
    const m = /\[download\]\s+([\d.]+)%/.exec(d.toString());
    if (m) job.pct = Math.floor(parseFloat(m[1]));
  });
  p.stderr.on('data', (d) => {
    errText = (errText + d.toString()).slice(-400);
  });
  p.on('error', (e) => {
    job.state = 'err';
    job.msg = 'yt-dlp: ' + e.message;
  });
  p.on('close', (code) => {
    fs.rm(cookies, () => {});
    if (code === 0 && fs.existsSync(tmp)) {
      fs.renameSync(tmp, file);
      job.state = 'ready';
      job.pct = 100;
      log('video ready', key, fs.statSync(file).size, 'bytes');
    } else {
      job.state = 'err';
      job.msg = (errText.split('\n').filter((l) => /ERROR/.test(l)).pop() || `yt-dlp exit ${code}`).slice(0, 120);
      log('video failed', key, job.msg);
    }
  });
  return { key };
}

function videoStatus(key) {
  if (fs.existsSync(path.join(VIDEO_DIR, key + '.mp4'))) return 'ready';
  const j = videoJobs.get(key);
  if (!j) return 'err unknown video';
  if (j.state === 'dl') return 'dl ' + j.pct;
  return j.state === 'ready' ? 'ready' : 'err ' + j.msg;
}

// Serve a downloaded MP4 with Range support (needed by phone media players).
function serveVideo(req, res, key) {
  const file = path.join(VIDEO_DIR, key + '.mp4');
  if (!/^[0-9a-f]{16}$/.test(key) || !fs.existsSync(file)) {
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
    const page = active(s).page;
    const opts = { type: fmt, timeout: 15000 };
    if (fmt === 'jpeg') opts.quality = quality;
    const img = await page.screenshot(opts);
    const input = q.get('op') === 'click' ? await focusedInput(page) : null;
    const v = active(s);
    return { img, input, out, url: page.url(), oy: Math.round(v.oy * v.scale) };
  });
  s.chain = job.catch(() => {});
  const { img, input, out, url, oy } = await job;

  const hash = crypto.createHash('md5').update(img).update(String(oy)).digest('hex').slice(0, 12);
  const headers = {
    'X-Url': encodeURIComponent(url),
    'X-Hash': hash,
    // Where the phone's view starts inside the (taller) image, device px.
    'X-Oy': String(oy),
    'Cache-Control': 'no-store',
  };
  if (input) {
    headers['X-Input'] = input.password ? 'p' : '1';
    headers['X-Value'] = encodeURIComponent(input.value || '');
  }
  if (out.video) {
    if (out.video.key) headers['X-Video'] = out.video.key;
    else headers['X-Video-Err'] = encodeURIComponent(out.video.err);
  }
  if (hash === lastHash) {
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
