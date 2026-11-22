package fbc;

import javax.microedition.lcdui.Font;
import javax.microedition.lcdui.Graphics;
import javax.microedition.lcdui.Image;

/**
 * Text mode: the server sends a screenshot taken without text plus the
 * page's text lines ("x y w h size flags rrggbb text", tab separated, one
 * per line, image px). They are drawn here (TextFont), once per frame,
 * so painting stays a plain drawImage. Picks the fonts all the app's text
 * uses: the phone's own, in its three sizes.
 */
final class TextFrame {

    private static final int BOLD = 1;
    private static final int CLIP = 2;
    private static final int CENTER = 4;
    private static final int TOP = 8;

    // Phone fonts come in three sizes; a text's CSS px size picks one
    // (FONT_PX: the smallest px for MEDIUM, for LARGE). [bold][size].
    private static final int[] SIZES = {Font.SIZE_SMALL, Font.SIZE_MEDIUM, Font.SIZE_LARGE};
    private static final int[] FONT_PX = {15, 20};
    private static final TextFont[][] FONTS = new TextFont[2][3];

    // Text size setting: one phone font size up (Large) or down (Small).
    // gen changes with it, so laid out text is redone.
    static final int SIZE_LARGE = 0;
    static final int SIZE_NORMAL = 1;
    static final int SIZE_SMALL = 2;
    static final int SIZE_DEFAULT = SIZE_NORMAL;
    static final String[] SIZE_NAMES = {"Large", "Default", "Small"};
    private static final int[] STEP = {1, 0, -1};
    private static int textFont = SIZE_DEFAULT;

    // App text (menu, toasts, buttons, video status), em px at 100% zoom;
    // grows with the page's zoom.
    static final int UI_SIZE = 14;
    static final int UI_BIG = 16;
    private static int zoom = 100;
    static int gen;

    private TextFrame() {
    }

    /** The zoom setting (Settings > Zoom %). */
    static void setZoom(int z) {
        zoom = z;
    }

    /** Zoom the page is laid out at (the setting). */
    static int pageZoom() {
        return zoom;
    }

    static void setTextFont(int v) {
        if (v != textFont) {
            textFont = v;
            gen++;
        }
    }

    /** Draws the lines in text[off..off+len) over bg; returns a mutable image. */
    static Image draw(Image bg, byte[] text, int off, int len) {
        Image dst = bg;
        if (!bg.isMutable()) {
            dst = Image.createImage(bg.getWidth(), bg.getHeight());
            dst.getGraphics().drawImage(bg, 0, 0, Graphics.TOP | Graphics.LEFT);
        }
        Graphics g = dst.getGraphics();
        int fullW = dst.getWidth();
        int fullH = dst.getHeight();
        String all = Net.utf8(text, off, len);
        String[] f = new String[8];
        // Phone fonts are often wider than the page's: a run that follows
        // another on the same line starts after it instead of overlapping.
        int lastY = -1000;
        int lastRight = 0;
        int lastBoxRight = 0;
        int start = 0;
        while (start < all.length()) {
            int end = all.indexOf('\n', start);
            if (end < 0) {
                end = all.length();
            }
            if (split(all, start, end, f)) {
                int x = FbMidlet.parseInt(f[0], 0);
                int y = FbMidlet.parseInt(f[1], 0);
                int w = FbMidlet.parseInt(f[2], 0);
                int h = FbMidlet.parseInt(f[3], 0);
                int flags = FbMidlet.parseInt(f[5], 0);
                int color;
                try {
                    color = Integer.parseInt(f[6], 16);
                } catch (Exception e) {
                    color = 0;
                }
                String s = f[7];
                TextFont font = (flags & CLIP) != 0 ? font(FbMidlet.parseInt(f[4], 14), (flags & BOLD) != 0)
                        : fit(FbMidlet.parseInt(f[4], 14), (flags & BOLD) != 0, s, w, h);
                int tw = font.stringWidth(s);
                int ty = font.top(y, h, (flags & TOP) != 0);
                int boxRight = x + w;
                if ((flags & CLIP) == 0) {
                    if ((flags & CENTER) != 0) {
                        x += (w - tw) / 2;
                    } else if (Math.abs(ty - lastY) < 3) {
                        x = after(x, lastRight, lastBoxRight, font);
                    }
                    if (x + tw > boxRight + slack(w)) {
                        s = clip(s, font, boxRight + slack(w) - x);
                        tw = font.stringWidth(s);
                    }
                }
                if ((flags & CLIP) != 0) {
                    g.setClip(x, y, w, h);
                }
                font.drawTop(g, s, x, ty, color, -1);
                if ((flags & CLIP) != 0) {
                    g.setClip(0, 0, fullW, fullH);
                } else {
                    lastY = ty;
                    lastRight = x + tw;
                    lastBoxRight = boxRight;
                }
            }
            start = end + 1;
        }
        return dst;
    }

