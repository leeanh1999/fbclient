package fbc;

import java.util.Hashtable;

import javax.microedition.lcdui.Graphics;
import javax.microedition.lcdui.Image;

/**
 * Vector icons drawn with Graphics primitives (no image resources, any size).
 * Each icon is centred on (x, y) and fits a box of about s x s pixels.
 *
 * MIDP has no anti-aliasing, so drawSmooth() renders the icon at 3x into an
 * off-screen mask, box-filters it down to an alpha channel and caches the
 * resulting ARGB image.
 */
final class Icons {

    static final int MENU = 0;
    static final int HOME = 1;
    static final int BACK = 2;
    static final int FORWARD = 3;
    static final int KEYBOARD = 4;
    static final int ENTER = 5;
    static final int GLOBE = 6;
    static final int MESSENGER = 7;
    static final int VIDEO = 8;
    static final int LIVE = 9;
    static final int RELOAD = 10;
    static final int SETTINGS = 11;
    static final int EXIT = 12;
    static final int CIRCLE = 13; // filled disc, for button backgrounds
    static final int CLOSE = 14;
    static final int PLAY = 15;
    static final int PAUSE = 16;
    static final int REWIND = 17;
    static final int FFWD = 18;
    static final int NEXT = 19;
    static final int PREV = 20;

    // cos/sin * 100 for 0, 45, ... 315 degrees (y axis pointing down).
    private static final int[] COS8 = {100, 71, 0, -71, -100, -71, 0, 71};
    private static final int[] SIN8 = {0, 71, 100, 71, 0, -71, -100, -71};

    private static final int SUPERSAMPLE = 3;
    private static final Hashtable CACHE = new Hashtable();

    private Icons() {
    }

    /**
     * Anti-aliased icon in color fg, centred on (x, y). Cut-outs are
     * transparent. bg is only used by the aliased fallback.
     */
    static void drawSmooth(Graphics g, int id, int x, int y, int s, int fg, int bg) {
        String k = id + "/" + s + "/" + fg;
        Image img = (Image) CACHE.get(k);
        if (img == null) {
            img = render(id, s, fg);
            if (img == null) {
                draw(g, id, x, y, s, fg, bg);
                return;
            }
            CACHE.put(k, img);
        }
        g.drawImage(img, x, y, Graphics.HCENTER | Graphics.VCENTER);
    }

    private static Image render(int id, int s, int fg) {
        int box = s + 6; // room for strokes that overshoot the nominal size
        int big = box * SUPERSAMPLE;
        try {
            Image mask = Image.createImage(big, big);
            Graphics mg = mask.getGraphics();
            mg.setColor(0x000000);
            mg.fillRect(0, 0, big, big);
            draw(mg, id, big / 2, big / 2, s * SUPERSAMPLE, 0xFFFFFF, 0x000000);
            int[] px = new int[big * big];
            mask.getRGB(px, 0, big, 0, 0, big, big);
            int[] out = new int[box * box];
            int rgb = fg & 0xFFFFFF;
            int n = SUPERSAMPLE * SUPERSAMPLE;
            for (int y = 0; y < box; y++) {
                for (int x = 0; x < box; x++) {
                    int sum = 0;
                    for (int j = 0; j < SUPERSAMPLE; j++) {
                        int row = (y * SUPERSAMPLE + j) * big + x * SUPERSAMPLE;
                        for (int i = 0; i < SUPERSAMPLE; i++) {
                            sum += (px[row + i] >> 8) & 0xFF;
                        }
                    }
                    out[y * box + x] = ((sum / n) << 24) | rgb;
                }
            }
            return Image.createRGBImage(out, box, box, true);
        } catch (Throwable t) {
            return null; // no mutable images / out of memory: draw aliased
        }
    }

