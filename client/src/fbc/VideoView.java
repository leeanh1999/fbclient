package fbc;

import javax.microedition.lcdui.Canvas;
import javax.microedition.lcdui.Font;
import javax.microedition.lcdui.Graphics;
import javax.microedition.media.Manager;
import javax.microedition.media.Player;
import javax.microedition.media.PlayerListener;
import javax.microedition.media.control.VideoControl;
import javax.microedition.media.control.VolumeControl;

/**
 * Native video playback (MMAPI). The server downloads the Facebook video as
 * MP4; this screen waits for it, then streams it over HTTP with sound.
 *
 * Keys: 5/FIRE pause, 4/6 or left/right seek 10 s, up/down volume,
 * #/right soft/1 close. Touch: bottom bar Close | Pause | -10 | +10.
 */
class VideoView extends Canvas implements Runnable, PlayerListener {

    private static final String[] TOOLS = {"Close", "Pause", "-10s", "+10s"};
    private static final long SEEK_US = 10000000L;

    private final FbMidlet app;
    private final String videoKey;
    private final Font font = Font.getFont(Font.FACE_SYSTEM, Font.STYLE_PLAIN, Font.SIZE_SMALL);
    private final int barH;

    private volatile boolean closed;
    private volatile String status = "Preparing video...";
    private Player player;
    private VolumeControl volume;
    private boolean paused;
    private boolean ended;

    VideoView(FbMidlet app, String videoKey) {
        this.app = app;
        this.videoKey = videoKey;
        setFullScreenMode(true);
        barH = Math.max(font.getHeight() + 18, 40);
        new Thread(this).start();
    }

    public void run() {
        try {
            String base = app.server;
            String statusUrl = base + "/vs?k=" + videoKey + app.keyParam("&");
            while (!closed) {
                String st = Net.fetchText(statusUrl).trim();
                if (st.startsWith("ready")) {
                    break;
                }
                if (st.startsWith("err")) {
                    setStatus("Video error: " + st.substring(3).trim());
                    return;
                }
                setStatus(st.startsWith("dl ") ? "Downloading " + st.substring(3) + "%" : st);
                Thread.sleep(800);
            }
            if (closed) {
                return;
            }
            setStatus("Starting player...");
            String url = base + "/v/" + videoKey + ".mp4" + app.keyParam("?");
            player = Manager.createPlayer(url);
            player.addPlayerListener(this);
            player.realize();
            VideoControl vc = (VideoControl) player.getControl("VideoControl");
            if (vc != null) {
                vc.initDisplayMode(VideoControl.USE_DIRECT_VIDEO, this);
                fit(vc);
                vc.setVisible(true);
            }
            volume = (VolumeControl) player.getControl("VolumeControl");
            player.prefetch();
            if (closed) {
                return;
            }
            player.start();
            setStatus(null);
            // Keep the progress bar moving.
            while (!closed) {
                repaint();
                Thread.sleep(500);
            }
        } catch (Throwable t) {
            setStatus("Player error: " + t.toString());
        }
    }

    /** Scale the video to fit above the control bar, keeping aspect ratio. */
    private void fit(VideoControl vc) {
        int aw = getWidth();
        int ah = getHeight() - barH;
        int sw = vc.getSourceWidth();
        int sh = vc.getSourceHeight();
        int w = aw;
        int h = ah;
        if (sw > 0 && sh > 0) {
            if (sw * ah > sh * aw) {
                h = sh * aw / sw;
            } else {
                w = sw * ah / sh;
            }
        }
        try {
            vc.setDisplaySize(w, h);
        } catch (Exception e) {
            // Some devices only support the native size.
        }
        vc.setDisplayLocation((aw - w) / 2, (ah - h) / 2);
    }

    private void setStatus(String s) {
        status = s;
        repaint();
    }

    public void playerUpdate(Player p, String event, Object data) {
        if (PlayerListener.END_OF_MEDIA.equals(event)) {
            ended = true;
            paused = true;
        } else if (PlayerListener.ERROR.equals(event)) {
            setStatus("Playback error: " + data);
        }
        repaint();
    }

