package fbc;

import java.io.InputStream;
import java.util.Enumeration;
import java.util.Hashtable;
import java.util.Vector;

import javax.microedition.io.Connector;
import javax.microedition.io.HttpConnection;
import javax.microedition.lcdui.Image;

/**
 * Page mode images: fetches the ones near the view from /img (by key, a
 * few per request, packed by the server into a PNG and a JPEG sheet), cuts
 * them out and caches them by key, so each crosses the network once.
 * Its own thread, so actions on Net never wait for images.
 */
class ImageLoader implements Runnable {

    private static final int BATCH = 12;
    // Pixels per request and kept in the cache (an old phone's heap).
    private static final int BATCH_PX = 250000;
    private static final int CACHE_PX = 800000;
    // Requests in a row that bring nothing back before giving up for now.
    private static final int MAX_EMPTY = 3;
    private static final int ERROR_BACKOFF_MS = 3000;

    private final FbMidlet app;
    /** key -> Image, read by PageView.paint. */
    final Hashtable cache = new Hashtable();
    // Keys the server doesn't know (X-Unknown): key -> key.
    private final Hashtable failed = new Hashtable();
    private int empty;
    private int cachePx;
    private volatile boolean running;
    private boolean woken;

    ImageLoader(FbMidlet app) {
        this.app = app;
    }

    void start() {
        running = true;
        // Below the UI: decoding an image must not stall scrolling.
        Thread t = new Thread(this);
        t.setPriority(Thread.MIN_PRIORITY);
        t.start();
    }

    synchronized void stop() {
        running = false;
        notifyAll();
    }

    /** Something changed (new page, scroll): look for missing images. */
    synchronized void wake() {
        woken = true;
        notifyAll();
    }

    public void run() {
        while (running) {
            synchronized (this) {
                while (running && !woken) {
                    try {
                        wait();
                    } catch (InterruptedException e) {
                        // continue
                    }
                }
                woken = false;
            }
            try {
                while (running && loadSome()) {
                    ImageSource src = source();
                    if (src != null) {
                        src.repaint();
                    } else {
                        app.canvas.repaint();
                    }
                }
            } catch (Throwable t) {
                try {
                    Thread.sleep(ERROR_BACKOFF_MS);
                } catch (InterruptedException e) {
                    // continue
                }
                woken = true;
            }
        }
    }

    /** The app's own screen (feed, chats) that is shown, or null for the page. */
    private ImageSource source() {
        ImageSource f = app.feed;
        if (f != null && f.shownNow()) {
            return f;
        }
        ImageSource ch = app.chat;
        if (ch != null && ch.shownNow()) {
            return ch;
        }
        ImageSource r = app.reader;
        return r != null && r.shownNow() ? r : null;
    }

    /**
     * One request for the most needed images (of the feed or chat screen
     * when one is shown, else of the page); false if none are missing.
     */
    private boolean loadSome() throws Exception {
        BrowserCanvas c = app.canvas;
        ImageSource f = source();
        boolean feed = f != null;
        PageView p = c.page;
        int sy = c.pageSy;
        int vh = c.viewHeight();
        // Emoji in text drawn so far first (small), then the screen's images.
        Vector keys = Emoji.take(cache, failed, BATCH);
        Vector more = feed ? f.missing(cache, failed, BATCH, BATCH_PX)
                : p != null ? p.missing(c.getWidth(), sy, sy + vh, sy - vh, sy + 2 * vh, cache, failed, BATCH, BATCH_PX)
                : new Vector();
        for (int i = 0; i < more.size() && keys.size() < BATCH; i++) {
            if (!keys.contains(more.elementAt(i))) {
                keys.addElement(more.elementAt(i));
            }
        }
        if (keys.isEmpty()) {
            return false;
        }
        StringBuffer url = new StringBuffer(app.server);
        url.append("/img?id=").append(app.clientId).append("&k=");
        for (int i = 0; i < keys.size(); i++) {
            if (i > 0) {
                url.append(',');
            }
            url.append((String) keys.elementAt(i));
        }
        url.append("&f=").append(app.png ? "png" : "jpg");
        url.append("&q=").append(app.quality);
        url.append(app.keyParam("&"));
        int got = fetch(url.toString());
        evict(feed ? f.keysNear() : p != null ? p.keysIn(sy - 2 * vh, sy + 3 * vh) : new Hashtable());
        // Nothing came back (server busy or restarted): stop until the next
        // wake instead of asking again and again.
        empty = got > 0 ? 0 : empty + 1;
        if (empty >= MAX_EMPTY) {
            empty = 0;
            return false;
        }
        return true;
    }