    /** Draws icon id in color fg; bg is used for cut-outs (door, holes). */
    static void draw(Graphics g, int id, int x, int y, int s, int fg, int bg) {
        int h = s / 2;
        int t = Math.max(2, s / 9); // stroke width
        g.setColor(fg);
        switch (id) {
            case MENU:
                for (int i = -1; i <= 1; i++) {
                    g.fillRoundRect(x - h, y + i * h * 2 / 3 - t / 2, s, t + 1, t, t);
                }
                break;
            case HOME:
                g.fillTriangle(x, y - h - 1, x - h - 1, y - h / 6, x + h + 1, y - h / 6);
                g.fillRect(x - h * 2 / 3, y - h / 4, h * 4 / 3 + 1, h * 5 / 4);
                g.setColor(bg);
                g.fillRect(x - h / 5, y + h / 4, h * 2 / 5 + 1, h * 3 / 4);
                break;
            case BACK:
                arrow(g, x, y, h, t, -1);
                break;
            case FORWARD:
                arrow(g, x, y, h, t, 1);
                break;
            case KEYBOARD: {
                int top = y - h * 2 / 3;
                for (int i = 0; i < t; i++) {
                    g.drawRoundRect(x - h + i, top + i, s - 2 * i, h * 4 / 3 - 2 * i, 5, 5);
                }
                int k = Math.max(2, s / 10);
                for (int r = 0; r < 2; r++) {
                    for (int c = 0; c < 4; c++) {
                        g.fillRect(x - h * 3 / 5 + c * h * 2 / 5, top + h / 3 + r * h / 3, k, k);
                    }
                }
                g.fillRect(x - h / 2, top + h, h + 1, k);
                break;
            }
            case ENTER: {
                int rx = x + h * 2 / 3;
                int by = y + h / 4;
                g.fillRect(rx - t + 1, y - h * 3 / 4, t, by - (y - h * 3 / 4) + t / 2 + 1);
                g.fillRect(x - h / 3, by - t / 2, rx - (x - h / 3) + 1, t);
                g.fillTriangle(x - h, by, x - h / 3, by - h / 2, x - h / 3, by + h / 2);
                break;
            }
            case GLOBE:
                ring(g, x, y, h, t, 0, 360);
                for (int i = 0; i < Math.max(1, t - 1); i++) {
                    g.drawArc(x - h / 2 + i, y - h, h - 2 * i, s, 0, 360);
                }
                g.fillRect(x - h, y - t / 2, s, t);
                break;
            case MESSENGER:
                g.fillArc(x - h, y - h, s, s * 9 / 10, 0, 360);
                g.fillTriangle(x - h * 3 / 5, y + h / 3, x - h * 3 / 5, y + h + 1, x - h / 8, y + h * 2 / 3);
                g.setColor(bg);
                zigzag(g, x, y - h / 20, h, t);
                break;
            case VIDEO: {
                int top = y - h * 2 / 3;
                for (int i = 0; i < t; i++) {
                    g.drawRoundRect(x - h + i, top + i, s - 2 * i, h * 4 / 3 - 2 * i, 6, 6);
                }
                g.fillTriangle(x - h / 4, y - h / 3, x - h / 4, y + h / 3, x + h * 2 / 5, y);
                break;
            }
            case LIVE: {
                int d = h / 2;
                g.fillArc(x - d / 2 - 1, y - d / 2 - 1, d + 2, d + 2, 0, 360);
                ring(g, x, y, h * 3 / 5, t, 135, 90);
                ring(g, x, y, h * 3 / 5, t, -45, 90);
                ring(g, x, y, h, t, 135, 90);
                ring(g, x, y, h, t, -45, 90);
                break;
            }
            case RELOAD: {
                int r = h * 4 / 5;
                ring(g, x, y, r, t, 60, 280);
                // Arrow head at the arc start (60 deg), pointing clockwise:
                // tip along the tangent (0.87, 0.5), base along (-0.5, 0.87).
                int px = x + r / 2;
                int py = y - r * 87 / 100;
                int a = h / 2 + 1;
                g.fillTriangle(px + a * 87 / 100, py + a * 50 / 100,
                        px - a * 30 / 100, py + a * 52 / 100,
                        px + a * 30 / 100, py - a * 52 / 100);
                break;
            }
            case SETTINGS: {
                int r = h * 7 / 10;
                int tooth = Math.max(3, s / 5);
                for (int i = 0; i < 8; i++) {
                    int tx = x + COS8[i] * (h - tooth / 3) / 100;
                    int ty = y + SIN8[i] * (h - tooth / 3) / 100;
                    g.fillRect(tx - tooth / 2, ty - tooth / 2, tooth, tooth);
                }
                g.fillArc(x - r, y - r, 2 * r, 2 * r, 0, 360);
                g.setColor(bg);
                int hole = h / 3;
                g.fillArc(x - hole, y - hole, 2 * hole, 2 * hole, 0, 360);
                break;
            }
            case EXIT:
                ring(g, x, y + h / 10, h * 4 / 5, t, 125, -290);
                g.fillRect(x - t / 2, y - h, t, h);
                break;
            case CIRCLE:
                g.fillArc(x - h, y - h, s, s, 0, 360);
                break;
            case CLOSE: {
                int a = h * 3 / 4;
                for (int i = -t / 2; i <= t / 2; i++) {
                    g.drawLine(x - a + i, y - a, x + a + i, y + a);
                    g.drawLine(x + a + i, y - a, x - a + i, y + a);
                    g.drawLine(x - a, y - a + i, x + a, y + a + i);
                    g.drawLine(x + a, y - a + i, x - a, y + a + i);
                }
                break;
            }
            case PLAY:
                // Shifted right a little so it looks centred.
                g.fillTriangle(x - h / 2, y - h * 4 / 5, x - h / 2, y + h * 4 / 5, x + h * 4 / 5, y);
                break;
            case PAUSE:
                g.fillRect(x - h * 2 / 3, y - h * 3 / 4, h / 2, h * 3 / 2);
                g.fillRect(x + h / 6, y - h * 3 / 4, h / 2, h * 3 / 2);
                break;
            case REWIND:
                g.fillTriangle(x - h, y, x, y - h * 3 / 4, x, y + h * 3 / 4);
                g.fillTriangle(x, y, x + h, y - h * 3 / 4, x + h, y + h * 3 / 4);
                break;
            case FFWD:
                g.fillTriangle(x + h, y, x, y - h * 3 / 4, x, y + h * 3 / 4);
                g.fillTriangle(x, y, x - h, y - h * 3 / 4, x - h, y + h * 3 / 4);
                break;
            case NEXT:
                g.fillTriangle(x - h * 3 / 4, y - h * 3 / 4, x - h * 3 / 4, y + h * 3 / 4, x + h / 3, y);
                g.fillRect(x + h / 3, y - h * 3 / 4, Math.max(3, t + 1), h * 3 / 2);
                break;
            case PREV: {
                // NEXT mirrored.
                int bar = Math.max(3, t + 1);
                g.fillTriangle(x + h * 3 / 4, y - h * 3 / 4, x + h * 3 / 4, y + h * 3 / 4, x - h / 3, y);
                g.fillRect(x - h / 3 - bar, y - h * 3 / 4, bar, h * 3 / 2);
                break;
            }
            default:
                break;
        }
    }

