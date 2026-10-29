package fbc;

import javax.microedition.lcdui.Canvas;
import javax.microedition.lcdui.Font;
import javax.microedition.lcdui.Graphics;
import javax.microedition.lcdui.Image;

/**
 * Full-screen view of the remote page, similar to Cloud Phone.
 *
 * Keys: arrows move the focus between links/buttons (the server highlights
 * it and scrolls to it), FIRE/5 presses it, 2/8 scroll page, 4/6 scroll
 * sideways, 1 back, 3 refresh, 7 URL, 9 Enter, 0 type text,
 * left soft/* menu, right soft/# back.
 * Touch: tap click, drag/flick scroll, long-press play video,
 * footer Menu | Home | Back.
 * Pressing a video opens the native player (the server finds and fetches
 * it); a play button drawn over a video (X-Video-Offer) does the same.
 */
class BrowserCanvas extends Canvas implements Runnable {

    private static final int TICK_MS = 40;
    private static final int LONG_PRESS_MS = 600;
    private static final int DRAG_SLOP = 12;
    // Holding an arrow: first repeat after REPEAT_DELAY ticks, then every
    // REPEAT_EVERY ticks (only when the previous move has been answered).
    private static final int REPEAT_DELAY = 8;
    private static final int REPEAT_EVERY = 4;
    private static final int OFFER_MS = 15000;
    // BlackBerry trackpad: one swipe fires many arrow events; drop extras
    // while the previous move is still in flight.
    private static final int TRACKPAD_GAP_MS = 150;
    private long lastMoveAt;

    private Image logo;
    private volatile boolean alive = true;
    // Busy indicator area, top-right corner.
    private static final int BUSY_W = 30;
    private static final int BUSY_H = 14;

    private static final int[] FOOTER = {Icons.MENU, Icons.HOME, Icons.BACK};

    private final FbMidlet app;
    private final Font font = Font.getFont(Font.FACE_SYSTEM, Font.STYLE_PLAIN, Font.SIZE_SMALL);
    private final boolean touch;
    private final int barH;
    private final MenuOverlay menu;
    private int barPress = -1; // footer button under the finger

    private Image image;
    // The frame is taller than the view (server overscan); imgOy is where
    // the view starts inside it.
    private int imgOy;
    // Scroll sent to the server but not yet reflected in a frame, and the
    // eased amount currently drawn. Both in device px, + = page moves up.
    private int pendingDy, shownDy;

    // Page mode (PageView): the page as drawing commands, scrolled here.
    // pageSy is the document y at the top of the view, pageTarget where an
    // eased scroll (keys, flick) is heading. Both phone px.
    volatile PageView page;
    volatile int pageSy;
    private int pageTarget;
    private int pressSy;
    // Requests already made for this stretch / this page height.
    private PageView rangeAsked;
    private int moreAsked = -1;
    private int olderAsked = -1;
    private static final int LIVE_HOLD_MS = 300;
    private long liveHoldUntil;
    // D-pad focus: direction held ('u', 'd', 'l', 'r' or 0) and for how long.
    private char holdDir;
    private int holdTicks;
    // Menu highlight follows keys only while the user is using them.
    private boolean touchMode;

    // D-pad focus rect in image coordinates (x, y, w, h), or null. Drawn here
    // rather than in the page so moving it needs no new screenshot.
    private int[] focus;

    // Play button over a pressed video (view coordinates), until offerUntil.
    private int offerX, offerY, offerW, offerH;
    private long offerUntil;

    private String toastMsg;
    private long toastUntil;

