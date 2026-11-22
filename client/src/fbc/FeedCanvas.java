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
 * The app's own News Feed screen: posts from the server's /f as data, laid
 * out and drawn here (FeedPost), scrolled locally. Images come through
 * ImageLoader (/img) like page mode's.
 *
 * The app's home screen. Keys: up/down move between a post's header, its
 * content and its button bar (left/right pick Like, Comment, Share), FIRE/5
 * presses, 2/8 scroll, 3 reloads, left soft / * the menu (Messenger, URL,
 * Settings, Exit...), right soft / # / 1 back to the top (at the top: the
 * menu). Touch: drag to scroll, tap to press, footer Menu | Home | Back.
 *
 * Pressing anything but Like opens a page on the server (the post, the
 * author, comments): the app goes back to the browser view to show it.
 */
class FeedCanvas extends Canvas implements Runnable, ImageSource {

    // Focusable parts of a post.
    private static final int P_HEAD = 0;
    private static final int P_BODY = 1;
    private static final int P_LIKE = 2;
    private static final int P_COMMENT = 3;
    private static final int P_SHARE = 4;
    private static final String[] BAR = {"Like", "Comment", "Share"};
    private static final String[] PART_OP = {"author", "post", "like", "comment", "share"};

    private static final int C_BG = 0xC9CCD1;
    private static final int C_POST = 0xFFFFFF;
    private static final int C_TEXT = 0x050505;
    private static final int C_SUB = 0x65676B;
    private static final int C_BLUE = 0x0866FF;
    private static final int C_LINE = 0xE4E6EB;
    private static final int C_HOLDER = 0xE4E6EB;
    private static final int DRAG_SLOP = 12;
    private static final int MSG_MS = 3000;

    private static final int[] FOOTER = {Icons.MENU, Icons.HOME, Icons.BACK};

    private final MenuOverlay menu = new MenuOverlay(MenuOverlay.SCREEN_ITEMS);

    private final FbMidlet app;
    private final boolean touch;
    private final int barH;

    /** FeedPost list, replaced as a whole when a reply arrives. */
    private volatile Vector posts = new Vector();
    private int[] postTop = new int[0];
    private int contentH;
    private int layoutW = -1;
    private int layoutGen = -1;
    private Vector laidOut;

    /** Where the view is going (all logic); shownSy eases toward it (painting). */
    volatile int sy;
    private volatile int shownSy;
    private int focusPost = -1;
    private int focusPart = P_HEAD;
    volatile boolean shown;

    // Network: requests for /f, one worker thread.
    private final Vector queue = new Vector();
    private volatile boolean running = true;
    private volatile boolean loading;
    // Touch scrolling that goes on after a quick swipe.
    private final Kinetic fling = new Kinetic();
    // Opened from another screen: the logo until the first reply.
    final Splash splash;
    private String hash = "";
    private int moreAsked = -1;

    private String msg;
    private long msgUntil;

    // Touch
    private boolean pressed, dragging, pressOnBar;
    private int px0, py0, pressSy, barPress = -1;

