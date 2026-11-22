package fbc;

/**
 * A phone maker's way to keep the backlight on (NokiaLights). Lights loads
 * it by name only, so FbClient-bb.jar can leave it out (BlackBerry refuses
 * to install a jar that mentions a Nokia class).
 */
public interface Backlit {
    void on();
}
