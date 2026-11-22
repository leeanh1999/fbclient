package fbc;

import java.util.Vector;

/**
 * One post of the feed screen (FeedCanvas), as the server's /f sends it,
 * and its layout for the screen width: text lines (wrapped here with the
 * app's fonts), media boxes and the Like / Comment / Share bar. All y are
 * phone px from the top of the post.
 */
final class FeedPost {

    static final int LIKED = 1;
    static final int CUT = 2; // the text is cut ("See more")

    // Line kinds, each with its font and colour (FeedCanvas paints them).
    static final int L_TITLE = 0;
    static final int L_META = 1;
    static final int L_BODY = 2;
    static final int L_MORE = 3;
    static final int L_CARD = 4;
    static final int L_COUNT = 5;

    static final int PAD = 8;
    static final int GAP = 8; // grey space between posts

    String key = "";
    /** The post's lines as received: same sig, same post (its layout is kept). */
    String sig = "";
    int flags;
    String avKey = "";
    int avSize;
    String title = "", meta = "", likes = "", comments = "", shares = "";
    final Vector body = new Vector();
    final Vector card = new Vector();
    // Media: key and {x, y, w, h, video} within the media block.
    final Vector mediaKey = new Vector();
    final Vector media = new Vector();

    // Layout for layoutW (and font generation layoutGen).
    int layoutW = -1;
    int layoutGen = -1;
    int height;
    int headH, bodyY, bodyH, mediaY, barY, barH;
    String[] lineText = new String[0];
    int[] lineY = new int[0];
    int[] lineKind = new int[0];

    boolean liked() {
        return (flags & LIKED) != 0;
    }

    /** Font of a line kind, at the app's page zoom. */
    static TextFont font(int kind) {
        switch (kind) {
            case L_TITLE: return size(15, true);
            case L_META: return size(12, false);
            case L_CARD: return size(13, false);
            case L_COUNT: return size(13, false);
            default: return size(15, false);
        }
    }

    static TextFont size(int css, boolean bold) {
        return TextFrame.font(css * TextFrame.pageZoom() / 100, bold);
    }

    static int avatarSize(int avSize) {
        return avSize > 0 ? avSize : 40;
    }

    /** Lays the post out for width w (again only if w or the fonts changed). */
    void layout(int w) {
        if (w == layoutW && layoutGen == TextFrame.gen) {
            return;
        }
        layoutW = w;
        layoutGen = TextFrame.gen;
        Vector text = new Vector();
        Vector ys = new Vector();
        Vector kinds = new Vector();
        int a = avatarSize(avSize);
        int tx = PAD + a + 8;
        int y = PAD;
        y = add(text, ys, kinds, title, L_TITLE, w - tx - PAD, 3, y);
        if (meta.length() > 0) {
            y = add(text, ys, kinds, meta, L_META, w - tx - PAD, 1, y);
        }
        headH = Math.max(a, y - PAD);
        y = PAD + headH + 6;
        bodyY = y;
        for (int i = 0; i < body.size(); i++) {
            y = add(text, ys, kinds, (String) body.elementAt(i), L_BODY, w - 2 * PAD, 40, y) + 2;
        }
        if ((flags & CUT) != 0) {
            y = add(text, ys, kinds, "See more", L_MORE, w - 2 * PAD, 1, y) + 2;
        }
        if (body.size() > 0 || (flags & CUT) != 0) {
            y += 4;
        }
        mediaY = y;
        int mh = 0;
        for (int i = 0; i < media.size(); i++) {
            int[] m = (int[]) media.elementAt(i);
            mh = Math.max(mh, m[1] + m[3]);
        }
        if (mh > 0) {
            y += mh + 6;
        }
        for (int i = 0; i < card.size(); i++) {
            y = add(text, ys, kinds, (String) card.elementAt(i), L_CARD, w - 2 * PAD, 2, y);
        }
        String counts = counts();
        if (counts.length() > 0) {
            y = add(text, ys, kinds, counts, L_COUNT, w - 2 * PAD, 1, y + 4);
        }
        bodyH = y - bodyY;
        barY = y + 4;
        barH = Math.max(34, size(14, true).height() + 16);
        height = barY + barH;
        int n = text.size();
        lineText = new String[n];
        lineY = new int[n];
        lineKind = new int[n];
        for (int i = 0; i < n; i++) {
            lineText[i] = (String) text.elementAt(i);
            lineY[i] = ((Integer) ys.elementAt(i)).intValue();
            lineKind[i] = ((Integer) kinds.elementAt(i)).intValue();
        }
    }

    /** "12 likes · 3 comments · 1 share", empty when there are none. */
    private String counts() {
        StringBuffer sb = new StringBuffer();
        count(sb, likes, " like", " likes");
        count(sb, comments, " comment", " comments");
        count(sb, shares, " share", " shares");
        return sb.toString();
    }

    private static void count(StringBuffer sb, String n, String one, String many) {
        if (n.length() == 0) {
            return;
        }
        if (sb.length() > 0) {
            sb.append(" · ");
        }
        sb.append(n).append("1".equals(n) ? one : many);
    }

    /** Wraps s into lines of kind at y; returns the y below them. */
    private static int add(Vector text, Vector ys, Vector kinds, String s, int kind, int maxW, int maxLines, int y) {
        TextFont f = font(kind);
        Vector lines = new Vector();
        wrap(s, f, maxW, maxLines, lines);
        int lh = f.height() + 2;
        for (int i = 0; i < lines.size(); i++) {
            text.addElement(lines.elementAt(i));
            ys.addElement(new Integer(y));
            kinds.addElement(new Integer(kind));
            y += lh;
        }
        return y;
    }

    /**
     * Breaks s into lines at most maxW wide, at spaces (words longer than a
     * line are cut anywhere); after maxLines the last line ends in "...".
     */
    static void wrap(String s, TextFont f, int maxW, int maxLines, Vector out) {
        int n = s.length();
        int start = 0;
        int max8 = (maxW << 3) + 3; // (w8 + 4) >> 3 <= maxW
        while (start < n && out.size() < maxLines) {
            while (start < n && s.charAt(start) == ' ') {
                start++;
            }
            if (start >= n) {
                break;
            }
            int end = start;
            int lastSpace = -1;
            int w8 = 0;
            while (end < n) {
                char c = s.charAt(end);
                w8 += f.advance8(c);
                if (w8 > max8) {
                    break;
                }
                if (c == ' ') {
                    lastSpace = end;
                }
                end++;
            }
            if (end < n && lastSpace > start) {
                end = lastSpace; // break at the last space that fits
            } else if (end == start) {
                end = start + 1; // not even one character fits
            }
            String line = s.substring(start, end).trim();
            if (out.size() == maxLines - 1 && end < n) {
                line = TextFrame.clip(s.substring(start).trim(), f, maxW);
                end = n;
            }
            out.addElement(line);
            start = end;
        }
    }
}
