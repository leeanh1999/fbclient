package fbc;

import javax.microedition.media.Player;

/**
 * Closes a video player off the UI thread: on BlackBerry Player.close() on a
 * stream can take seconds, which froze the screen after leaving a video.
 * Top-level, not nested: KEmulator fails on nested classes.
 */
class PlayerClose implements Runnable {

    private final Player player;

    PlayerClose(Player player) {
        this.player = player;
    }

    public void run() {
        try {
            player.close();
        } catch (Throwable t) {
            // already closed or failed: nothing left to free
        }
    }
}