    // Moving between Facebook and Messenger (server X-Loading, or the menu):
    // a white splash with the destination's logo until its first frame.
    // When it was shown, 0 = hidden.
    private volatile long splashAt;
    private volatile int splashTo;
    static final int SPLASH_MESSENGER = 0;
    static final int SPLASH_FACEBOOK = 1;
    private static final String[] SPLASH_NAME = {"Messenger", "Facebook"};
    private static final String[] SPLASH_RES = {"messenger", "facebook"};
    private static final int[] SPLASH_COLOR = {0x0A7CFF, 0x0866FF};
    private static final int[] SPLASH_ICON = {Icons.MESSENGER, Icons.HOME};
    private static final int SPLASH_MAX_MS = 20000;
    private static final int SPLASH_BG = 0xFFFFFF;
    // Logos from the jar (res/<name>48.png, 64.png), loaded on first use;
    // a vector icon if they can't be.
    private final Image[] splashLogo = new Image[2];
    private final boolean[] splashTried = new boolean[2];

    // Touch state
    private boolean pressed, dragging, longFired, pressOnBar;
    // Touch scrolling is vertical only: pages are laid out to the screen
    // width, so sideways drags would just reveal blank bands.
    private int px0, py0, dragY;
    private long pressAt;
    private int lastY;
    private long lastT;
    private int velY; // px per 100 ms
    private int tapX, tapY;
    private long tapUntil;

    BrowserCanvas(FbMidlet app) {
        this.app = app;
        setFullScreenMode(true);
        touch = hasPointerEvents();
        touchMode = touch;
        barH = touch ? Math.max(font.getHeight() + 22, 46) : 0;
        menu = new MenuOverlay(!touch);
        try {
            logo = Image.createImage("/icon.png");
        } catch (Exception e) {
            // Splash without logo.
        }
        // Plain thread instead of an anonymous TimerTask: KEmulator fails to
        // load nested classes.
        new Thread(this).start();
    }

    /** Tick loop: key repeat, long-press, animations, toast expiry. */
    /** Ends the tick thread (app exit). */
    void dispose() {
        alive = false;
    }

    public void run() {
        while (alive) {
            try {
                Thread.sleep(TICK_MS);
            } catch (InterruptedException e) {
                // continue
            }
            tick();
        }
    }

    /** Height of the page area sent to the server (screen minus toolbar). */
    int viewHeight() {
        return getHeight() - barH;
    }

    /**
     * Called once per server reply. img is null when the frame is unchanged
     * or the request failed; appliedDy is the scroll this reply accounts for.
     */
    synchronized void applyFrame(Image img, int oy, int appliedDy) {
        pendingDy -= appliedDy;
        if (img != null) {
            page = null; // server fell back to images (e.g. Messenger)
            image = img;
            imgOy = oy;
            // The new frame already contains the scroll: no visual jump.
            shownDy -= appliedDy;
        }
        // Unchanged frame after a scroll (e.g. page end): shownDy eases back.
        liveHoldUntil = System.currentTimeMillis() + LIVE_HOLD_MS;
        repaint();
    }

    /**
     * Frame pushed by the live stream. Skipped while the user is touching
     * or a scroll is in flight, so the local scroll prediction never jumps;
     * also briefly after an action reply, as a stream frame captured before
     * that action could still be in transit.
     */
    synchronized void applyLiveFrame(Image img, int oy) {
        if (page != null || pressed || pendingDy != 0 || shownDy != 0
                || System.currentTimeMillis() < liveHoldUntil
                || (app.net != null && app.net.userBusy)) {
            return;
        }
        image = img;
        imgOy = oy;
        repaint();
    }

    /**
     * Page mode reply. sy is where the server has the view now, sentSy where
     * the phone had it when asking: a local scroll made meanwhile is kept and
     * only what the server moved (focus, navigation) is added.
     */
    void applyPage(PageView p, int sy, int sentSy) {
        synchronized (this) {
            if (page == null || sentSy < 0) {
                pageSy = sy;
                pageTarget = sy;
            } else {
                pageSy += sy - sentSy;
                pageTarget += sy - sentSy;
            }
            page = p;
            image = null;
            int[] f = focus;
            if (f != null && f.length >= 6) {
                int[] g = p.snapFocus(f);
                if (g != null) {
                    focus = g;
                }
            }
            int max = p.maxScroll(viewHeight());
            pageSy = FbMidlet.clamp(pageSy, 0, max);
            pageTarget = FbMidlet.clamp(pageTarget, 0, max);
            liveHoldUntil = System.currentTimeMillis() + LIVE_HOLD_MS;
        }
        repaint();
        pageMoved();
    }

