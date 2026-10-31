package fbc;

import java.io.DataInputStream;
import java.io.InputStream;
import java.util.Hashtable;

import javax.microedition.lcdui.Font;
import javax.microedition.lcdui.Graphics;
import javax.microedition.lcdui.Image;

/**
 * A font for page text: one of the bitmap fonts in the jar (res/fonts,
 * made by tools/mkfont.py: Roboto, antialiased, with Vietnamese) or a
 * phone system font. Phone fonts come in 3 sizes only and are often too
 * big and wide for the page's layout.
 *
 * Bitmap glyphs are made into images per colour on first use. Characters
 * missing from the bitmap font are drawn with the phone's small font.
 */
final class TextFont {

    /** Phone font, or null for a bitmap font. */
    private final Font sys;
    /** Em size in px: the CSS font size this font matches. */
    final int em;

    // Bitmap font: cell height, baseline, the normal line (ascent/descent).
    private int cell, base, asc, desc;
    private int[] chars, gx, gy, gw, gl, adv; // adv in 1/8 px
    private final int[] ascii = new int[128];
    private byte[] alpha;
    private int atlasW;
    private boolean bold;
    // Colour on background (Long) -> Image[] by glyph index.
    private Hashtable tints;
    private static final int MAX_TINTS = 12;
    private static Font fallback, fallbackBold;

    TextFont(Font f) {
        sys = f;
        em = f.getHeight() * 4 / 5;
    }

    private TextFont(int em) {
        sys = null;
        this.em = em;
    }

