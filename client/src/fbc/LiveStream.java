package fbc;

import java.io.InputStream;

import javax.microedition.io.Connector;
import javax.microedition.io.HttpConnection;
import javax.microedition.lcdui.Image;

/**
 * Live view: one long-lived HTTP connection to /live over which the server
 * pushes a JPEG every time the page changes ("F <oy> <len>\n" + bytes).
 * Much faster than one request per frame. If the phone's HTTP stack buffers
 * the body instead of streaming it, no frame arrives, healthy stays false
 * and Net keeps polling as before.
 */
class LiveStream implements Runnable {

    private static final int RETRY_MS = 1500;

    private final FbMidlet app;
    private volatile boolean running;
    private volatile HttpConnection hc;
    private volatile InputStream in;

    /** A frame has arrived on the current connection. */
    volatile boolean healthy;

    LiveStream(FbMidlet app) {
        this.app = app;
    }

    synchronized void start() {
        if (running) {
            return;
        }
        running = true;
        new Thread(this).start();
    }

    void stop() {
        running = false;
        healthy = false;
        close(); // unblocks a pending read
        app.net.wake();
    }

    public void run() {
        while (running) {
            try {
                stream();
            } catch (Throwable t) {
                // Connection lost or refused: retry below.
            }
            healthy = false;
            close();
            app.net.wake(); // fall back to polling meanwhile
            if (running) {
                try {
                    Thread.sleep(RETRY_MS);
                } catch (InterruptedException e) {
                    // continue
                }
            }
        }
    }

    private void stream() throws Exception {
        String url = app.server + "/live?" + app.net.viewParams();
        hc = (HttpConnection) Connector.open(url, Connector.READ, true);
        hc.setRequestMethod(HttpConnection.GET);
        if (hc.getResponseCode() != HttpConnection.HTTP_OK) {
            throw new Exception("live HTTP " + hc.getResponseCode());
        }
        in = hc.openInputStream();
        while (running) {
            String line = readLine(in);
            if (line == null) {
                return;
            }
            int a = line.indexOf(' ');
            int b = line.indexOf(' ', a + 1);
            if (!line.startsWith("F") || a < 0 || b < 0) {
                return;
            }
            int oy = FbMidlet.parseInt(line.substring(a + 1, b), 0);
            int len = FbMidlet.parseInt(line.substring(b + 1), 0);
            byte[] data = readFully(in, len);
            Image img;
            try {
                img = Image.createImage(data, 0, len);
            } catch (OutOfMemoryError e) {
                data = null;
                app.overscan = FbMidlet.OVERSCAN_LOW_MEM;
                return; // reconnect with smaller frames
            }
            data = null;
            if (!healthy) {
                healthy = true;
                app.net.wake(); // stop polling
            }
            app.canvas.applyLiveFrame(img, oy);
        }
    }

    private static String readLine(InputStream in) throws Exception {
        StringBuffer sb = new StringBuffer();
        int c;
        while ((c = in.read()) != '\n') {
            if (c < 0) {
                return null;
            }
            if (sb.length() > 64) {
                throw new Exception("bad frame header");
            }
            sb.append((char) c);
        }
        return sb.toString();
    }

    private static byte[] readFully(InputStream in, int len) throws Exception {
        byte[] b = new byte[len];
        int off = 0;
        while (off < len) {
            int n = in.read(b, off, len - off);
            if (n < 0) {
                throw new Exception("stream closed");
            }
            off += n;
        }
        return b;
    }

    private void close() {
        InputStream i = in;
        HttpConnection h = hc;
        in = null;
        hc = null;
        if (i != null) {
            try {
                i.close();
            } catch (Exception e) {
                // ignore
            }
        }
        if (h != null) {
            try {
                h.close();
            } catch (Exception e) {
                // ignore
            }
        }
    }
}