    /** View position for requests in page mode, -1 otherwise. */
    int pageScroll() {
        return page != null ? pageSy : -1;
    }

    /**
     * After the view moved in page mode: fetch the images now in reach, a
     * new stretch when close to an edge of this one, and more of the page
     * (feed) when close to its end.
     */
    private void pageMoved() {
        PageView p = page;
        if (p == null) {
            return;
        }
        app.loader.wake();
        int sy = pageSy;
        int vh = viewHeight();
        if (((p.top > 0 && sy < p.top + vh) || (p.bottom < p.height && sy + 2 * vh > p.bottom))
                && rangeAsked != p) {
            rangeAsked = p;
            app.net.refresh();
        }
        if (sy + 2 * vh >= p.height && moreAsked != p.height) {
            moreAsked = p.height;
            app.net.action("op=more");
        }
        // A pane (Messenger thread) loads older items at its top.
        if (p.paneH > 0 && sy < vh && olderAsked != p.height) {
            olderAsked = p.height;
            app.net.action("op=more&top=1");
        }
    }

    /** Page mode: scroll the view by dy with easing. */
    private void pageScrollBy(int dy) {
        PageView p = page;
        if (p == null) {
            return;
        }
        synchronized (this) {
            pageTarget = FbMidlet.clamp(pageTarget + dy, 0, p.maxScroll(viewHeight()));
        }
        repaint();
    }

    /**
     * Focus rect (x, y, w, h; image coordinates from the server, or in page
     * mode a PageView focus), null = none.
     */
    void setFocus(int[] r) {
        int[] old = focus;
        focus = r;
        PageView p = page;
        boolean moved = r != null && (old == null || old[0] != r[0] || old[1] != r[1]);
        if (p != null && moved && !(r.length >= 6 && r[5] != 0)) {
            // Page mode: the server only moved the focus; bring it into view
            // (only when it moved, as every reply repeats it).
            int vh = viewHeight();
            int pad = 12;
            synchronized (this) {
                int t = pageTarget;
                if (r[1] < t + pad) {
                    t = r[1] - pad;
                } else if (r[1] + r[3] > t + vh - pad) {
                    t = Math.min(r[1] - pad, r[1] + r[3] - vh + pad);
                }
                pageTarget = FbMidlet.clamp(t, 0, p.maxScroll(vh));
            }
        }
        repaint();
    }

    /** The server says the press landed on a video: show a play button. */
    void showVideoOffer(int x, int y, int w, int h) {
        offerX = x;
        offerY = y;
        offerW = w;
        offerH = h;
        offerUntil = System.currentTimeMillis() + OFFER_MS;
        repaint();
    }

    private boolean offerShown() {
        return offerUntil > System.currentTimeMillis();
    }

    private void clearOffer() {
        if (offerUntil != 0) {
            offerUntil = 0;
            repaint();
        }
    }

    // Play button geometry: centred on the visible part of the video.
    private int offerSize() {
        return Math.max(48, Math.min(84, Math.min(offerW, offerH) / 2));
    }

    private int offerCx() {
        return offerX + offerW / 2;
    }

    private int offerCy() {
        int r = offerSize() / 2 + 6;
        int top = Math.max(offerY, 0);
        int bottom = Math.min(offerY + offerH, viewHeight());
        return FbMidlet.clamp((top + bottom) / 2, r, viewHeight() - r);
    }

    private void playOffer() {
        int x = offerCx();
        int y = offerCy();
        clearOffer();
        playVideo(x, y);
    }

    /** to: SPLASH_MESSENGER or SPLASH_FACEBOOK. */
    void showSplash(int to) {
        splashTo = to;
        splashAt = System.currentTimeMillis();
        repaint();
    }

