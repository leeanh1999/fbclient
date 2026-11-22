package fbc;

/**
 * Touch scrolling that keeps going after the finger leaves (a fling) and
 * slows down, as on phones' own lists. The screen feeds it the finger's
 * positions while dragging; after release, step() gives how far to scroll
 * for each painted frame, by the time since the last one.
 */
class Kinetic {

    // Recent finger samples (y, time), newest at (count - 1) % N.
    private static final int N = 6;
    private final int[] ys = new int[N];
    private final long[] ts = new long[N];
    private int count;

    // Fling speed in px per ms (positive: content moves up, sy grows).
    private float v;
    private float rest; // fraction of a pixel carried to the next step
    private long last;
    volatile boolean active;

    // Below this speed a release is just a drag ending; above MAX it is capped.
    private static final float MIN_V = 0.25f;
    private static final float MAX_V = 5f;
    private static final float STOP_V = 0.03f;
    // Speed lost per ms (about 30% every 100 ms).
    private static final float FRICTION = 0.0035f;

    /** A finger went down: stop any fling, start a new drag. */
    void press(int y) {
        active = false;
        count = 0;
        track(y);
    }

    /** The finger moved to y. */
    void track(int y) {
        int i = count % N;
        ys[i] = y;
        ts[i] = System.currentTimeMillis();
        count++;
    }

    /** The finger left: true if that starts a fling. */
    boolean release() {
        active = false;
        if (count < 2) {
            return false;
        }
        long now = System.currentTimeMillis();
        int newest = (count - 1) % N;
        if (now - ts[newest] > 80) {
            return false; // the finger stopped before leaving
        }
        // The oldest sample of the last 120 ms.
        int oldest = newest;
        for (int k = 1; k < Math.min(count, N); k++) {
            int i = (count - 1 - k) % N;
            if (ts[newest] - ts[i] > 120) {
                break;
            }
            oldest = i;
        }
        long dt = ts[newest] - ts[oldest];
        if (dt <= 0) {
            return false;
        }
        float speed = (float) (ys[oldest] - ys[newest]) / dt;
        if (Math.abs(speed) < MIN_V) {
            return false;
        }
        v = Math.max(-MAX_V, Math.min(MAX_V, speed));
        rest = 0;
        last = now;
        active = true;
        return true;
    }

    void stop() {
        active = false;
    }

    /** Pixels to scroll now (0 when the fling is over). */
    int step() {
        if (!active) {
            return 0;
        }
        long now = System.currentTimeMillis();
        int dt = (int) Math.min(50, Math.max(1, now - last));
        last = now;
        float d = v * dt + rest;
        int px = (int) d;
        rest = d - px;
        v -= v * Math.min(1f, FRICTION * dt);
        if (Math.abs(v) < STOP_V) {
            active = false;
        }
        return px;
    }
}
