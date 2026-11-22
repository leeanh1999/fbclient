package fbc;

import java.util.Enumeration;
import java.util.Hashtable;
import java.util.Vector;

import javax.microedition.lcdui.Graphics;
import javax.microedition.lcdui.Image;

/**
 * Emoji, which phone fonts lack: the server sends each one as a character
 * of the Private Use Area (U+E000-U+F8FF) and says which image (/img key,
 * size) it stands for ("X char key w h" lines). TextFont measures and draws
 * those characters as the images, so every screen gets emoji without
 * knowing about them. Images come through ImageLoader.
 */
final class Emoji {

    /** Character -> Object[] {image key, int[] {w, h}}. */
    private static final Hashtable MAP = new Hashtable();
    /** Keys drawn but not loaded yet. */
    private static final Vector WANTED = new Vector();
    static ImageLoader loader;

    private Emoji() {
    }

    static boolean isMark(char c) {
        return c >= 0xE000 && c <= 0xF8FF;
    }

    /** An "X char key w h" line, as fields. */
    static void define(String[] f, int n) {
        if (n < 5 || f[1].length() != 1) {
            return;
        }
        int w = FbMidlet.parseInt(f[3], 18);
        int h = FbMidlet.parseInt(f[4], 18);
        MAP.put(new Character(f[1].charAt(0)), new Object[] {f[2], new int[] {w, h}});
    }

    private static Object[] get(char c) {
        return isMark(c) ? (Object[]) MAP.get(new Character(c)) : null;
    }

    /** Width of emoji c with a little space after it, or -1 if c is not one. */
    static int width(char c) {
        Object[] e = get(c);
        return e == null ? -1 : ((int[]) e[1])[0] + 1;
    }

    /**
     * Draws emoji c at x, centred on a line lh high whose top is y; false if
     * c is not an emoji. Not loaded yet: asks for it (the screen repaints
     * when it arrives).
     */
    static boolean draw(Graphics g, char c, int x, int y, int lh) {
        Object[] e = get(c);
        if (e == null) {
            return false;
        }
        String k = (String) e[0];
        int[] wh = (int[]) e[1];
        ImageLoader l = loader;
        Image im = l != null ? (Image) l.cache.get(k) : null;
        if (im != null) {
            g.drawImage(im, x, y + (lh - wh[1]) / 2, Graphics.TOP | Graphics.LEFT);
        } else {
            want(k);
        }
        return true;
    }

    private static void want(String k) {
        boolean added = false;
        synchronized (WANTED) {
            if (!WANTED.contains(k)) {
                WANTED.addElement(k);
                added = true;
            }
        }
        ImageLoader l = loader;
        if (added && l != null) {
            l.wake();
        }
    }

    /** Up to max wanted keys not in have or skip (the rest are dropped). */
    static Vector take(Hashtable have, Hashtable skip, int max) {
        Vector out = new Vector();
        synchronized (WANTED) {
            for (int i = WANTED.size() - 1; i >= 0; i--) {
                String k = (String) WANTED.elementAt(i);
                if (have.containsKey(k) || skip.containsKey(k)) {
                    WANTED.removeElementAt(i);
                } else if (out.size() < max) {
                    out.addElement(k);
                }
            }
        }
        return out;
    }

    /** Adds every emoji's key to keep: they are small and used everywhere. */
    static void keepAll(Hashtable keep) {
        for (Enumeration en = MAP.elements(); en.hasMoreElements();) {
            String k = (String) ((Object[]) en.nextElement())[0];
            keep.put(k, k);
        }
    }
}