    /**
     * A reply without X-Loading arrived: hide the splash, unless the request
     * was sent before it was shown (it may predate the switch).
     */
    void hideSplash(long requestAt) {
        long at = splashAt;
        if (at != 0 && requestAt >= at) {
            splashAt = 0;
            repaint();
        }
    }

    private boolean splashShown() {
        long at = splashAt;
        return at != 0 && System.currentTimeMillis() - at < SPLASH_MAX_MS;
    }

    private void drawSplash(Graphics g, int w, int vh) {
        g.setColor(SPLASH_BG);
        g.fillRect(0, 0, w, vh);
        int to = splashTo;
        if (!splashTried[to]) {
            splashTried[to] = true;
            try {
                splashLogo[to] = Image.createImage("/" + SPLASH_RES[to]
                        + (Math.min(w, vh) >= 360 ? "64" : "48") + ".png");
            } catch (Exception e) {
                // vector icon below
            }
        }
        Image logoImg = splashLogo[to];
        int s = logoImg != null ? logoImg.getHeight() : 48;
        int cy = vh / 2 - s / 3;
        if (logoImg != null) {
            g.drawImage(logoImg, w / 2, cy, Graphics.HCENTER | Graphics.VCENTER);
        } else {
            Icons.drawSmooth(g, SPLASH_ICON[to], w / 2, cy, s, SPLASH_COLOR[to], SPLASH_BG);
        }
        g.setFont(font);
        g.setColor(0x65676B);
        int ty = cy + s / 2 + 10;
        g.drawString(SPLASH_NAME[to], w / 2, ty, Graphics.TOP | Graphics.HCENTER);
        // Three dots, one lit at a time.
        int phase = (int) ((System.currentTimeMillis() / 250) % 3);
        int dy = ty + font.getHeight() + 14;
        for (int i = 0; i < 3; i++) {
            Icons.drawSmooth(g, Icons.CIRCLE, w / 2 + (i - 1) * 16, dy, 8,
                    i == phase ? SPLASH_COLOR[to] : 0xBCC0C4, SPLASH_BG);
        }
    }

    void toast(String msg) {
        toastMsg = msg;
        toastUntil = System.currentTimeMillis() + 2500;
        repaint();
    }

    // ---- Painting ----

