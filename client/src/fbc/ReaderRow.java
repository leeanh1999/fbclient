package fbc;

import java.util.Vector;

/**
 * One row of the reader screen (ReaderCanvas): the items of one line of the
 * page (text runs, images, inputs) as the server's /p sends them, and their
 * layout for the screen width. Text runs flow one after another, wrapped
 * at spaces with the app's fonts; a small leading image (avatar) gets a
 * column of its own, big images go on lines of their own (side by side
 * when they fit), an input takes a line. Positions are phone px from the
 * row's top.
 */
final class ReaderRow {

    static final int K_TEXT = 0;
    static final int K_IMAGE = 1;
    static final int K_VIDEO = 2;
    static final int K_INPUT = 3;

    private static final int PAD = 8;
    private static final int TOP = 3;
    private static final int AVATAR_MAX = 72;
    private static final int ICON_MAX = 24;

    int indent;
    /** Raw items: String[] fields of the T / I / E line. */
    final Vector items = new Vector();

    int layoutW = -1;
    int layoutGen = -1;
    int height;
    // Fragments: what is drawn where.
    int n;
    int[] kind, x, y, w, h, color, bg;
    TextFont[] font;
    String[] str;   // text, or the image key, or the input's text
    String[] key;   // what pressing it presses ("" = nothing)
    boolean[] pass; // inputs: password field
    // Fills behind text (a comment's bubble, a button): one box per run of
    // fragments with the same fill.
    int boxes;
    int[] boxX, boxY, boxW, boxH, boxC;
    static final int BOX_PAD_X = 6;
    static final int BOX_PAD_Y = 3;

    // Building fragments.
    private Vector vKind, vX, vY, vW, vH, vColor, vBg, vFont, vStr, vKey, vPass;
    private int lineX, lineY, lineH, colX, right;

