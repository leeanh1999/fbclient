package fbc;

import java.io.InputStream;
import java.util.Hashtable;
import java.util.Vector;

import javax.microedition.io.Connector;
import javax.microedition.io.HttpConnection;
import javax.microedition.lcdui.Canvas;
import javax.microedition.lcdui.Graphics;
import javax.microedition.lcdui.Image;

/**
 * The app's own Messenger screen: the chat list and a thread from the
 * server's /m as data, laid out and drawn here (ChatItem).
 *
 * List: up/down pick a chat, FIRE/5 opens it, 3 reloads, left soft / * the
 * menu, 1 / # / right soft back home (the feed). Thread: up/down and 2/8
 * scroll, FIRE/5 or 0 writes a message, 3 reloads, left soft / * the menu,
 * 1 / # / right soft back to the list.
 * Touch: drag to scroll, tap a chat to open it, tap the message bar to
 * write; footer Menu | Home | Back.
 *
 * The open screen is polled (a thread every few seconds) so new messages
 * show up; the server answers 204 while nothing changed.
 */
class ChatCanvas extends Canvas implements Runnable, ImageSource {

    private static final int C_BG = 0xFFFFFF;
    private static final int C_TEXT = 0x050505;
    private static final int C_SUB = 0x65676B;
    private static final int C_MINE = 0x0866FF;
    private static final int C_THEIRS = 0xF0F0F0;
    private static final int C_SEL = 0xE7F3FF;
    private static final int C_HOLDER = 0xE4E6EB;
    private static final int C_ONLINE = 0x31A24C;
    private static final int DRAG_SLOP = 12;
    private static final int MSG_MS = 3000;
    private static final int POLL_THREAD_MS = 3000;
    private static final int POLL_LIST_MS = 8000;
    private static final int AVATAR = 40;
    private static final String POLL = "op=poll";

    private static final int[] FOOTER_LIST = {Icons.MENU, Icons.HOME, Icons.BACK};

    private final MenuOverlay menu = new MenuOverlay(MenuOverlay.SCREEN_ITEMS);
    private static final int[] FOOTER_THREAD = FOOTER_LIST;

    private final FbMidlet app;
    private final boolean touch;
    private final int barH;

    // What is shown: the list or a thread (from the last reply's X-Chat).
    private volatile boolean thread;
    private volatile Vector rows = new Vector();
    private volatile Vector msgs = new Vector();
    private String title = "";
    private int[] msgTop = new int[0];
    private int contentH;
    private Vector laidOut;
    private int layoutW = -1;
    private int layoutGen = -1;

    private volatile int sy;
    private int shownSy;
    private int sel = -1;
    private boolean stickBottom = true;
    private int olderAsked = -1;
    private long olderAt;
    private int moreAsked = -1;
    private long moreAt;
    volatile boolean shown;

    private final Vector queue = new Vector();
    private volatile boolean running = true;
    private volatile boolean loading;
    private String hash = "";

    private String msg;
    private long msgUntil;

    private boolean pressed, dragging, pressOnBar;
    private int px0, py0, pressSy, barPress = -1;

    ChatCanvas(FbMidlet app) {
        this.app = app;
        setFullScreenMode(true);
        touch = hasPointerEvents();
        barH = touch ? Math.max(TextFrame.ui(TextFrame.UI_SIZE, false).height() + 22, 46) : 0;
        new Thread(this).start();
    }

    void dispose() {
        running = false;
        synchronized (queue) {
            queue.notifyAll();
        }
    }

    /** Height of the scrolling area: above the footer and the message bar. */
    private int viewHeight() {
        return getHeight() - barH - (thread ? composerH() : 0);
    }

    private int composerH() {
        return ChatItem.textFont().height() + 20;
    }

    // ---- Requests ----

    /** Shows the chat list (from the start). */
    void loadList() {
        request("op=list");
    }

    /** Sends a message in the open thread. */
    void send(String text) {
        if (text.trim().length() == 0) {
            return;
        }
        stickBottom = true;
        showMsg("Sending...");
        request("op=send&t=" + Net.urlEncode(text));
    }

