package fbc;

/** Nokia only (see Lights): full backlight until the phone's own timeout. */
class NokiaLights {
    static void on() {
        com.nokia.mid.ui.DeviceControl.setLights(0, 100);
    }
}
