package fbc;

import java.util.Hashtable;
import java.util.Vector;

import javax.microedition.lcdui.Font;
import javax.microedition.lcdui.Graphics;
import javax.microedition.lcdui.Image;

/**
 * Page mode: a long stretch of the page as drawing commands (server
 * pageDump), so the phone scrolls through it without asking the server.
 * One tab-separated line per command, phone px, document coordinates:
 *   T x y w h fontSize flags rrggbb text   text line
 *   B x y w h radius flags rrggbb          filled box
 *   R x y w h radius flags rrggbb          box outline
 *   I x y w h 0 flags key                  image (ImageLoader fetches it)
 *   C x y w h 0 flags                      clip for what follows (w=0: none)
 *   F x y w h radius flags                 something the D-pad can focus
 * Flag 16: pinned to the screen (y relative to the view), drawn on top.
 * Immutable once parsed, so the UI and loader threads can share it.
 */
final class PageView {

    static final char TEXT = 'T';
    static final char BOX = 'B';
    static final char RECT = 'R';
    static final char IMAGE = 'I';
    static final char CLIP = 'C';
    static final char FOCUS = 'F';

    private static final int BOLD = 1;
    private static final int CLIP_BOX = 2;
    private static final int CENTER = 4;
    private static final int TOP = 8;
    static final int FIXED = 16;
    // Pinned under the scrolling content (around a Messenger pane).
    static final int BELOW = 32;
    private static final int PINNED = FIXED | BELOW;

    private static final int PLACEHOLDER = 0xE4E6EB;

    /** Stretch of the document described (top..bottom) and its full height. */
    final int top, bottom, height, bg;
    /**
     * Scrolling pane on screen (x, y, w, h; desktop view): the content is
     * clipped to it. paneH = 0: the whole view scrolls.
     */
    final int paneX, paneY, paneW, paneH;
    final int n;
    final char[] type;
    final int[] x, y, w, h, s, flags, color;
    final String[] str;
    // Text widths in the phone font, measured on first paint.
    private final int[] tw;

    private PageView(int[] r, int bg, int n) {
        top = r[0];
        bottom = r[1];
        height = r[2];
        paneX = r[3];
        paneY = r[4];
        paneW = r[5];
        paneH = r[6];
        this.bg = bg;
        this.n = n;
        type = new char[n];
        x = new int[n];
        y = new int[n];
        w = new int[n];
        h = new int[n];
        s = new int[n];
        flags = new int[n];
        color = new int[n];
        str = new String[n];
        tw = new int[n];
    }

