package fbc;

import javax.microedition.lcdui.Canvas;
import javax.microedition.lcdui.Graphics;
import javax.microedition.media.Manager;
import javax.microedition.media.Player;
import javax.microedition.media.PlayerListener;
import javax.microedition.media.control.VideoControl;
import javax.microedition.media.control.VolumeControl;

/**
 * Native video playback (MMAPI). The server downloads the Facebook video as
 * MP4; this screen waits for it, then streams it over HTTP with sound,
 * scaled to fit the screen with its own aspect ratio.
 *
 * Keys: 5/FIRE pause, 4/6 or left/right seek 10 s, 2/8 or up/down volume,
 * 7 previous video, 9 next video, #/1/soft keys close.
 * Touch: tap video = pause; bar Close | Previous | -10s | Play/Pause | +10s | Next.
 * While playing, the bar hides after a few seconds and the video fills the
 * screen (aspect ratio kept); a tap, or an arrow key, brings it back.
 */
class VideoView extends Canvas implements Runnable, PlayerListener {

    private static final int B_CLOSE = 0;
    private static final int B_PREV = 1;
    private static final int B_REWIND = 2;
    private static final int B_PLAY = 3;
    private static final int B_FFWD = 4;
    private static final int B_NEXT = 5;
    private static final int BUTTONS = 6;
    private static final long SEEK_US = 10000000L;
    // The bar hides this long after the last touch or key while playing.
    private static final int BAR_MS = 3000;

    private static final int C_BAR = 0x18191A;
    private static final int C_ICON = 0xE4E6EB;
    private static final int C_PRESS = 0x3A3B3C;
    private static final int C_BLUE = 0x1877F2;

    private final FbMidlet app;
    private final String videoKey;
    private static TextFont font() {
        return TextFrame.ui(TextFrame.UI_SIZE, false);
    }
    private final int barH;

    private volatile boolean closed;
    private volatile String status = "Preparing video...";
    private Player player;
    private VolumeControl volume;
    private boolean paused;
    private boolean ended;
    // Video size reported by the server (from the MP4), 0 if unknown.
    private int srcW, srcH;
    private int pressedButton = -1;
    private VideoControl video;
    // Control bar on screen; hidden while playing, until a touch or key.
    private volatile boolean barShown = true;
    private volatile long barUntil;
    // The touch in progress only brought the bar back.
    private boolean wakeTouch;

    VideoView(FbMidlet app, String videoKey) {
        this.app = app;
        this.videoKey = videoKey;
        setFullScreenMode(true);
        barH = Math.max(font().height() + 26, 52);
        new Thread(this).start();
    }

    public void run() {
        try {
            String base = app.server;
            String statusUrl = app.connUrl(base + "/vs?k=" + videoKey + app.keyParam("&"));
            while (!closed) {
                String st = Net.fetchText(statusUrl).trim();
                if (st.startsWith("ready")) {
                    readSize(st);
                    break;
                }
                if (st.startsWith("err")) {
                    setStatus("Video error: " + st.substring(3).trim());
                    return;
                }
                setStatus(st.startsWith("dl ") ? "Downloading " + st.substring(3) + "%" : st);
                Thread.sleep(800);
            }
            if (closed) {
                return;
            }
            setStatus("Starting player...");
            String url = base + "/v/" + videoKey + ".mp4" + app.keyParam("?");
            Player p = Manager.createPlayer(app.connUrl(url));
            player = p;
            p.addPlayerListener(this);
            p.realize();
            VideoControl vc = (VideoControl) p.getControl("VideoControl");
            video = vc;
            if (vc != null) {
                vc.initDisplayMode(VideoControl.USE_DIRECT_VIDEO, this);
                fit(vc);
                vc.setVisible(true);
            }
            volume = (VolumeControl) p.getControl("VolumeControl");
            p.prefetch();
            if (vc != null) {
                fit(vc); // some phones only know the source size now
            }
            if (closed) {
                return;
            }
            p.start();
            setStatus(null);
            showBar();
            // Keep the progress bar moving; hide the bar once left alone.
            long lightAt = 0;
            while (!closed) {
                long now = System.currentTimeMillis();
                if (barShown && !paused && !ended && status == null && now > barUntil) {
                    setBar(false);
                }
                // MIDP has no "keep screen on": while playing, re-light the
                // backlight before the phone's timeout (often 10-30 s) dims it.
                if (!paused && !ended && now - lightAt > 5000) {
                    lightAt = now;
                    try {
                        app.display.flashBacklight(15000);
                    } catch (Throwable t) {
                        // not supported on this phone
                    }
                }
                repaint();
                Thread.sleep(500);
            }
        } catch (Throwable t) {
            if (!closed) {
                setStatus("Player error: " + t.toString());
            }
        }
    }