    FeedCanvas(FbMidlet app) {
        this.app = app;
        splash = new Splash(this, Splash.FACEBOOK);
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

    int viewHeight() {
        return getHeight() - barH;
    }

    // ---- Requests ----

    /** Loads the feed (fresh: reload the page on the server first). */
    void load(boolean fresh) {
        request(fresh ? "op=load&fresh=1" : "op=load");
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
        while (running) {
            String req;
            synchronized (queue) {
                while (running && queue.isEmpty()) {
                    try {
                        // Wake up now and then to clear an expired message.
                        queue.wait(msg != null ? 500 : 0);
                    } catch (InterruptedException e) {
                        // continue
                    }
                    if (msg != null && System.currentTimeMillis() > msgUntil) {
                        msg = null;
                        repaint();
                    }
                }
                if (!running) {
                    return;
                }
                req = (String) queue.elementAt(0);
                queue.removeElementAt(0);
            }
            loading = true;
            if (posts.size() == 0) {
                splash.show(); // nothing to show yet: the logo, not "Loading feed..."
            }
            repaint();
            try {
                execute(req);
            } catch (Throwable t) {
                showMsg("Error: " + t.getMessage());
            }
            loading = false;
            splash.hide(); // its first reply is in
            repaint();
        }
    }

    private void execute(String params) throws Exception {
        StringBuffer url = new StringBuffer(app.server);
        url.append("/f?").append(app.net.viewParams());
        url.append("&hash=").append(hash);
        url.append('&').append(params);
        HttpConnection hc = null;
        InputStream in = null;
        try {
            hc = (HttpConnection) Connector.open(app.connUrl(url.toString()), Connector.READ, true);
            hc.setRequestMethod(HttpConnection.GET);
            int code = hc.getResponseCode();
            String err = hc.getHeaderField("X-Feed-Err");
            if (err != null) {
                showMsg(Net.urlDecode(err));
            }
            String need = hc.getHeaderField("X-Need");
            if (need != null) {
                // Logged out: the browser view, to log in.
                app.display.callSerially(new UiTask(app, UiTask.NEED_USER, need, false));
                return;
            }
            if (hc.getHeaderField("X-Feed-Exit") != null) {
                app.display.callSerially(new UiTask(app, UiTask.FEED_EXIT, null, false));
                return;
            }
            if (code == HttpConnection.HTTP_NO_CONTENT) {
                return;
            }
            if (code != HttpConnection.HTTP_OK) {
                throw new Exception("HTTP " + code);
            }
            String h = hc.getHeaderField("X-Hash");
            in = hc.openInputStream();
            byte[] data = Net.readAll(in, (int) hc.getLength());
            Vector list = parse(Net.utf8(data, 0, data.length));
            data = null;
            if (h != null) {
                hash = h;
            }
            apply(list);
        } finally {
            Net.close(in, hc);
        }
    }

    /** Lines from /f (see server encodeFeed) -> FeedPost list. */
    private static Vector parse(String body) {
        Vector list = new Vector();
        FeedPost cur = null;
        int curStart = 0;
        String[] f = new String[10];
        int start = 0;
        int n = body.length();
        while (start < n) {
            int end = body.indexOf('\n', start);
            if (end < 0) {
                end = n;
            }
            int k = split(body, start, end, f);
            int lineStart = start;
            start = end + 1;
            if (k < 2) {
                continue;
            }
            char t = f[0].length() > 0 ? f[0].charAt(0) : ' ';
            if (t == 'X') {
                Emoji.define(f, k);
            } else if (t == 'P' && k >= 10) {
                if (cur != null) {
                    cur.sig = body.substring(curStart, lineStart);
                }
                curStart = lineStart;
                cur = new FeedPost();
                cur.key = f[1];
                cur.flags = FbMidlet.parseInt(f[2], 0);
                cur.avKey = f[3];
                cur.avSize = FbMidlet.parseInt(f[4], 0);
                cur.title = f[5];
                cur.meta = f[6];
                cur.likes = f[7];
                cur.comments = f[8];
                cur.shares = f[9];
                list.addElement(cur);
            } else if (cur == null) {
                continue;
            } else if (t == 'T') {
                cur.body.addElement(f[1]);
            } else if (t == 'S') {
                cur.card.addElement(f[1]);
            } else if (t == 'I' && k >= 7) {
                cur.mediaKey.addElement(f[1]);
                cur.media.addElement(new int[] {
                    FbMidlet.parseInt(f[2], 0), FbMidlet.parseInt(f[3], 0),
                    FbMidlet.parseInt(f[4], 0), FbMidlet.parseInt(f[5], 0), FbMidlet.parseInt(f[6], 0)});
            }
        }
        if (cur != null) {
            cur.sig = body.substring(curStart, n);
        }
        return list;
    }

    /** Splits body[start..end) at tabs into out; returns the field count. */
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

    /** New posts: keep the focus on the same post, the view where it was. */
    private void apply(Vector list) {
        synchronized (this) {
            Vector old = posts;
            String focusKey = focusPost >= 0 && focusPost < old.size()
                    ? ((FeedPost) old.elementAt(focusPost)).key : null;
            boolean same = old.size() > 0 && list.size() > 0
                    && ((FeedPost) old.elementAt(0)).key.equals(((FeedPost) list.elementAt(0)).key);
            // Unchanged posts: keep the old objects, already laid out.
            Hashtable byKey = new Hashtable();
            for (int i = 0; i < old.size(); i++) {
                FeedPost o = (FeedPost) old.elementAt(i);
                byKey.put(o.key, o);
            }
            for (int i = 0; i < list.size(); i++) {
                FeedPost p = (FeedPost) list.elementAt(i);
                FeedPost o = (FeedPost) byKey.get(p.key);
                if (o != null && o.sig.equals(p.sig)) {
                    list.setElementAt(o, i);
                }
            }
            posts = list;
            layoutW = -1;
            focusPost = -1;
            if (!same) {
                sy = 0;
                shownSy = 0;
                moreAsked = -1;
            } else if (focusKey != null) {
                for (int i = 0; i < list.size(); i++) {
                    if (((FeedPost) list.elementAt(i)).key.equals(focusKey)) {
                        focusPost = i;
                        break;
                    }
                }
            }
        }
        repaint();
        moved();
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

    /** Lays out every post for the screen width; returns the post list. */
    private synchronized Vector layout() {
        Vector list = posts;
        int w = getWidth();
        if (list == laidOut && w == layoutW && layoutGen == TextFrame.gen) {
            return list;
        }
        laidOut = list;
        layoutW = w;
        layoutGen = TextFrame.gen;
        int n = list.size();
        postTop = new int[n];
        int y = 0;
        for (int i = 0; i < n; i++) {
            FeedPost p = (FeedPost) list.elementAt(i);
            p.layout(w);
            postTop[i] = y;
            y += p.height + FeedPost.GAP;
        }
        contentH = y + 48; // room for "Loading..." at the end
        sy = FbMidlet.clamp(sy, 0, maxScroll());
        shownSy = FbMidlet.clamp(shownSy, 0, maxScroll());
        return list;
    }

    private int maxScroll() {
        return Math.max(0, contentH - viewHeight());
    }

    /** Rect {x, y, w, h} (document px) of a part of post i. */
    private int[] partRect(int i, int part) {
        FeedPost p = (FeedPost) layout().elementAt(i);
        int top = postTop[i];
        int w = getWidth();
        switch (part) {
            case P_HEAD: return new int[] {0, top, w, FeedPost.PAD + p.headH + 4};
            case P_BODY: return new int[] {0, top + p.bodyY - 2, w, Math.max(8, p.bodyH + 2)};
            default:
                int k = part - P_LIKE;
                return new int[] {k * w / 3, top + p.barY, w / 3, p.barH};
        }
    }

    // ---- Painting ----

    protected void paint(Graphics g) {
        int w = getWidth();
        int h = getHeight();
        int vh = viewHeight();
        Vector list = layout();
        Hashtable images = app.loader.cache;
        g.setColor(C_BG);
        g.fillRect(0, 0, w, vh);
        // Ease the drawn position toward sy; keep painting until there.
        if (fling.active) {
            // A swipe going on: no easing, stop at either end.
            int want = sy + fling.step();
            int fy = FbMidlet.clamp(want, 0, maxScroll());
            if (fy != want) {
                fling.stop();
            }
            sy = shownSy = fy;
            moved();
        }
        int d = sy - shownSy;
        if (d != 0) {
            shownSy += Math.abs(d) <= 3 ? d : d / 2;
        }
        int top = shownSy;
        int n = list.size();
        for (int i = 0; i < n; i++) {
            FeedPost p = (FeedPost) list.elementAt(i);
            int oy = postTop[i] - top;
            if (oy >= vh) {
                break;
            }
            if (oy + p.height < 0) {
                continue;
            }
            g.setClip(0, 0, w, vh);
            paintPost(g, p, oy, w, images, i == focusPost && focusPart >= P_LIKE ? focusPart - P_LIKE : -1);
        }
        g.setClip(0, 0, w, h);
        TextFont uf = TextFrame.ui(TextFrame.UI_SIZE, false);
        if (n == 0) {
            uf.draw(g, loading ? "Loading feed..." : "No posts. Press 3 to reload.",
                    w / 2, vh / 3, C_TEXT, C_BG, Graphics.TOP | Graphics.HCENTER);
        } else if (contentH - 48 - top < vh) {
            uf.draw(g, loading ? "Loading..." : "", w / 2, contentH - 40 - top, C_SUB, C_BG,
                    Graphics.TOP | Graphics.HCENTER);
        }
        if (focusPost >= 0 && focusPost < n && focusPart < P_LIKE) {
            // Header / content: a ring (the bar buttons get a highlight).
            int[] r = partRect(focusPost, focusPart);
            g.setClip(0, 0, w, vh);
            FocusRing.draw(g, r[0] + 3, r[1] - top + 1, r[2] - 6, r[3] - 2, 12);
            g.setClip(0, 0, w, h);
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
        splash.paint(g, w, vh, uf);
        if (barH > 0) {
            paintFooter(g, w, h);
        }
        boolean more = shownSy != sy || fling.active;
        if (menu.open) {
            more |= menu.tick();
            g.setClip(0, 0, w, h);
            menu.paint(g, w, vh, uf, !touch, "Facebook");
        }
        if (more) {
            app.again(); // menu slide-in, eased scroll
        }
    }

    private static final int C_FOCUS = 0xDCE8FA;

    /** focusBar: the button of the bar in focus (0 Like, 1 Comment, 2 Share), -1 none. */
    private void paintPost(Graphics g, FeedPost p, int oy, int w, Hashtable images, int focusBar) {
        g.setColor(C_POST);
        g.fillRect(0, oy, w, p.height);
        // Avatar, round placeholder until it arrives.
        int a = FeedPost.avatarSize(p.avSize);
        Image av = p.avKey.length() > 0 ? (Image) images.get(p.avKey) : null;
        if (av != null) {
            g.drawImage(av, FeedPost.PAD, oy + FeedPost.PAD, Graphics.TOP | Graphics.LEFT);
        } else {
            g.setColor(C_HOLDER);
            g.fillArc(FeedPost.PAD, oy + FeedPost.PAD, a, a, 0, 360);
        }
        int tx = FeedPost.PAD + a + 8;
        for (int i = 0; i < p.lineText.length; i++) {
            int kind = p.lineKind[i];
            int x = kind <= FeedPost.L_META ? tx : FeedPost.PAD;
            int col = kind == FeedPost.L_TITLE || kind == FeedPost.L_BODY ? C_TEXT : C_SUB;
            FeedPost.font(kind).drawTop(g, p.lineText[i], x, oy + p.lineY[i], col, C_POST);
        }
        // Media in their boxes from the page; a play button on videos.
        for (int i = 0; i < p.media.size(); i++) {
            int[] m = (int[]) p.media.elementAt(i);
            int mx = m[0];
            int my = oy + p.mediaY + m[1];
            Image im = (Image) images.get(p.mediaKey.elementAt(i));
            g.setClip(0, 0, w, viewHeight());
            g.clipRect(mx, my, m[2], m[3]);
            if (im != null) {
                g.drawImage(im, mx, my, Graphics.TOP | Graphics.LEFT);
            } else {
                g.setColor(C_HOLDER);
                g.fillRect(mx, my, m[2], m[3]);
            }
            if (m[4] != 0) {
                int d = Math.max(36, Math.min(56, Math.min(m[2], m[3]) / 3));
                int cx = mx + m[2] / 2;
                int cy = my + m[3] / 2;
                Icons.drawSmooth(g, Icons.CIRCLE, cx, cy, d, 0x1877F2, 0x1877F2);
                Icons.drawSmooth(g, Icons.PLAY, cx, cy, d * 9 / 20, 0xFFFFFF, 0x1877F2);
            }
        }
        g.setClip(0, 0, w, viewHeight());
        // Button bar.
        int by = oy + p.barY;
        g.setColor(C_LINE);
        g.drawLine(FeedPost.PAD, by, w - FeedPost.PAD, by);
        TextFont bf = FeedPost.size(14, true);
        for (int k = 0; k < 3; k++) {
            int col = k == 0 && p.liked() ? C_BLUE : C_SUB;
            int under = C_POST;
            if (k == focusBar) {
                under = C_FOCUS;
                g.setColor(under);
                g.fillRoundRect(k * w / 3 + 4, by + 3, w / 3 - 8, p.barH - 6, 14, 14);
            }
            bf.draw(g, BAR[k], (2 * k + 1) * w / 6, by + (p.barH - bf.height()) / 2, col, under,
                    Graphics.TOP | Graphics.HCENTER);
        }
    }

    private void paintFooter(Graphics g, int w, int h) {
        int y = h - barH;
        g.setColor(0xFFFFFF);
        g.fillRect(0, y, w, barH);
        g.setColor(0xDADDE1);
        g.drawLine(0, y, w, y);
        int n = FOOTER.length;
        int s = Math.min(26, barH / 2);
        for (int i = 0; i < n; i++) {
            int bx = (2 * i + 1) * w / (2 * n);
            int cy = y + barH / 2;
            int back = i == barPress ? 0xE4E6EB : 0xFFFFFF;
            if (i == barPress) {
                Icons.drawSmooth(g, Icons.CIRCLE, bx, cy, barH - 8, back, back);
            }
            Icons.drawSmooth(g, FOOTER[i], bx, cy, s, 0x65676B, back);
        }
    }

    // ---- Scrolling ----

    private void scrollTo(int y) {
        fling.stop(); // keys, Home: the view goes where they say
        layout();
        sy = FbMidlet.clamp(y, 0, maxScroll());
        repaint();
        moved();
    }

    /** Scroll with no easing (a finger dragging). */
    private void jumpTo(int y) {
        scrollTo(y);
        shownSy = sy;
    }

    /** After the view moved: images in reach, more posts near the end. */
    private void moved() {
        app.loader.wake();
        Vector list = layout();
        if (list.size() > 0 && sy + 3 * viewHeight() >= contentH && moreAsked != list.size()) {
            moreAsked = list.size();
            request("op=more");
        }
    }

    /** Brings rect r (document px) into view if it is not. */
    private void reveal(int[] r) {
        int vh = viewHeight();
        int pad = 8;
        if (r[1] < sy + pad) {
            scrollTo(r[1] - pad);
        } else if (r[1] + r[3] > sy + vh - pad) {
            scrollTo(Math.min(r[1] - pad, r[1] + r[3] - vh + pad));
        }
    }

    // ---- Focus ----

    /**
     * Up/down: header -> content -> button bar -> next post. A part taller
     * than the view is scrolled through before the focus leaves it.
     */
    private void moveFocus(boolean down) {
        Vector list = layout();
        int n = list.size();
        if (n == 0) {
            return;
        }
        int vh = viewHeight();
        if (focusPost < 0 || focusPost >= n) {
            // Start from the first post whose top is in view.
            focusPost = n - 1;
            for (int i = 0; i < n; i++) {
                if (postTop[i] + ((FeedPost) list.elementAt(i)).height > sy + 8) {
                    focusPost = i;
                    break;
                }
            }
            focusPart = P_HEAD;
            reveal(partRect(focusPost, focusPart));
            repaint();
            return;
        }
        int[] r = partRect(focusPost, focusPart);
        if (down && r[1] + r[3] > sy + vh) {
            scrollTo(Math.min(sy + vh * 2 / 3, r[1] + r[3] - vh + 8));
            return;
        }
        if (!down && r[1] < sy) {
            scrollTo(Math.max(sy - vh * 2 / 3, r[1] - 8));
            return;
        }
        int bar = focusPart >= P_LIKE ? P_LIKE : focusPart;
        if (down) {
            if (bar == P_HEAD) {
                focusPart = P_BODY;
            } else if (bar == P_BODY) {
                focusPart = P_LIKE;
            } else if (focusPost + 1 < n) {
                focusPost++;
                focusPart = P_HEAD;
            } else {
                scrollTo(sy + vh * 2 / 3);
                return;
            }
        } else {
            if (bar >= P_LIKE) {
                focusPart = P_BODY;
            } else if (bar == P_BODY) {
                focusPart = P_HEAD;
            } else if (focusPost > 0) {
                focusPost--;
                focusPart = P_LIKE;
            } else {
                scrollTo(0);
                return;
            }
        }
        // Entering a tall part going up: show its bottom first.
        r = partRect(focusPost, focusPart);
        if (!down && r[3] > vh) {
            scrollTo(r[1] + r[3] - vh + 8);
        } else {
            reveal(r);
        }
        repaint();
    }

    private void moveSideways(boolean right) {
        if (focusPost < 0 || focusPart < P_LIKE) {
            return;
        }
        focusPart = P_LIKE + (focusPart - P_LIKE + (right ? 1 : 2)) % 3;
        repaint();
    }

    private void press(int post, int part) {
        Vector list = posts;
        if (post < 0 || post >= list.size()) {
            return;
        }
        FeedPost p = (FeedPost) list.elementAt(post);
        if (part == P_LIKE) {
            showMsg(p.liked() ? "Unliking..." : "Liking...");
        }
        request("op=" + PART_OP[part] + "&k=" + Net.urlEncode(p.key));
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
        if (k == -7 || k == -22 || k == 22 || k == 57346 || k == KEY_POUND || k == KEY_NUM1
                || k == 27 || k == 8) {
            backPressed();
        } else if (k == -6 || k == -21 || k == 21 || k == 57345 || k == KEY_STAR) {
            toggleMenu();
        } else if (k == KEY_NUM3) {
            load(true);
        } else if (k == KEY_NUM2) {
            scrollTo(sy - vh * 3 / 4);
        } else if (k == KEY_NUM8) {
            scrollTo(sy + vh * 3 / 4);
        } else if (fire) {
            if (focusPost >= 0) {
                press(focusPost, focusPart);
            }
        } else if (ga == UP || ga == DOWN) {
            moveFocus(ga == DOWN);
        } else if (ga == LEFT || ga == RIGHT) {
            moveSideways(ga == RIGHT);
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
            moveFocus(ga == DOWN);
        }
    }

    private void toggleMenu() {
        if (menu.open) {
            menu.hide();
        } else {
            menu.show(app.blackberry ? 0 : viewHeight()); // BlackBerry: no slide-in, whole menu at once
        }
        repaint();
    }

    /** Back: closes the menu, else to the top, else (at the top) the menu, which has Exit. */
    void backPressed() {
        if (menu.open) {
            menu.hide();
            repaint();
        } else if (sy > 0) {
            focusPost = -1;
            scrollTo(0);
        } else {
            toggleMenu();
        }
    }

    protected void showNotify() {
        shown = true;
        app.loader.wake();
    }

    public boolean shownNow() {
        return shown;
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

    // ---- Touch ----

    protected void pointerPressed(int x, int y) {
        pressed = true;
        dragging = false;
        pressOnBar = y >= viewHeight();
        px0 = x;
        py0 = y;
        sy = shownSy; // a touch stops the easing
        fling.press(y);
        pressSy = sy;
        if (pressOnBar) {
            barPress = x * FOOTER.length / getWidth();
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
            fling.track(y);
            jumpTo(pressSy + py0 - y);
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
            if (y >= viewHeight() && i == x * FOOTER.length / getWidth()) {
                if (i == 0) {
                    toggleMenu();
                } else if (i == 1) {
                    // Home on the home screen: the newest posts.
                    menu.hide();
                    focusPost = -1;
                    scrollTo(0);
                    load(true);
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
            if (fling.release()) {
                repaint(); // goes on in paint()
            }
            return;
        }
        // Tap: the part under the finger.
        Vector list = layout();
        int dy = y + shownSy;
        for (int i = 0; i < list.size(); i++) {
            for (int part = P_HEAD; part <= P_SHARE; part++) {
                int[] r = partRect(i, part);
                if (x >= r[0] && x < r[0] + r[2] && dy >= r[1] && dy < r[1] + r[3]) {
                    focusPost = i;
                    focusPart = part;
                    repaint();
                    press(i, part);
                    return;
                }
            }
        }
    }

    // ---- Images (ImageLoader) ----

    /**
     * Image keys of the posts in view, then those a view above and below,
     * not in have or skip; at most max keys and about maxPx pixels.
     */
    public Vector missing(Hashtable have, Hashtable skip, int max, int maxPx) {
        Vector out = new Vector();
        Vector list = layout();
        int vh = viewHeight();
        int px = 0;
        for (int pass = 0; pass < 2; pass++) {
            int from = pass == 0 ? sy : sy - vh;
            int to = pass == 0 ? sy + vh : sy + 2 * vh;
            for (int i = 0; i < list.size() && out.size() < max; i++) {
                FeedPost p = (FeedPost) list.elementAt(i);
                int top = postTop[i];
                if (top > to || top + p.height < from) {
                    continue;
                }
                if (p.avKey.length() > 0) {
                    int a = FeedPost.avatarSize(p.avSize);
                    px = want(out, p.avKey, a * a, px, have, skip, maxPx);
                }
                for (int j = 0; j < p.media.size() && out.size() < max; j++) {
                    int[] m = (int[]) p.media.elementAt(j);
                    int my = top + p.mediaY + m[1];
                    if (my > to || my + m[3] < from) {
                        continue;
                    }
                    px = want(out, (String) p.mediaKey.elementAt(j), m[2] * m[3], px, have, skip, maxPx);
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

    /** Keys of the images within two views of the screen (kept cached). */
    public Hashtable keysNear() {
        Hashtable t = new Hashtable();
        Vector list = layout();
        int vh = viewHeight();
        for (int i = 0; i < list.size(); i++) {
            FeedPost p = (FeedPost) list.elementAt(i);
            int top = postTop[i];
            if (top > sy + 3 * vh || top + p.height < sy - 2 * vh) {
                continue;
            }
            if (p.avKey.length() > 0) {
                t.put(p.avKey, p.avKey);
            }
            for (int j = 0; j < p.mediaKey.size(); j++) {
                Object k = p.mediaKey.elementAt(j);
                t.put(k, k);
            }
        }
        return t;
    }
}
