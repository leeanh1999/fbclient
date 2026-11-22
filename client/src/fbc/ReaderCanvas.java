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
 * The app's own screen for every page other than the feed and Messenger (a
 * post and its comments, profiles, notifications, groups, search...): the
 * server's /p reads the page into rows of text runs, images and inputs,
 * laid out and drawn here (ReaderRow) and scrolled locally.
 *
 * Keys: up/down move between the things that can be pressed (rows apart),
 * left/right between those on one row, FIRE/5 presses (an input opens a
 * text box; a video plays), 2/8 scroll, 3 reloads, 1 / # / right soft go
 * back, left soft / * the menu, 9 shows the page as the browser view.
 * Touch: drag to scroll, tap to press; footer Menu | Home | Back.
 */
class ReaderCanvas extends Canvas implements Runnable, ImageSource {

    private static final int C_BG = 0xFFFFFF;
    private static final int C_LINE = 0xE4E6EB;
    private static final int C_HOLDER = 0xE4E6EB;
    private static final int DRAG_SLOP = 12;
    private static final int MSG_MS = 3000;
    // After a press the page may change a moment later: look again.
    private static final int FOLLOW_UPS = 2;
    private static final int FOLLOW_MS = 800;

    private static final int[] FOOTER = {Icons.MENU, Icons.HOME, Icons.BACK};

    private final FbMidlet app;
    private final boolean touch;
    private final int barH;
    private final MenuOverlay menu = new MenuOverlay(MenuOverlay.SCREEN_ITEMS);

    private volatile Vector rows = new Vector();
    private String url = "";
    private String title = "";
    private boolean atEnd;
    private int[] rowTop = new int[0];
    private int contentH;
    private Vector laidOut;
    private int layoutW = -1;
    private int layoutGen = -1;

    // Things to press, in order: key, row and rect (document px).
    private String[] tKey = new String[0];
    private int[] tRow = new int[0];
    private int[] tX = new int[0];
    private int[] tY = new int[0];
    private int[] tW = new int[0];
    private int[] tH = new int[0];
    // Only plain text (a link): shown with a highlight behind it, else a ring.
    private boolean[] tText = new boolean[0];
    private static final int C_FOCUS = 0xDCE8FA;
    private int focus = -1;
    private String focusKey;

    private volatile int sy;
    private int shownSy;
    volatile boolean shown;

    private final Vector queue = new Vector();
    private volatile boolean running = true;
    private volatile boolean loading;
    // Touch scrolling that goes on after a quick swipe.
    private final Kinetic fling = new Kinetic();
    private String hash = "";
    private int followUps;
    private long followAt;
    private int moreAsked = -1;
    private long moreAt;

    private String msg;
    private long msgUntil;

    private boolean pressed, dragging, pressOnBar;
    private int px0, py0, pressSy, barPress = -1;

