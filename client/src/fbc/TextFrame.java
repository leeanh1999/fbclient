package fbc;

import javax.microedition.lcdui.Font;
import javax.microedition.lcdui.Graphics;
import javax.microedition.lcdui.Image;

/**
 * Text mode: the server sends a screenshot taken without text plus the
 * page's text lines ("x y w h size flags rrggbb text", tab separated, one
 * per line, image px). They are drawn here with the phone's own fonts,
 * once per frame, so painting stays a plain drawImage.
 */
final class TextFrame {

    private static final int BOLD = 1;
    private static final int CLIP = 2;
    private static final int CENTER = 4;
    private static final int TOP = 8;

    private static final int[] SIZES = {Font.SIZE_SMALL, Font.SIZE_MEDIUM, Font.SIZE_LARGE};
    // [style][size], filled on first use.
    private static final Font[][] FONTS = new Font[2][3];

    private TextFrame() {
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
                Font font = font(FbMidlet.parseInt(f[4], 14), (flags & BOLD) != 0);
                String s = f[7];
                int tw = font.stringWidth(s);
                int ty = (flags & TOP) != 0 ? y : y + (h - font.getHeight()) / 2;
                if ((flags & CENTER) != 0) {
                    x += (w - tw) / 2;
                } else if ((flags & CLIP) == 0 && Math.abs(ty - lastY) < 3 && x < lastRight) {
                    x = lastRight;
                }
                g.setColor(color);
                g.setFont(font);
                if ((flags & CLIP) != 0) {
                    g.setClip(x, y, w, h);
                }
                g.drawString(s, x, ty, Graphics.TOP | Graphics.LEFT);
                if ((flags & CLIP) != 0) {
                    g.setClip(0, 0, fullW, fullH);
                } else {
                    lastY = ty;
                    lastRight = x + tw;
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

    /** The phone font whose height is closest to the page's line of px size. */
    static Font font(int px, boolean bold) {
        int style = bold ? 1 : 0;
        int want = px * 5 / 4; // CSS font-size -> line height incl. leading
        Font best = null;
        int bestDiff = Integer.MAX_VALUE;
        for (int i = 0; i < SIZES.length; i++) {
            Font f = FONTS[style][i];
            if (f == null) {
                f = Font.getFont(Font.FACE_PROPORTIONAL,
                        bold ? Font.STYLE_BOLD : Font.STYLE_PLAIN, SIZES[i]);
                FONTS[style][i] = f;
            }
            int d = Math.abs(f.getHeight() - want);
            if (d < bestDiff) {
                bestDiff = d;
                best = f;
            }
        }
        return best;
    }
}