    private void request(String params) {
        synchronized (queue) {
            if (!queue.contains(params)) {
                queue.addElement(params);
            }
            queue.notifyAll();
        }
        repaint();
    }

    public void run() {
        long lastReply = System.currentTimeMillis();
        while (running) {
            String req = null;
            synchronized (queue) {
                while (running && queue.isEmpty()) {
                    long every = thread ? POLL_THREAD_MS : POLL_LIST_MS;
                    long wait = lastReply + every - System.currentTimeMillis();
                    if (msg != null) {
                        wait = Math.min(wait, 500);
                    }
                    if (msg != null && System.currentTimeMillis() > msgUntil) {
                        msg = null;
                        repaint();
                    }
                    if (shown && System.currentTimeMillis() - lastReply >= every) {
                        // At the newest messages: the server keeps its page there too.
                        req = thread && stickBottom ? POLL + "&b=1" : POLL;
                        break;
                    }
                    try {
                        // Hidden: no polling, sleep until a request or showNotify.
                        queue.wait(shown ? Math.max(50, wait) : (msg != null ? 500 : 0));
                    } catch (InterruptedException e) {
                        // continue
                    }
                }
                if (!running) {
                    return;
                }
                if (req == null) {
                    req = (String) queue.elementAt(0);
                    queue.removeElementAt(0);
                }
            }
            loading = !req.startsWith(POLL);
            if (loading) {
                repaint();
            }
            try {
                execute(req);
            } catch (Throwable t) {
                showMsg("Error: " + t.getMessage());
            }
            lastReply = System.currentTimeMillis();
            loading = false;
            repaint();
        }
    }

    private void execute(String params) throws Exception {
        StringBuffer url = new StringBuffer(app.server);
        url.append("/m?").append(app.net.viewParams());
        url.append("&hash=").append(hash);
        url.append('&').append(params);
        HttpConnection hc = null;
        InputStream in = null;
        try {
            hc = (HttpConnection) Connector.open(app.connUrl(url.toString()), Connector.READ, true);
            hc.setRequestMethod(HttpConnection.GET);
            int code = hc.getResponseCode();
            String need = hc.getHeaderField("X-Need");
            if (need != null) {
                // Logged out, or Messenger asks for its PIN: the browser view.
                app.display.callSerially(new UiTask(app, UiTask.NEED_USER, need, false));
                return;
            }
            String err = hc.getHeaderField("X-Chat-Err");
            if (err != null) {
                showMsg(Net.urlDecode(err));
            }
            if (code == HttpConnection.HTTP_NO_CONTENT) {
                return;
            }
            if (code != HttpConnection.HTTP_OK) {
                throw new Exception("HTTP " + code);
            }
            String screen = hc.getHeaderField("X-Chat");
            String h = hc.getHeaderField("X-Hash");
            in = hc.openInputStream();
            byte[] data = Net.readAll(in, (int) hc.getLength());
            String body = Net.utf8(data, 0, data.length);
            data = null;
            if (h != null) {
                hash = h;
            }
            apply("thread".equals(screen), body);
        } finally {
            Net.close(in, hc);
        }
    }