    ReaderCanvas(FbMidlet app) {
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

    private int viewHeight() {
        return getHeight() - barH;
    }

    // ---- Requests ----

    /** Shows url, or (null) the page the server has open now. */
    void load(String u) {
        synchronized (this) {
            rows = new Vector();
            laidOut = null;
            focus = -1;
            focusKey = null;
            sy = shownSy = 0;
            hash = "";
        }
        request(u == null ? "op=load" : "op=open&u=" + Net.urlEncode(u));
    }

    void reload() {
        hash = "";
        request("op=load");
    }

    /** Types text into the input with key k (from the text box). */
    void type(String k, String text) {
        showMsg("Sending...");
        request("op=type&k=" + Net.urlEncode(k) + "&t=" + Net.urlEncode(text));
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
            String req = null;
            boolean quiet = false; // a follow-up look: no busy dots
            synchronized (queue) {
                while (running && queue.isEmpty()) {
                    long now = System.currentTimeMillis();
                    if (msg != null && now > msgUntil) {
                        msg = null;
                        repaint();
                    }
                    if (followUps > 0 && now >= followAt) {
                        followUps--;
                        followAt = now + FOLLOW_MS;
                        req = "op=load";
                        quiet = true;
                        break;
                    }
                    long wait = followUps > 0 ? Math.max(50, followAt - now) : 0;
                    if (msg != null) {
                        wait = wait == 0 ? 500 : Math.min(wait, 500);
                    }
                    try {
                        queue.wait(wait);
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
            boolean follow = req.startsWith("op=press") || req.startsWith("op=type");
            loading = !quiet;
            repaint();
            try {
                execute(req);
            } catch (Throwable t) {
                showMsg("Error: " + t.getMessage());
            }
            if (follow) {
                followUps = FOLLOW_UPS;
                followAt = System.currentTimeMillis() + FOLLOW_MS;
            }
            loading = false;
            repaint();
        }
    }

    private void execute(String params) throws Exception {
        StringBuffer u = new StringBuffer(app.server);
        u.append("/p?").append(app.net.viewParams());
        u.append("&hash=").append(hash);
        u.append('&').append(params);
        HttpConnection hc = null;
        InputStream in = null;
        try {
            hc = (HttpConnection) Connector.open(app.connUrl(u.toString()), Connector.READ, true);
            hc.setRequestMethod(HttpConnection.GET);
            int code = hc.getResponseCode();
            String err = hc.getHeaderField("X-Err");
            if (err != null) {
                showMsg(Net.urlDecode(err));
            }
            String need = hc.getHeaderField("X-Need");
            if (need != null) {
                app.display.callSerially(new UiTask(app, UiTask.NEED_USER, need, false));
                return;
            }
            String open = hc.getHeaderField("X-Open");
            if (open != null) {
                followUps = 0;
                app.display.callSerially(new UiTask(app, UiTask.OPEN, open, false));
                return;
            }
            String video = hc.getHeaderField("X-Video");
            String videoErr = hc.getHeaderField("X-Video-Err");
            if (video != null) {
                app.display.callSerially(new UiTask(app, UiTask.VIDEO, video, false));
            } else if (videoErr != null) {
                showMsg(Net.urlDecode(videoErr));
            }
            if (code == HttpConnection.HTTP_NO_CONTENT) {
                return;
            }
            if (code != HttpConnection.HTTP_OK) {
                throw new Exception("HTTP " + code);
            }
            String h = hc.getHeaderField("X-Hash");
            boolean end = hc.getHeaderField("X-End") != null;
            in = hc.openInputStream();
            byte[] data = Net.readAll(in, (int) hc.getLength());
            String body = Net.utf8(data, 0, data.length);
            data = null;
            if (h != null) {
                hash = h;
            }
            apply(body, end);
        } finally {
            Net.close(in, hc);
        }
    }

    private void apply(String body, boolean end) {
        Vector list = new Vector();
        String newUrl = "";
        String newTitle = "";
        ReaderRow cur = null;
        int start = 0;
        int n = body.length();
        while (start < n) {
            int e = body.indexOf('\n', start);
            if (e < 0) {
                e = n;
            }
            String[] f = split(body, start, e);
            start = e + 1;
            char t = f[0].length() > 0 ? f[0].charAt(0) : ' ';
            if (t == 'X') {
                Emoji.define(f, f.length);
            } else if (t == 'U') {
                newUrl = f.length > 1 ? f[1] : "";
                newTitle = f.length > 2 ? f[2] : "";
            } else if (t == 'R') {
                cur = new ReaderRow();
                cur.indent = f.length > 1 ? FbMidlet.parseInt(f[1], 0) : 0;
                list.addElement(cur);
            } else if (cur != null && ((t == 'T' && f.length >= 7) || (t == 'I' && f.length >= 6)
                    || (t == 'E' && f.length >= 5))) {
                cur.items.addElement(f);
            }
        }
        synchronized (this) {
            boolean samePage = newUrl.equals(url);
            url = newUrl;
            title = newTitle;
            atEnd = end;
            rows = list;
            laidOut = null;
            if (!samePage) {
                sy = shownSy = 0;
                focus = -1;
                focusKey = null;
                moreAsked = -1;
            }
            layout();
            // The same thing stays in focus if it is still there.
            focus = -1;
            for (int i = 0; focusKey != null && i < tKey.length; i++) {
                if (tKey[i].equals(focusKey)) {
                    focus = i;
                    break;
                }
            }
        }
        app.loader.wake();
        repaint();
        moved();
    }

    /** Fields of body[start..end) split at tabs. */
    private static String[] split(String body, int start, int end) {
        int count = 1;
        for (int i = start; i < end; i++) {
            if (body.charAt(i) == '\t') {
                count++;
            }
        }
        String[] f = new String[count];
        int k = 0;
        int s = start;
        for (int i = start; i < end; i++) {
            if (body.charAt(i) == '\t') {
                f[k++] = body.substring(s, i);
                s = i + 1;
            }
        }
        f[k] = body.substring(s, end);
        return f;
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

    private synchronized Vector layout() {
        Vector list = rows;
        int w = getWidth();
        if (list == laidOut && w == layoutW && layoutGen == TextFrame.gen) {
            return list;
        }
        laidOut = list;
        layoutW = w;
        layoutGen = TextFrame.gen;
        int n = list.size();
        rowTop = new int[n];
        Vector keys = new Vector();
        Vector tr = new Vector();
        Vector rects = new Vector();
        Vector texts = new Vector();
        int y = 4;
        for (int i = 0; i < n; i++) {
            ReaderRow r = (ReaderRow) list.elementAt(i);
            r.layout(w);
            rowTop[i] = y;
            // Pressable things: one per key and row (the union of its pieces).
            for (int j = 0; j < r.n; j++) {
                String k = r.key[j];
                if (k.length() == 0) {
                    continue;
                }
                int fx = r.x[j];
                int fy = y + r.y[j];
                boolean plain = r.kind[j] == ReaderRow.K_TEXT && r.bg[j] < 0;
                int last = keys.size() - 1;
                if (last >= 0 && keys.elementAt(last).equals(k)
                        && (((Integer) tr.elementAt(last)).intValue() == i || ((Integer) tr.elementAt(last)).intValue() == i - 1)) {
                    int[] u = (int[]) rects.elementAt(last);
                    int x2 = Math.max(u[0] + u[2], fx + r.w[j]);
                    int y2 = Math.max(u[1] + u[3], fy + r.h[j]);
                    u[0] = Math.min(u[0], fx);
                    u[1] = Math.min(u[1], fy);
                    u[2] = x2 - u[0];
                    u[3] = y2 - u[1];
                    if (!plain) {
                        texts.setElementAt(Boolean.FALSE, last);
                    }
                    continue;
                }
                texts.addElement(plain ? Boolean.TRUE : Boolean.FALSE);
                keys.addElement(k);
                tr.addElement(new Integer(i));
                rects.addElement(new int[] {fx, fy, r.w[j], r.h[j]});
            }
            y += r.height;
        }
        contentH = y + 48;
        int m = keys.size();
        tKey = new String[m];
        tRow = new int[m];
        tX = new int[m];
        tY = new int[m];
        tW = new int[m];
        tH = new int[m];
        tText = new boolean[m];
        for (int i = 0; i < m; i++) {
            tText[i] = ((Boolean) texts.elementAt(i)).booleanValue();
            int[] u = (int[]) rects.elementAt(i);
            tKey[i] = (String) keys.elementAt(i);
            tRow[i] = ((Integer) tr.elementAt(i)).intValue();
            tX[i] = u[0];
            tY[i] = u[1];
            tW[i] = u[2];
            tH[i] = u[3];
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
        Hashtable images = app.loader.cache;
        g.setClip(0, 0, w, h);
        g.setColor(C_BG);
        g.fillRect(0, 0, w, h);
        g.setClip(0, 0, w, vh);
        int f = focus;
        String fk = f >= 0 && f < tKey.length && tText[f] ? tKey[f] : null;
        if (fk != null) {
            // A link: a soft highlight behind it (its text is drawn on it).
            g.setColor(C_FOCUS);
            g.fillRoundRect(tX[f] - 5, tY[f] - top - 3, tW[f] + 10, tH[f] + 6, 12, 12);
        }
        for (int i = 0; i < list.size(); i++) {
            ReaderRow r = (ReaderRow) list.elementAt(i);
            int oy = rowTop[i] - top;
            if (oy >= vh) {
                break;
            }
            if (oy + r.height >= 0) {
                boolean inFocus = fk != null && rowTop[i] < tY[f] + tH[f] && rowTop[i] + r.height > tY[f];
                paintRow(g, r, oy, w, vh, images, inFocus ? fk : null);
            }
        }
        g.setClip(0, 0, w, h);
        TextFont uf = TextFrame.ui(TextFrame.UI_SIZE, false);
        if (list.size() == 0) {
            uf.draw(g, loading ? "Loading..." : "Nothing here. Press 3 to reload.",
                    w / 2, vh / 3, 0x65676B, C_BG, Graphics.TOP | Graphics.HCENTER);
        } else if (loading && contentH - 48 - top < vh) {
            uf.draw(g, "Loading...", w / 2, contentH - 40 - top, 0x65676B, C_BG, Graphics.TOP | Graphics.HCENTER);
        }
        if (f >= 0 && f < tKey.length && !tText[f]) {
            // Images, inputs, buttons: a ring around.
            g.setClip(0, 0, w, vh);
            FocusRing.draw(g, tX[f] - 4, tY[f] - top - 4, tW[f] + 8, tH[f] + 8, 10);
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
        if (barH > 0) {
            paintFooter(g, w, h);
        }
        boolean more = shownSy != sy || fling.active;
        if (menu.open) {
            more |= menu.tick();
            g.setClip(0, 0, w, h);
            menu.paint(g, w, vh, uf, !touch, title);
        }
        if (more) {
            app.again(); // menu slide-in, eased scroll
        }
    }

    /** focusKey: the highlighted link on this row (its text goes on the highlight), or null. */
    private void paintRow(Graphics g, ReaderRow r, int oy, int w, int vh, Hashtable images, String focusKey) {
        for (int b = 0; b < r.boxes; b++) {
            g.setColor(r.boxC[b]);
            g.fillRoundRect(r.boxX[b], oy + r.boxY[b], r.boxW[b], r.boxH[b], 16, 16);
        }
        for (int j = 0; j < r.n; j++) {
            int x = r.x[j];
            int y = oy + r.y[j];
            int fw = r.w[j];
            int fh = r.h[j];
            if (y >= vh || y + fh < 0) {
                continue;
            }
            switch (r.kind[j]) {
                case ReaderRow.K_TEXT: {
                    int fill = r.bg[j];
                    int under = fill >= 0 ? fill : (focusKey != null && focusKey.equals(r.key[j]) ? C_FOCUS : C_BG);
                    r.font[j].drawTop(g, r.str[j], x, y, r.color[j], under);
                    break;
                }
                case ReaderRow.K_INPUT: {
                    g.setColor(0xF0F2F5);
                    g.fillRoundRect(x, y, fw, fh, fh, fh);
                    String s = r.str[j];
                    if (r.pass[j] && r.color[j] != 0x8A8D91) {
                        s = "********";
                    }
                    TextFont f = r.font[j];
                    f.drawTop(g, f.shorten(s, fw - 24), x + 12, y + (fh - f.height()) / 2, r.color[j], 0xF0F2F5);
                    break;
                }
                default: {
                    Image im = (Image) images.get(r.str[j]);
                    g.setClip(0, 0, w, vh);
                    g.clipRect(x, y, fw, fh);
                    if (im != null) {
                        g.drawImage(im, x, y, Graphics.TOP | Graphics.LEFT);
                    } else if (fw * fh >= 400) {
                        g.setColor(C_HOLDER);
                        g.fillRect(x, y, fw, fh);
                    }
                    g.setClip(0, 0, w, vh);
                    if (r.kind[j] == ReaderRow.K_VIDEO && fw >= 60 && fh >= 40) {
                        int dd = Math.max(28, Math.min(52, Math.min(fw, fh) / 3));
                        Icons.drawSmooth(g, Icons.CIRCLE, x + fw / 2, y + fh / 2, dd, 0x1877F2, 0x1877F2);
                        Icons.drawSmooth(g, Icons.PLAY, x + fw / 2, y + fh / 2, dd * 9 / 20, 0xFFFFFF, 0x1877F2);
                    }
                    break;
                }
            }
        }
        // A thin line under rows that end a block (a big image or an input).
        if (r.n > 0 && r.kind[r.n - 1] == ReaderRow.K_INPUT) {
            g.setColor(C_LINE);
            g.drawLine(0, oy + r.height - 1, w, oy + r.height - 1);
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

    // ---- Scrolling and focus ----

    private void scrollTo(int y, boolean smooth) {
        fling.stop(); // keys, a drag: the view goes where they say
        layout();
        sy = FbMidlet.clamp(y, 0, maxScroll());
        if (!smooth) {
            shownSy = sy;
        }
        repaint();
        moved();
    }

    /** Images in reach; more of the page near its end. */
    private void moved() {
        app.loader.wake();
        layout();
        long now = System.currentTimeMillis();
        if (!atEnd && rows.size() > 0 && sy + 2 * viewHeight() >= contentH
                && (moreAsked != rows.size() || now - moreAt > 4000)) {
            moreAsked = rows.size();
            moreAt = now;
            request("op=more");
        }
    }

    private void setFocus(int i) {
        focus = i;
        focusKey = i >= 0 ? tKey[i] : null;
        if (i >= 0) {
            int vh = viewHeight();
            int pad = 10;
            if (tY[i] < sy + pad) {
                scrollTo(tY[i] - pad, true);
            } else if (tY[i] + tH[i] > sy + vh - pad) {
                scrollTo(Math.min(tY[i] - pad, tY[i] + tH[i] - vh + pad), true);
            }
        }
        repaint();
    }

    /**
     * Up/down: the next thing to press on another row; when it is more than
     * a view away, scroll toward it first so the text between can be read.
     */
    private void moveFocus(boolean down) {
        layout();
        int vh = viewHeight();
        int m = tKey.length;
        int cur = focus;
        if (cur >= 0 && (tY[cur] + tH[cur] < sy || tY[cur] > sy + vh)) {
            cur = -1; // scrolled away from it
        }
        int next = -1;
        if (cur < 0) {
            for (int i = 0; i < m; i++) {
                int k = down ? i : m - 1 - i;
                if (tY[k] >= sy && tY[k] + tH[k] <= sy + vh) {
                    next = k;
                    break;
                }
            }
        } else if (down) {
            for (int i = cur + 1; i < m; i++) {
                if (tRow[i] != tRow[cur]) {
                    next = i;
                    break;
                }
            }
        } else {
            for (int i = cur - 1; i >= 0; i--) {
                if (tRow[i] != tRow[cur]) {
                    // The first one on that row.
                    next = i;
                    while (next > 0 && tRow[next - 1] == tRow[i]) {
                        next--;
                    }
                    break;
                }
            }
        }
        if (next >= 0 && (down ? tY[next] > sy + vh + vh / 3 : tY[next] + tH[next] < sy - vh / 3)) {
            next = -1; // far away: scroll instead
        }
        if (next < 0) {
            scrollTo(sy + (down ? 1 : -1) * vh * 2 / 3, true);
            if (cur >= 0) {
                focus = -1;
                focusKey = null;
            }
            return;
        }
        setFocus(next);
    }

    private void moveSideways(boolean right) {
        int cur = focus;
        if (cur < 0) {
            moveFocus(right);
            return;
        }
        int next = cur + (right ? 1 : -1);
        if (next >= 0 && next < tKey.length && tRow[next] == tRow[cur]) {
            setFocus(next);
        }
    }

    /** Press thing i: an input opens a text box, a video plays. */
    private void press(int i) {
        if (i < 0 || i >= tKey.length) {
            return;
        }
        String k = tKey[i];
        ReaderRow r = (ReaderRow) rows.elementAt(tRow[i]);
        for (int j = 0; j < r.n; j++) {
            if (!r.key[j].equals(k)) {
                continue;
            }
            if (r.kind[j] == ReaderRow.K_INPUT) {
                boolean empty = r.color[j] == 0x8A8D91;
                app.showReaderInput(k, empty ? "" : r.str[j], empty ? r.str[j] : "", r.pass[j]);
                return;
            }
            if (r.kind[j] == ReaderRow.K_VIDEO) {
                showMsg("Loading video...");
                request("op=video&k=" + Net.urlEncode(k));
                return;
            }
        }
        request("op=press&k=" + Net.urlEncode(k));
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
        } else if (k == KEY_NUM9) {
            app.showBrowser(); // the page as the browser view
        } else if (k == KEY_NUM2) {
            scrollTo(sy - vh * 3 / 4, true);
        } else if (k == KEY_NUM8) {
            scrollTo(sy + vh * 3 / 4, true);
        } else if (fire) {
            press(focus);
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
        if (!menu.open && (ga == UP || ga == DOWN)) {
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

    void backPressed() {
        if (menu.open) {
            menu.hide();
            repaint();
            return;
        }
        followUps = 0;
        request("op=back");
    }

    protected void showNotify() {
        shown = true;
        app.loader.wake();
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
        pressOnBar = y >= viewHeight();
        px0 = x;
        py0 = y;
        sy = shownSy;
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
            if (y >= viewHeight() && i == x * FOOTER.length / getWidth()) {
                if (i == 0) {
                    toggleMenu();
                } else if (i == 1) {
                    menu.hide();
                    app.openFeed();
                } else {
                    menu.hide();
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
        layout();
        int dy = y + shownSy;
        for (int i = 0; i < tKey.length; i++) {
            if (x >= tX[i] - 4 && x < tX[i] + tW[i] + 4 && dy >= tY[i] - 4 && dy < tY[i] + tH[i] + 4) {
                setFocus(i);
                press(i);
                return;
            }
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
                ReaderRow r = (ReaderRow) list.elementAt(i);
                int top = rowTop[i];
                if (top > to || top + r.height < from) {
                    continue;
                }
                for (int j = 0; j < r.n && out.size() < max; j++) {
                    if (r.kind[j] != ReaderRow.K_IMAGE && r.kind[j] != ReaderRow.K_VIDEO) {
                        continue;
                    }
                    String k = r.str[j];
                    if (have.containsKey(k) || skip.containsKey(k) || out.contains(k)) {
                        continue;
                    }
                    int size = r.w[j] * r.h[j];
                    if (out.size() > 0 && px + size > maxPx) {
                        continue;
                    }
                    out.addElement(k);
                    px += size;
                }
            }
        }
        return out;
    }

    public Hashtable keysNear() {
        Hashtable t = new Hashtable();
        Vector list = layout();
        int vh = viewHeight();
        for (int i = 0; i < list.size(); i++) {
            ReaderRow r = (ReaderRow) list.elementAt(i);
            int top = rowTop[i];
            if (top > sy + 3 * vh || top + r.height < sy - 2 * vh) {
                continue;
            }
            for (int j = 0; j < r.n; j++) {
                if (r.kind[j] == ReaderRow.K_IMAGE || r.kind[j] == ReaderRow.K_VIDEO) {
                    t.put(r.str[j], r.str[j]);
                }
            }
        }
        return t;
    }
}