    void layout(int width) {
        if (width == layoutW && layoutGen == TextFrame.gen) {
            return;
        }
        layoutW = width;
        layoutGen = TextFrame.gen;
        vKind = new Vector();
        vX = new Vector();
        vY = new Vector();
        vW = new Vector();
        vH = new Vector();
        vColor = new Vector();
        vBg = new Vector();
        vFont = new Vector();
        vStr = new Vector();
        vKey = new Vector();
        vPass = new Vector();
        int x0 = indent < PAD ? PAD : Math.min(indent, width / 3);
        right = width - PAD;
        colX = x0;
        lineX = x0;
        lineY = TOP;
        lineH = 0;
        int bottom = TOP;
        boolean lastSpace = true;
        for (int i = 0; i < items.size(); i++) {
            String[] f = (String[]) items.elementAt(i);
            char t = f[0].charAt(0);
            // The page breaks the line before this item.
            int flags = FbMidlet.parseInt(t == 'I' ? f[5] : f[2 + (t == 'T' ? 1 : 0)], 0);
            if ((flags & 2) != 0 && lineX > colX) {
                newLine();
                lastSpace = true;
            }
            if (t == 'I') {
                int iw = FbMidlet.parseInt(f[3], 0);
                int ih = FbMidlet.parseInt(f[4], 0);
                int k = (flags & 1) != 0 ? K_VIDEO : K_IMAGE;
                if ((flags & 4) != 0) {
                    // An emoji in the text: flows with it.
                    if (lineX + iw > right && lineX > colX) {
                        newLine();
                    }
                    add(k, lineX, lineY, iw, ih, 0, -1, null, f[1], f[2], false);
                    lineX += iw;
                    lineH = Math.max(lineH, ih);
                    continue;
                } else if (i == 0 && iw > ICON_MAX && iw <= AVATAR_MAX && ih <= AVATAR_MAX && items.size() > 1) {
                    // Leading avatar: a column of its own.
                    add(k, x0, TOP, iw, ih, 0, -1, null, f[1], f[2], false);
                    colX = x0 + iw + 6;
                    lineX = colX;
                    bottom = TOP + ih;
                } else if (iw <= ICON_MAX && ih <= ICON_MAX) {
                    if (lineX + iw > right && lineX > colX) {
                        newLine();
                    }
                    add(k, lineX, lineY, iw, ih, 0, -1, null, f[1], f[2], false);
                    lineX += iw + 4;
                    lineH = Math.max(lineH, ih);
                } else {
                    // Big image: its own line, or beside the one before if it
                    // fits (a grid of photos: a few px over is clipped).
                    boolean first = lineX == colX;
                    if (!first && (((Integer) vKind.lastElement()).intValue() == K_TEXT || lineX + iw > width + 6)) {
                        newLine();
                        first = true;
                    }
                    int ix = lineX;
                    if (first) {
                        if (iw >= width - 2 * PAD) {
                            ix = Math.max(0, (width - iw) / 2); // full width
                        } else if (colX == x0 && iw >= width / 4) {
                            ix = 0; // a grid starts at the edge, as on the page
                        }
                    }
                    add(k, ix, lineY, iw, ih, 0, -1, null, f[1], f[2], false);
                    lineX = ix + iw + 2;
                    lineH = Math.max(lineH, ih);
                }
                lastSpace = true;
            } else if (t == 'E') {
                if (lineX > colX) {
                    newLine();
                }
                TextFont ef = TextFrame.font(15, false);
                String value = f[4];
                String shownText = value.length() > 0 ? value : f[3];
                int bh = ef.height() + 12;
                add(K_INPUT, colX, lineY, right - colX, bh, value.length() > 0 ? 0x050505 : 0x8A8D91, -1, ef,
                        shownText, f[1], (flags & 1) != 0);
                lineY += bh + 4;
                lineH = 0;
                lastSpace = true;
            } else if (t == 'T') {
                int size = FbMidlet.parseInt(f[2], 14);
                boolean bold = (flags & 1) != 0;
                int col = hex(f[4], 0x050505);
                int fill = f[5].length() > 0 ? hex(f[5], -1) : -1;
                String text = f[6];
                TextFont tf = TextFrame.font(size, bold);
                // Separate runs (buttons, labels) get a space between them.
                if (!lastSpace && text.length() > 0 && text.charAt(0) != ' ' && lineX > colX) {
                    lineX += tf.stringWidth(" ");
                }
                // Room for the box around filled text (not again inside one).
                int prevFill = vBg.size() > 0 ? ((Integer) vBg.lastElement()).intValue() : -1;
                if (fill >= 0 && fill != prevFill) {
                    lineX += BOX_PAD_X;
                }
                flow(text, tf, col, fill, f[1]);
                if (fill >= 0) {
                    lineX += BOX_PAD_X;
                }
                lastSpace = text.length() == 0 || text.charAt(text.length() - 1) == ' ';
            }
        }
        if (lineH > 0) {
            lineY += lineH;
        }
        height = Math.max(lineY, bottom) + TOP;
        n = vKind.size();
        kind = ints(vKind);
        x = ints(vX);
        y = ints(vY);
        w = ints(vW);
        h = ints(vH);
        color = ints(vColor);
        bg = ints(vBg);
        font = new TextFont[n];
        str = new String[n];
        key = new String[n];
        pass = new boolean[n];
        for (int i = 0; i < n; i++) {
            font[i] = (TextFont) vFont.elementAt(i);
            str[i] = (String) vStr.elementAt(i);
            key[i] = (String) vKey.elementAt(i);
            pass[i] = ((Boolean) vPass.elementAt(i)).booleanValue();
        }
        vKind = vX = vY = vW = vH = vColor = vBg = vFont = vStr = vKey = vPass = null;
        makeBoxes();
        for (int k = 0; k < boxes; k++) {
            height = Math.max(height, boxY[k] + boxH[k] + 1);
        }
    }

