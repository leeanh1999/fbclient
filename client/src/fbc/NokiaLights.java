package fbc;

/** Nokia only (see Lights): full backlight until the phone's own timeout. */
public class NokiaLights implements Backlit {
    public NokiaLights() {
    }

    public void on() {
        com.nokia.mid.ui.DeviceControl.setLights(0, 100);
    }
}