    /** Fetches and caches the images in url; returns how many arrived. */
    private int fetch(String url) throws Exception {
        HttpConnection hc = null;
        InputStream in = null;
        try {
            hc = (HttpConnection) Connector.open(app.connUrl(url), Connector.READ, true);
            hc.setRequestMethod(HttpConnection.GET);
            int code = hc.getResponseCode();
            String unknown = hc.getHeaderField("X-Unknown");
            if (unknown != null) {
                int start = 0;
                while (start < unknown.length()) {
                    int end = unknown.indexOf(',', start);
                    if (end < 0) {
                        end = unknown.length();
                    }
                    if (end > start) {
                        String k = unknown.substring(start, end);
                        failed.put(k, k);
                    }
                    start = end + 1;
                }
            }
            if (code == HttpConnection.HTTP_NO_CONTENT) {
                return 0;
            }
            if (code != HttpConnection.HTTP_OK) {
                throw new Exception("HTTP " + code);
            }
            String sheets = hc.getHeaderField("X-Sheets");
            in = hc.openInputStream();
            byte[] data = Net.readAll(in, (int) hc.getLength());
            if (sheets == null) {
                return 0;
            }
            int a = sheets.indexOf(',');
            int b = sheets.indexOf(',', a + 1);
            int textLen = FbMidlet.parseInt(sheets.substring(0, a), 0);
            int pngLen = FbMidlet.parseInt(sheets.substring(a + 1, b), 0);
            int jpgLen = FbMidlet.parseInt(sheets.substring(b + 1), 0);
            Image png = pngLen > 0 ? Image.createImage(data, textLen, pngLen) : null;
            Image jpg = jpgLen > 0 ? Image.createImage(data, textLen + pngLen, jpgLen) : null;
            String text = Net.utf8(data, 0, textLen);
            data = null;
            int got = 0;
            int start = 0;
            while (start < text.length()) {
                int end = text.indexOf('\n', start);
                if (end < 0) {
                    end = text.length();
                }
                if (cut(text.substring(start, end), png, jpg)) {
                    got++;
                }
                start = end + 1;
            }
            return got;
        } finally {
            Net.close(in, hc);
        }
    }

    /** "key sheet x y w h": cuts that image out of its sheet into the cache. */
    private boolean cut(String line, Image png, Image jpg) {
        String[] f = new String[6];
        int start = 0;
        for (int i = 0; i < 6; i++) {
            int tab = line.indexOf('\t', start);
            if (tab < 0 && i < 5) {
                return false;
            }
            f[i] = line.substring(start, tab < 0 ? line.length() : tab);
            start = tab + 1;
        }
        Image src = "0".equals(f[1]) ? png : jpg;
        if (src == null) {
            return false;
        }
        int x = FbMidlet.parseInt(f[2], 0);
        int y = FbMidlet.parseInt(f[3], 0);
        int w = Math.min(FbMidlet.parseInt(f[4], 0), src.getWidth() - x);
        int h = Math.min(FbMidlet.parseInt(f[5], 0), src.getHeight() - y);
        if (w <= 0 || h <= 0 || x < 0 || y < 0) {
            return false;
        }
        Image part = Image.createImage(src, x, y, w, h, 0); // 0 = Sprite.TRANS_NONE
        cache.put(f[0], part);
        cachePx += w * h;
        return true;
    }

    /** Over the limit: drop cached images not in keep (far from the view). */
    private void evict(Hashtable keep) {
        if (cachePx <= CACHE_PX) {
            return;
        }
        Emoji.keepAll(keep);
        Vector drop = new Vector();
        int px = 0;
        for (Enumeration e = cache.keys(); e.hasMoreElements();) {
            Object k = e.nextElement();
            Image im = (Image) cache.get(k);
            if (im != null && keep.containsKey(k)) {
                px += im.getWidth() * im.getHeight();
            } else {
                drop.addElement(k);
            }
        }
        for (int i = 0; i < drop.size(); i++) {
            cache.remove(drop.elementAt(i));
        }
        cachePx = px;
    }
}