    /**
     * Parses a page reply; range is the X-Page header
     * "top,bottom,height,bg[,paneX,paneY,paneW,paneH]".
     */
    static PageView parse(String body, String range) {
        // top, bottom, height, (bg), paneX, paneY, paneW, paneH
        int[] r = new int[7];
        int bg = 0xFFFFFF;
        int start = 0;
        for (int i = 0; i < 8 && start < range.length(); i++) {
            int end = range.indexOf(',', start);
            String f = range.substring(start, end < 0 ? range.length() : end);
            if (i == 3) {
                bg = hex(f, 0xFFFFFF);
            } else {
                r[i < 3 ? i : i - 1] = FbMidlet.parseInt(f, 0);
            }
            start = end < 0 ? range.length() : end + 1;
        }
        int count = 1;
        for (int i = body.indexOf('\n'); i >= 0; i = body.indexOf('\n', i + 1)) {
            count++;
        }
        PageView p = new PageView(r, bg, count);
        String[] f = new String[9];
        int k = 0;
        start = 0;
        while (start < body.length()) {
            int end = body.indexOf('\n', start);
            if (end < 0) {
                end = body.length();
            }
            int nf = split(body, start, end, f);
            if (nf >= 7 && f[0].length() == 1) {
                char t = f[0].charAt(0);
                p.type[k] = t;
                p.x[k] = FbMidlet.parseInt(f[1], 0);
                p.y[k] = FbMidlet.parseInt(f[2], 0);
                p.w[k] = FbMidlet.parseInt(f[3], 0);
                p.h[k] = FbMidlet.parseInt(f[4], 0);
                p.s[k] = FbMidlet.parseInt(f[5], 0);
                p.flags[k] = FbMidlet.parseInt(f[6], 0);
                if (t == TEXT && nf >= 9) {
                    p.color[k] = hex(f[7], 0);
                    p.str[k] = f[8];
                } else if (t == IMAGE && nf >= 8) {
                    p.str[k] = f[7];
                } else if ((t == BOX || t == RECT) && nf >= 8) {
                    p.color[k] = hex(f[7], 0);
                } else if (t != CLIP && t != FOCUS) {
                    t = 0;
                }
                p.tw[k] = -1;
                if (t != 0) {
                    k++;
                }
            }
            start = end + 1;
        }
        if (k == count) {
            return p;
        }
        // Some lines were malformed: copy into exact-size arrays.
        PageView q = new PageView(r, bg, k);
        System.arraycopy(p.type, 0, q.type, 0, k);
        System.arraycopy(p.x, 0, q.x, 0, k);
        System.arraycopy(p.y, 0, q.y, 0, k);
        System.arraycopy(p.w, 0, q.w, 0, k);
        System.arraycopy(p.h, 0, q.h, 0, k);
        System.arraycopy(p.s, 0, q.s, 0, k);
        System.arraycopy(p.flags, 0, q.flags, 0, k);
        System.arraycopy(p.color, 0, q.color, 0, k);
        System.arraycopy(p.str, 0, q.str, 0, k);
        System.arraycopy(p.tw, 0, q.tw, 0, k);
        return q;
    }

    /** Splits a line at tabs into out (up to its length); returns the field count. */
    private static int split(String line, int start, int end, String[] out) {
        int i = 0;
        while (i < out.length - 1) {
            int tab = line.indexOf('\t', start);
            if (tab < 0 || tab > end) {
                break;
            }
            out[i++] = line.substring(start, tab);
            start = tab + 1;
        }
        out[i++] = line.substring(start, end);
        return i;
    }

    private static int hex(String v, int def) {
        try {
            return Integer.parseInt(v.trim(), 16);
        } catch (Exception e) {
            return def;
        }
    }

    /** Largest scroll position for a view of height vh. */
    int maxScroll(int vh) {
        return Math.max(0, height - vh);
    }

    // ---- Painting ----

    /** Draws the page scrolled to sy into a view of vw x vh. */
    void paint(Graphics g, int sy, int vw, int vh, Hashtable images) {
        g.setColor(bg);
        g.fillRect(0, 0, vw, vh);
        paintPass(g, 0, 0, 0, vw, vh, images, BELOW);
        if (paneH > 0) {
            paintPass(g, sy, paneX, paneY, paneW, paneH, images, 0);
        } else {
            paintPass(g, sy, 0, 0, vw, vh, images, 0);
        }
        paintPass(g, 0, 0, 0, vw, vh, images, FIXED);
        g.setClip(0, 0, vw, vh);
    }

