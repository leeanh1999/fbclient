package fbc;

import javax.microedition.lcdui.Canvas;
import javax.microedition.lcdui.Graphics;
import javax.microedition.lcdui.Image;

/**
 * Loading screen: white, the destination's logo, its name and three dots
 * lit in turn. The browser view shows it while switching between Facebook
 * and Messenger; the feed and chat screens while they load on opening.
 * While shown, its own thread repaints the canvas 4 times a second (the
 * screens' workers are busy with the request).
 */
class Splash {

    static final int MESSENGER = 0;
    static final int FACEBOOK = 1;
    private static final String[] NAME = {"Messenger", "Facebook"};
    private static final String[] RES = {"messenger", "facebook"};
    private static final int[] COLOR = {0x0A7CFF, 0x0866FF};
    private static final int[] ICON = {Icons.MESSENGER, Icons.HOME};
    private static final int BG = 0xFFFFFF;
    // Never longer than this, whatever happens to the request (a cold start
    // on a NAS or phone server can take half a minute).
    private static final int MAX_MS = 60000;

    private static final Image[] logo = new Image[2];
    private static final boolean[] tried = new boolean[2];

    private final Canvas canvas;
    private final int to;
    private volatile long since;
    private int gen;

    Splash(Canvas canvas, int to) {
        this.canvas = canvas;
        this.to = to;
    }

    /**
     * Shown until hide(). Not hidden by hideNotify: phones call it for
     * their own pop-ups (S60's network access prompt on the first request),
     * which left "Loading feed..." instead of the logo.
     */
    void show() {
        int g;
        synchronized (this) {
            since = System.currentTimeMillis();
            g = ++gen;
        }
        new Thread(new SplashTick(this, g)).start();
        canvas.repaint();
    }

    void hide() {
        synchronized (this) {
            if (since == 0) {
                return;
            }
            since = 0;
            gen++;
        }
        canvas.repaint();
    }

    boolean shown() {
        long at = since;
        return at != 0 && System.currentTimeMillis() - at < MAX_MS;
    }

    /** SplashTick: true while its generation is the current one. */
    synchronized boolean current(int g) {
        return g == gen && shown();
    }

    void repaint() {
        canvas.repaint();
    }

    void paint(Graphics g, int w, int vh, TextFont font) {
        if (shown()) {
            draw(g, w, vh, to, font);
        }
    }

    static void draw(Graphics g, int w, int vh, int to, TextFont font) {
        g.setColor(BG);
        g.fillRect(0, 0, w, vh);
        if (!tried[to]) {
            tried[to] = true;
            try {
                logo[to] = Image.createImage("/" + RES[to]
                        + (Math.min(w, vh) >= 360 ? "64" : "48") + ".png");
            } catch (Exception e) {
                // vector icon below
            }
        }
        Image img = logo[to];
        int s = img != null ? img.getHeight() : 48;
        int cy = vh / 2 - s / 3;
        if (img != null) {
            g.drawImage(img, w / 2, cy, Graphics.HCENTER | Graphics.VCENTER);
        } else {
            Icons.drawSmooth(g, ICON[to], w / 2, cy, s, COLOR[to], BG);
        }
        int ty = cy + s / 2 + 10;
        font.draw(g, NAME[to], w / 2, ty, 0x65676B, BG, Graphics.TOP | Graphics.HCENTER);
        // Three dots, one lit at a time.
        int phase = (int) ((System.currentTimeMillis() / 250) % 3);
        int dy = ty + font.height() + 14;
        for (int i = 0; i < 3; i++) {
            Icons.drawSmooth(g, Icons.CIRCLE, w / 2 + (i - 1) * 16, dy, 8,
                    i == phase ? COLOR[to] : 0xBCC0C4, BG);
        }
    }
}
