package fbc;

import java.util.Hashtable;
import java.util.Vector;

/** A screen of the app's own (feed, chats) whose images ImageLoader fetches. */
interface ImageSource {

    /**
     * Image keys in and near the view not in have or skip, those on screen
     * first; at most max keys and about maxPx pixels.
     */
    Vector missing(Hashtable have, Hashtable skip, int max, int maxPx);

    /** Keys of the images near the view (kept in the cache). */
    Hashtable keysNear();

    /** True while the screen is shown. */
    boolean shownNow();

    void repaint();
}
