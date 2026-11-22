package fbc;

import javax.microedition.lcdui.Font;
import javax.microedition.lcdui.Graphics;

/**
 * A font for the app's text: a phone (system) font, drawn with drawString.
 * Characters of the Private Use Area that the server mapped to emoji
 * (Emoji) are measured and drawn as their images.
 */
final class TextFont {

    private final Font sys;
    /** Em size in px (about the CSS font size this font matches). */
    final int em;

    TextFont(Font f) {
        sys = f;
        em = f.getHeight() * 4 / 5;
    }

    /** Height of a line of this font. */
    int height() {
        return sys.getHeight();
    }

    /** Top to draw at for text in a box at y, h tall: centred in it, or at its top. */
    int top(int y, int h, boolean atTop) {
        return atTop ? y : y + (h - height()) / 2;
    }

    private static boolean hasEmoji(String s) {
        for (int i = s.length() - 1; i >= 0; i--) {
            if (Emoji.isMark(s.charAt(i))) {
                return true;
            }
        }
        return false;
    }

    int stringWidth(String s) {
        if (!hasEmoji(s)) {
            return sys.stringWidth(s);
        }
        int w = 0;
        int start = 0;
        int n = s.length();
        for (int i = 0; i < n; i++) {
            int ew = Emoji.width(s.charAt(i));
            if (ew < 0) {
                continue;
            }
            if (i > start) {
                w += sys.stringWidth(s.substring(start, i));
            }
            w += ew;
            start = i + 1;
        }
        if (start < n) {
            w += sys.stringWidth(s.substring(start));
        }
        return w;
    }

    /**
     * Advance of c in 1/8 px: summed over a string and rounded ((sum + 4)
     * >> 3) it gives about its width, so text can be measured as it grows.
     */
    int advance8(char c) {
        int ew = Emoji.isMark(c) ? Emoji.width(c) : -1;
        return (ew >= 0 ? ew : sys.charWidth(c)) << 3;
    }

    /**
     * Draws s anchored like Graphics.drawString: LEFT, HCENTER or RIGHT of
     * x; TOP or BASELINE at y. bg (the colour under the text) is not needed
     * by phone fonts; kept for the callers.
     */
    void draw(Graphics g, String s, int x, int y, int color, int bg, int anchor) {
        if ((anchor & Graphics.HCENTER) != 0) {
            x -= stringWidth(s) / 2;
        } else if ((anchor & Graphics.RIGHT) != 0) {
            x -= stringWidth(s);
        }
        if ((anchor & Graphics.BASELINE) != 0) {
            y -= sys.getBaselinePosition();
        }
        drawTop(g, s, x, y, color, bg);
    }

    /** s cut to at most maxW px, ending in "..." when cut. */
    String shorten(String s, int maxW) {
        if (stringWidth(s) <= maxW) {
            return s;
        }
        int n = s.length();
        while (n > 1 && stringWidth(s.substring(0, n) + "...") > maxW) {
            n--;
        }
        return s.substring(0, n) + "...";
    }

    /** Draws s with the top of its line at y. */
    void drawTop(Graphics g, String s, int x, int y, int color, int bg) {
        g.setColor(color);
        g.setFont(sys);
        if (!hasEmoji(s)) {
            g.drawString(s, x, y, Graphics.TOP | Graphics.LEFT);
            return;
        }
        int lh = height();
        int start = 0;
        int n = s.length();
        for (int i = 0; i < n; i++) {
            char c = s.charAt(i);
            int ew = Emoji.width(c);
            if (ew < 0) {
                continue;
            }
            if (i > start) {
                String part = s.substring(start, i);
                g.drawString(part, x, y, Graphics.TOP | Graphics.LEFT);
                x += sys.stringWidth(part);
            }
            Emoji.draw(g, c, x, y, lh);
            g.setColor(color);
            x += ew;
            start = i + 1;
        }
        if (start < n) {
            g.drawString(s.substring(start), x, y, Graphics.TOP | Graphics.LEFT);
        }
    }
}
