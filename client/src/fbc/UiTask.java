package fbc;

/**
 * Runs a UI action on the event thread (via Display.callSerially).
 * Top-level rather than nested: some emulators (KEmulator) fail to load
 * nested/anonymous classes.
 */
class UiTask implements Runnable {

    static final int INPUT = 0;
    static final int VIDEO = 1;
    static final int VIDEO_ERROR = 2;
    // Run on plain threads (not the event thread) by FbMidlet.exit().
    static final int SHUTDOWN = 3;
    static final int BYE = 4;
    static final int LEAVE = 5;
    // The feed screen opened a page on the server: show the browser view.
    static final int FEED_EXIT = 6;
    // The server's page waits for the user (value: "login" or "pin").
    static final int NEED_USER = 7;
    // Logged in / PIN entered (flag: it was the PIN).
    static final int ASSIST_DONE = 8;
    // A screen says which one to show instead (value: "home" or "chats").
    static final int OPEN = 9;

    private final FbMidlet app;
    private final int kind;
    private final String value;
    private final boolean flag;

    UiTask(FbMidlet app, int kind, String value, boolean flag) {
        this.app = app;
        this.kind = kind;
        this.value = value;
        this.flag = flag;
    }

    public void run() {
        if (kind == INPUT) {
            app.showTextInput(value, flag);
        } else if (kind == VIDEO) {
            app.openVideo(value);
        } else if (kind == SHUTDOWN) {
            app.shutdown();
        } else if (kind == BYE) {
            app.sayBye();
        } else if (kind == LEAVE) {
            app.leave();
        } else if (kind == FEED_EXIT) {
            app.openReader(null); // the page the feed opened
        } else if (kind == OPEN) {
            app.openScreen(value);
        } else if (kind == NEED_USER) {
            app.needUser(value);
        } else if (kind == ASSIST_DONE) {
            app.assistDone(flag);
        } else {
            app.videoError(value);
        }
    }
}
