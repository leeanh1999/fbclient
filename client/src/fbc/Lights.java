package fbc;

import javax.microedition.lcdui.Display;

/**
 * Keeps the screen lit while a video plays. MIDP has no "keep screen on",
 * and Display.flashBacklight dims and re-lights the screen on each call on
 * Nokia and BlackBerry, so their own APIs are used where present: Nokia's
 * DeviceControl.setLights, BlackBerry's Backlight.enable. Those classes are
 * only touched through NokiaLights / RimLights, loaded on the phone that
 * has them.
 */
class Lights {

    private static final int NONE = 0;
    private static final int NOKIA = 1;
    private static final int RIM = 2;
    private static int kind = -1;
    private static long flashAt;

    /** Call every few seconds while the light must stay on. */
    static void keepOn(Display d) {
        if (kind < 0) {
            kind = has("com.nokia.mid.ui.DeviceControl") ? NOKIA
                    : has("net.rim.device.api.system.Backlight") ? RIM : NONE;
        }
        try {
            if (kind == NOKIA) {
                NokiaLights.on();
                return;
            }
            if (kind == RIM) {
                RimLights.on();
                return;
            }
        } catch (Throwable t) {
            kind = NONE; // not allowed or missing after all
        }
        // Other phones: as rarely as possible, it may blink.
        long now = System.currentTimeMillis();
        if (now - flashAt > 20000) {
            flashAt = now;
            try {
                d.flashBacklight(30000);
            } catch (Throwable t) {
                // not supported
            }
        }
    }

    private static boolean has(String name) {
        try {
            Class.forName(name);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }
}