    private void apply(boolean isThread, String body) {
        Vector list = new Vector();
        String head = "";
        ChatItem cur = null;
        String[] f = new String[7];
        int start = 0;
        int n = body.length();
        while (start < n) {
            int end = body.indexOf('\n', start);
            if (end < 0) {
                end = n;
            }
            int k = split(body, start, end, f);
            start = end + 1;
            char t = k > 0 && f[0].length() > 0 ? f[0].charAt(0) : ' ';
            if (t == 'X') {
                Emoji.define(f, k);
            } else if (t == 'H' && k >= 2) {
                head = f[1];
            } else if (t == 'C' && k >= 7) {
                cur = new ChatItem();
                cur.key = f[1];
                cur.flags = FbMidlet.parseInt(f[2], 0);
                cur.avKey = f[3];
                cur.name = f[4];
                cur.snippet = f[5];
                cur.time = f[6];
                list.addElement(cur);
            } else if (t == 'M' && k >= 6) {
                cur = new ChatItem();
                cur.key = f[1];
                cur.flags = FbMidlet.parseInt(f[2], 0);
                cur.time = f[3];
                cur.name = f[4];
                cur.text = f[5];
                list.addElement(cur);
            } else if (t == 'A' && k >= 2 && cur != null) {
                cur.avKey = f[1];
            } else if (t == 'L' && k >= 2 && cur != null) {
                cur.text = cur.text + "\n" + f[1];
            } else if (t == 'I' && k >= 5 && cur != null) {
                cur.mediaKey.addElement(f[1]);
                cur.media.addElement(new int[] {
                    FbMidlet.parseInt(f[2], 0), FbMidlet.parseInt(f[3], 0), FbMidlet.parseInt(f[4], 0)});
            }
        }
        synchronized (this) {
            boolean switched = isThread != thread;
            if (isThread) {
                // Keep laid out messages that did not change.
                Hashtable old = new Hashtable();
                for (int i = 0; i < msgs.size(); i++) {
                    ChatItem o = (ChatItem) msgs.elementAt(i);
                    old.put(o.key, o);
                }
                for (int i = 0; i < list.size(); i++) {
                    ChatItem m = (ChatItem) list.elementAt(i);
                    ChatItem o = (ChatItem) old.get(m.key);
                    if (o != null && o.text.equals(m.text) && o.media.size() == m.media.size()
                            && o.avKey.equals(m.avKey)) {
                        list.setElementAt(o, i);
                    }
                }
                // The first message in view and how far into it the view is,
                // so added messages (older ones above) do not move what is read.
                String anchor = null;
                int into = 0;
                Vector cur0 = msgs;
                for (int i = 0; thread && i < cur0.size() && i < msgTop.length; i++) {
                    ChatItem o = (ChatItem) cur0.elementAt(i);
                    if (msgTop[i] + o.height > sy) {
                        anchor = o.key;
                        into = sy - msgTop[i];
                        break;
                    }
                }
                boolean atBottom = stickBottom;
                msgs = list;
                if (head.length() > 0) {
                    title = head;
                }
                thread = true;
                laidOut = null;
                layout();
                if (switched || atBottom) {
                    sy = shownSy = maxScroll();
                    stickBottom = true;
                    olderAsked = -1;
                } else if (anchor != null) {
                    for (int i = 0; i < list.size(); i++) {
                        if (((ChatItem) list.elementAt(i)).key.equals(anchor)) {
                            int d = msgTop[i] + into - sy;
                            sy += d;
                            shownSy += d;
                            break;
                        }
                    }
                }
            } else {
                String selKey = sel >= 0 && sel < rows.size() ? ((ChatItem) rows.elementAt(sel)).key : null;
                rows = list;
                thread = false;
                laidOut = null;
                if (switched) {
                    sy = shownSy = 0;
                    sel = list.size() > 0 ? 0 : -1;
                    moreAsked = -1;
                } else {
                    sel = Math.min(sel, list.size() - 1);
                    for (int i = 0; selKey != null && i < list.size(); i++) {
                        if (((ChatItem) list.elementAt(i)).key.equals(selKey)) {
                            sel = i;
                        }
                    }
                }
                layout();
            }
        }
        app.loader.wake();
        repaint();
        moved(); // still near the top: ask for more older messages
    }

    private static int split(String body, int start, int end, String[] out) {
        int i = 0;
        while (i < out.length - 1) {
            int tab = body.indexOf('\t', start);
            if (tab < 0 || tab >= end) {
                break;
            }
            out[i++] = body.substring(start, tab);
            start = tab + 1;
        }
        out[i++] = body.substring(start, end);
        return i;
    }

    void showMsg(String m) {
        msg = m;
        msgUntil = System.currentTimeMillis() + MSG_MS;
        synchronized (queue) {
            queue.notifyAll();
        }
        repaint();
    }