    protected void paint(Graphics g) {
        int w = getWidth();
        int h = getHeight();
        int vh = viewHeight();
        g.setColor(0xFFFFFF);
        g.fillRect(0, 0, w, vh);
        PageView pv = page;
        if (pv != null) {
            int sy = pageSy;
            pv.paint(g, sy, w, vh, app.loader.cache);
            g.setClip(0, 0, w, h);
            int[] f = focus;
            if (f != null) {
                boolean pinned = f.length >= 6 && f[5] != 0;
                FocusRing.draw(g, f[0], pinned ? f[1] : f[1] - sy, f[2], f[3], f.length >= 5 ? f[4] : 8);
                g.setClip(0, 0, w, h);
            }
        } else if (image != null) {
            // Stop at the edges of the overscan buffer instead of showing
            // blank space; the next frame brings more content.
            int y = dragY - imgOy - shownDy;
            int ih = image.getHeight();
            if (ih <= vh) {
                // No buffer (Messenger's desktop view): never shift the
                // frame locally. Only an inner list scrolls there, so moving
                // the whole image would drag the header and composer along
                // and uncover blank space; frequent scroll requests while
                // dragging show the list moving instead.
                y = 0;
            } else if (y > 0) {
                y = 0;
            } else if (y + ih < vh) {
                y = vh - ih;
            }
            g.drawImage(image, 0, y, Graphics.TOP | Graphics.LEFT);
            int[] f = focus;
            if (f != null) {
                FocusRing.draw(g, f[0], y + f[1], f[2], f[3], 8);
            }
        } else {
            g.setFont(font);
            g.setColor(0x1877F2);
            int ty = vh / 2;
            if (logo != null) {
                g.drawImage(logo, w / 2, vh / 2, Graphics.BOTTOM | Graphics.HCENTER);
                ty += font.getHeight() + 8;
            }
            g.drawString("Loading...", w / 2, ty, Graphics.BASELINE | Graphics.HCENTER);
        }

        if (splashShown()) {
            drawSplash(g, w, vh);
        }

        if (offerShown()) {
            int d = offerSize();
            int cx = offerCx();
            int cy = offerCy();
            Icons.drawSmooth(g, Icons.CIRCLE, cx, cy, d + 6, 0xFFFFFF, 0xFFFFFF);
            Icons.drawSmooth(g, Icons.CIRCLE, cx, cy, d, 0x1877F2, 0x1877F2);
            Icons.drawSmooth(g, Icons.PLAY, cx, cy, d * 9 / 20, 0xFFFFFF, 0x1877F2);
        }

        if (app.net != null && app.net.userBusy) {
            // Busy indicator, top-right corner.
            int phase = (int) ((System.currentTimeMillis() / 150) % 3);
            for (int i = 0; i < 3; i++) {
                g.setColor(i == phase ? 0x1877F2 : 0xA0B8E0);
                g.fillRect(w - BUSY_W + 4 + i * 8, 4, 6, 6);
            }
        }

        if (System.currentTimeMillis() < tapUntil) {
            g.setColor(0x1877F2);
            g.drawArc(tapX - 16, tapY - 16, 32, 32, 0, 360);
            g.drawArc(tapX - 15, tapY - 15, 30, 30, 0, 360);
        }

        if (toastMsg != null) {
            if (System.currentTimeMillis() > toastUntil) {
                toastMsg = null;
            } else {
                drawToast(g, toastMsg, w, vh);
            }
        }

        if (menu.open) {
            menu.paint(g, w, vh, font, app.live, !touchMode,
                    app.net == null ? "" : app.net.currentUrl);
        }
        if (barH > 0) {
            drawFooter(g, w, h);
        }
    }

    private void drawFooter(Graphics g, int w, int h) {
        int y = h - barH;
        g.setColor(0xFFFFFF);
        g.fillRect(0, y, w, barH);
        g.setColor(0xDADDE1);
        g.drawLine(0, y, w, y);
        int n = FOOTER.length;
        int s = Math.min(26, barH / 2);
        for (int i = 0; i < n; i++) {
            int bx = (2 * i + 1) * w / (2 * n);
            int by = y + barH / 2;
            boolean active = i == 0 && menu.open;
            int back = active ? 0xE7F3FF : (i == barPress ? 0xE4E6EB : 0xFFFFFF);
            if (i == barPress || active) {
                Icons.drawSmooth(g, Icons.CIRCLE, bx, by, barH - 8, back, back);
            }
            Icons.drawSmooth(g, FOOTER[i], bx, by, s, active ? 0x1877F2 : 0x65676B, back);
        }
    }

    private void drawToast(Graphics g, String msg, int w, int h) {
        g.setFont(font);
        int tw = Math.min(font.stringWidth(msg) + 12, w);
        int th = font.getHeight() + 6;
        int x = (w - tw) / 2;
        int y = h - th - 6;
        g.setColor(0x333333);
        g.fillRoundRect(x, y, tw, th, 8, 8);
        g.setColor(0xFFFFFF);
        g.drawString(msg, w / 2, y + 3, Graphics.TOP | Graphics.HCENTER);
    }

    // ---- Tick ----

