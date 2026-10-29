package fbc;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.Vector;

import javax.microedition.io.Connector;
import javax.microedition.io.HttpConnection;
import javax.microedition.lcdui.Graphics;
import javax.microedition.lcdui.Image;

/**
 * Background worker: sends actions to the render server one at a time and
 * hands the returned screenshot to the canvas.
 *
 * After each action it keeps polling frames quickly until the page stops
 * changing.
 */
class Net implements Runnable {

    private static final String REFRESH = "";
    private static final int BURST_MS = 6000;     // max polling after an action
    private static final int BURST_GAP_MS = 250;  // delay between burst frames
    private static final int STABLE_FRAMES = 3;   // unchanged frames to stop burst
    private static final int ERROR_BACKOFF_MS = 2000;
    // Download + decode of one frame. Slower phones (Nokia E6: ~900 ms for
    // a 640x1278 overscan frame) get shorter frames: one switch only, as the
    // server relaunches the browser when the overscan changes.
    private static final int SLOW_FRAME_MS = 450;
    private static final int SLOW_SAMPLES = 4;
    private int loadAvgMs, loadSamples;

    private final FbMidlet app;
    private final Vector queue = new Vector();
    private volatile boolean running;
    private Thread thread;

    private String lastHash = "";
    private long pollUntil;
    private long nextPollAt;
    private int unchanged;

    volatile String currentUrl = "";
    volatile boolean busy;
    /** Busy with something the user asked for (not background polling). */
    volatile boolean userBusy;

    Net(FbMidlet app) {
        this.app = app;
    }

    void start() {
        running = true;
        thread = new Thread(this);
        thread.start();
    }

    void stop() {
        running = false;
        wake();
    }

    void wake() {
        synchronized (queue) {
            queue.notifyAll();
        }
    }

    void resetHash() {
        lastHash = "";
    }

    void refresh() {
        enqueue(REFRESH);
    }

    void action(String params) {
        enqueue(params);
    }

    /** True if nothing is waiting, used to throttle edge scrolling. */
    boolean idle() {
        synchronized (queue) {
            return queue.isEmpty() && !userBusy;
        }
    }

    private void enqueue(String params) {
        synchronized (queue) {
            // A pending refresh is redundant when anything else is queued.
            if (queue.size() > 0 && REFRESH.equals(queue.lastElement())) {
                queue.removeElementAt(queue.size() - 1);
            }
            if (REFRESH.equals(params) && queue.size() > 0) {
                return;
            }
            queue.addElement(params);
            queue.notifyAll();
        }
        app.canvas.repaint();
    }

