# fbclient — J2ME Facebook thin client (Cloud Phone style)

```
[J2ME phone] --HTTP--> [server: Node + headless Chromium] ----------------------------> facebook.com
   shows JPEG/PNG          renders page, executes click/scroll/type
```

## Install the app
Download `FbClient.jad` + `FbClient.jar` from the
[latest release](https://github.com/leeanh1999/fbclient/releases/latest). Release builds are
preverified (class 45 + StackMap) for real phones (Nokia E6 / S60). On its first start the app asks
for the server address (e.g. `http://192.168.1.10:5080`); Menu → Settings → Server changes it.

## Deploy on Synology NAS (Docker)
1. Container Manager → Project → Create, paste [`docker-compose.yml`](docker-compose.yml)
   (image `ghcr.io/leeanh1999/fbclient:latest`, **arm64 only**, port **5080**; on an x86 NAS use
   `build: ./server` in the compose file instead of `image`).
2. The image always connects to Facebook directly (no proxy in production).
3. Updates: put [`deploy.sh`](deploy.sh) next to the compose file and run `sudo ./deploy.sh`
   (pulls the image, restarts, waits for health, copies the latest app release to `APP_DIR`).

The image uses Playwright Chromium (`CHANNEL=`; Google Chrome has no ARM build). Videos play in
the phone's native player, so Chromium's missing H.264 codec doesn't matter. Each phone uses
roughly 0.6–1 GB RAM while active.

CI (`.github/workflows`): `docker.yml` builds the arm64 image natively on GitHub's ARM runner
(`ubuntu-24.04-arm`, ~2–3 min; QEMU took 10+), smoke-tests it and pushes it to GHCR;
`j2me.yml` builds the prod app, checks the bytecode and, on `v*` tags, attaches it to the release.

## Server
Requires Google Chrome (H.264 codecs for Facebook video) and `yt-dlp` on PATH (video playback).
```powershell
cd server
npm install
npx playwright install chromium   # fallback if Chrome is missing
npm start                         # listens on :8080
```
Env vars: `PORT` (8080), `PROXY` (optional, local runs only, e.g. `socks5://host:port` where
Facebook is blocked; empty = direct; ignored with `NODE_ENV=production`, i.e. in Docker),
`TOKEN` (access key, empty = none),
`HOME_URL` (https://m.facebook.com/), `IDLE_MIN` (5; minutes before an idle phone's browsers close), `DESK_IDLE_MIN` (2; minutes the Messenger browser stays open unused once the phone is back on Facebook), `MOB_IDLE_MIN` (2; likewise the Facebook browser while the phone stays in its chat screen), `CHANNEL` (chrome; empty = bundled Chromium),
`YTDLP` (yt-dlp), `DATA_DIR` (`server/data`; `/data` in Docker).

Each phone gets two persistent Chrome profiles in `<DATA_DIR>/profiles/<clientId>-{mob,desk}`:
- `mob`: Android UA, m.facebook.com
- `desk`: desktop UA, used automatically for `facebook.com/messages`, messenger.com, m.me, and when
  the m.facebook.com Messenger tab shows its in-page "Tải ứng dụng Messenger" wall (detected by text
  for 8 s after a tap). Rendered at the phone's own width (not a scaled-down 900 px page), so
  Facebook's responsive layout gives a single column with normal-size text. Cookies are copied
  between them; IndexedDB persists so the Messenger E2EE PIN is asked only once.

Every page gets an init script (`pageHelpers` in `server.js`) that blocks inline video playback,
hides "Mở ứng dụng" / "Open app" buttons, and implements D-pad focus navigation (`window.__fbc`).

Video: pressing a video (tap or 5 on a focused video) does not touch the page; the server starts
it as `op=video` would and answers `X-Video`, so the phone's player opens at once. This includes a
feed video's own play button and reel posts (a button labelled as a video, or a big link to a
reel/video, showing a thumbnail), which would otherwise open the reel page; for those the server
opens the reel page to find the video and goes back to the feed. (`X-Video-Offer: x,y,w,h`, a play
button the phone draws over a video, is still understood by the phone.) That button sends `op=video`,
which takes the MP4 from the player's `data-video-url` (or a `/videos/`, `/reel/`, `watch?v=` link),
downloads it with yt-dlp (through `PROXY` when set) into `<DATA_DIR>/video/` (kept 24h). As soon as the MP4
header (`moov`, at the front of Facebook's progressive files) plus 128 KB have arrived, `/vs` says
`ready <w> <h>` and `/v/<k>.mp4` streams the growing file (HTTP/1.0, no length), so playback starts
during the download; once complete it is served with Range support. The phone fits the video to the
screen with that size. `op=nextvideo` (player's Next) takes the next not-yet-played player on the
page (`data-video-id`/`data-video-url`), loading more of the feed or swiping reels when needed.
`YTDLP_EXTRA_ARGS` passes extra yt-dlp options (e.g. `--limit-rate 2M`).

API: `GET /a?id=&w=&h=&z=&f=jpg|png&q=&r=&hash=&key=&op=...`

`r=1.5` / `r=2` (not set by the app any more): the page is rendered with 1/r of the device
scale factor, so the image is 2/3 or 1/2 of the phone's size per side (~44% / 25% of the pixels
to send and decode) with JPEG quality at least 80 (scaling magnifies artifacts); the phone scales
it back up once per frame (`Net.fitScreen`: x1.5 turns every 2 pixels into 3, x2 every pixel
into 2, new pixels averaging their neighbours). Coordinates in requests and headers stay in phone px.
Changing `r`, like `w`/`h`/`z`/`ov`, relaunches that phone's browser.

`m=t`: text mode, also what page mode falls back to where it can't dump the page (a large video in view still gets a plain screenshot). The screenshot is taken with text glyphs
hidden (`-webkit-text-fill-color: transparent`; SVG icons keep their colour) and the page's visible
text lines go along with it, for the phone to draw with its own fonts (`TextFrame`). The JPEG has
no text edges, so it is much smaller (a test page: 4 KB + 0.5 KB of text vs 17 KB). The body is the
text (UTF-8, `X-Text: <bytes>`) followed by the image. One line per text line:
`x y w h size flags rrggbb text`, tab separated (image px; flags 1 bold, 2 clip to the
box, 4 centre, 8 top of the box), skipping text clipped by a scroll pane or covered by an opaque
element. Pages with a large video in view or a desktop-width page shrunk to fit get a plain
screenshot (no `X-Text`). Pseudo-element text (`::before`) stays in the image.

`m=p&sy=<y>`: page mode, what the phone always asks for. When nothing on the page changed since the
dump the phone has (DOM mutations, loads, transitions, scroll position: `__fbc.dumpKey`), the server
answers `204` without dumping again. The server sends no image but a long
stretch of the page (2 views above the phone's view to 6 below) as drawing commands, and the phone
scrolls through it locally (`PageView`) with no request per scroll. `sy` is the document y of the
phone's view (phone px): the server first scrolls its page there, so `x`/`y` of every op mean the
same as on the phone. In the desktop view (Messenger) the page doesn't scroll but an inner pane
does (chat list, message list): the largest scrolling pane in view is taken as the document, `sy`
is its scroll position, and everything around it is pinned. Reply: `text/plain` body,
`X-Page: top,bottom,height,bg[,paneX,paneY,paneW,paneH]` (stretch sent, page height, background
colour, and the pane's box on screen, to which the phone clips the scrolling content) and `X-Sy`
(where the view is now; differs from `sy` when the server moved it). `X-Focus` is in document px.
The phone draws text with its own fonts, which can be wider or narrower than the page's (a run
following another on the same line starts after it). A tap on a pinned bar (`position: fixed`) lands
on that bar, however the view is scrolled. Text in the body is NFC.
One command per line, tab separated, phone px:

| | fields | |
|---|---|---|
| `T` | x y w h fontSize flags rrggbb text | text line (flags as in text mode) |
| `B` | x y w h radius flags rrggbb | filled box (backgrounds, border sides, `::before` pills) |
| `R` | x y w h radius flags rrggbb | box outline (uniform border) |
| `I` | x y w h 0 flags key | image, fetched from `/img` by key |
| `C` | x y w h 0 flags | clip for the following commands (w=0: none; scroll panes, `clip-path: inset`) |
| `F` | x y w h radius flags | something the D-pad can focus (inner controls only, as `__fbc.move`) |

In page mode the D-pad focus moves on the phone over the `F` items (same scoring as `__fbc.move`,
no request), scrolling the view when nothing is further that way; 5/FIRE taps the middle of the
focused item (`op=click`), and `X-Focus` is ignored. The ring is drawn anti-aliased with a soft
glow (`FocusRing`).

Flag 16: pinned to the screen (`position: fixed`, or after the pane; y relative to the view),
drawn over the content; flag 32: pinned under it (around a pane). Commands come in paint order
(z-index and positioning, simplified). Elements hidden by `clip-path: inset(50%)` or
`clip: rect(0 0 0 0)` are left out; an image filling a rounded clip is rounded by the server.
Icon-font glyphs and emoji, which phone fonts lack, are drawn by the page into a canvas and sent as
images. The phone asks for a new stretch when its view nears an edge of the current one, and sends
`op=more` (the server scrolls to the bottom for 1.5 s so the feed loads more) near the page end;
in a pane, `op=more&top=1` near its top loads older messages and keeps the same ones in view
(`X-Sy` grows by what was added above).

`GET /img?id=&k=<key>,<key>…&f=&q=` → the page's images (a recipe per key: the `<img>`, CSS
background, mask or inlined SVG redrawn alone by a tab of the phone's own mobile browser at the
phone's scale),
packed into a PNG sheet with transparency (icons, small images) and a JPEG sheet (photos). Body =
index text + PNG + JPEG, `X-Sheets: <text bytes>,<png bytes>,<jpg bytes>`; index lines
`key sheet(0 png, 1 jpg) x y w h`. A sheet stops at ~400k px; keys left out come on the next
request. `X-Unknown` lists keys the server has no recipe for. The phone (`ImageLoader`, its own
thread) asks for the images in and near its view, cuts them out and caches them by key (~800k px),
so a repeated avatar or icon crosses the network once. Measured on the m.facebook.com feed at
372x473: one screenshot frame 101 KB; page mode 4–8 KB for 8 views of commands plus 40–70 KB of
images for the first view, then only new images while scrolling.
| op | params | action |
|---|---|---|
| (none) | | screenshot |
| click | x,y | click; returns `X-Input`/`X-Value` if a text field got focus |
| scroll | x,y,dx,dy | mouse wheel |
| type | t | replace focused field's text |
| key | k | press key (Enter, Backspace…) |
| nav | u | open URL |
| move | d=u/d/l/r | move the D-pad focus; scrolls to it. Without a scroll: `204`, no screenshot |
| activate | | press the focused element (or `X-Video-Offer` if it is a video) |
| back / fwd / reload / home | | |
| video | x,y (optional) | start video download; returns `X-Video: <k>` or `X-Video-Err` |
| nextvideo | | next reel / next video in the feed, as `video` (after `prevvideo`: the next one played) |
| prevvideo | | the video played before (the session keeps the last 50), as `video` |
| bye | | the app is exiting (Menu → Exit): close this phone's session now; `204`, no session is created |

Responses: `200` image, `204` unchanged (same `hash`); headers `X-State` (`login`: a login, checkpoint or
2FA page; `pin`: Messenger asks for the PIN of end-to-end encrypted chats; `ok`), `X-Url`, `X-Hash`, `X-Oy`,
`X-Focus: x,y,w,h` (D-pad focus in image px, drawn by the phone, so moving it needs no new frame).
`X-Loading: messenger` / `facebook`: the request moves between the mobile view and the desktop
(Messenger) view (menu, Messenger tab, Back from Messenger's start, Home, a link), which takes
seconds; the server answers at once with the old page and switches in the background, and the
session's next request waits for it. Meanwhile the phone shows a white splash with that logo
(`res/messenger*.png`, `res/facebook*.png`; also right away for its own Messenger and Home buttons)
until a reply to a request sent after it arrives.

Overscan (`ov` = % of view height, client sends 100, or 50 after running out of memory, when frames
average over 450 ms to download + decode (e.g. Nokia E6);
saved in RMS since a change relaunches the browser on the server): in the mobile view the viewport is rendered
`ov`% taller above and below the phone's view; `X-Oy` says where the view starts in the image.
`op=scroll` moves the view inside that buffer and re-centres it by scrolling the window (falls back
to mouse wheel for inner scroll areas). Off in the desktop/Messenger view.
`GET /vs?k=` → `dl <pct>` / `ready` / `err <msg>`; `GET /v/<k>.mp4` → MP4 with Range support.

### The app's own screens
The app starts in its feed screen (`/f`); Home opens it, Messenger opens the chat screen
(`/m`), and every other page (a post and its comments, profiles, notifications, groups, search,
a typed URL) opens in the reader screen (`/p`). All three have a menu (Home, Messenger, URL,
Reload, Settings, Exit). The browser view (`/a`) is left for logging in and Messenger's PIN (`/f`,
`/m` or `/p` answer `X-Need: login` / `pin`; the phone shows the page until `/a` says
`X-State: ok`, then goes back), and for key 9 in the reader (the same page as before). Each screen
uses one of the session's two browsers; the other closes after `DESK_IDLE_MIN` / `MOB_IDLE_MIN`,
and `/img` renders in the one in use.

### Reader screen (`/p`)
`__fbc.readerDump` turns the page into rows in reading order: items whose boxes overlap
vertically share a row. Text runs carry size, weight, colour and the fill behind them (a button);
images their `/img` key; inputs their hint and value. Whatever can be pressed (link, button,
`[data-action-id]`, input) gets a key (`data-fbc-k` on the element). The phone (`ReaderCanvas`,
`ReaderRow`) flows a row's runs together, wrapped at spaces, with a leading avatar in a column of
its own and big images on lines of their own. `GET /p?<view params>&hash=&op=`:

| op | params | action |
|---|---|---|
| load | | the page the mobile view has open (after a post was pressed in the feed) |
| open | u | open URL u (a Messenger URL answers `X-Open: chats`) |
| press | k | press the element with key k |
| type | k, t | type t into input k (a one-line input then gets Enter) |
| video | k | play the video k in the phone's player (`X-Video`) |
| back | | browser Back (`X-Open: home` when that is the feed or there is nothing before) |
| more | | scroll to the bottom so lists load more |

Body lines (tab separated, phone px): `U url title`; `R indent` (a new row); `T key size flags
color bg text` (flags 1 = bold, bg empty = none); `I img key w h flags` (1 = video); `E key flags
hint value` (1 = password). Flag 2 on any item: the page breaks the line before it (a commenter's
name above the comment). Items keep document order within a row; consecutive runs with the
same fill share one box (a comment bubble). Bars pinned to the screen (position fixed/sticky) come
first (top ones) or last (bottom ones, the comment box). Text in `aria-hidden` blocks is read
(Facebook hides visible names and counts from screen readers); screen-reader-only text (1 px) is
not. Headers: `X-Hash`, `X-End` (the page ends in view), `X-Open`, `X-Need`,
`X-Err`, `X-Video` / `X-Video-Err`. After a press or typing the phone asks again twice, 0.8 s
apart, for changes that come a moment later.

### Emoji
Phone fonts have no emoji. In `/f`, `/m` and `/p` text each emoji (a grapheme: ZWJ sequences,
flags, keycaps included) is replaced by a character of the Private Use Area (U+E000-U+F8FF), one
per emoji for the session, and the reply starts with an `X char imgKey w h` line for each one it
uses. The image (`/img` key) is the emoji drawn by Chromium at 18 CSS px (Docker:
`fonts-noto-color-emoji`). The phone's `TextFont` measures and draws those characters as the
images, so all its text shows emoji. Page mode (`/a`) draws them into images itself.

### Feed screen (`/f`)
The app's own News Feed screen (`FeedCanvas`): the posts as data, laid out and drawn
by the phone. m.facebook.com's feed is a Bloks "weblite" screen that gets new posts over a
WebSocket (no GraphQL/XHR to intercept), so the server reads the posts from the page
(`__fbc.feedDump`): each `[data-tracking-duration-id]` block with a round avatar and a bold title
line is a post; its parts are found by layout. Posts are kept per session in feed order (the page
drops the media of posts far away). `GET /f?<same view params as /a>&hash=&op=`:

| op | params | action |
|---|---|---|
| load | fresh=1 (optional) | open the feed in the mobile view (reload it with `fresh`, or when the page is elsewhere) |
| more | | scroll the page down so the feed loads more posts |
| like | k | press the post's Like button, then return the posts again |
| post / author / comment / share / media | k, i (media index) | press that part of the post; `X-Feed-Exit: 1`, the phone goes back to the browser view |

Body (`200`, `text/plain` UTF-8; `204` when the same `hash`), one tab-separated line each, sizes in
phone px:

| line | fields | |
|---|---|---|
| `P` | key flags avatarKey avatarSize title meta likes comments shares | a post; flags 1 = liked, 2 = text cut ("See more") |
| `T` | text | a line of the body |
| `S` | text | text under the media (shared link title, page name) |
| `I` | key x y w h video | an image in the post's media block (`/img` key), video = 1 draws a play button |

Headers: `X-Hash`, `X-Count` (posts kept), `X-Feed-Err` (URL-encoded message), `X-Feed-Exit`.

### Chat screen (`/m`)
The app's own Messenger screen (`ChatCanvas`), from the desktop (Messenger) view.
At phone width Messenger shows either the chat list (`[role=grid]` rows linking to
`/messages/t/<id>` or `/messages/e2ee/t/<id>`) or one thread (`[role=log]`, a virtualized list of
`[role=article]` messages). A message's `aria-label` reads "… <time>, <sender>: <text>"; own
messages are told by position (right side, no grey bubble). Threads open by a tap on their row
(loaded by URL at this width, Messenger shows the list). Images in end-to-end encrypted chats are
`blob:` URLs, so the page draws them into a JPEG for the recipe. A thread's messages are kept per
session in order (the page keeps only those near its view). `GET /m?<view params>&hash=&op=`:

| op | params | action |
|---|---|---|
| list | | the chat list (Back from a thread) |
| more | | scroll the list down for more chats |
| open | k (chat key), t (its name) | open the chat; also scrolls up twice for earlier messages |
| older | | scroll the thread up for earlier messages |
| send | t | type t in the message box and press Enter |
| poll | | the screen as it is (the phone polls: a thread every 3 s, the list every 8 s) |

Body (`200`; `204` when the same `hash`), `X-Chat: list` or `thread`, `X-Chat-Err`:

| line | fields | |
|---|---|---|
| `C` | key flags avatarKey name snippet time | a chat; flags 1 = unread, 2 = online |
| `H` | title | the open thread's name |
| `M` | key flags time sender text | a message; flags 1 = own; its other lines follow as `L text` |
| `I` | key w h video | an image of the message before (phone px; empty key = not available) |
While the feed screen is shown the browser view stops polling; leaving it, the phone forgets its
page and asks for a fresh one.

## Client (MIDP 2.0 / CLDC 1.1)
Phone build (JDK 11+ and Maven; ECJ + ProGuard preverify, as in CI) → `client/build/`:
```sh
bash client/build.sh
```
Offline build for emulators only (JDK only, no downloads; class version 48, not preverified)
→ `client/dist/`:
```sh
sh client/build-emu.sh
```

No server address is built in. On the first start the app shows a box for it (it stays until an
address is given; `http://` is added if missing); it is saved in RMS and Menu → Settings → Server
changes it.

BlackBerry (detected from `microedition.platform`): every connection gets a transport suffix chosen
in Settings → Connection: WiFi (`;interface=wifi`, default), mobile data (`;deviceside=true`) or
BIS/MDS (none). The letter keys W E R / S D F / Z X C act as 1–9, Q as #, A as *.

If the emulator locks the jar: `OUT=dist-new sh client/build-emu.sh`.

Menu → Settings has the server, the access key, the connection (BlackBerry) and the text size. The
rest uses fixed defaults (zoom 100%, JPEG, quality 75, full resolution); settings saved by older
versions for those go back to them.

Frames: after every action the client polls every 250 ms until 3 unchanged frames (max 6 s).

Icons are vector-drawn and anti-aliased (3x supersampled into a cached ARGB image).

Touch: tap = click, drag = scroll (vertical only, with live preview; flick = scroll further),
long-press = play video under finger. Footer (touch screens): Menu · Home · Back (vector icons).

Menu: bottom sheet over the dimmed page with icon tiles — Type text, Enter, Go to URL, Messenger,
Play video, Forward, Reload, Settings, Exit (+ Home on keypad-only phones). Arrows + FIRE or tap.

Settings ends with an on-screen **Save** button. BlackBerry OS 7 ignores a StringItem button's
command, so there it is a self-drawn `FormButton` (CustomItem), and Escape also saves.

BlackBerry text input is a Form with one field and a **Send** button instead of a TextBox (whose OK
is only in the BlackBerry-key menu): Enter in the field sends at once and presses Enter on the page;
Escape sends without Enter; Cancel is in the menu.

Saved across restarts (RMS): server, access key, zoom, image format, JPEG quality,
BlackBerry connection.

Text input: the text box has only OK and Cancel (more commands would put them behind S60's
"Options" soft key). A line break at the end of the text (Enter key) also presses Enter on the page.

Video player (icon bar): Close · Previous · −10 s · Play/Pause · +10 s · Next. Keys: 5 = pause,
4/6 = −/+10 s, 2/8 = volume, 7 = previous video, 9 = next video, # / soft keys = close. While
playing, the bar hides after 3 s and the video fills the screen (aspect ratio kept); a touch or an
arrow key only brings it back (other keys act and show it too).

| Key | Action |
|---|---|
| Arrows | move focus to the next link/button/field/video (hold = repeat; scrolls as needed) |
| 5 / FIRE | press the focused element (a text field opens the input box, a video shows a play button) |
| 2 / 8 | scroll up / down |
| 4 / 6 | scroll left / right |
| 1, # / right soft, Esc, Backspace | back |
| Enter (QWERTY) | same as 5 / FIRE |
| 3 | refresh screen |
| 7 | go to URL |
| 9 | Enter |
| 0 | type text |
| * / left soft | open/close menu |