    private void tick() {
        boolean dirty = false;
        long now = System.currentTimeMillis();
        if (holdDir != 0) {
            holdTicks++;
            if (holdTicks >= REPEAT_DELAY && holdTicks % REPEAT_EVERY == 0 && (page != null || app.net.idle())) {
                move(holdDir);
            }
        }
        if (menu.tick()) {
            dirty = true;
        }
        if (pressed && !dragging && !longFired && !pressOnBar && !menu.open
                && now - pressAt >= LONG_PRESS_MS) {
            longFired = true;
            playVideo(px0, py0);
        }
        if (toastMsg != null && now > toastUntil) {
            dirty = true;
        }
        if (splashAt != 0) {
            dirty = true; // animation, and hiding it after SPLASH_MAX_MS
            if (now - splashAt >= SPLASH_MAX_MS) {
                splashAt = 0;
            }
        }
        if (tapUntil > 0 && now > tapUntil) {
            tapUntil = 0;
            dirty = true;
        }
        if (offerUntil != 0 && now > offerUntil) {
            offerUntil = 0;
            dirty = true;
        }
        if (easeScroll()) {
            dirty = true;
        }
        if (easePage()) {
            dirty = true;
            pageMoved();
        }
        if (dirty) {
            repaint();
        } else if (app.net != null && app.net.userBusy) {
            // Only the busy dots: a full 640x480 redraw 25 times a second
            // takes CPU from downloading/decoding the frame on slow phones.
            repaint(getWidth() - BUSY_W, 0, BUSY_W, BUSY_H);
        }
    }

    /** Animate the drawn scroll toward the requested one. */
    private synchronized boolean easeScroll() {
        int d = pendingDy - shownDy;
        if (d == 0) {
            return false;
        }
        shownDy += Math.abs(d) <= 3 ? d : d / 2;
        return true;
    }

    /** Page mode: move the view toward pageTarget. */
    private synchronized boolean easePage() {
        if (page == null || pressed) {
            return false;
        }
        int d = pageTarget - pageSy;
        if (d == 0) {
            return false;
        }
        pageSy += Math.abs(d) <= 3 ? d : d / 2;
        return true;
    }

    // ---- Actions ----

    private void move(char d) {
        if (page != null) {
            pageMove(d);
            return;
        }
        long now = System.currentTimeMillis();
        if (app.blackberry && now - lastMoveAt < TRACKPAD_GAP_MS && !app.net.idle()) {
            return;
        }
        lastMoveAt = now;
        app.net.action("op=move&d=" + d);
    }

    /**
     * Page mode: the focusable items came with the page, so the focus moves
     * here with no request; with nothing further up/down, the view scrolls.
     */
    private void pageMove(char d) {
        PageView p = page;
        int vh = viewHeight();
        int sy = pageTarget;
        int[] cur = focus;
        if (cur != null && (cur.length < 6
                || (cur[5] == 0 && (cur[1] + cur[3] < sy || cur[1] > sy + vh)))) {
            cur = null; // scrolled away from it: start from the view
        }
        int i = p.nextFocus(cur, d, sy, vh);
        if (i < 0) {
            if (d == 'd' || d == 'u') {
                pageScrollBy((d == 'd' ? 1 : -1) * vh * 2 / 3);
            }
            return;
        }
        setFocus(p.focusAt(i));
    }

    /** Page mode 5/FIRE: a click in the middle of the focused item. */
    private void pageActivate() {
        int[] f = focus;
        if (f == null || f.length < 6) {
            return;
        }
        int vy;
        synchronized (this) {
            pageSy = pageTarget; // the click must match the view sent with it
            vy = (f[5] != 0 ? f[1] : f[1] - pageSy) + f[3] / 2;
        }
        click(f[0] + f[2] / 2, FbMidlet.clamp(vy, 0, viewHeight() - 1));
    }

    private void scroll(int x, int y, int dx, int dy) {
        clearOffer();
        synchronized (this) {
            // Show the scroll immediately from the overscan buffer.
            pendingDy += dy;
        }
        app.net.action("op=scroll&x=" + x + "&y=" + y + "&dx=" + dx + "&dy=" + dy);
    }

    private void click(int x, int y) {
        tapX = x;
        tapY = y;
        tapUntil = System.currentTimeMillis() + 300;
        app.net.action("op=click&x=" + x + "&y=" + y);
    }

    private void playVideo(int x, int y) {
        toast("Loading video...");
        app.net.action("op=video&x=" + x + "&y=" + y);
    }

