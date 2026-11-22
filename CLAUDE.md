# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A "cloud phone" Facebook client for old J2ME phones (Nokia E6 / S60). The phone app is a thin
client that only shows images and forwards input; a Node server drives headless Chromium
(Playwright), renders facebook.com and returns screenshots.

```
[J2ME phone: client/] --HTTP /a, /img, /vs, /v/--> [server/server.js + Chromium] --> facebook.com
```

`README.md` is the protocol spec (ops, query params, `X-*` response headers, key map). Keep it in
sync when changing the wire protocol, because both sides must agree.

## Commands

No test suite or linter exists. CI smoke-tests the Docker image (`.github/workflows/docker.yml`)
and checks the J2ME bytecode (`.github/workflows/j2me.yml`).

Server (`server/`, Node 22, single file `server.js`):
```sh
cd server && npm install && npm start          # :8080
npx playwright install chromium                 # if Google Chrome is missing (or set CHANNEL=)
HOME_URL='data:text/html,<h1>x</h1>' npm start  # test without Facebook, like CI does
curl -D- -o f.jpg 'http://127.0.0.1:8080/a?id=dev&w=240&h=320&ov=100'   # fetch one frame
```
Running locally (no `NODE_ENV=production`), set `PROXY=socks5://host:port` to route Chromium and
yt-dlp through a proxy (e.g. where Facebook is blocked). Production/Docker always connects directly.

Client (`client/`, run from repo root, Git Bash on Windows):
```sh
bash client/build.sh                 # real phones -> client/build/ (JDK 11+, Maven downloads ECJ+ProGuard)
sh client/build-emu.sh               # emulators only -> client/dist/ (JDK + python, offline, stubs)
OUT=dist-new sh client/build-emu.sh  # when the emulator locks dist/FbClient.jar
VERSION=1.2.3 bash client/build.sh
```
The jar carries no server address: on its first start the app asks for it (a text box until one
is given), saves it in RMS, and Settings changes it later.
`client/res/` (app icon) is packed into the jar root. Every `Connector.open`/`createPlayer` URL must go
through `app.connUrl()` (BlackBerry transport suffix).