    // ---- Layout ----

    /** A chat row: the avatar or the name and last-message lines, whichever is taller (phone fonts vary a lot). */
    private int rowH() {
        int text = FeedPost.size(15, true).height() + FeedPost.size(13, true).height() + 2;
        return Math.max(AVATAR, text) + 14;
    }

    private synchronized Vector layout() {
        Vector list = thread ? msgs : rows;
        int w = getWidth();
        if (list == laidOut && w == layoutW && layoutGen == TextFrame.gen) {
            return list;
        }
        laidOut = list;
        layoutW = w;
        layoutGen = TextFrame.gen;
        int n = list.size();
        if (thread) {
            msgTop = new int[n];
            int y = 0;
            ChatItem prev = null;
            for (int i = 0; i < n; i++) {
                ChatItem m = (ChatItem) list.elementAt(i);
                m.layoutMessage(w, prev);
                msgTop[i] = y;
                y += m.height;
                prev = m;
            }
            contentH = y + 8;
        } else {
            contentH = n * rowH();
        }
        sy = FbMidlet.clamp(sy, 0, maxScroll());
        shownSy = FbMidlet.clamp(shownSy, 0, maxScroll());
        return list;
    }

    private int maxScroll() {
        return Math.max(0, contentH - viewHeight());
    }

    // ---- Painting ----

    protected void paint(Graphics g) {
        int w = getWidth();
        int h = getHeight();
        int vh = viewHeight();
        Vector list = layout();
        int d = sy - shownSy;
        if (d != 0) {
            shownSy += Math.abs(d) <= 3 ? d : d / 2;
        }
        int top = shownSy;
        Hashtable images = app.loader.cache;
        g.setClip(0, 0, w, h);
        g.setColor(C_BG);
        g.fillRect(0, 0, w, h);
        g.setClip(0, 0, w, vh);
        TextFont uf = TextFrame.ui(TextFrame.UI_SIZE, false);
        if (thread) {
            for (int i = 0; i < list.size(); i++) {
                ChatItem m = (ChatItem) list.elementAt(i);
                int oy = msgTop[i] - top;
                if (oy >= vh) {
                    break;
                }
                if (oy + m.height >= 0) {
                    paintMessage(g, m, oy, w, vh, images);
                }
            }
        } else {
            int rh = rowH();
            for (int i = top / rh; i < list.size(); i++) {
                int oy = i * rh - top;
                if (oy >= vh) {
                    break;
                }
                paintRow(g, (ChatItem) list.elementAt(i), oy, w, i == sel, images);
            }
        }
        g.setClip(0, 0, w, h);
        if (list.size() == 0) {
            uf.draw(g, loading ? "Loading chats..." : (thread ? "No messages" : "No chats. Press 3 to reload."),
                    w / 2, vh / 3, C_SUB, C_BG, Graphics.TOP | Graphics.HCENTER);
        }
        if (thread) {
            paintComposer(g, w, vh);
        }
        if (loading) {
            int phase = (int) ((System.currentTimeMillis() / 150) % 3);
            for (int i = 0; i < 3; i++) {
                g.setColor(i == phase ? 0x1877F2 : 0xA0B8E0);
                g.fillRect(w - 26 + i * 8, 4, 6, 6);
            }
        }
        String m = msg;
        if (m != null) {
            m = uf.shorten(m, w - 12);
            int tw = Math.min(uf.stringWidth(m) + 12, w);
            int th = uf.height() + 6;
            int y = vh - th - 6;
            g.setColor(0x333333);
            g.fillRoundRect((w - tw) / 2, y, tw, th, 8, 8);
            uf.draw(g, m, w / 2, y + 3, 0xFFFFFF, 0x333333, Graphics.TOP | Graphics.HCENTER);
        }
        if (barH > 0) {
            paintFooter(g, w, h);
        }
        if (menu.open) {
            boolean sliding = menu.tick();
            g.setClip(0, 0, w, h);
            menu.paint(g, w, getHeight() - barH, uf, !touch, "Messenger");
            if (sliding) {
                repaint();
            }
        }
        if (shownSy != sy) {
            repaint();
        }
    }