    /** Splits one line into its 8 tab-separated fields; false if malformed. */
    private static boolean split(String s, int start, int end, String[] out) {
        for (int i = 0; i < 7; i++) {
            int tab = s.indexOf('\t', start);
            if (tab < 0 || tab > end) {
                return false;
            }
            out[i] = s.substring(start, tab);
            start = tab + 1;
        }
        out[7] = s.substring(start, end);
        return true;
    }

    /** Phone font of size index i (SIZES). */
    private static TextFont fontAt(int i, boolean bold) {
        int style = bold ? 1 : 0;
        TextFont t = FONTS[style][i];
        if (t == null) {
            t = new TextFont(Font.getFont(Font.FACE_PROPORTIONAL, bold ? Font.STYLE_BOLD : Font.STYLE_PLAIN, SIZES[i]));
            FONTS[style][i] = t;
        }
        return t;
    }

    /** Size index for text of px (CSS px at the page's scale). */
    private static int index(int px) {
        return px >= FONT_PX[1] ? 2 : (px >= FONT_PX[0] ? 1 : 0);
    }

    /** The font for page text of px size (with the setting's step). */
    static TextFont font(int px, boolean bold) {
        return fontAt(FbMidlet.clamp(index(px) + STEP[textFont], 0, 2), bold);
    }

    /** The font for the app's own text of px size (UI_SIZE, UI_BIG). */
    static TextFont ui(int px, boolean bold) {
        return fontAt(index(px * pageZoom() / 100), bold);
    }

    /** How far text may run past the right of its box (phone px). */
    static int slack(int w) {
        return w / 16 + 2;
    }

    /**
     * The font for text s laid out by the page in a w x h box: the size for
     * the page's, or a smaller one while that is too wide or too tall for
     * the box (fonts wider than the page's would run into icons and the
     * next line).
     */
    static TextFont fit(int px, boolean bold, String s, int w, int h) {
        int i = FbMidlet.clamp(index(px) + STEP[textFont], 0, 2);
        TextFont f = fontAt(i, bold);
        while (i > 0 && (f.stringWidth(s) > w || f.height() > h + 3)) {
            f = fontAt(--i, bold);
        }
        return f;
    }

    /** s cut to at most max px wide in font f, with "..." when cut. */
    static String clip(String s, TextFont f, int max) {
        if (f.stringWidth(s) <= max) {
            return s;
        }
        int dots = f.stringWidth("...");
        if (max <= dots) {
            return "";
        }
        int lo = 0;
        int hi = s.length();
        while (lo < hi) {
            int mid = (lo + hi + 1) / 2;
            if (f.stringWidth(s.substring(0, mid)) + dots <= max) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        return s.substring(0, lo).trim() + "...";
    }

    /**
     * Left of a run at x on the same line as the previous run, which was
     * drawn up to lastRight and laid out by the page up to lastBoxRight:
     * after it (phone fonts are wider), with a space when the page had a
     * gap between the two ("Name" + "shared" from two text nodes).
     */
    static int after(int x, int lastRight, int lastBoxRight, TextFont f) {
        int min = x > lastBoxRight + 1 ? lastRight + f.stringWidth(" ") : lastRight;
        return x < min ? min : x;
    }
}