    private void footerPressed(int i) {
        if (i == 0) {
            if (menu.open) {
                closeMenu();
            } else {
                openMenu();
            }
            return;
        }
        closeMenu();
        clearOffer();
        if (i == 1) {
            app.home();
        } else {
            app.net.action("op=back");
        }
    }

    // ---- Menu ----

    void openMenu() {
        holdDir = 0;
        clearOffer();
        menu.show(viewHeight());
        repaint();
    }

    void closeMenu() {
        menu.hide();
        repaint();
    }

    private void menuActivate(int action) {
        closeMenu();
        app.menuAction(action);
    }

    private void menuKey(int k) {
        if (isLeftSoft(k) || isRightSoft(k) || k == KEY_STAR || k == KEY_POUND
                || k == KEY_ESC || k == KEY_BACKSPACE) {
            closeMenu();
            return;
        }
        int ga = gameAction(k);
        if (k == KEY_NUM5 || ga == FIRE || isEnter(k)) {
            menuActivate(menu.selectedAction());
            return;
        }
        touchMode = false;
        switch (ga) {
            case UP: menu.move(0, -1); break;
            case DOWN: menu.move(0, 1); break;
            case LEFT: menu.move(-1, 0); break;
            case RIGHT: menu.move(1, 0); break;
            default: break;
        }
        repaint();
    }

    // ---- Keys ----

    private static boolean isLeftSoft(int k) {
        return k == -6 || k == -21 || k == 21 || k == 57345;
    }

    private static boolean isRightSoft(int k) {
        return k == -7 || k == -22 || k == 22 || k == 57346;
    }

    // QWERTY keys (Nokia E6, BlackBerry): Enter presses, Escape/Backspace go back.
    private static final int KEY_BACKSPACE = 8;
    private static final int KEY_ESC = 27;

    private static boolean isEnter(int k) {
        return k == 10 || k == 13;
    }

    private int gameAction(int k) {
        try {
            return getGameAction(k);
        } catch (Exception e) {
            return 0; // unknown key code on this device
        }
    }

    protected void keyPressed(int k) {
        k = app.mapKey(k);
        if (menu.open) {
            menuKey(k);
            return;
        }
        touchMode = false;
        int ga = gameAction(k);
        boolean fire = k == KEY_NUM5 || isEnter(k) || (ga == FIRE && (k < KEY_NUM0 || k > KEY_NUM9));
        if (offerShown()) {
            if (fire) {
                playOffer();
                return;
            }
            clearOffer();
        }
        if (isLeftSoft(k) || k == KEY_STAR) {
            openMenu();
            return;
        }
        if (isRightSoft(k) || k == KEY_POUND || k == KEY_NUM1 || k == KEY_ESC || k == KEY_BACKSPACE) {
            app.net.action("op=back");
            return;
        }
        int h = viewHeight();
        int w = getWidth();
        if (page != null && (k == KEY_NUM2 || k == KEY_NUM8)) {
            pageScrollBy((k == KEY_NUM2 ? -h : h) * 3 / 4);
            return;
        }
        switch (k) {
            case KEY_NUM2: scroll(w / 2, h / 2, 0, -h * 3 / 4); return;
            case KEY_NUM8: scroll(w / 2, h / 2, 0, h * 3 / 4); return;
            case KEY_NUM4: scroll(w / 2, h / 2, -w / 2, 0); return;
            case KEY_NUM6: scroll(w / 2, h / 2, w / 2, 0); return;
            case KEY_NUM3: app.net.resetHash(); app.net.refresh(); return;
            case KEY_NUM7: app.showUrlInput(); return;
            case KEY_NUM9: app.net.action("op=key&k=Enter"); return;
            case KEY_NUM0: app.showTextInput("", false); return;
            default: break;
        }
        if (fire) {
            if (page != null) {
                pageActivate();
            } else {
                app.net.action("op=activate");
            }
            return;
        }
        char d = 0;
        switch (ga) {
            case UP: d = 'u'; break;
            case DOWN: d = 'd'; break;
            case LEFT: d = 'l'; break;
            case RIGHT: d = 'r'; break;
            default: break;
        }
        if (d != 0) {
            holdDir = d;
            holdTicks = 0;
            move(d);
        }
    }

