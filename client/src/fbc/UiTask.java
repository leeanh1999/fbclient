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
        } else {
            app.videoError(value);
        }
    }
}