    /** "ready <w> <h>" from the server. */
    private void readSize(String st) {
        int a = st.indexOf(' ');
        int b = a < 0 ? -1 : st.indexOf(' ', a + 1);
        if (b > a) {
            srcW = FbMidlet.parseInt(st.substring(a + 1, b), 0);
            srcH = FbMidlet.parseInt(st.substring(b + 1), 0);
        }
    }

    /**
     * Scale the video to fit above the control bar (the whole screen when it
     * is hidden), keeping aspect ratio. The video layer covers whatever the
     * canvas draws on many phones, so the bar never overlaps it.
     */
    private void fit(VideoControl vc) {
        int aw = getWidth();
        int ah = getHeight() - (barShown ? barH : 0);
        int sw = srcW;
        int sh = srcH;
        if (sw <= 0 || sh <= 0) {
            sw = vc.getSourceWidth();
            sh = vc.getSourceHeight();
        }
        int w = aw;
        int h = ah;
        if (sw > 0 && sh > 0) {
            if (sw * ah > sh * aw) {
                h = sh * aw / sw;
            } else {
                w = sw * ah / sh;
            }
        }
        try {
            vc.setDisplaySize(w, h);
        } catch (Exception e) {
            // Some devices only support the native size.
        }
        vc.setDisplayLocation((aw - w) / 2, (ah - h) / 2);
    }

    private void setStatus(String s) {
        status = s;
        if (s != null) {
            setBar(true);
        }
        repaint();
    }

    /** Show the bar (and keep it a while), e.g. after a touch or key. */
    private void showBar() {
        barUntil = System.currentTimeMillis() + BAR_MS;
        setBar(true);
    }

    private void setBar(boolean shown) {
        if (barShown == shown) {
            return;
        }
        barShown = shown;
        VideoControl vc = video;
        if (vc != null) {
            try {
                fit(vc);
            } catch (Exception e) {
                // The player is closing.
            }
        }
        repaint();
    }

    private int bottom() {
        return getHeight() - (barShown ? barH : 0);
    }

    /** A video request failed (e.g. no next video). */
    void showError(String msg) {
        setStatus(msg);
    }

    public void playerUpdate(Player p, String event, Object data) {
        if (PlayerListener.END_OF_MEDIA.equals(event)) {
            ended = true;
            paused = true;
            setBar(true);
        } else if (PlayerListener.ERROR.equals(event)) {
            setStatus("Playback error: " + data);
        }
        repaint();
    }

    // ---- Painting ----

    protected void paint(Graphics g) {
        int w = getWidth();
        int h = getHeight();
        int vb = bottom();
        g.setColor(0x000000);
        g.fillRect(0, 0, w, vb);
        String s = status;
        if (s != null) {
            font().draw(g, font().shorten(s, w - 8), w / 2, vb / 2, 0xFFFFFF, 0x000000,
                    Graphics.BASELINE | Graphics.HCENTER);
        }
        if (!barShown) {
            return;
        }

        int y = h - barH;
        g.setColor(C_BAR);
        g.fillRect(0, y, w, barH);
        // Progress line on top of the bar.
        Player p = player;
        if (p != null) {
            long dur = p.getDuration();
            long pos = p.getMediaTime();
            if (dur > 0 && pos >= 0) {
                g.setColor(C_PRESS);
                g.fillRect(0, y, w, 3);
                g.setColor(C_BLUE);
                g.fillRect(0, y, (int) (w * pos / dur), 3);
            }
        }
        int s1 = Math.min(26, barH / 2);
        for (int i = 0; i < BUTTONS; i++) {
            int bx = (2 * i + 1) * w / (2 * BUTTONS);
            int by = y + 3 + (barH - 3) / 2;
            boolean main = i == B_PLAY;
            int back = i == pressedButton ? C_PRESS : C_BAR;
            if (main) {
                // Play/Pause stands out as a filled circle.
                Icons.drawSmooth(g, Icons.CIRCLE, bx, by, barH - 12, C_BLUE, C_BLUE);
                back = C_BLUE;
            } else if (i == pressedButton) {
                Icons.drawSmooth(g, Icons.CIRCLE, bx, by, barH - 12, back, back);
            }
            Icons.drawSmooth(g, icon(i), bx, by, main ? s1 * 4 / 5 : s1, main ? 0xFFFFFF : C_ICON, back);
        }
    }

    private int icon(int button) {
        switch (button) {
            case B_CLOSE: return Icons.CLOSE;
            case B_PREV: return Icons.PREV;
            case B_REWIND: return Icons.REWIND;
            case B_PLAY: return paused || ended ? Icons.PLAY : Icons.PAUSE;
            case B_FFWD: return Icons.FFWD;
            default: return Icons.NEXT;
        }
    }