    private void paintRow(Graphics g, ChatItem c, int oy, int w, boolean selected, Hashtable images) {
        int rh = rowH();
        int bg = selected ? C_SEL : C_BG;
        if (selected) {
            g.setColor(bg);
            g.fillRect(0, oy, w, rh);
        }
        int ax = ChatItem.PAD;
        int ay = oy + (rh - AVATAR) / 2;
        Image av = c.avKey.length() > 0 ? (Image) images.get(c.avKey) : null;
        if (av != null) {
            g.drawImage(av, ax, ay, Graphics.TOP | Graphics.LEFT);
        } else {
            g.setColor(C_HOLDER);
            g.fillArc(ax, ay, AVATAR, AVATAR, 0, 360);
        }
        if ((c.flags & ChatItem.ONLINE) != 0) {
            g.setColor(bg);
            g.fillArc(ax + AVATAR - 13, ay + AVATAR - 13, 14, 14, 0, 360);
            g.setColor(C_ONLINE);
            g.fillArc(ax + AVATAR - 11, ay + AVATAR - 11, 10, 10, 0, 360);
        }
        boolean unread = (c.flags & ChatItem.UNREAD) != 0;
        int tx = ax + AVATAR + 10;
        int tw = w - tx - ChatItem.PAD - (unread ? 14 : 0);
        TextFont nf = FeedPost.size(15, unread);
        TextFont sf = FeedPost.size(13, unread);
        int ty = oy + (rh - nf.height() - sf.height() - 2) / 2;
        nf.drawTop(g, nf.shorten(c.name, tw), tx, ty, C_TEXT, bg);
        String sub = c.snippet;
        if (c.time.length() > 0) {
            sub = sub.length() > 0 ? sub + " · " + c.time : c.time;
        }
        sf.drawTop(g, sf.shorten(sub, tw), tx, ty + nf.height() + 2, unread ? C_TEXT : C_SUB, bg);
        if (unread) {
            g.setColor(C_MINE);
            g.fillArc(w - ChatItem.PAD - 10, oy + rh / 2 - 5, 10, 10, 0, 360);
        }
    }

    private void paintMessage(Graphics g, ChatItem m, int oy, int w, int vh, Hashtable images) {
        TextFont tf = ChatItem.textFont();
        TextFont sf = ChatItem.smallFont();
        if (m.showTime) {
            sf.draw(g, m.time, w / 2, oy + m.timeY, C_SUB, C_BG, Graphics.TOP | Graphics.HCENTER);
        }
        if (m.showSender) {
            sf.drawTop(g, sf.shorten(m.name, w * 3 / 4), m.bubbleX + ChatItem.BUBBLE, oy + m.senderY, C_SUB, C_BG);
        }
        boolean mine = m.mine();
        int bub = mine ? C_MINE : C_THEIRS;
        if (!mine && m.avKey.length() > 0) {
            int a = ChatItem.AVATAR;
            int ay = oy + m.bubbleY + Math.max(m.bubbleH, a) - a;
            Image av = (Image) images.get(m.avKey);
            if (av != null) {
                g.drawImage(av, ChatItem.PAD, ay, Graphics.TOP | Graphics.LEFT);
            } else {
                g.setColor(C_HOLDER);
                g.fillArc(ChatItem.PAD, ay, a, a, 0, 360);
            }
        }
        if (m.lines.length > 0) {
            int th = m.mediaY - m.bubbleY - (m.media.size() > 0 ? 4 : 0);
            g.setColor(bub);
            g.fillRoundRect(m.bubbleX, oy + m.bubbleY, m.bubbleW, th, 18, 18);
            int lh = tf.height() + 1;
            int x = m.bubbleX + ChatItem.BUBBLE;
            for (int i = 0; i < m.lines.length; i++) {
                tf.drawTop(g, m.lines[i], x, oy + m.textY + i * lh, mine ? 0xFFFFFF : C_TEXT, bub);
            }
        }
        int my = oy + m.mediaY;
        for (int i = 0; i < m.media.size(); i++) {
            int[] md = (int[]) m.media.elementAt(i);
            int mw = Math.min(md[0], w * 3 / 4);
            int mx = mine ? w - ChatItem.PAD - mw : ChatItem.PAD + ChatItem.AV_COL;
            String k = (String) m.mediaKey.elementAt(i);
            Image im = k.length() > 0 ? (Image) images.get(k) : null;
            g.setClip(0, 0, w, vh);
            g.clipRect(mx, my, mw, md[1]);
            if (im != null) {
                g.drawImage(im, mx, my, Graphics.TOP | Graphics.LEFT);
            } else {
                g.setColor(C_HOLDER);
                g.fillRect(mx, my, mw, md[1]);
            }
            if (md[2] != 0) {
                int d = Math.max(28, Math.min(44, Math.min(mw, md[1]) / 3));
                Icons.drawSmooth(g, Icons.CIRCLE, mx + mw / 2, my + md[1] / 2, d, 0x1877F2, 0x1877F2);
                Icons.drawSmooth(g, Icons.PLAY, mx + mw / 2, my + md[1] / 2, d * 9 / 20, 0xFFFFFF, 0x1877F2);
            }
            g.setClip(0, 0, w, vh);
            my += md[1] + 4;
        }
    }