Docker / deploy: `docker build server`; the published image is `ghcr.io/leeanh1999/fbclient`
(**arm64 only**, Synology NAS, host port 5080). `deploy.sh` runs on the NAS. A push to main that
changes `client/**` rebuilds the app and replaces `FbClient.jar/.jad` in the latest GitHub release
(no new release; MIDlet-Version = that release's a.b + the run number).

Rooted Android phone (arm64, e.g. Redmi Note 5) instead of the NAS: no Docker there, so
`android/pull-image.py` pulls the published image from GHCR and unpacks it as a rootfs, and
`android/fbclient.sh` runs it in a chroot (port 5080; data bound from `/data/local/fbclient/data`;
Magisk `service.d` autostart) plus `android/files.py` on port 8090, which serves the latest release's
`FbClient.jad/.jar` for OTA installs. On the phone (Termux, `pkg install python`):
`su -c "sh /sdcard/fbclient/fbclient.sh update"`. From the PC over SSH (Termux sshd, 8022):
`PHONE=<ip> SSH_USER=<u> bash android/deploy-phone.sh [update|scripts|local|status|log|rollback]`.

## Client constraints (MIDP 2.0 / CLDC 1.1)

- Source level 1.3, target 1.1 (ECJ), then ProGuard preverifies to class version 45 + StackMap.
  CI fails otherwise. No generics, autoboxing, enhanced for, varargs, enums, `String.format`,
  collections beyond `Vector`/`Hashtable`, or other Java 5+/J2SE-only APIs.
- **No nested, inner or anonymous classes** (CI rejects any `*$*.class`; KEmulator fails on them).
  Use top-level package-private classes instead (see `UiTask`, which dispatches UI work by an
  int `kind` through `Display.callSerially`).
- `client/stubs/` are hand-written API stubs used only by `build-emu.sh`. If you use a MIDP/MMAPI
  method that the stubs lack, add it there too. `fix_sb.py` patches the emulator build
  (`StringBuilder`→`StringBuffer`, class version 48).

Client structure (`client/src/fbc/`): `FbMidlet` (settings in RMS, forms, server URL) ·
`BrowserCanvas` (draws frames, focus rectangle, touch/key handling) · `Net` (single background
worker thread with an action queue; after each action it polls frames every 250 ms until 3 are
unchanged or 6 s pass) · `TextFrame` (text mode: draws the server's text lines with phone
fonts over a text-free screenshot) · `PageView` (page mode: parses and paints drawing commands,
scrolled locally) · `ImageLoader` (page mode images from `/img`, own thread, cached by key) · `FocusRing` (D-pad
outline) · `VideoView` (native MMAPI player)
· `FeedCanvas` / `FeedPost` (own News Feed screen: posts from `/f` as data, laid out and drawn
here; the start screen and Home) · `ChatCanvas` / `ChatItem` (own Messenger screen from `/m`:
chat list and thread, polled; Messenger) · `ReaderCanvas` / `ReaderRow` (every other page from
`/p`: rows of text runs, images, inputs, flowed and drawn here). The browser view (`BrowserCanvas`)
is only for logging in and Messenger's PIN (`X-Need` / `X-State`, `FbMidlet.assist`), plus key 9 in
the reader · `ImageSource` (those screens' images for `ImageLoader`)
· `MenuOverlay` / `Icons` (vector-drawn UI) · `TextFont` (all text the app draws: the phone's
own fonts, SMALL / MEDIUM / LARGE picked from the CSS px size by `TextFrame`, one size up or down
with Settings > Text size) · `Emoji` (phone fonts lack emoji: the server sends each as a Private
Use Area character plus an `X char key w h` line; `TextFont` draws those characters as `/img`
images, so every screen shows emoji).

## Server architecture (`server/server.js`)

- `sessions` Map keyed by the phone's `id` (clientId). Each session has two persistent Chromium
  profiles in `<DATA_DIR>/profiles/<id>-{mob,desk}`: mobile UA on m.facebook.com, and desktop UA
  for Messenger (`DESKTOP_URL`, or when the `MESSENGER_WALL` text appears). `switchMode` copies
  cookies between them. `reapIdle` closes sessions after `IDLE_MIN`.
- `pageHelpers()` is an init script injected into every page. It runs **in the browser**, not
  Node. It blocks inline video, hides "open app" buttons, and implements D-pad focus navigation as
  `window.__fbc`, used by `op=move/activate/click`.
- `handle()` routes `/ping`, `/a` (one action + screenshot; `runAction` switch on `op`), `/img`,
  `/vs` and `/v/<k>.mp4` (video).
- Text mode (`m=t`): `__fbc.textDump` lists visible text lines, the screenshot hides glyphs
  (`HIDE_TEXT_CSS`) and the body is text (`X-Text` bytes) + image. Falls back to a plain screenshot.
- Page mode (`m=p&sy=`): `__fbc.pageDump` returns drawing commands for a long stretch plus image
  recipes (`addRecipes`, per session); `placeView` (mobile) or `__fbc.paneTo` (desktop: the inner
  scrolling pane is the document) puts the server's view at the phone's `sy` before each action.
  `/img` renders recipes in an extra tab of the session's mobile browser (`imgPage`, left alone by
  the popup handler) into PNG/JPEG sheets. `__fbc.dumpKey` lets polls skip unchanged dumps. Check changes by rendering a dump next to a screenshot of the same state.
- Feed screen (`/f`, `feedAction`): `__fbc.feedDump` reads posts from m.facebook.com's Bloks
  feed by layout (`[data-tracking-duration-id]` blocks: avatar + bold title, body, media, button
  row); keys are content hashes (the attribute changes on scroll). `__fbc.feedTarget` finds where
  to tap for like/open. The feed arrives over a WebSocket, so there is no API to intercept.
- Reader (`/p`, `readerAction`): `__fbc.readerDump` reads any page into rows of items; pressable
  elements get `data-fbc-k` keys that `op=press/type/video` act on (`__fbc.readerTarget`).
- Chat screen (`/m`, `chatAction`): `__fbc.chatList` / `chatThread` read Messenger's desktop
  view at phone width (message text from each `[role=article]`'s aria-label, own messages by
  position). Threads must be opened by tapping their row; a URL shows the list at this width.
- Responses use a hash so the client gets `204` when the frame is unchanged. Overscan (`ov`)
  renders a taller image in the mobile view, and `X-Oy` gives the view offset.
- Video: the server never plays video in Chromium. It finds the MP4 URL, downloads it with yt-dlp
  into `<DATA_DIR>/video/` (24 h cache), and streams the growing file once the `moov` atom + 128 KB
  arrive (`mp4Head`, `streamGrowingVideo`).

UI text on Facebook is Vietnamese. Regexes such as `MESSENGER_WALL` match both Vietnamese and
English strings.

## Conventions

- Commit messages: short Vietnamese without diacritics (e.g. `Phim dieu huong nhanh hon, ...`).
- `.sh` files and `Dockerfile` must stay LF (`.gitattributes`); CRLF breaks the container.
- Never commit `server/data/` (Facebook logins per phone).
- CI by path: `server/**` builds only the Docker image (`docker.yml`), `client/**` only the app
  (`j2me.yml`); docs-only commits build nothing.