    /**
     * Draws the commands of one layer (0 = scrolling content, BELOW, FIXED)
     * shifted up by oy, inside the box bx, by, bw, bh.
     */
    private void paintPass(Graphics g, int oy, int bx, int by, int bw, int bh, Hashtable images, int layer) {
        int vh = by + bh;
        // Current clip (view coordinates).
        int cx = bx;
        int cy = by;
        int cw = bw;
        int ch = bh;
        g.setClip(cx, cy, cw, ch);
        // Phone fonts are often wider than the page's: a run that follows
        // another on the same line starts after it instead of overlapping.
        int lastY = -1000;
        int lastRight = 0;
        for (int i = 0; i < n; i++) {
            if ((flags[i] & PINNED) != layer) {
                continue;
            }
            int yy = y[i] - oy;
            char t = type[i];
            if (t == CLIP) {
                if (w[i] > 0) {
                    cx = Math.max(bx, x[i]);
                    cy = Math.max(by, yy);
                    cw = Math.min(bx + bw, x[i] + w[i]) - cx;
                    ch = Math.min(vh, yy + h[i]) - cy;
                } else {
                    cx = bx;
                    cy = by;
                    cw = bw;
                    ch = bh;
                }
                g.setClip(cx, cy, Math.max(0, cw), Math.max(0, ch));
                continue;
            }
            if (yy >= vh || yy + h[i] <= by || cw <= 0 || ch <= 0) {
                continue;
            }
            if (t == BOX) {
                g.setColor(color[i]);
                int a = Math.min(s[i] * 2, Math.min(w[i], h[i]));
                if (a > 1) {
                    g.fillRoundRect(x[i], yy, w[i], h[i], a, a);
                } else {
                    g.fillRect(x[i], yy, Math.max(1, w[i]), Math.max(1, h[i]));
                }
            } else if (t == RECT) {
                g.setColor(color[i]);
                int a = Math.min(s[i] * 2, Math.min(w[i], h[i]));
                g.drawRoundRect(x[i], yy, w[i] - 1, h[i] - 1, a, a);
            } else if (t == IMAGE) {
                Image im = (Image) images.get(str[i]);
                if (im != null) {
                    g.drawImage(im, x[i], yy, Graphics.TOP | Graphics.LEFT);
                } else if (w[i] * h[i] >= 2500) {
                    g.setColor(PLACEHOLDER);
                    g.fillRect(x[i], yy, w[i], h[i]);
                }
            } else if (t == TEXT) {
                Font font = TextFrame.font(s[i], (flags[i] & BOLD) != 0);
                if (tw[i] < 0) {
                    tw[i] = font.stringWidth(str[i]);
                }
                int f = flags[i];
                int tx = x[i];
                int ty = (f & TOP) != 0 ? yy : yy + (h[i] - font.getHeight()) / 2;
                if ((f & CENTER) != 0) {
                    tx += (w[i] - tw[i]) / 2;
                } else if ((f & CLIP_BOX) == 0 && Math.abs(ty - lastY) < 3 && tx < lastRight) {
                    tx = lastRight;
                }
                g.setColor(color[i]);
                g.setFont(font);
                if ((f & CLIP_BOX) != 0) {
                    g.clipRect(x[i], yy, w[i], h[i]);
                }
                g.drawString(str[i], tx, ty, Graphics.TOP | Graphics.LEFT);
                if ((f & CLIP_BOX) != 0) {
                    g.setClip(cx, cy, Math.max(0, cw), Math.max(0, ch));
                } else {
                    lastY = ty;
                    lastRight = tx + tw[i];
                }
            }
        }
    }

    // ---- D-pad focus ----
    // A focus is {x, y, w, h, radius, pinned}: y in document px, or view px
    // when pinned (1).

    /** Focus item i as a focus, for the view at sy. */
    int[] focusAt(int i) {
        return new int[] {x[i], y[i], w[i], h[i], s[i], (flags[i] & PINNED) != 0 ? 1 : 0};
    }