    /** Loads /fonts/<r|b><size>; null if missing or broken. */
    static TextFont load(int size, boolean bold) {
        String name = "/fonts/" + (bold ? "b" : "r") + size;
        InputStream in = null;
        try {
            TextFont t = new TextFont(size);
            in = t.getClass().getResourceAsStream(name + ".bin");
            if (in == null) {
                return null;
            }
            DataInputStream d = new DataInputStream(in);
            if (d.readUnsignedByte() != 2) {
                return null;
            }
            t.bold = bold;
            t.cell = d.readUnsignedByte();
            t.base = d.readUnsignedByte();
            t.asc = d.readUnsignedByte();
            t.desc = d.readUnsignedByte();
            int n = d.readUnsignedShort();
            t.chars = new int[n];
            t.gx = new int[n];
            t.gy = new int[n];
            t.gw = new int[n];
            t.gl = new int[n];
            t.adv = new int[n];
            for (int i = 0; i < 128; i++) {
                t.ascii[i] = -1;
            }
            for (int i = 0; i < n; i++) {
                t.chars[i] = d.readUnsignedShort();
                t.gx[i] = d.readUnsignedShort();
                t.gy[i] = d.readUnsignedShort();
                t.gw[i] = d.readUnsignedByte();
                t.gl[i] = d.readByte();
                t.adv[i] = d.readUnsignedShort();
                if (t.chars[i] < 128) {
                    t.ascii[t.chars[i]] = i;
                }
            }
            Image atlas = Image.createImage(name + ".png");
            int w = atlas.getWidth();
            int h = atlas.getHeight();
            int[] px = new int[w * h];
            atlas.getRGB(px, 0, w, 0, 0, w, h);
            atlas = null;
            t.alpha = new byte[w * h];
            for (int i = 0; i < px.length; i++) {
                t.alpha[i] = (byte) (px[i] >>> 24);
            }
            t.atlasW = w;
            t.tints = new Hashtable();
            return t;
        } catch (Throwable e) {
            return null;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Exception e) {
                    // ignore
                }
            }
        }
    }

    /** Height of the font's normal line (what the page's line box holds). */
    int height() {
        return sys != null ? sys.getHeight() : asc + desc;
    }

    /**
     * Top to draw at for text in a box at y, h tall: centred in it, or at
     * its top (atTop). Bitmap cells have room above for stacked accents.
     */
    int top(int y, int h, boolean atTop) {
        int lead = sys != null ? 0 : base - asc;
        return (atTop ? y : y + (h - height()) / 2) - lead;
    }

    private int glyph(char c) {
        if (c < 128) {
            return ascii[c];
        }
        int lo = 0;
        int hi = chars.length - 1;
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            int v = chars[mid];
            if (v < c) {
                lo = mid + 1;
            } else if (v > c) {
                hi = mid - 1;
            } else {
                return mid;
            }
        }
        return -1;
    }

    private Font fallback() {
        if (bold) {
            if (fallbackBold == null) {
                fallbackBold = Font.getFont(Font.FACE_PROPORTIONAL, Font.STYLE_BOLD, Font.SIZE_SMALL);
            }
            return fallbackBold;
        }
        if (fallback == null) {
            fallback = Font.getFont(Font.FACE_PROPORTIONAL, Font.STYLE_PLAIN, Font.SIZE_SMALL);
        }
        return fallback;
    }

    int stringWidth(String s) {
        if (sys != null) {
            return sys.stringWidth(s);
        }
        int w8 = 0;
        int extra = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            int g = glyph(c);
            if (g >= 0) {
                w8 += adv[g];
            } else {
                extra += fallback().charWidth(c);
            }
        }
        return ((w8 + 4) >> 3) + extra;
    }

    /**
     * Draws s anchored like Graphics.drawString: LEFT, HCENTER or RIGHT of
     * x; TOP (top of the normal line) or BASELINE at y. bg: the colour
     * under the text, or -1 if not one colour (see drawTop).
     */
    void draw(Graphics g, String s, int x, int y, int color, int bg, int anchor) {
        if ((anchor & Graphics.HCENTER) != 0) {
            x -= stringWidth(s) / 2;
        } else if ((anchor & Graphics.RIGHT) != 0) {
            x -= stringWidth(s);
        }
        if (sys != null) {
            y = (anchor & Graphics.BASELINE) != 0 ? y - sys.getBaselinePosition() : y;
        } else {
            y = (anchor & Graphics.BASELINE) != 0 ? y - base : y - (base - asc);
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

    /**
     * Draws s with its cell top at y. With the background colour known
     * (bg >= 0), glyph edges are blended with it here and drawn opaque, so
     * they stay smooth on phones that draw image alpha as on/off (Nokia
     * S60); with bg = -1 they rely on the phone's alpha blending.
     */
    void drawTop(Graphics g, String s, int x, int y, int color, int bg) {
        g.setColor(color);
        if (sys != null) {
            g.setFont(sys);
            g.drawString(s, x, y, Graphics.TOP | Graphics.LEFT);
            return;
        }
        Image[] img = tint(color, bg);
        int pen8 = 0;
        int extra = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            int k = glyph(c);
            int px = x + ((pen8 + 4) >> 3) + extra;
            if (k < 0) {
                Font f = fallback();
                g.setFont(f);
                g.drawChar(c, px, y + base, Graphics.BASELINE | Graphics.LEFT);
                extra += f.charWidth(c);
                continue;
            }
            if (gw[k] > 0) {
                Image im = img[k];
                if (im == null) {
                    im = glyphImage(k, color, bg);
                    img[k] = im;
                }
                g.drawImage(im, px + gl[k], y, Graphics.TOP | Graphics.LEFT);
            }
            pen8 += adv[k];
        }
    }

    private synchronized Image[] tint(int color, int bg) {
        Long key = new Long(((long) bg << 24) ^ (color & 0xFFFFFF));
        Image[] img = (Image[]) tints.get(key);
        if (img == null) {
            if (tints.size() >= MAX_TINTS) {
                tints.clear();
            }
            img = new Image[chars.length];
            tints.put(key, img);
        }
        return img;
    }

    private Image glyphImage(int k, int color, int bg) {
        int w = gw[k];
        int[] px = new int[w * cell];
        int rgb = color & 0xFFFFFF;
        int fr = (rgb >> 16) & 255;
        int fg = (rgb >> 8) & 255;
        int fb = rgb & 255;
        int br = (bg >> 16) & 255;
        int bgg = (bg >> 8) & 255;
        int bb = bg & 255;
        int src = gy[k] * atlasW + gx[k];
        int dst = 0;
        for (int r = 0; r < cell; r++) {
            for (int c = 0; c < w; c++) {
                int a = alpha[src + c] & 0xFF;
                if (bg < 0) {
                    px[dst++] = (a << 24) | rgb;
                } else if (a == 0) {
                    px[dst++] = 0;
                } else {
                    int na = 255 - a;
                    px[dst++] = 0xFF000000
                            | (((fr * a + br * na) / 255) << 16)
                            | (((fg * a + bgg * na) / 255) << 8)
                            | ((fb * a + bb * na) / 255);
                }
            }
            src += atlasW;
        }
        return Image.createRGBImage(px, w, cell, true);
    }
}
