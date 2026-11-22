package fbc;

/**
 * Animates a Splash: repaints its canvas 4 times a second until that
 * splash is hidden or shown again (a newer SplashTick takes over).
 * Top-level, not nested: KEmulator fails on nested classes.
 */
class SplashTick implements Runnable {

    private final Splash splash;
    private final int gen;

    SplashTick(Splash splash, int gen) {
        this.splash = splash;
        this.gen = gen;
    }

    public void run() {
        while (splash.current(gen)) {
            try {
                Thread.sleep(250);
            } catch (InterruptedException e) {
                // continue
            }
            splash.repaint();
        }
    }
}