    /**
     * The focusable item to move to from cur (null = none, start at the
     * view's top) in direction d (u/d/l/r), with the view at sy..sy+vh; -1
     * if none near the view. Same rules as the server's __fbc.move.
     */
    int nextFocus(int[] cur, char d, int sy, int vh) {
        int cl = 0;
        int ct = 0;
        int cr = 0;
        int cb = 0;
        if (cur != null) {
            cl = cur[0];
            ct = cur[5] != 0 ? cur[1] + sy : cur[1];
            cr = cl + cur[2];
            cb = ct + cur[3];
        }
        int best = -1;
        long bestScore = Long.MAX_VALUE;
        for (int i = 0; i < n; i++) {
            if (type[i] != FOCUS) {
                continue;
            }
            int l = x[i];
            int t = (flags[i] & PINNED) != 0 ? y[i] + sy : y[i];
            int r = l + w[i];
            int b = t + h[i];
            if (b < sy - vh || t > sy + 2 * vh) {
                continue; // only near the view
            }
            long score;
            if (cur == null) {
                if (t < sy - 1 || t > sy + vh) {
                    continue;
                }
                score = (long) t * 4 + l;
            } else {
                if ((l <= cl && r >= cr && t <= ct && b >= cb) || (l >= cl && r <= cr && t >= ct && b <= cb)) {
                    continue; // itself, or containing / inside it
                }
                // Centres doubled to stay in integers.
                int dcx = (l + r) - (cl + cr);
                int dcy = (t + b) - (ct + cb);
                int offX = Math.max(0, Math.max(l - cr, cl - r));
                int offY = Math.max(0, Math.max(t - cb, ct - b));
                if (d == 'd') {
                    if (dcy <= 2 || b <= cb) {
                        continue;
                    }
                    score = 20L * Math.max(0, t - cb) + 40L * offX + Math.abs(dcx) / 2;
                } else if (d == 'u') {
                    if (dcy >= -2 || t >= ct) {
                        continue;
                    }
                    score = 20L * Math.max(0, ct - b) + 40L * offX + Math.abs(dcx) / 2;
                } else if (d == 'r') {
                    if (dcx <= 2 || r <= cr) {
                        continue;
                    }
                    score = 20L * Math.max(0, l - cr) + 60L * offY;
                } else {
                    if (dcx >= -2 || l >= cl) {
                        continue;
                    }
                    score = 20L * Math.max(0, cl - r) + 60L * offY;
                }
            }
            if (score < bestScore) {
                bestScore = score;
                best = i;
            }
        }
        return best;
    }

    /**
     * After a new stretch arrived: the item matching focus f (same size,
     * close by), or null (keep f as it is).
     */
    int[] snapFocus(int[] f) {
        int best = -1;
        int bestDist = 120;
        for (int i = 0; i < n; i++) {
            if (type[i] != FOCUS || ((flags[i] & PINNED) != 0 ? 1 : 0) != f[5]
                    || Math.abs(w[i] - f[2]) > 2 || Math.abs(h[i] - f[3]) > 2) {
                continue;
            }
            int dist = Math.abs(x[i] - f[0]) + Math.abs(y[i] - f[1]);
            if (dist < bestDist) {
                bestDist = dist;
                best = i;
            }
        }
        return best < 0 ? null : focusAt(best);
    }

    // ---- Images ----

    /**
     * Image keys between document y from..to (and pinned ones) that are not
     * in have or skip, those on screen (vTop..vBottom) first; at most max
     * keys and about maxPx pixels. Images sideways out of the view (rest
     * of a carousel) wait until it scrolls.
     */
    Vector missing(int vw, int vTop, int vBottom, int from, int to, Hashtable have, Hashtable skip,
            int max, int maxPx) {
        Vector out = new Vector();
        int px = 0;
        for (int pass = 0; pass < 2; pass++) {
            for (int i = 0; i < n && out.size() < max; i++) {
                if (type[i] != IMAGE) {
                    continue;
                }
                boolean pinned = (flags[i] & PINNED) != 0;
                int a = pass == 0 ? vTop : from;
                int b = pass == 0 ? vBottom : to;
                if ((!pinned && (y[i] + h[i] < a || y[i] > b)) || x[i] >= vw || x[i] + w[i] <= 0) {
                    continue;
                }
                String k = str[i];
                if (have.containsKey(k) || skip.containsKey(k) || out.contains(k)) {
                    continue;
                }
                int p = w[i] * h[i];
                if (out.size() > 0 && px + p > maxPx) {
                    continue;
                }
                px += p;
                out.addElement(k);
            }
        }
        return out;
    }

    /** Keys of the images between document y from..to, and pinned ones. */
    Hashtable keysIn(int from, int to) {
        Hashtable t = new Hashtable();
        for (int i = 0; i < n; i++) {
            if (type[i] == IMAGE && ((flags[i] & PINNED) != 0 || (y[i] + h[i] >= from && y[i] <= to))) {
                t.put(str[i], str[i]);
            }
        }
        return t;
    }
}
