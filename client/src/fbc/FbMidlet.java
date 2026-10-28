package fbc;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.util.Random;

import javax.microedition.lcdui.Choice;
import javax.microedition.lcdui.ChoiceGroup;
import javax.microedition.lcdui.Command;
import javax.microedition.lcdui.CommandListener;
import javax.microedition.lcdui.Display;
import javax.microedition.lcdui.Displayable;
import javax.microedition.lcdui.Form;
import javax.microedition.lcdui.TextBox;
import javax.microedition.lcdui.TextField;
import javax.microedition.midlet.MIDlet;
import javax.microedition.rms.RecordStore;

/**
 * Thin-client browser: the server renders pages and sends screenshots,
 * this MIDlet only shows images and forwards cursor/key events.
 */
public class FbMidlet extends MIDlet implements CommandListener {

    // Fixed at build time via the FbClient-Server JAD/manifest attribute.
    String server;

    // Settings (persisted in RMS)
    String key = "";
    String clientId = "";
    boolean png = false;
    int zoom = DEFAULT_ZOOM;
    int quality = DEFAULT_QUALITY;
    // Continuous frame polling (animations, in-page video).
    volatile boolean live;

    // Tuned for fast WiFi phones like the Nokia E6: native-pixel rendering
    // (sharp text) and higher JPEG quality.
    private static final int DEFAULT_ZOOM = 100;
    private static final int DEFAULT_QUALITY = 75;
    // 1: zoom/quality defaults changed; 2: live persisted.
    private static final int SETTINGS_VERSION = 2;
    // Extra page rendered above and below the view (% of view height) so
    // scrolling shows real content immediately instead of blank space.
    // Net lowers it if the phone runs out of memory decoding tall frames.
    static final int OVERSCAN = 100;
    static final int OVERSCAN_LOW_MEM = 50;
    volatile int overscan = OVERSCAN;

    Display display;
    BrowserCanvas canvas;
    Net net;
    LiveStream stream;

    private Form settingsForm;
    private TextField tfKey, tfZoom, tfQuality;
    private ChoiceGroup cgFormat;
    private TextBox textBox;
    private int textMode; // 0 = type into field, 1 = URL

    private final Command cmdOk = new Command("OK", Command.OK, 1);
    private final Command cmdOkEnter = new Command("OK + Enter", Command.SCREEN, 2);
    private final Command cmdCancel = new Command("Cancel", Command.BACK, 3);

    // Record layout changed when the server field was removed; new store name
    // avoids misreading old records.
    private static final String STORE = "fbc2";

    private boolean started;

    protected void startApp() {
        if (started) {
            display.setCurrent(canvas);
            return;
        }
        started = true;
        display = Display.getDisplay(this);
        server = getAppProperty("FbClient-Server");
        if (server == null || server.length() == 0) {
            server = "http://127.0.0.1:8080";
        }
        loadSettings();
        canvas = new BrowserCanvas(this);
        net = new Net(this);
        stream = new LiveStream(this);
        net.start();
        display.setCurrent(canvas);
        net.refresh();
        if (live) {
            stream.start();
        }
    }

    protected void pauseApp() {
    }

    protected void destroyApp(boolean unconditional) {
        if (stream != null) {
            stream.stop();
        }
        if (net != null) {
            net.stop();
        }
    }

    void exit() {
        destroyApp(true);
        notifyDestroyed();
    }

    // ---- Menu ----

    /** Runs an item chosen in the on-screen menu (see MenuOverlay). */
    void menuAction(int action) {
        switch (action) {
            case MenuOverlay.TYPE: showTextInput("", false); break;
            case MenuOverlay.ENTER: net.action("op=key&k=Enter"); break;
            case MenuOverlay.URL: showUrlInput(); break;
            case MenuOverlay.MESSENGER:
                net.action("op=nav&u=" + Net.urlEncode("https://www.facebook.com/messages/"));
                break;
            case MenuOverlay.VIDEO: canvas.toast("Loading video..."); net.action("op=video"); break;
            case MenuOverlay.LIVE: toggleLive(); break;
            case MenuOverlay.FORWARD: net.action("op=fwd"); break;
            case MenuOverlay.RELOAD: net.action("op=reload"); break;
            case MenuOverlay.SETTINGS: showSettings(); break;
            case MenuOverlay.EXIT: exit(); break;
            case MenuOverlay.HOME: net.action("op=home"); break;
            default: break;
        }
    }

    void toggleLive() {
        live = !live;
        saveSettings();
        canvas.toast(live ? "Live view ON" : "Live view OFF");
        if (live) {
            stream.start();
        } else {
            stream.stop();
        }
        net.wake();
    }

    void openVideo(String videoKey) {
        display.setCurrent(new VideoView(this, videoKey));
    }

    /** Access key as a query parameter, prefixed by sep ("&" or "?"). */
    String keyParam(String sep) {
        return key.length() > 0 ? sep + "key=" + Net.urlEncode(key) : "";
    }

    // ---- Text input ----

    void showTextInput(String value, boolean password) {
        textMode = 0;
        textBox = makeTextBox("Text", value, password ? TextField.PASSWORD : TextField.ANY);
        textBox.addCommand(cmdOkEnter);
        display.setCurrent(textBox);
    }

    void showUrlInput() {
        textMode = 1;
        textBox = makeTextBox("URL", net.currentUrl, TextField.URL);
        display.setCurrent(textBox);
    }

