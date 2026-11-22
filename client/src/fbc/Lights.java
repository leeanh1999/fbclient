package fbc;

import javax.microedition.lcdui.Display;

/**
 * Keeps the screen lit while a video plays. MIDP has no "keep screen on",
 * and Display.flashBacklight dims and re-lights the screen on each call on
 * Nokia and BlackBerry, so their own APIs are used where present: Nokia's
 * DeviceControl.setLights (NokiaLights, in FbClient.jar), BlackBerry's
 * Backlight.enable (RimLights, in FbClient-bb.jar). Both are loaded by
 * name, so a jar without one still installs and runs.
 */
class Lights {

    private static boolean tried;
    private static Backlit maker;
    private static long flashAt;

    /** Call every few seconds while the light must stay on. */
    static void keepOn(Display d) {
        if (!tried) {
            tried = true;
            maker = load("com.nokia.mid.ui.DeviceControl", "fbc.NokiaLights");
            if (maker == null) {
                maker = load("net.rim.device.api.system.Backlight", "fbc.RimLights");
            }
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
        if (now - flashAt > 20000) {
            flashAt = now;
            try {
                d.flashBacklight(30000);
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
