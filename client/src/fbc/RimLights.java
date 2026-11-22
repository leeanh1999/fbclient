package fbc;

/** BlackBerry only (see Lights): backlight on for 30 s more. */
public class RimLights implements Backlit {
    public RimLights() {
    }

    public void on() {
        net.rim.device.api.system.Backlight.enable(true, 30);
    }
}