    public void run() {
        while (running) {
            String req = null;
            synchronized (queue) {
                while (running && queue.isEmpty()) {
                    long wait = 0;
                    if (pollUntil > 0) {
                        wait = nextPollAt - System.currentTimeMillis();
                        if (wait <= 0) {
                            req = REFRESH;
                            break;
                        }
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
                boolean poll = req != null;
                if (req == null) {
                    req = (String) queue.elementAt(0);
                    queue.removeElementAt(0);
                }
                // A focus move changes nothing on the page: no burst of
                // follow-up frames (each one costs a screenshot on the server).
                if (!poll && !req.startsWith("op=move")) {
                    pollUntil = System.currentTimeMillis() + BURST_MS;
                    unchanged = 0;
                }
                busy = true;
                userBusy = !poll;
            }
            app.canvas.repaint();
            boolean changed = false;
            long backoff = 0;
            int sdy = scrollDy(req);
            try {
                changed = execute(req, sdy);
            } catch (Throwable t) {
                app.canvas.applyFrame(null, 0, sdy);
                app.canvas.toast("Error: " + t.getMessage());
                backoff = ERROR_BACKOFF_MS;
            }
            synchronized (queue) {
                busy = false;
                userBusy = false;
                long now = System.currentTimeMillis();
                unchanged = changed ? 0 : unchanged + 1;
                if (backoff > 0 || unchanged >= STABLE_FRAMES || now > pollUntil) {
                    pollUntil = 0;
                }
                nextPollAt = now + backoff + BURST_GAP_MS;
            }
            app.canvas.repaint();
        }
    }

    /** Vertical distance of a queued "op=scroll" request, else 0. */
    private static int scrollDy(String params) {
        if (!params.startsWith("op=scroll")) {
            return 0;
        }
        int i = params.indexOf("&dy=");
        if (i < 0) {
            return 0;
        }
        int end = params.indexOf('&', i + 4);
        return FbMidlet.parseInt(params.substring(i + 4, end < 0 ? params.length() : end), 0);
    }

    /**
     * Returns true if a new frame was received. Always hands the result to
     * the canvas together with the scroll distance it accounts for.
     */
    /** Session/view query parameters for /a. */
    String viewParams() {
        BrowserCanvas c = app.canvas;
        StringBuffer sb = new StringBuffer("id=").append(app.clientId);
        sb.append("&w=").append(c.getWidth());
        sb.append("&h=").append(c.viewHeight());
        sb.append("&ov=").append(app.overscan);
        sb.append(app.resParam());
        sb.append("&z=").append(app.zoom);
        sb.append("&f=").append(app.png ? "png" : "jpg");
        sb.append("&q=").append(app.quality);
        // Page mode: the page as drawing commands, scrolled here (the
        // server falls back to text + image or a screenshot where it can't).
        sb.append("&m=p");
        sb.append(app.keyParam("&"));
        return sb.toString();
    }

    private boolean execute(String params, int sdy) throws Exception {
        BrowserCanvas c = app.canvas;
        StringBuffer url = new StringBuffer(app.server);
        url.append("/a?").append(viewParams());
        url.append("&hash=").append(lastHash);
        // Page mode: where the phone's view is, so the server acts there.
        int sentSy = c.pageScroll();
        if (sentSy >= 0) {
            url.append("&sy=").append(sentSy);
        }
        if (params.length() > 0) {
            url.append('&').append(params);
        }

        HttpConnection hc = null;
        InputStream in = null;
        long sentAt = System.currentTimeMillis();
        try {
            hc = (HttpConnection) Connector.open(app.connUrl(url.toString()), Connector.READ, true);
            hc.setRequestMethod(HttpConnection.GET);
            int code = hc.getResponseCode();
            String u = hc.getHeaderField("X-Url");
            // Switching to/from Messenger on the server: splash until a
            // later reply.
            String loading = hc.getHeaderField("X-Loading");
            if (loading != null) {
                c.showSplash("facebook".equals(loading)
                        ? BrowserCanvas.SPLASH_FACEBOOK : BrowserCanvas.SPLASH_MESSENGER);
            } else if (code == HttpConnection.HTTP_OK || code == HttpConnection.HTTP_NO_CONTENT) {
                c.hideSplash(sentAt);
            }
            if (u != null) {
                currentUrl = urlDecode(u);
            }
            String hash = hc.getHeaderField("X-Hash");
            String input = hc.getHeaderField("X-Input");
            String value = hc.getHeaderField("X-Value");
            String video = hc.getHeaderField("X-Video");
            String videoErr = hc.getHeaderField("X-Video-Err");
            String oy = hc.getHeaderField("X-Oy");
            String offer = hc.getHeaderField("X-Video-Offer");
            String focus = hc.getHeaderField("X-Focus");
            // Text mode: that many bytes of text lines precede the image.
            String xText = hc.getHeaderField("X-Text");
            int textLen = xText == null ? 0 : FbMidlet.parseInt(xText, 0);
            String xPage = hc.getHeaderField("X-Page");
            String xSy = hc.getHeaderField("X-Sy");

            boolean changed = false;
            if (code == HttpConnection.HTTP_OK && xPage != null) {
                // Page mode: drawing commands, no image.
                in = hc.openInputStream();
                byte[] data = readAll(in, (int) hc.getLength());
                PageView pv = PageView.parse(utf8(data, 0, data.length), xPage);
                data = null;
                if (hash != null) {
                    lastHash = hash;
                }
                c.applyPage(pv, xSy == null ? 0 : FbMidlet.parseInt(xSy, 0), sentSy);
                changed = true;
            } else if (code == HttpConnection.HTTP_OK) {
                long t0 = System.currentTimeMillis();
                in = hc.openInputStream();
                byte[] data = readAll(in, (int) hc.getLength());
                Image img;
                try {
                    img = Image.createImage(data, textLen, data.length - textLen);
                    img = fitScreen(img, c.getWidth());
                    if (textLen > 0) {
                        img = TextFrame.draw(img, data, 0, textLen);
                    }
                    data = null;
                } catch (OutOfMemoryError e) {
                    data = null;
                    if (app.overscan > FbMidlet.OVERSCAN_LOW_MEM) {
                        // Ask for shorter frames from now on.
                        app.overscan = FbMidlet.OVERSCAN_LOW_MEM;
                        lastHash = "";
                    }
                    throw new Exception("Low memory, using smaller frames");
                } catch (Exception e) {
                    throw new Exception(app.png
                            ? "Bad image" : "JPEG unsupported? Use PNG in Settings");
                }
                if (hash != null) {
                    lastHash = hash;
                }
                c.applyFrame(img, oy == null ? 0 : FbMidlet.parseInt(oy, 0), sdy);
                changed = true;
                measureLoad((int) (System.currentTimeMillis() - t0), img.getHeight());
            } else if (code == HttpConnection.HTTP_NO_CONTENT) {
                c.applyFrame(null, 0, sdy);
            } else {
                throw new Exception("HTTP " + code);
            }

            if (input != null) {
                app.display.callSerially(new UiTask(app, UiTask.INPUT,
                        value == null ? "" : urlDecode(value), "p".equals(input)));
            }
            if (video != null) {
                app.display.callSerially(new UiTask(app, UiTask.VIDEO, video, false));
            } else if (videoErr != null) {
                app.display.callSerially(new UiTask(app, UiTask.VIDEO_ERROR, urlDecode(videoErr), false));
            }
            if (focus != null && c.page == null) {
                // After the frame, so the highlight matches the new image.
                // (Page mode moves the focus on the phone.)
                c.setFocus(parseRect(focus));
            }
            if (offer != null) {
                // Pressed video, view coordinates.
                int[] r = parseRect(offer);
                if (r != null) {
                    c.showVideoOffer(r[0], r[1], r[2], r[3]);
                }
            }
            return changed;
        } finally {
            close(in, hc);
        }
    }

    /**
     * Low-resolution frames are scaled back up to the screen: x2 for half
     * resolution (r=2), x1.5 for 2/3 (r=1.5; every 2 pixels become 3). New
     * pixels are averages of their neighbours (nearest neighbour made text
     * look grainy). Row by row so no full-size int[] is needed; done once
     * per frame here, so painting stays a plain drawImage.
     */
    static Image fitScreen(Image src, int screenW) {
        int sw = src.getWidth();
        int sh = src.getHeight();
        boolean half;
        if (sw * 2 <= screenW + 2) {
            half = true;
        } else if (sw * 3 <= screenW * 2 + 3) {
            half = false;
        } else {
            return src; // full resolution
        }
        int dw = half ? sw * 2 : scale15(sw);
        Image dst = Image.createImage(dw, half ? sh * 2 : scale15(sh));
        Graphics g = dst.getGraphics();
        int[] in = new int[sw];
        int[] cur = new int[dw];
        int[] next = new int[dw];
        int[] mid = new int[dw];
        src.getRGB(in, 0, sw, 0, 0, sw, 1);
        widen(in, cur, sw, half);
        int dy = 0;
        for (int y = 0; y < sh; y++) {
            boolean more = y + 1 < sh;
            if (more) {
                src.getRGB(in, 0, sw, 0, y + 1, sw, 1);
                widen(in, next, sw, half);
                for (int i = 0; i < dw; i++) {
                    mid[i] = mix(cur[i], next[i]);
                }
            }
            g.drawRGB(cur, 0, dw, 0, dy++, dw, 1, false);
            // x2: a blended row after every row. x1.5: rows go in pairs
            // (row, blend, next row), so only after even rows.
            if (half || (more && y % 2 == 0)) {
                g.drawRGB(more ? mid : cur, 0, dw, 0, dy++, dw, 1, false);
            }
            int[] t = cur;
            cur = next;
            next = t;
        }
        return dst;
    }

    /** Size after x1.5: each pair of pixels becomes 3, a lone last one 1. */
    private static int scale15(int n) {
        return n / 2 * 3 + n % 2;
    }

    /** One row widened x2 or x1.5; new pixels average their neighbours. */
    private static void widen(int[] in, int[] out, int sw, boolean half) {
        int o = 0;
        if (half) {
            for (int x = 0; x < sw; x++) {
                int p = in[x];
                out[o++] = p;
                out[o++] = x + 1 < sw ? mix(p, in[x + 1]) : p;
            }
            return;
        }
        for (int x = 0; x < sw; x += 2) {
            int p = in[x];
            out[o++] = p;
            if (x + 1 < sw) {
                int q = in[x + 1];
                out[o++] = mix(p, q);
                out[o++] = q;
            }
        }
    }

    /** Average of two RGB pixels (per channel, alpha dropped). */
    private static int mix(int a, int b) {
        return ((a & 0xFEFEFE) >>> 1) + ((b & 0xFEFEFE) >>> 1);
    }

    /** Averages frame load time; switches to shorter frames if too slow. */
    private void measureLoad(int ms, int imgH) {
        if (!app.frameAuto || app.overscan <= FbMidlet.OVERSCAN_LOW_MEM
                || imgH <= app.canvas.viewHeight()) {
            return; // user's choice, already short, or a view without overscan
        }
        loadAvgMs = loadSamples == 0 ? ms : (loadAvgMs * 3 + ms) / 4;
        if (++loadSamples >= SLOW_SAMPLES && loadAvgMs > SLOW_FRAME_MS) {
            app.overscan = FbMidlet.OVERSCAN_LOW_MEM;
            app.saveSettings();
            lastHash = "";
            app.canvas.toast("Slow frames (" + loadAvgMs + " ms): using smaller ones");
        }
    }

    /** "x,y,w,h" -> int[4]; null if empty or malformed. */
    private static int[] parseRect(String s) {
        int[] r = new int[4];
        int start = 0;
        for (int i = 0; i < 4; i++) {
            int end = s.indexOf(',', start);
            if (end < 0 && i < 3) {
                return null;
            }
            try {
                r[i] = Integer.parseInt(s.substring(start, end < 0 ? s.length() : end).trim());
            } catch (Exception e) {
                return null;
            }
            start = end + 1;
        }
        return r[2] > 0 && r[3] > 0 ? r : null;
    }

    /** Simple GET returning the body as UTF-8 text (used for status polls). */
    static String fetchText(String url) throws Exception {
        HttpConnection hc = null;
        InputStream in = null;
        try {
            hc = (HttpConnection) Connector.open(url, Connector.READ, true);
            hc.setRequestMethod(HttpConnection.GET);
            int code = hc.getResponseCode();
            if (code != HttpConnection.HTTP_OK) {
                throw new Exception("HTTP " + code);
            }
            in = hc.openInputStream();
            byte[] b = readAll(in, (int) hc.getLength());
            return utf8(b);
        } finally {
            close(in, hc);
        }
    }

    static void close(InputStream in, HttpConnection hc) {
        if (in != null) {
            try {
                in.close();
            } catch (Exception e) {
                // ignore
            }
        }
        if (hc != null) {
            try {
                hc.close();
            } catch (Exception e) {
                // ignore
            }
        }
    }

    static byte[] readAll(InputStream in, int len) throws Exception {
        if (len > 0) {
            byte[] b = new byte[len];
            int off = 0;
            while (off < len) {
                int n = in.read(b, off, len - off);
                if (n < 0) {
                    break;
                }
                off += n;
            }
            return b;
        }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) {
            bos.write(buf, 0, n);
        }
        return bos.toByteArray();
    }

    // ---- URL encoding (UTF-8, done by hand for CLDC) ----

    private static final String HEX = "0123456789ABCDEF";

    static String urlEncode(String s) {
        StringBuffer sb = new StringBuffer();
        for (int i = 0; i < s.length(); i++) {
            int ch = s.charAt(i);
            if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
                    || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.' || ch == '~') {
                sb.append((char) ch);
            } else if (ch < 0x80) {
                hex(sb, ch);
            } else if (ch < 0x800) {
                hex(sb, 0xC0 | (ch >> 6));
                hex(sb, 0x80 | (ch & 0x3F));
            } else if (ch >= 0xD800 && ch <= 0xDBFF && i + 1 < s.length()) {
                int cp = 0x10000 + ((ch - 0xD800) << 10) + (s.charAt(++i) - 0xDC00);
                hex(sb, 0xF0 | (cp >> 18));
                hex(sb, 0x80 | ((cp >> 12) & 0x3F));
                hex(sb, 0x80 | ((cp >> 6) & 0x3F));
                hex(sb, 0x80 | (cp & 0x3F));
            } else {
                hex(sb, 0xE0 | (ch >> 12));
                hex(sb, 0x80 | ((ch >> 6) & 0x3F));
                hex(sb, 0x80 | (ch & 0x3F));
            }
        }
        return sb.toString();
    }

