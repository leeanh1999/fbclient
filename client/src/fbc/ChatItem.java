package fbc;

import java.util.Vector;

/**
 * A row of the chat list or a message of a thread (ChatCanvas), as /m
 * sends it, with its layout for the screen width. y are phone px from the
 * item's top.
 */
final class ChatItem {

    // List rows
    static final int UNREAD = 1;
    static final int ONLINE = 2;
    // Messages
    static final int MINE = 1;

    static final int PAD = 8;     // screen edge
    static final int BUBBLE = 8;  // inside a bubble
    static final int AVATAR = 28; // sender avatar beside others' messages
    static final int AV_COL = AVATAR + 6;

    String key = "";
    int flags;
    String avKey = "";
    String name = "";    // list: chat name; message: sender
    String snippet = ""; // list: last message
    String time = "";
    String text = "";    // message text (may hold '\n')
    final Vector mediaKey = new Vector();
    final Vector media = new Vector(); // int[] {w, h, video}

    // Message layout
    int layoutW = -1;
    int layoutGen = -1;
    boolean showSender, showTime;
    int height;
    int senderY, timeY, bubbleX, bubbleY, bubbleW, bubbleH, textY, mediaY;
    String[] lines = new String[0];

    boolean mine() {
        return (flags & MINE) != 0;
    }

    static TextFont textFont() {
        return FeedPost.size(15, false);
    }

    static TextFont smallFont() {
        return FeedPost.size(12, false);
    }

    /**
     * Lays a message out for width w; prev is the message before it (null
     * for the first): the sender is shown when it changes, the time when it
     * is the first or 15+ minutes after the previous one.
     */
    void layoutMessage(int w, ChatItem prev) {
        boolean sender = !mine() && name.length() > 0 && (prev == null || prev.mine() || !prev.name.equals(name));
        boolean when = time.length() > 0 && (prev == null || minutesBetween(prev.time, time) >= 15);
        if (w == layoutW && layoutGen == TextFrame.gen && sender == showSender && when == showTime) {
            return;
        }
        layoutW = w;
        layoutGen = TextFrame.gen;
        showSender = sender;
        showTime = when;
        TextFont tf = textFont();
        TextFont sf = smallFont();
        int y = prev == null || prev.mine() != mine() || sender ? 8 : 2;
        if (when) {
            timeY = y + 4;
            y = timeY + sf.height() + 8;
        }
        if (sender) {
            senderY = y;
            y += sf.height() + 2;
        }
        int maxW = w * 3 / 4 - (mine() ? 0 : AV_COL);
        Vector out = new Vector();
        if (text.length() > 0) {
            int start = 0;
            while (start <= text.length()) {
                int nl = text.indexOf('\n', start);
                if (nl < 0) {
                    nl = text.length();
                }
                String para = text.substring(start, nl);
                if (para.trim().length() == 0) {
                    out.addElement("");
                } else {
                    FeedPost.wrap(para, tf, maxW - 2 * BUBBLE, 60, out);
                }
                start = nl + 1;
            }
        }
        lines = new String[out.size()];
        int textW = 0;
        for (int i = 0; i < lines.length; i++) {
            lines[i] = (String) out.elementAt(i);
            textW = Math.max(textW, tf.stringWidth(lines[i]));
        }
        int lh = tf.height() + 1;
        bubbleY = y;
        textY = y + (lines.length > 0 ? BUBBLE / 2 + 2 : 0);
        int th = lines.length > 0 ? lines.length * lh + BUBBLE : 0;
        int mw = 0;
        int mh = 0;
        for (int i = 0; i < media.size(); i++) {
            int[] m = (int[]) media.elementAt(i);
            mw = Math.max(mw, Math.min(m[0], maxW));
            mh += m[1] + (i > 0 ? 4 : 0);
        }
        mediaY = bubbleY + th + (th > 0 && mh > 0 ? 4 : 0);
        bubbleW = Math.max(lines.length > 0 ? textW + 2 * BUBBLE : 0, mw);
        bubbleH = mediaY + mh - bubbleY;
        bubbleX = mine() ? w - PAD - bubbleW : PAD + AV_COL;
        height = bubbleY + Math.max(bubbleH, avKey.length() > 0 ? AVATAR : 0);
    }

    /** Minutes from "H:MM" a to b; 0 when either is not a time. */
    static int minutesBetween(String a, String b) {
        int ma = minutes(a);
        int mb = minutes(b);
        if (ma < 0 || mb < 0) {
            return 0;
        }
        int d = mb - ma;
        return d < 0 ? d + 24 * 60 : d;
    }

    private static int minutes(String t) {
        int c = t.indexOf(':');
        if (c <= 0) {
            return -1;
        }
        int h = FbMidlet.parseInt(t.substring(0, c), -1);
        int m = FbMidlet.parseInt(t.substring(c + 1), -1);
        return h < 0 || m < 0 ? -1 : h * 60 + m;
    }
}