    protected void keyReleased(int k) {
        holdDir = 0;
    }

    protected void hideNotify() {
        holdDir = 0;
        pressed = false;
        barPress = -1;
    }

    protected void sizeChanged(int w, int h) {
        if (app.net != null) {
            app.net.resetHash();
            app.net.refresh();
        }
    }

    // ---- Touch ----

    protected void pointerPressed(int x, int y) {
        touchMode = true;
        pressed = true;
        dragging = false;
        longFired = false;
        pressOnBar = y >= viewHeight();
        px0 = x;
        py0 = lastY = y;
        pressAt = lastT = System.currentTimeMillis();
        velY = 0;
        synchronized (this) {
            pressSy = pageTarget = pageSy; // a touch stops a flick
        }
        if (pressOnBar) {
            barPress = x * FOOTER.length / getWidth();
            repaint();
        }
    }

    protected void pointerDragged(int x, int y) {
        if (!pressed || pressOnBar || longFired || menu.open) {
            return;
        }
        if (!dragging && (Math.abs(x - px0) > DRAG_SLOP || Math.abs(y - py0) > DRAG_SLOP)) {
            dragging = true;
            clearOffer();
        }
        if (dragging) {
            long now = System.currentTimeMillis();
            long dt = now - lastT;
            if (dt > 0) {
                // Smoothed velocity for flick scrolling.
                velY = (velY + (int) ((y - lastY) * 100 / dt)) / 2;
            }
            lastY = y;
            lastT = now;
            PageView p = page;
            if (p != null) {
                // Page mode: the whole stretch is here, just move the view.
                synchronized (this) {
                    pageSy = pageTarget = FbMidlet.clamp(pressSy + py0 - y, 0, p.maxScroll(viewHeight()));
                }
                pageMoved();
                repaint();
                return;
            }
            // Instant local feedback: shift the current frame.
            dragY = y - py0;
            // Long drag: send what we have so far, so the server refills
            // the buffer while the finger is still moving. Without a buffer
            // send much more often, so the content keeps up with the finger.
            Image img = image;
            int every = img != null && img.getHeight() <= viewHeight() ? viewHeight() / 8 : viewHeight() / 3;
            if (Math.abs(dragY) > every && app.net.idle()) {
                commitDrag(x, y, 0);
                py0 = y;
            }
            repaint();
        }
    }

    /** Turn the finger offset into a scroll request without a visual jump. */
    private void commitDrag(int x, int y, int extra) {
        int dy = py0 - y;
        synchronized (this) {
            shownDy += dy;
            dragY = 0;
        }
        // The extra (flick) part eases in.
        scroll(x, y, 0, dy + extra);
    }

    protected void pointerReleased(int x, int y) {
        if (!pressed) {
            return;
        }
        pressed = false;
        if (pressOnBar) {
            int i = barPress;
            barPress = -1;
            if (y >= viewHeight() && i == x * FOOTER.length / getWidth()) {
                footerPressed(i);
            }
            repaint();
            return;
        }
        if (menu.open) {
            int a = menu.hit(x, y);
            if (a >= 0) {
                menuActivate(a);
            } else if (a == -2) {
                closeMenu(); // tapped the dimmed page
            }
            return;
        }
        if (longFired) {
            return;
        }
        if (dragging) {
            dragging = false;
            // Flick: keep going in the drag direction if released fast.
            int flick = System.currentTimeMillis() - lastT < 120 ? -velY * 4 : 0;
            if (page != null) {
                pageScrollBy(flick);
            } else {
                commitDrag(x, y, flick);
            }
        } else if (offerShown()) {
            int r = offerSize() / 2 + 10;
            if (Math.abs(x - offerCx()) <= r && Math.abs(y - offerCy()) <= r) {
                playOffer();
            } else {
                clearOffer();
                click(x, y);
            }
        } else {
            click(x, y);
        }
        repaint();
    }
}
