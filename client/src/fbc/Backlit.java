package fbc;

/**
 * A phone maker's way to keep the backlight on (NokiaLights, RimLights).
 * Lights loads them by name only: each jar carries just its own (the
 * BlackBerry one has no Nokia class, which BlackBerry refuses to install).
 */
public interface Backlit {
    void on();
}
