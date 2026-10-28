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
 * Pressing a video shows a play button; that opens the native player.
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
        toast(touch ? "Tap = click, hold = video, drag = scroll"
                : "Arrows = move  5 = open  * = Menu");
        // Plain thread instead of an anonymous TimerTask: KEmulator fails to
        // load nested classes.
        new Thread(this).start();
    }

    /** Tick loop: key repeat, long-press, animations, toast expiry. */
    public void run() {
        while (true) {
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
        if (pressed || pendingDy != 0 || shownDy != 0
                || System.currentTimeMillis() < liveHoldUntil
                || (app.net != null && app.net.userBusy)) {
            return;
        }
        image = img;
        imgOy = oy;
        repaint();
    }

    /** Focus rect from the server (image coordinates), null = none. */
    void setFocus(int[] r) {
        focus = r;
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
        if (image != null) {
            // Stop at the edges of the overscan buffer instead of showing
            // blank space; the next frame brings more content.
            int y = dragY - imgOy - shownDy;
            int ih = image.getHeight();
            if (y > 0 || ih <= vh) {
                y = 0;
            } else if (y + ih < vh) {
                y = vh - ih;
            }
            g.drawImage(image, 0, y, Graphics.TOP | Graphics.LEFT);
            int[] f = focus;
            if (f != null) {
                g.setColor(0x1877F2);
                for (int i = 0; i < 3; i++) {
                    g.drawRoundRect(f[0] + i, y + f[1] + i, f[2] - 1 - 2 * i, f[3] - 1 - 2 * i, 10, 10);
                }
            }
        } else {
            g.setFont(font);
            g.setColor(0x1877F2);
            g.drawString("Loading...", w / 2, vh / 2, Graphics.BASELINE | Graphics.HCENTER);
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
                g.fillRect(w - 26 + i * 8, 4, 6, 6);
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
            if (holdTicks >= REPEAT_DELAY && holdTicks % REPEAT_EVERY == 0 && app.net.idle()) {
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
        if (tapUntil > 0 && now > tapUntil) {
            tapUntil = 0;
            dirty = true;
        }
        if (offerUntil != 0 && now > offerUntil) {
            offerUntil = 0;
            dirty = true;
        }
        if (app.net != null && app.net.userBusy) {
            dirty = true;
        }
        if (easeScroll()) {
            dirty = true;
        }
        if (dirty) {
            repaint();
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

    // ---- Actions ----

    private void move(char d) {
        app.net.action("op=move&d=" + d);
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
        app.net.action(i == 1 ? "op=home" : "op=back");
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
        if (isLeftSoft(k) || isRightSoft(k) || k == KEY_STAR || k == KEY_POUND) {
            closeMenu();
            return;
        }
        int ga = gameAction(k);
        if (k == KEY_NUM5 || ga == FIRE) {
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

    private int gameAction(int k) {
        try {
            return getGameAction(k);
        } catch (Exception e) {
            return 0; // unknown key code on this device
        }
    }

    protected void keyPressed(int k) {
        if (menu.open) {
            menuKey(k);
            return;
        }
        touchMode = false;
        int ga = gameAction(k);
        boolean fire = k == KEY_NUM5 || (ga == FIRE && (k < KEY_NUM0 || k > KEY_NUM9));
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
        if (isRightSoft(k) || k == KEY_POUND || k == KEY_NUM1) {
            app.net.action("op=back");
            return;
        }
        int h = viewHeight();
        int w = getWidth();
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
            app.net.action("op=activate");
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
            // Instant local feedback: shift the current frame.
            dragY = y - py0;
            // Long drag: send what we have so far, so the server refills
            // the buffer while the finger is still moving.
            if (Math.abs(dragY) > viewHeight() / 3 && app.net.idle()) {
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
            commitDrag(x, y, flick);
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
