package fbc;

import javax.microedition.lcdui.Graphics;

/**
 * The D-pad focus outline: an anti-aliased blue ring just outside the
 * element, with a soft glow, following its rounded corners. Straight edges
 * are drawn a row of pixels at a time with the colour for that distance;
 * corners are computed once per radius and cached.
 */
final class FocusRing {

    private static final int BLUE = 0x1877F2;
    // Solid ring from the element's edge out to RING px, then a glow fading
    // out by OUT px.
    private static final double RING = 2.5;
    private static final double GLOW_ALPHA = 0.3;
    private static final int OUT = 5;
    private static final int MAX_RADIUS = 16;

    // ARGB per row outward (distance k + 0.5 from the edge).
    private static int[] rows;
    // Corner pixels (size (r + OUT)^2) per radius: top-left, top-right,
    // bottom-left, bottom-right.
    private static final int[][][] corners = new int[MAX_RADIUS + 1][][];
    private static int[] line = new int[0];

    private FocusRing() {
    }

    /** Ring around x, y, w, h (view px) with corner radius r. */
    static void draw(Graphics g, int x, int y, int w, int h, int r) {
        if (w <= 0 || h <= 0) {
            return;
        }
        r = Math.max(2, Math.min(Math.min(r, MAX_RADIUS), Math.min(w, h) / 2));
        if (rows == null) {
            rows = new int[OUT];
            for (int k = 0; k < OUT; k++) {
                rows[k] = color(k + 0.5);
            }
        }
        int[][] c = corners[r];
        if (c == null) {
            c = cornerSet(r);
            corners[r] = c;
        }
        int s = r + OUT;
        int right = x + w;
        int bottom = y + h;
        g.drawRGB(c[0], 0, s, x - OUT, y - OUT, s, s, true);
        g.drawRGB(c[1], 0, s, right - r, y - OUT, s, s, true);
        g.drawRGB(c[2], 0, s, x - OUT, bottom - r, s, s, true);
        g.drawRGB(c[3], 0, s, right - r, bottom - r, s, s, true);
        int lw = w - 2 * r;
        int lh = h - 2 * r;
        int[] buf = buffer(Math.max(lw, lh));
        for (int k = 0; k < OUT; k++) {
            fill(buf, Math.max(lw, lh), rows[k]);
            if (lw > 0) {
                g.drawRGB(buf, 0, lw, x + r, y - 1 - k, lw, 1, true);
                g.drawRGB(buf, 0, lw, x + r, bottom + k, lw, 1, true);
            }
            if (lh > 0) {
                g.drawRGB(buf, 0, 1, x - 1 - k, y + r, 1, lh, true);
                g.drawRGB(buf, 0, 1, right + k, y + r, 1, lh, true);
            }
        }
    }

    /** ARGB at distance d (px, + = outside) from the element's edge. */
    private static int color(double d) {
        double ring = Math.min(d + 0.5, RING) - Math.max(d - 0.5, 0);
        ring = ring < 0 ? 0 : (ring > 1 ? 1 : ring);
        double glow = d > RING ? GLOW_ALPHA * (1 - (d - RING) / (OUT - RING)) : (d > 0 ? GLOW_ALPHA : 0);
        if (glow < 0) {
            glow = 0;
        }
        double a = ring + (1 - ring) * glow;
        return ((int) (a * 255 + 0.5) << 24) | BLUE;
    }

    private static int[][] cornerSet(int r) {
        int s = r + OUT;
        int[] tl = new int[s * s];
        int[] tr = new int[s * s];
        int[] bl = new int[s * s];
        int[] br = new int[s * s];
        for (int j = 0; j < s; j++) {
            for (int i = 0; i < s; i++) {
                // Top-left: pixel (i, j) of a square whose bottom-right is
                // the corner's centre, r px inside the element.
                double dx = s - (i + 0.5);
                double dy = s - (j + 0.5);
                int v = color(Math.sqrt(dx * dx + dy * dy) - r);
                tl[j * s + i] = v;
                tr[j * s + (s - 1 - i)] = v;
                bl[(s - 1 - j) * s + i] = v;
                br[(s - 1 - j) * s + (s - 1 - i)] = v;
            }
        }
        return new int[][] {tl, tr, bl, br};
    }

    private static int[] buffer(int n) {
        if (line.length < n) {
            line = new int[n];
        }
        return line;
    }

    private static void fill(int[] a, int n, int v) {
        for (int i = 0; i < n; i++) {
            a[i] = v;
        }
    }
}
