package fbc;

/** BlackBerry only (see Lights): backlight on for 30 s more. */
class RimLights {
    static void on() {
        net.rim.device.api.system.Backlight.enable(true, 30);
    }
}