    private void paintComposer(Graphics g, int w, int vh) {
        int ch = composerH();
        g.setColor(C_BG);
        g.fillRect(0, vh, w, ch);
        g.setColor(0xDADDE1);
        g.drawLine(0, vh, w, vh);
        g.setColor(C_THEIRS);
        g.fillRoundRect(ChatItem.PAD, vh + 6, w - 2 * ChatItem.PAD, ch - 12, ch - 12, ch - 12);
        TextFont tf = ChatItem.textFont();
        String hint = touch ? "Write a message" : "Write a message (5)";
        tf.drawTop(g, hint, ChatItem.PAD + 12, vh + (ch - tf.height()) / 2, C_SUB, C_THEIRS);
    }

    private void paintFooter(Graphics g, int w, int h) {
        int[] icons = thread ? FOOTER_THREAD : FOOTER_LIST;
        int y = h - barH;
        g.setColor(0xFFFFFF);
        g.fillRect(0, y, w, barH);
        g.setColor(0xDADDE1);
        g.drawLine(0, y, w, y);
        int n = icons.length;
        int s = Math.min(26, barH / 2);
        for (int i = 0; i < n; i++) {
            int bx = (2 * i + 1) * w / (2 * n);
            int cy = y + barH / 2;
            int back = i == barPress ? 0xE4E6EB : 0xFFFFFF;
            if (i == barPress) {
                Icons.drawSmooth(g, Icons.CIRCLE, bx, cy, barH - 8, back, back);
            }
            Icons.drawSmooth(g, icons[i], bx, cy, s, 0x65676B, back);
        }
    }

    // ---- Scrolling ----

    private void scrollTo(int y, boolean smooth) {
        layout();
        sy = FbMidlet.clamp(y, 0, maxScroll());
        if (!smooth) {
            shownSy = sy;
        }
        stickBottom = thread && sy >= maxScroll() - 4;
        repaint();
        moved();
    }

    /** Images in reach; older messages near the top, more chats near the end. */
    private void moved() {
        app.loader.wake();
        Vector list = layout();
        int vh = viewHeight();
        long now = System.currentTimeMillis();
        if (thread && list.size() > 0 && sy < vh && (olderAsked != list.size() || now - olderAt > 4000)) {
            olderAsked = list.size();
            olderAt = now;
            request("op=older");
        } else if (!thread && list.size() > 0 && sy + 2 * vh >= contentH
                && (moreAsked != list.size() || now - moreAt > 4000)) {
            moreAsked = list.size();
            moreAt = now;
            request("op=more");
        }
    }