    private static void hex(StringBuffer sb, int b) {
        sb.append('%').append(HEX.charAt((b >> 4) & 0xF)).append(HEX.charAt(b & 0xF));
    }

    static String urlDecode(String s) {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == '%' && i + 2 < s.length()) {
                bos.write(Integer.parseInt(s.substring(i + 1, i + 3), 16));
                i += 2;
            } else if (ch == '+') {
                bos.write(' ');
            } else {
                bos.write(ch);
            }
        }
        return utf8(bos.toByteArray());
    }

    private static String utf8(byte[] b) {
        return utf8(b, 0, b.length);
    }

    static String utf8(byte[] b, int off, int len) {
        StringBuffer sb = new StringBuffer();
        int i = off;
        int n = off + len;
        while (i < n) {
            int c = b[i++] & 0xFF;
            if (c < 0x80) {
                sb.append((char) c);
            } else if (c < 0xE0 && i < n) {
                sb.append((char) (((c & 0x1F) << 6) | (b[i++] & 0x3F)));
            } else if (c < 0xF0 && i + 1 < n) {
                sb.append((char) (((c & 0x0F) << 12) | ((b[i] & 0x3F) << 6) | (b[i + 1] & 0x3F)));
                i += 2;
            } else if (i + 2 < n) {
                int cp = ((c & 0x07) << 18) | ((b[i] & 0x3F) << 12)
                        | ((b[i + 1] & 0x3F) << 6) | (b[i + 2] & 0x3F);
                i += 3;
                cp -= 0x10000;
                sb.append((char) (0xD800 + (cp >> 10)));
                sb.append((char) (0xDC00 + (cp & 0x3FF)));
            } else {
                sb.append('?');
                i = n;
            }
        }
        return sb.toString();
    }
}
