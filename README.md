# fbclient — J2ME Facebook thin client (Cloud Phone style)

```
[J2ME phone] --HTTP--> [server: Node + headless Chromium] --SOCKS5 proxy-host:1080--> facebook.com
   shows JPEG/PNG          renders page, executes click/scroll/type
```

## Install the app
Download `FbClient.jad` + `FbClient.jar` from the
[latest release](https://github.com/leeanh1999/fbclient/releases/latest). Release builds are
preverified (class 45 + StackMap) for real phones (Nokia E6 / S60) and point at
`http://10.15.188.183:5080` (`client/prod.conf`).

## Deploy on Synology NAS (Docker)
1. Container Manager → Project → Create, paste [`docker-compose.yml`](docker-compose.yml)
   (image `ghcr.io/leeanh1999/fbclient:latest`, amd64 + arm64, port **5080**).
2. The proxy `proxy-host` is a Tailscale address: the NAS must be on the same tailnet
   (Tailscale package for DSM) for the container to reach it.
3. Updates: put [`deploy.sh`](deploy.sh) next to the compose file and run `sudo ./deploy.sh`
   (pulls the image, restarts, waits for health, copies the latest app release to `APP_DIR`).

On ARM NAS models the image uses Playwright Chromium (Google Chrome has no ARM build): pages and
the native video player work, but videos playing *inside* the page in Live view need Chrome's H.264
codec, which only the amd64 image has. Each phone uses roughly 0.6–1 GB RAM while active.

CI (`.github/workflows`): `docker.yml` builds + smoke-tests the image and pushes it to GHCR;
`j2me.yml` builds the prod app, checks the bytecode and, on `v*` tags, attaches it to the release.

## Server
Requires Google Chrome (H.264 codecs for Facebook video) and `yt-dlp` on PATH (video playback).
```powershell
cd server
npm install
npx playwright install chromium   # fallback if Chrome is missing
npm start                         # listens on :8080
```
Env vars: `PORT` (8080), `PROXY` (socks5://host:port), `TOKEN` (access key, empty = none),
`HOME_URL` (https://m.facebook.com/), `IDLE_MIN` (30), `CHANNEL` (chrome; empty = bundled Chromium),
`YTDLP` (yt-dlp), `DATA_DIR` (`server/data`; `/data` in Docker).

Each phone gets two persistent Chrome profiles in `<DATA_DIR>/profiles/<clientId>-{mob,desk}`:
- `mob`: Android UA, m.facebook.com
- `desk`: desktop UA, used automatically for `facebook.com/messages`, messenger.com, m.me, and when
  the m.facebook.com Messenger tab shows its in-page "Tải ứng dụng Messenger" wall (detected by text
  for 8 s after a tap). Cookies are copied
  between them; IndexedDB persists so the Messenger E2EE PIN is asked only once.

Video: `op=video` finds the video under (x,y) (or the most visible one), downloads it with yt-dlp
through the proxy into `server/data/video/` (kept 24h), then the phone plays it natively.

API: `GET /a?id=&w=&h=&z=&f=jpg|png&q=&hash=&key=&op=...`
| op | params | action |
|---|---|---|
| (none) | | screenshot |
| click | x,y | click; returns `X-Input`/`X-Value` if a text field got focus |
| scroll | x,y,dx,dy | mouse wheel |
| type | t | replace focused field's text |
| key | k | press key (Enter, Backspace…) |
| nav | u | open URL |
| back / fwd / reload / home | | |
| video | x,y (optional) | start video download; returns `X-Video: <k>` or `X-Video-Err` |

Responses: `200` image, `204` unchanged (same `hash`); headers `X-Url`, `X-Hash`, `X-Oy`.

Overscan (`ov` = % of view height, client sends 100, or 50 after running out of memory): in the mobile view the viewport is rendered
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

Server URL is fixed at build time (JAD/manifest attribute `FbClient-Server`), not editable in the app:
- `dev` (default): `http://127.0.0.1:8080`
- `prod`: `SERVER_URL` from env or `client/prod.conf` (`http://10.15.188.183:5080`)

If the emulator locks the jar: `OUT=dist-new sh client/build-emu.sh`.

Other settings use defaults (access key empty, zoom 100%, JPEG, quality 75; tuned for WiFi phones
like the Nokia E6) and can be changed in Menu → Settings.

Frames: after every action the client polls every 250 ms until 3 unchanged frames (max 6 s).

**Live view** (menu): `GET /live?<same params as /a>` keeps one connection open; the server pushes
Chrome screencast JPEGs (`F <oy> <len>\n` + bytes, raw HTTP/1.0 body) only when the page changes,
and asks Chrome for the next frame only after the socket took the previous one (download speed sets
the FPS; ~28 fps measured locally on a playing video, quality capped at 65). The stream follows
mobile/desktop view switches. If no frame arrives (phone HTTP stack buffers), the client falls back
to polling every 60 ms.

Icons are vector-drawn and anti-aliased (3x supersampled into a cached ARGB image).

Touch: tap = click, drag = scroll (vertical only, with live preview; flick = scroll further),
long-press = play video under finger. Footer (touch screens): Menu · Home · Back (vector icons).

Menu: bottom sheet over the dimmed page with icon tiles — Type text, Enter, Go to URL, Messenger,
Play video, Live, Forward, Reload, Settings, Exit (+ Home on keypad-only phones). Arrows + FIRE or tap.

Saved across restarts (RMS): access key, zoom, image format, JPEG quality, Live view.

Video player: tap/5 = pause, 4/6 = −/+10 s, 2/8 = volume, # / right soft = close.

| Key | Action |
|---|---|
| Arrows | move cursor (hold = accelerate, push at edge = scroll) |
| 5 / FIRE | click (tapping a text field opens the input box) |
| 2 / 8 | scroll up / down |
| 4 / 6 | scroll left / right |
| 1, # / right soft | back |
| 3 | refresh screen |
| 7 | go to URL |
| 9 | Enter |
| 0 | type text |
| * / left soft | open/close menu |

If images don't show, switch **Image format** to PNG in Settings (some phones lack JPEG decoding).