    private static void arrow(Graphics g, int x, int y, int h, int t, int dir) {
        int tip = x + dir * h;
        int base = x + dir * h / 6;
        g.fillTriangle(tip, y, base, y - h * 3 / 4, base, y + h * 3 / 4);
        int tail = x - dir * h;
        g.fillRect(Math.min(base, tail), y - t / 2 - 1, Math.abs(base - tail) + 1, t + 1);
    }

    /** Thick arc: t concentric arcs of radius r..r-t+1. */
    private static void ring(Graphics g, int x, int y, int r, int t, int start, int sweep) {
        for (int i = 0; i < t; i++) {
            int rr = r - i;
            g.drawArc(x - rr, y - rr, 2 * rr, 2 * rr, start, sweep);
        }
    }

    /** Messenger lightning bolt. */
    private static void zigzag(Graphics g, int x, int y, int h, int t) {
        int[] xs = {x - h / 2, x - h / 6, x + h / 6, x + h / 2};
        int[] ys = {y + h / 5, y - h / 5, y + h / 5, y - h / 5};
        for (int i = 0; i < 3; i++) {
            for (int j = 0; j < t; j++) {
                g.drawLine(xs[i], ys[i] + j, xs[i + 1], ys[i + 1] + j);
            }
        }
    }
}