    private void select(int i) {
        Vector list = layout();
        if (list.size() == 0) {
            return;
        }
        sel = FbMidlet.clamp(i, 0, list.size() - 1);
        int rh = rowH();
        int vh = viewHeight();
        if (sel * rh < sy) {
            scrollTo(sel * rh, true);
        } else if ((sel + 1) * rh > sy + vh) {
            scrollTo((sel + 1) * rh - vh, true);
        } else {
            moved();
        }
        repaint();
    }

    private void open(int i) {
        Vector list = rows;
        if (thread || i < 0 || i >= list.size()) {
            return;
        }
        ChatItem c = (ChatItem) list.elementAt(i);
        title = c.name;
        showMsg("Opening " + c.name + "...");
        request("op=open&k=" + Net.urlEncode(c.key) + "&t=" + Net.urlEncode(c.name));
    }

    private void compose() {
        if (thread) {
            app.showChatInput(title);
        }
    }

    // ---- Keys ----

    protected void keyPressed(int k) {
        k = app.mapKey(k);
        int ga;
        try {
            ga = getGameAction(k);
        } catch (Exception e) {
            ga = 0;
        }
        if (menu.open) {
            int a = menu.key(k, ga);
            repaint();
            if (a >= 0) {
                app.menuAction(a);
            }
            return;
        }
        boolean fire = k == KEY_NUM5 || k == 10 || k == 13 || (ga == FIRE && (k < KEY_NUM0 || k > KEY_NUM9));
        int vh = viewHeight();
        if (k == -7 || k == -22 || k == 22 || k == 57346 || k == KEY_POUND || k == KEY_NUM1 || k == 27 || k == 8) {
            backPressed();
        } else if (k == -6 || k == -21 || k == 21 || k == 57345 || k == KEY_STAR) {
            toggleMenu();
        } else if (k == KEY_NUM3) {
            reload();
        } else if (k == KEY_NUM2) {
            scrollTo(sy - vh * 3 / 4, true);
        } else if (k == KEY_NUM8) {
            scrollTo(sy + vh * 3 / 4, true);
        } else if (thread && (fire || k == KEY_NUM0)) {
            compose();
        } else if (fire) {
            open(sel);
        } else if (ga == UP || ga == DOWN) {
            arrow(ga == DOWN);
        }
    }

    protected void keyRepeated(int k) {
        int ga;
        try {
            ga = getGameAction(app.mapKey(k));
        } catch (Exception e) {
            return;
        }
        if (ga == UP || ga == DOWN) {
            arrow(ga == DOWN);
        }
    }

    private void arrow(boolean down) {
        if (thread) {
            scrollTo(sy + (down ? 1 : -1) * viewHeight() / 3, true);
        } else {
            select(sel < 0 ? 0 : sel + (down ? 1 : -1));
        }
    }

    /** Reload what is shown (menu Reload, 3). */
    void reload() {
        request(thread ? POLL : "op=list");
    }

    private void toggleMenu() {
        if (menu.open) {
            menu.hide();
        } else {
            menu.show(getHeight() - barH);
        }
        repaint();
    }

    void backPressed() {
        if (menu.open) {
            menu.hide();
            repaint();
        } else if (thread) {
            synchronized (this) {
                thread = false;
                laidOut = null;
            }
            repaint();
            request("op=list");
        } else {
            app.openFeed(); // home
        }
    }

    protected void showNotify() {
        shown = true;
        app.loader.wake();
        synchronized (queue) {
            queue.notifyAll(); // polling resumes
        }
    }

    protected void hideNotify() {
        shown = false;
        pressed = false;
        barPress = -1;
    }

    protected void sizeChanged(int w, int h) {
        layoutW = -1;
        repaint();
    }

    public boolean shownNow() {
        return shown;
    }

    // ---- Touch ----

    protected void pointerPressed(int x, int y) {
        pressed = true;
        dragging = false;
        pressOnBar = y >= getHeight() - barH;
        px0 = x;
        py0 = y;
        sy = shownSy;
        pressSy = sy;
        if (pressOnBar) {
            int n = (thread ? FOOTER_THREAD : FOOTER_LIST).length;
            barPress = x * n / getWidth();
            repaint();
        }
    }