    // ---- Painting ----

    protected void paint(Graphics g) {
        int w = getWidth();
        int h = getHeight();
        g.setColor(0x000000);
        g.fillRect(0, 0, w, h - barH);
        g.setFont(font);
        String s = status;
        if (s != null) {
            g.setColor(0xFFFFFF);
            g.drawString(s, w / 2, (h - barH) / 2, Graphics.BASELINE | Graphics.HCENTER);
        }

        int y = h - barH;
        g.setColor(0x18191A);
        g.fillRect(0, y, w, barH);
        // Progress line on top of the bar.
        Player p = player;
        if (p != null) {
            long dur = p.getDuration();
            long pos = p.getMediaTime();
            if (dur > 0 && pos >= 0) {
                g.setColor(0x3A3B3C);
                g.fillRect(0, y, w, 3);
                g.setColor(0x1877F2);
                g.fillRect(0, y, (int) (w * pos / dur), 3);
            }
        }
        int n = TOOLS.length;
        for (int i = 0; i < n; i++) {
            int x0 = i * w / n;
            int x1 = (i + 1) * w / n;
            String label = i == 1 ? (ended ? "Replay" : (paused ? "Play" : "Pause")) : TOOLS[i];
            g.setColor(0xE4E6EB);
            g.drawString(label, (x0 + x1) / 2, y + (barH - font.getHeight()) / 2,
                    Graphics.TOP | Graphics.HCENTER);
        }
    }

    // ---- Controls ----

    private void togglePause() {
        Player p = player;
        if (p == null) {
            return;
        }
        try {
            if (ended) {
                p.setMediaTime(0);
                ended = false;
                paused = true;
            }
            if (paused) {
                p.start();
            } else {
                p.stop();
            }
            paused = !paused;
        } catch (Exception e) {
            setStatus("Error: " + e.getMessage());
        }
        repaint();
    }

    private void seek(long deltaUs) {
        Player p = player;
        if (p == null) {
            return;
        }
        try {
            long t = p.getMediaTime() + deltaUs;
            long dur = p.getDuration();
            if (t < 0) {
                t = 0;
            }
            if (dur > 0 && t > dur) {
                t = dur;
            }
            p.setMediaTime(t);
        } catch (Exception e) {
            // Seeking not supported for this stream.
        }
        repaint();
    }

    private void changeVolume(int delta) {
        if (volume != null) {
            volume.setLevel(FbMidlet.clamp(volume.getLevel() + delta, 0, 100));
        }
    }

    void close() {
        closed = true;
        if (player != null) {
            player.close();
            player = null;
        }
        app.display.setCurrent(app.canvas);
    }

    protected void keyPressed(int k) {
        if (k == -7 || k == -22 || k == KEY_POUND || k == KEY_NUM1 || k == -6 || k == KEY_STAR) {
            close();
            return;
        }
        switch (k) {
            case KEY_NUM5: togglePause(); return;
            case KEY_NUM4: seek(-SEEK_US); return;
            case KEY_NUM6: seek(SEEK_US); return;
            case KEY_NUM2: changeVolume(10); return;
            case KEY_NUM8: changeVolume(-10); return;
            default: break;
        }
        int ga = 0;
        try {
            ga = getGameAction(k);
        } catch (Exception e) {
            // Unknown key code on this device.
        }
        switch (ga) {
            case FIRE: togglePause(); break;
            case LEFT: seek(-SEEK_US); break;
            case RIGHT: seek(SEEK_US); break;
            case UP: changeVolume(10); break;
            case DOWN: changeVolume(-10); break;
            default: break;
        }
    }

    protected void pointerReleased(int x, int y) {
        if (y < getHeight() - barH) {
            togglePause();
            return;
        }
        switch (x * TOOLS.length / getWidth()) {
            case 0: close(); break;
            case 1: togglePause(); break;
            case 2: seek(-SEEK_US); break;
            case 3: seek(SEEK_US); break;
            default: break;
        }
    }
}