    private TextBox makeTextBox(String title, String value, int constraints) {
        if (value == null) {
            value = "";
        }
        TextBox tb;
        try {
            tb = new TextBox(title, value, 1000, constraints);
        } catch (IllegalArgumentException e) {
            // Some phones limit the max size or reject the initial value.
            tb = new TextBox(title, "", 256, constraints);
        }
        tb.addCommand(cmdOk);
        tb.addCommand(cmdCancel);
        tb.setCommandListener(this);
        return tb;
    }

    private void textSubmitted(boolean enter) {
        String s = textBox.getString();
        display.setCurrent(canvas);
        if (textMode == 1) {
            net.action("op=nav&u=" + Net.urlEncode(s));
        } else {
            net.action("op=type&t=" + Net.urlEncode(s));
            if (enter) {
                net.action("op=key&k=Enter");
            }
        }
    }

    // ---- Settings ----

    void showSettings() {
        settingsForm = new Form("Settings");
        tfKey = new TextField("Access key", key, 64, TextField.ANY);
        tfZoom = new TextField("Zoom %", String.valueOf(zoom), 3, TextField.NUMERIC);
        tfQuality = new TextField("JPEG quality", String.valueOf(quality), 2, TextField.NUMERIC);
        cgFormat = new ChoiceGroup("Image format", Choice.EXCLUSIVE,
                new String[] {"JPEG (small)", "PNG (compatible)"}, null);
        cgFormat.setSelectedIndex(png ? 1 : 0, true);
        settingsForm.append(tfKey);
        settingsForm.append(tfZoom);
        settingsForm.append(cgFormat);
        settingsForm.append(tfQuality);
        settingsForm.addCommand(cmdOk);
        settingsForm.addCommand(cmdCancel);
        settingsForm.setCommandListener(this);
        display.setCurrent(settingsForm);
    }

    private void settingsSubmitted() {
        key = tfKey.getString().trim();
        zoom = clamp(parseInt(tfZoom.getString(), DEFAULT_ZOOM), 25, 200);
        quality = clamp(parseInt(tfQuality.getString(), DEFAULT_QUALITY), 10, 95);
        png = cgFormat.getSelectedIndex() == 1;
        saveSettings();
        display.setCurrent(canvas);
        net.resetHash();
        net.refresh();
    }

    // ---- CommandListener ----

    public void commandAction(Command c, Displayable d) {
        if (d == textBox) {
            if (c == cmdOk) {
                textSubmitted(false);
            } else if (c == cmdOkEnter) {
                textSubmitted(true);
            } else {
                display.setCurrent(canvas);
            }
        } else if (d == settingsForm) {
            if (c == cmdOk) {
                settingsSubmitted();
            } else {
                display.setCurrent(canvas);
            }
        }
    }

    // ---- Persistence ----

    private void loadSettings() {
        RecordStore rs = null;
        try {
            rs = RecordStore.openRecordStore(STORE, true);
            if (rs.getNumRecords() > 0) {
                DataInputStream in = new DataInputStream(new ByteArrayInputStream(rs.getRecord(1)));
                key = in.readUTF();
                clientId = in.readUTF();
                png = in.readBoolean();
                zoom = in.readInt();
                quality = in.readInt();
                int version = 0;
                try {
                    version = in.readInt();
                } catch (Exception e) {
                    // Record written before versioning.
                }
                if (version >= 2) {
                    live = in.readBoolean();
                }
                if (version < 1) {
                    // Old builds defaulted to 75% zoom / quality 50.
                    zoom = DEFAULT_ZOOM;
                    quality = DEFAULT_QUALITY;
                }
                if (version < SETTINGS_VERSION) {
                    saveSettings();
                }
            }
        } catch (Exception e) {
            // Use defaults.
        } finally {
            closeStore(rs);
        }
        if (clientId.length() == 0) {
            clientId = randomId();
            saveSettings();
        }
    }

    void saveSettings() {
        RecordStore rs = null;
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            DataOutputStream out = new DataOutputStream(bos);
            out.writeUTF(key);
            out.writeUTF(clientId);
            out.writeBoolean(png);
            out.writeInt(zoom);
            out.writeInt(quality);
            out.writeInt(SETTINGS_VERSION);
            out.writeBoolean(live);
            byte[] b = bos.toByteArray();
            rs = RecordStore.openRecordStore(STORE, true);
            if (rs.getNumRecords() > 0) {
                rs.setRecord(1, b, 0, b.length);
            } else {
                rs.addRecord(b, 0, b.length);
            }
        } catch (Exception e) {
            if (canvas != null) {
                canvas.toast("Save failed: " + e);
            }
        } finally {
            closeStore(rs);
        }
    }

    private static void closeStore(RecordStore rs) {
        if (rs != null) {
            try {
                rs.closeRecordStore();
            } catch (Exception e) {
                // ignore
            }
        }
    }

    private static String randomId() {
        String chars = "abcdefghijklmnopqrstuvwxyz0123456789";
        Random r = new Random(System.currentTimeMillis());
        StringBuffer sb = new StringBuffer();
        for (int i = 0; i < 16; i++) {
            sb.append(chars.charAt(Math.abs(r.nextInt()) % chars.length()));
        }
        return sb.toString();
    }

    static int parseInt(String s, int def) {
        try {
            return Integer.parseInt(s.trim());
        } catch (Exception e) {
            return def;
        }
    }

    static int clamp(int v, int lo, int hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }
}