    // ---- Controls ----

    private void press(int button) {
        switch (button) {
            case B_CLOSE: close(); break;
            case B_PREV: previous(); break;
            case B_REWIND: seek(-SEEK_US); break;
            case B_PLAY: togglePause(); break;
            case B_FFWD: seek(SEEK_US); break;
            case B_NEXT: next(); break;
            default: break;
        }
    }

    private void togglePause() {
        Player p = player;
        if (p == null) {
            return;
        }
        try {
            if (ended) {
                p.setMediaTime(0);
                ended = false;
                paused = true;
            }
            if (paused) {
                p.start();
            } else {
                p.stop();
            }
            paused = !paused;
            showBar();
        } catch (Exception e) {
            setStatus("Error: " + e.getMessage());
        }
        repaint();
    }

    private void seek(long deltaUs) {
        Player p = player;
        if (p == null) {
            return;
        }
        try {
            long t = p.getMediaTime() + deltaUs;
            long dur = p.getDuration();
            if (t < 0) {
                t = 0;
            }
            if (dur > 0 && t > dur) {
                t = dur;
            }
            p.setMediaTime(t);
        } catch (Exception e) {
            // Seeking not supported for this stream.
        }
        repaint();
    }

    private void changeVolume(int delta) {
        if (volume != null) {
            volume.setLevel(FbMidlet.clamp(volume.getLevel() + delta, 0, 100));
        }
    }

    /** Stop playback and free the player (the screen may stay). */
    void dispose() {
        closed = true;
        Player p = player;
        player = null;
        if (p != null) {
            p.close();
        }
    }

    /** Next video: stay on this screen until the server has found it. */
    private void next() {
        dispose();
        paused = false;
        ended = false;
        setStatus("Loading next video...");
        app.nextVideo();
    }

    /** The video played before this one (the server keeps the history). */
    private void previous() {
        dispose();
        paused = false;
        ended = false;
        setStatus("Loading previous video...");
        app.prevVideo();
    }

    void close() {
        dispose();
        app.display.setCurrent(app.canvas);
    }

    private static boolean isSoft(int k) {
        return k == -6 || k == -7 || k == -21 || k == -22 || k == 57345 || k == 57346;
    }

    protected void keyPressed(int k) {
        k = app.mapKey(k);
        int action = 0;
        try {
            action = getGameAction(k);
        } catch (Exception e) {
            // Unknown key code on this device.
        }
        boolean arrow = action == UP || action == DOWN || action == LEFT || action == RIGHT;
        boolean wasHidden = !barShown;
        showBar();
        if (wasHidden && arrow && (k < KEY_NUM0 || k > KEY_NUM9)) {
            return; // an arrow only brings the bar back
        }
        if (isSoft(k) || k == KEY_POUND || k == KEY_NUM1 || k == KEY_STAR
                || k == 27 || k == 8) { // Escape / Backspace (QWERTY)
            close();
            return;
        }
        if (k == 10 || k == 13 || k == ' ') { // Enter / Space
            togglePause();
            return;
        }
        switch (k) {
            case KEY_NUM5: togglePause(); return;
            case KEY_NUM4: seek(-SEEK_US); return;
            case KEY_NUM6: seek(SEEK_US); return;
            case KEY_NUM2: changeVolume(10); return;
            case KEY_NUM8: changeVolume(-10); return;
            case KEY_NUM7: previous(); return;
            case KEY_NUM9: next(); return;
            default: break;
        }
        switch (action) {
            case FIRE: togglePause(); break;
            case LEFT: seek(-SEEK_US); break;
            case RIGHT: seek(SEEK_US); break;
            case UP: changeVolume(10); break;
            case DOWN: changeVolume(-10); break;
            default: break;
        }
    }

    private int buttonAt(int x, int y) {
        return !barShown || y < getHeight() - barH ? -1 : x * BUTTONS / getWidth();
    }

    protected void pointerPressed(int x, int y) {
        // With the bar hidden, a touch only brings it back.
        wakeTouch = !barShown;
        showBar();
        pressedButton = wakeTouch ? -1 : buttonAt(x, y);
        repaint();
    }

    protected void pointerReleased(int x, int y) {
        int b = pressedButton;
        pressedButton = -1;
        repaint();
        if (wakeTouch) {
            wakeTouch = false;
            return;
        }
        if (y < getHeight() - barH) {
            togglePause();
        } else if (b >= 0 && b == buttonAt(x, y)) {
            press(b);
        }
    }
}
