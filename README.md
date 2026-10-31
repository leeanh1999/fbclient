# fbclient — J2ME Facebook thin client (Cloud Phone style)

```
[J2ME phone] --HTTP--> [server: Node + headless Chromium] ----------------------------> facebook.com
   shows JPEG/PNG          renders page, executes click/scroll/type
```

## Install the app
Download `FbClient.jad` + `FbClient.jar` from the
[latest release](https://github.com/leeanh1999/fbclient/releases/latest). Release builds are
preverified (class 45 + StackMap) for real phones (Nokia E6 / S60) and point at
`http://10.15.188.183:5080` (`client/prod.conf`).

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
`HOME_URL` (https://m.facebook.com/), `IDLE_MIN` (5; minutes before an idle phone's browsers close), `DESK_IDLE_MIN` (2; minutes the Messenger browser stays open unused once the phone is back on Facebook), `CHANNEL` (chrome; empty = bundled Chromium),
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

`r=1.5` / `r=2` (Settings → Resolution → 2/3 / Half): the page is rendered with 1/r of the device
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
`fn=s|r`: the font the phone draws text with (Roboto; `s`: sharp 1-bit, `r`: smooth). The
server lays the page out with the same font (`server/fonts/`), so text lines are as wide as on the
phone. Without `fn` the page keeps its own fonts. A tap on a pinned bar (`position: fixed`) lands
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

Responses: `200` image, `204` unchanged (same `hash`); headers `X-Url`, `X-Hash`, `X-Oy`,
`X-Focus: x,y,w,h` (D-pad focus in image px, drawn by the phone, so moving it needs no new frame).
`X-Loading: messenger` / `facebook`: the request moves between the mobile view and the desktop
(Messenger) view (menu, Messenger tab, Back from Messenger's start, Home, a link), which takes
seconds; the server answers at once with the old page and switches in the background, and the
session's next request waits for it. Meanwhile the phone shows a white splash with that logo
(`res/messenger*.png`, `res/facebook*.png`; also right away for its own Messenger and Home buttons)
until a reply to a request sent after it arrives.

Overscan (`ov` = % of view height, client sends 100, or 50 after running out of memory, when frames
average over 450 ms to download + decode (e.g. Nokia E6), or when Settings → Frame size is "Short";
saved in RMS since a change relaunches the browser on the server): in the mobile view the viewport is rendered
`ov`% taller above and below the phone's view; `X-Oy` says where the view starts in the image.
`op=scroll` moves the view inside that buffer and re-centres it by scrolling the window (falls back
to mouse wheel for inner scroll areas). Off in the desktop/Messenger view.
`GET /vs?k=` → `dl <pct>` / `ready` / `err <msg>`; `GET /v/<k>.mp4` → MP4 with Range support.

## Client (MIDP 2.0 / CLDC 1.1)
Phone build (JDK 11+ and Maven; ECJ + ProGuard preverify, as in CI) → `client/build/`:
```sh
bash client/build.sh [dev|prod]
```
Offline build for emulators only (JDK only, no downloads; class version 48, not preverified)
→ `client/dist/`:
```sh
sh client/build-emu.sh [dev|prod]
```

Default server URL is set at build time (JAD/manifest attribute `FbClient-Server`) and can be
changed in Menu → Settings → Server (empty = back to the build default; `http://` is added if missing):
- `dev` (default): `http://127.0.0.1:8080`
- `prod`: `SERVER_URL` from env or `client/prod.conf` (`http://10.15.188.183:5080`)

BlackBerry (detected from `microedition.platform`): every connection gets a transport suffix chosen
in Settings → Connection: WiFi (`;interface=wifi`, default), mobile data (`;deviceside=true`) or
BIS/MDS (none). The letter keys W E R / S D F / Z X C act as 1–9, Q as #, A as *.

If the emulator locks the jar: `OUT=dist-new sh client/build-emu.sh`.

Other settings use defaults (access key empty, zoom 100%, JPEG, quality 75; tuned for WiFi phones
like the Nokia E6) and can be changed in Menu → Settings.

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

If images don't show, switch **Image format** to PNG in Settings (some phones lack JPEG decoding).