    protected void pointerDragged(int x, int y) {
        if (!pressed || pressOnBar || menu.open) {
            return;
        }
        if (!dragging && (Math.abs(x - px0) > DRAG_SLOP || Math.abs(y - py0) > DRAG_SLOP)) {
            dragging = true;
            py0 = y;
            pressSy = sy;
        }
        if (dragging) {
            scrollTo(pressSy + py0 - y, false);
        }
    }

    protected void pointerReleased(int x, int y) {
        if (!pressed) {
            return;
        }
        pressed = false;
        if (pressOnBar) {
            int i = barPress;
            barPress = -1;
            repaint();
            int n = (thread ? FOOTER_THREAD : FOOTER_LIST).length;
            if (y >= getHeight() - barH && i == x * n / getWidth()) {
                if (i == 0) {
                    toggleMenu();
                } else if (i == 1) {
                    menu.hide();
                    app.openFeed();
                } else {
                    backPressed();
                }
            }
            return;
        }
        if (menu.open) {
            int a = menu.hit(x, y);
            if (a >= 0) {
                menu.hide();
                app.menuAction(a);
            } else if (a == -2) {
                menu.hide();
            }
            repaint();
            return;
        }
        if (dragging) {
            dragging = false;
            return;
        }
        int vh = viewHeight();
        if (thread) {
            if (y >= vh) {
                compose();
            }
            return;
        }
        int i = (y + shownSy) / rowH();
        if (y < vh && i < rows.size()) {
            sel = i;
            repaint();
            open(i);
        }
    }

    // ---- Images (ImageLoader) ----

    public Vector missing(Hashtable have, Hashtable skip, int max, int maxPx) {
        Vector out = new Vector();
        Vector list = layout();
        int vh = viewHeight();
        int px = 0;
        for (int pass = 0; pass < 2; pass++) {
            int from = pass == 0 ? sy : sy - vh;
            int to = pass == 0 ? sy + vh : sy + 2 * vh;
            for (int i = 0; i < list.size() && out.size() < max; i++) {
                ChatItem c = (ChatItem) list.elementAt(i);
                int top = thread ? msgTop[i] : i * rowH();
                int h = thread ? c.height : rowH();
                if (top > to || top + h < from) {
                    continue;
                }
                if (c.avKey.length() > 0) {
                    px = want(out, c.avKey, AVATAR * AVATAR, px, have, skip, maxPx);
                }
                for (int j = 0; j < c.media.size() && out.size() < max; j++) {
                    int[] m = (int[]) c.media.elementAt(j);
                    String k = (String) c.mediaKey.elementAt(j);
                    if (k.length() > 0) {
                        px = want(out, k, m[0] * m[1], px, have, skip, maxPx);
                    }
                }
            }
        }
        return out;
    }

    private static int want(Vector out, String k, int size, int px, Hashtable have, Hashtable skip, int maxPx) {
        if (have.containsKey(k) || skip.containsKey(k) || out.contains(k)) {
            return px;
        }
        if (out.size() > 0 && px + size > maxPx) {
            return px;
        }
        out.addElement(k);
        return px + size;
    }

    public Hashtable keysNear() {
        Hashtable t = new Hashtable();
        Vector list = layout();
        int vh = viewHeight();
        for (int i = 0; i < list.size(); i++) {
            ChatItem c = (ChatItem) list.elementAt(i);
            int top = thread ? msgTop[i] : i * rowH();
            if (top > sy + 3 * vh || top + (thread ? c.height : rowH()) < sy - 2 * vh) {
                continue;
            }
            if (c.avKey.length() > 0) {
                t.put(c.avKey, c.avKey);
            }
            for (int j = 0; j < c.mediaKey.size(); j++) {
                Object k = c.mediaKey.elementAt(j);
                t.put(k, k);
            }
        }
        return t;
    }
}
