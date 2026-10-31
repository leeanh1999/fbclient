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
import javax.microedition.lcdui.Item;
import javax.microedition.lcdui.ItemCommandListener;
import javax.microedition.lcdui.ItemStateListener;
import javax.microedition.lcdui.StringItem;
import javax.microedition.lcdui.TextBox;
import javax.microedition.lcdui.TextField;
import javax.microedition.midlet.MIDlet;
import javax.microedition.rms.RecordStore;

/**
 * Thin-client browser: the server renders pages and sends screenshots,
 * this MIDlet only shows images and forwards cursor/key events.
 */
public class FbMidlet extends MIDlet
        implements CommandListener, ItemCommandListener, ItemStateListener {

    // Default from the FbClient-Server JAD/manifest attribute; can be
    // changed in Settings (saved in RMS).
    String defaultServer;
    volatile String server;

    // BlackBerry routes HTTP through BIS/MDS unless the URL says otherwise;
    // a LAN server needs WiFi or direct TCP.
    boolean blackberry;
    static final int BB_WIFI = 0;
    static final int BB_DIRECT = 1;
    static final int BB_DEFAULT = 2;
    private static final String[] BB_SUFFIX = {";interface=wifi", ";deviceside=true", ""};
    int bbConn = BB_WIFI;

    // Settings (persisted in RMS)
    String key = "";
    String clientId = "";
    boolean png = false;
    int zoom = DEFAULT_ZOOM;
    int quality = DEFAULT_QUALITY;

    // Tuned for fast WiFi phones like the Nokia E6: native-pixel rendering
    // (sharp text) and higher JPEG quality.
    private static final int DEFAULT_ZOOM = 100;
    private static final int DEFAULT_QUALITY = 75;
    // 1: zoom/quality defaults changed; 2: live persisted (now unused); 3: server and
    // BlackBerry connection persisted; 4: overscan persisted (lowered on
    // slow phones by Net); 5: half resolution persisted (boolean);
    // 6: resolution level persisted (int); 7: phone text size (int, dropped);
    // 8: text font persisted (int: page size, smaller, much smaller);
    // 9: text size as Large / Default / Small.
    private static final int SETTINGS_VERSION = 9;
    // Extra page rendered above and below the view (% of view height) so
    // scrolling shows real content immediately instead of blank space.
    // Net lowers it if the phone runs out of memory decoding tall frames.
    static final int OVERSCAN = 100;
    static final int OVERSCAN_LOW_MEM = 50;
    volatile int overscan = OVERSCAN;
    // Net may lower the overscan on slow phones until the user picks a
    // frame size in Settings.
    boolean frameAuto = true;
    // Render resolution: fewer pixels to download and decode, scaled up by
    // Net.fitScreen. For slow phones (Nokia E6).
    static final int RES_FULL = 0;
    static final int RES_TWO_THIRDS = 1; // r=1.5, ~44% of the pixels
    static final int RES_HALF = 2;       // r=2, 25% of the pixels
    private static final String[] RES_PARAM = {"", "&r=1.5", "&r=2"};
    volatile int res = RES_FULL;

    Display display;
    BrowserCanvas canvas;
    Net net;
    ImageLoader loader;

    private Form settingsForm;
    private TextField tfServer, tfKey, tfZoom, tfQuality;
    private ChoiceGroup cgFormat, cgBbConn, cgOverscan, cgRes, cgTextSize;
    int textFont = TextFrame.SIZE_DEFAULT;
    private FormButton btnSave;
    private TextBox textBox;
    // BlackBerry text input: a Form with one field and a Send button, since
    // its TextBox only offers OK in the BlackBerry-key menu and Enter there
    // just adds a line break.
    private Form inputForm;
    private TextField tfInput;
    private FormButton btnSend;
    private int textMode; // 0 = type into field, 1 = URL

    // Only one command besides Cancel: with two or more, S60 (Nokia E6)
    // hides them behind an "Options" soft key. "Submit with Enter" is a
    // line break at the end of the text instead (Enter key on QWERTY).
    private final Command cmdOk = new Command("OK", Command.OK, 1);
    private final Command cmdCancel = new Command("Cancel", Command.BACK, 2);
    // On-screen Save button: BlackBerry only lists Form commands in the
    // BlackBerry-key menu, and its Escape key means Cancel.
    private final Command cmdSave = new Command("Save", Command.ITEM, 1);
    private final Command cmdSaveBack = new Command("Save", Command.BACK, 2);
    // BlackBerry input form: Escape (BACK) sends, as Escape saves Settings.
    private final Command cmdSendBack = new Command("Send", Command.BACK, 1);
    private final Command cmdCancelScreen = new Command("Cancel", Command.SCREEN, 2);

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
        defaultServer = getAppProperty("FbClient-Server");
        if (defaultServer == null || defaultServer.length() == 0) {
            defaultServer = "http://127.0.0.1:8080";
        }
        server = defaultServer;
        String platform = System.getProperty("microedition.platform");
        blackberry = platform != null
                && (platform.startsWith("RIM") || platform.indexOf("BlackBerry") >= 0);
        loadSettings();
        canvas = new BrowserCanvas(this);
        net = new Net(this);
        loader = new ImageLoader(this);
        net.start();
        loader.start();
        display.setCurrent(canvas);
        net.refresh();
    }

    protected void pauseApp() {
    }

    protected void destroyApp(boolean unconditional) {
        shutdown();
    }

    /** Stops every background thread. */
    void shutdown() {
        if (canvas != null) {
            canvas.dispose();
        }
        if (loader != null) {
            loader.stop();
        }
        if (net != null) {
            net.stop();
        }
    }

    // Exit waits at most this long for the server to hear op=bye.
    private static final int BYE_WAIT_MS = 1500;
    private volatile boolean byeDone;

    /**
     * Exit from the menu. Closing a connection another thread is reading
     * can block on BlackBerry, which froze the app here: stop threads in
     * the background. op=bye lets the server free this phone's browsers
     * now instead of after its idle timeout; the app leaves once it is sent
     * or after BYE_WAIT_MS, whichever comes first.
     */
    void exit() {
        if (canvas != null) {
            canvas.toast("Closing...");
            canvas.dispose();
        }
        new Thread(new UiTask(this, UiTask.SHUTDOWN, null, false)).start();
        new Thread(new UiTask(this, UiTask.BYE, null, false)).start();
        new Thread(new UiTask(this, UiTask.LEAVE, null, false)).start();
    }

    /** Tells the server this phone is gone (best effort). */
    void sayBye() {
        try {
            Net.fetchText(connUrl(server + "/a?id=" + clientId + "&op=bye" + keyParam("&")));
        } catch (Throwable t) {
            // 204 (or no server): nothing more to do.
        }
        byeDone = true;
    }

    /** Leaves once op=bye is sent, or after BYE_WAIT_MS. */
    void leave() {
        long end = System.currentTimeMillis() + BYE_WAIT_MS;
        while (!byeDone && System.currentTimeMillis() < end) {
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                break;
            }
        }
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
                if (!inMessenger()) {
                    canvas.showSplash(BrowserCanvas.SPLASH_MESSENGER);
                }
                net.action("op=nav&u=" + Net.urlEncode("https://www.facebook.com/messages/"));
                break;
            case MenuOverlay.VIDEO: canvas.toast("Loading video..."); net.action("op=video"); break;
            case MenuOverlay.FORWARD: net.action("op=fwd"); break;
            case MenuOverlay.RELOAD: net.action("op=reload"); break;
            case MenuOverlay.SETTINGS: showSettings(); break;
            case MenuOverlay.EXIT: exit(); break;
            case MenuOverlay.HOME: home(); break;
            default: break;
        }
    }

    /** Facebook home; from Messenger with the splash right away. */
    void home() {
        if (inMessenger()) {
            canvas.showSplash(BrowserCanvas.SPLASH_FACEBOOK);
        }
        net.action("op=home");
    }

    /** The current page is Messenger (the server's desktop view). */
    boolean inMessenger() {
        String u = net.currentUrl;
        return u.indexOf("facebook.com/messages") >= 0 || u.indexOf("messenger.com") >= 0;
    }

    void openVideo(String videoKey) {
        Displayable d = display.getCurrent();
        if (d instanceof VideoView) {
            ((VideoView) d).dispose(); // "Next": free the previous player first
        }
        display.setCurrent(new VideoView(this, videoKey));
    }

    /** "Next" in the player: the server finds the following video. */
    void nextVideo() {
        net.action("op=nextvideo");
    }

    /** "Previous" in the player: the video played before, from the server's history. */
    void prevVideo() {
        net.action("op=prevvideo");
    }

    void videoError(String msg) {
        Displayable d = display.getCurrent();
        if (d instanceof VideoView) {
            ((VideoView) d).showError(msg);
        } else {
            canvas.toast(msg);
        }
    }

    /** "&r=..." for the chosen render resolution ("" = full). */
    String resParam() {
        return RES_PARAM[res];
    }

    /** Access key as a query parameter, prefixed by sep ("&" or "?"). */
    String keyParam(String sep) {
        return key.length() > 0 ? sep + "key=" + Net.urlEncode(key) : "";
    }

    /** Server URL for Connector.open / createPlayer (BlackBerry transport suffix). */
    String connUrl(String url) {
        return blackberry ? url + BB_SUFFIX[bbConn] : url;
    }

    /**
     * BlackBerry QWERTY phones have no number keys: the digits are printed on
     * letter keys (W E R / S D F / Z X C = 1-9, Q = #, A = *), so those
     * letters work as the keypad shortcuts. Other key codes pass through.
     */
    int mapKey(int k) {
        if (!blackberry) {
            return k;
        }
        int i = "wersdfzxcqaWERSDFZXCQA".indexOf((char) k);
        return i < 0 ? k : "123456789#*".charAt(i % 11);
    }

    // ---- Text input ----

    void showTextInput(String value, boolean password) {
        textMode = 0;
        showInput(password ? "Password" : "Text (Enter = send)", value,
                password ? TextField.PASSWORD : TextField.ANY);
    }

    void showUrlInput() {
        textMode = 1;
        showInput("URL", net.currentUrl, TextField.URL);
    }

    private void showInput(String title, String value, int constraints) {
        textBox = null;
        inputForm = null;
        if (blackberry) {
            inputForm = makeInputForm(title, value, constraints);
            display.setCurrent(inputForm);
        } else {
            textBox = makeTextBox(title, value, constraints);
            display.setCurrent(textBox);
        }
    }

    private Form makeInputForm(String title, String value, int constraints) {
        if (value == null) {
            value = "";
        }
        Form f = new Form(title);
        try {
            tfInput = new TextField(null, value, 1000, constraints);
        } catch (IllegalArgumentException e) {
            tfInput = new TextField(null, "", 256, constraints);
        }
        btnSend = new FormButton(this, textMode == 1 ? "Go" : "Send");
        btnSend.setLayout(Item.LAYOUT_CENTER | Item.LAYOUT_NEWLINE_BEFORE);
        f.append(tfInput);
        f.append(btnSend);
        f.addCommand(cmdSendBack);
        f.addCommand(cmdCancelScreen);
        f.setCommandListener(this);
        // Enter in the field: send at once (with Enter on the page).
        f.setItemStateListener(this);
        return f;
    }

    public void itemStateChanged(Item item) {
        if (item == tfInput && inputForm != null) {
            String s = tfInput.getString();
            if (s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
                textSubmitted();
            }
        }
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

    private void textSubmitted() {
        String s;
        boolean enter;
        if (inputForm != null) {
            // BlackBerry field: Enter may land anywhere in the text.
            String raw = tfInput.getString();
            StringBuffer sb = new StringBuffer();
            for (int i = 0; i < raw.length(); i++) {
                char ch = raw.charAt(i);
                if (ch != '\n' && ch != '\r') {
                    sb.append(ch);
                }
            }
            s = sb.toString();
            enter = s.length() < raw.length();
        } else if (textBox != null) {
            s = textBox.getString();
            // A line break typed at the end (Enter key) means "and press Enter".
            int end = s.length();
            while (end > 0 && (s.charAt(end - 1) == '\n' || s.charAt(end - 1) == '\r')) {
                end--;
            }
            enter = end < s.length();
            s = s.substring(0, end);
        } else {
            return; // already sent (button and command both fired)
        }
        textBox = null;
        inputForm = null;
        display.setCurrent(canvas);
        if (textMode == 1) {
            net.action("op=nav&u=" + Net.urlEncode(s.trim()));
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
        tfServer = new TextField("Server (empty = default)", server, 128, TextField.URL);
        tfKey = new TextField("Access key", key, 64, TextField.ANY);
        tfZoom = new TextField("Zoom %", String.valueOf(zoom), 3, TextField.NUMERIC);
        tfQuality = new TextField("JPEG quality", String.valueOf(quality), 2, TextField.NUMERIC);
        cgFormat = new ChoiceGroup("Image format", Choice.EXCLUSIVE,
                new String[] {"JPEG (small)", "PNG (compatible)"}, null);
        cgFormat.setSelectedIndex(png ? 1 : 0, true);
        settingsForm.append(tfServer);
        settingsForm.append(tfKey);
        if (blackberry) {
            cgBbConn = new ChoiceGroup("Connection", Choice.EXCLUSIVE,
                    new String[] {"WiFi", "Mobile data (direct)", "BIS / MDS"}, null);
            cgBbConn.setSelectedIndex(bbConn, true);
            settingsForm.append(cgBbConn);
        }
        settingsForm.append(tfZoom);
        settingsForm.append(cgFormat);
        settingsForm.append(tfQuality);
        cgOverscan = new ChoiceGroup("Frame size", Choice.EXCLUSIVE,
                new String[] {"Tall (smoother scroll)", "Short (faster phone)"}, null);
        cgOverscan.setSelectedIndex(overscan > OVERSCAN_LOW_MEM ? 0 : 1, true);
        settingsForm.append(cgOverscan);
        cgRes = new ChoiceGroup("Resolution", Choice.EXCLUSIVE,
                new String[] {"Full (sharp)", "2/3 (balanced)", "Half (fastest)"}, null);
        cgRes.setSelectedIndex(res, true);
        settingsForm.append(cgRes);
        cgTextSize = new ChoiceGroup("Text size", Choice.EXCLUSIVE, TextFrame.SIZE_NAMES, null);
        cgTextSize.setSelectedIndex(textFont, true);
        settingsForm.append(cgTextSize);
        if (blackberry) {
            // BlackBerry ignores a StringItem button's default command.
            btnSave = new FormButton(this, "Save");
            btnSave.setLayout(Item.LAYOUT_CENTER | Item.LAYOUT_NEWLINE_BEFORE);
            settingsForm.append(btnSave);
        } else {
            StringItem save = new StringItem(null, "Save", Item.BUTTON);
            save.setLayout(Item.LAYOUT_CENTER | Item.LAYOUT_NEWLINE_BEFORE);
            save.setDefaultCommand(cmdSave);
            save.setItemCommandListener(this);
            settingsForm.append(save);
        }
        settingsForm.addCommand(cmdOk);
        // BlackBerry: Escape triggers the BACK command; leaving the screen
        // saves, as in native BlackBerry apps (Cancel would lose the edits).
        settingsForm.addCommand(blackberry ? cmdSaveBack : cmdCancel);
        settingsForm.setCommandListener(this);
        display.setCurrent(settingsForm);
    }

    private void settingsSubmitted() {
        if (settingsForm == null) {
            return; // already handled (button and form command both fired)
        }
        settingsForm = null;
        String oldServer = server;
        int oldConn = bbConn;
        try {
            server = normalizeServer(tfServer.getString());
            key = tfKey.getString().trim();
            if (cgBbConn != null) {
                bbConn = cgBbConn.getSelectedIndex();
            }
            zoom = clamp(parseInt(tfZoom.getString(), DEFAULT_ZOOM), 25, 200);
            quality = clamp(parseInt(tfQuality.getString(), DEFAULT_QUALITY), 10, 95);
            png = cgFormat.getSelectedIndex() == 1;
            int ov = cgOverscan.getSelectedIndex() == 0 ? OVERSCAN : OVERSCAN_LOW_MEM;
            if (ov != overscan) {
                overscan = ov;
                frameAuto = false;
            }
            res = cgRes.getSelectedIndex();
            textFont = cgTextSize.getSelectedIndex();
            TextFrame.setTextFont(textFont);
            TextFrame.setZoom(zoom);
            saveSettings();
            canvas.toast(!server.equals(oldServer) || bbConn != oldConn
                    ? "Saved, server: " + server : "Settings saved");
        } catch (Throwable t) {
            canvas.toast("Settings error: " + t);
        }
        display.setCurrent(canvas);
        net.resetHash();
        net.refresh();
    }

    /** "10.0.0.5:8080/" -> "http://10.0.0.5:8080"; empty -> build default. */
    private String normalizeServer(String s) {
        s = s.trim();
        while (s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        if (s.length() == 0) {
            return defaultServer;
        }
        if (s.indexOf("://") < 0) {
            s = "http://" + s;
        }
        return s;
    }

    // ---- CommandListener ----

    public void commandAction(Command c, Displayable d) {
        if (d == textBox || d == inputForm) {
            if (c == cmdOk || c == cmdSendBack) {
                textSubmitted();
            } else {
                textBox = null;
                inputForm = null;
                display.setCurrent(canvas);
            }
        } else if (d == settingsForm) {
            // Some phones (BlackBerry) deliver the Save button's item
            // command here instead of to the ItemCommandListener.
            if (c == cmdOk || c == cmdSave || c == cmdSaveBack) {
                settingsSubmitted();
            } else {
                settingsForm = null;
                display.setCurrent(canvas);
            }
        }
    }

    /** A FormButton was clicked or tapped (BlackBerry forms). */
    void buttonPressed(FormButton b) {
        if (b == btnSave) {
            settingsSubmitted();
        } else if (b == btnSend) {
            textSubmitted();
        }
    }

    /** The on-screen Save button in Settings. */
    public void commandAction(Command c, Item item) {
        if (c == cmdSave) {
            settingsSubmitted();
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
                    in.readBoolean(); // former live view setting
                }
                if (version >= 3) {
                    String s = in.readUTF();
                    if (s.length() > 0) {
                        server = s;
                    }
                    bbConn = clamp(in.readInt(), BB_WIFI, BB_DEFAULT);
                }
                if (version >= 4) {
                    overscan = clamp(in.readInt(), OVERSCAN_LOW_MEM, OVERSCAN);
                    frameAuto = in.readBoolean();
                }
                if (version == 5) {
                    res = in.readBoolean() ? RES_HALF : RES_FULL;
                } else if (version >= 6) {
                    res = clamp(in.readInt(), RES_FULL, RES_HALF);
                }
                if (version == 7) {
                    in.readInt(); // phone font size, replaced by textFont
                } else if (version == 8) {
                    // Page size -> Default; smaller, much smaller -> Small.
                    textFont = in.readInt() == 0 ? TextFrame.SIZE_NORMAL : TextFrame.SIZE_SMALL;
                } else if (version >= 9) {
                    textFont = clamp(in.readInt(), TextFrame.SIZE_LARGE, TextFrame.SIZE_SMALL);
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
        TextFrame.setTextFont(textFont);
        TextFrame.setZoom(zoom);
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
            out.writeBoolean(false); // former live view setting
            // Empty = follow the build's default server.
            out.writeUTF(server.equals(defaultServer) ? "" : server);
            out.writeInt(bbConn);
            out.writeInt(overscan);
            out.writeBoolean(frameAuto);
            out.writeInt(res);
            out.writeInt(textFont);
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
