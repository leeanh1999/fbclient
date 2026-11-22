package fbc;

import javax.microedition.lcdui.Display;

/**
 * Keeps the screen lit while a video plays. MIDP has no "keep screen on",
 * and Display.flashBacklight dims and re-lights the screen on each call on
 * Nokia, so its own API is used where present: DeviceControl.setLights
 * (NokiaLights, only in FbClient.jar, loaded by name). BlackBerry's own
 * Backlight is a signed API (an unsigned app using it does not start), so
 * other phones use flashBacklight, as rarely as possible; BlackBerry none:
 * there it blinks the light for the whole duration.
 */
class Lights {

    private static boolean tried;
    private static Backlit maker;
    private static long flashAt;

    /**
     * Call every few seconds while the light must stay on. flash: whether
     * flashBacklight may be used (not on BlackBerry).
     */
    static void keepOn(Display d, boolean flash) {
        if (!tried) {
            tried = true;
            maker = load("com.nokia.mid.ui.DeviceControl", "fbc.NokiaLights");
        }
        if (maker != null) {
            try {
                maker.on();
                return;
            } catch (Throwable t) {
                maker = null; // not allowed after all
            }
        }
        // Other phones: as rarely as possible, it may blink.
        long now = System.currentTimeMillis();
        if (flash && now - flashAt > 20000) {
            flashAt = now;
            try {
                d.flashBacklight(30000);
            } catch (Throwable t) {
                // not supported
            }
        }
    }

    /** The video closed: end a flashBacklight effect still going. */
    static void stop(Display d) {
        if (flashAt != 0) {
            flashAt = 0;
            try {
                d.flashBacklight(0);
            } catch (Throwable t) {
                // not supported
            }
        }
    }

    /** The helper class when the phone has the API and the jar has the helper. */
    private static Backlit load(String api, String helper) {
        try {
            Class.forName(api);
            return (Backlit) Class.forName(helper).newInstance();
        } catch (Throwable t) {
            return null;
        }
    }
}