    /** One box per run of text fragments with the same fill. */
    private void makeBoxes() {
        Vector b = new Vector();
        int i = 0;
        while (i < n) {
            if (kind[i] != K_TEXT || bg[i] < 0) {
                i++;
                continue;
            }
            int c = bg[i];
            int x1 = x[i];
            int y1 = y[i];
            int x2 = x[i] + w[i];
            int y2 = y[i] + h[i];
            int j = i + 1;
            while (j < n && kind[j] == K_TEXT && bg[j] == c) {
                x1 = Math.min(x1, x[j]);
                y1 = Math.min(y1, y[j]);
                x2 = Math.max(x2, x[j] + w[j]);
                y2 = Math.max(y2, y[j] + h[j]);
                j++;
            }
            b.addElement(new int[] {x1 - BOX_PAD_X, y1 - BOX_PAD_Y, x2 - x1 + 2 * BOX_PAD_X, y2 - y1 + 2 * BOX_PAD_Y, c});
            i = j;
        }
        boxes = b.size();
        boxX = new int[boxes];
        boxY = new int[boxes];
        boxW = new int[boxes];
        boxH = new int[boxes];
        boxC = new int[boxes];
        for (int k = 0; k < boxes; k++) {
            int[] r = (int[]) b.elementAt(k);
            boxX[k] = r[0];
            boxY[k] = r[1];
            boxW[k] = r[2];
            boxH[k] = r[3];
            boxC[k] = r[4];
        }
    }

    /** Words of text onto the lines, one fragment per piece on a line. */
    private void flow(String text, TextFont tf, int col, int fill, String k) {
        int lh = tf.height();
        int len = text.length();
        int start = 0;
        while (start < len) {
            // The longest piece from start that fits the line, broken at a space.
            int avail = right - lineX;
            int w8 = 0;
            int end = start;
            int lastBreak = -1;
            while (end < len) {
                char c = text.charAt(end);
                int a = tf.advance8(c);
                if (((w8 + a + 4) >> 3) > avail) {
                    break;
                }
                w8 += a;
                end++;
                if (c == ' ') {
                    lastBreak = end;
                }
            }
            if (end < len) {
                if (lastBreak > start) {
                    end = lastBreak;
                } else if (lineX > colX) {
                    newLine(); // nothing fits after what is on the line
                    continue;
                } else if (end == start) {
                    end = start + 1;
                }
            }
            String piece = text.substring(start, end);
            String drawn = end < len ? piece.trim() : piece;
            if (drawn.trim().length() > 0) {
                int pw = tf.stringWidth(drawn);
                add(K_TEXT, lineX, lineY, pw, lh, col, fill, tf, drawn, k, false);
                lineX += tf.stringWidth(piece);
                lineH = Math.max(lineH, lh);
            } else {
                lineX += tf.stringWidth(piece);
            }
            start = end;
            if (start < len) {
                newLine();
                while (start < len && text.charAt(start) == ' ') {
                    start++;
                }
            }
        }
    }

    private void newLine() {
        lineY += (lineH > 0 ? lineH : 0) + 2;
        lineX = colX;
        lineH = 0;
    }

    private void add(int k, int fx, int fy, int fw, int fh, int col, int fill, TextFont f, String s, String ak,
            boolean pw) {
        vKind.addElement(new Integer(k));
        vX.addElement(new Integer(fx));
        vY.addElement(new Integer(fy));
        vW.addElement(new Integer(fw));
        vH.addElement(new Integer(fh));
        vColor.addElement(new Integer(col));
        vBg.addElement(new Integer(fill));
        vFont.addElement(f);
        vStr.addElement(s);
        vKey.addElement(ak == null ? "" : ak);
        vPass.addElement(pw ? Boolean.TRUE : Boolean.FALSE);
    }

    private static int[] ints(Vector v) {
        int[] a = new int[v.size()];
        for (int i = 0; i < a.length; i++) {
            a[i] = ((Integer) v.elementAt(i)).intValue();
        }
        return a;
    }

    static int hex(String s, int def) {
        try {
            return Integer.parseInt(s.trim(), 16);
        } catch (Exception e) {
            return def;
        }
    }
}
