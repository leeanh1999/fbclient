package fbc;

/**
 * Animation frames (menu slide-in, eased and swiped scrolling): a paint that
 * wants another frame calls FbMidlet.again(), and this thread repaints the
 * current screen FRAME_MS later. A thread rather than chained
 * Display.callSerially calls, which kept the event thread busy so key
 * presses (BlackBerry's trackpad) waited behind the frames; and rather than
 * repaint() inside paint(), which BlackBerry drops.
 * Top-level, not nested: KEmulator fails on nested classes.
 */
class FrameTick implements Runnable {

    private static final int FRAME_MS = 25;

    private final FbMidlet app;
    private boolean wanted;
    private boolean running;

    FrameTick(FbMidlet app) {
        this.app = app;
    }

    /** One more frame, soon. */
    synchronized void want() {
        wanted = true;
        if (!running) {
            running = true;
            new Thread(this).start();
        } else {
            notify();
        }
    }

    public void run() {
        while (true) {
            synchronized (this) {
                if (!wanted) {
                    try {
                        wait(1000);
                    } catch (InterruptedException e) {
                        // continue
                    }
                    if (!wanted) {
                        running = false; // idle: the next want() starts again
                        return;
                    }
                }
                wanted = false;
            }
            try {
                Thread.sleep(FRAME_MS);
            } catch (InterruptedException e) {
                // continue
            }
            app.repaintCurrent();
        }
    }
}
