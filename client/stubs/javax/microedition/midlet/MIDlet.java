package javax.microedition.midlet;
public abstract class MIDlet {
    protected MIDlet() {}
    protected abstract void startApp() throws MIDletStateChangeException;
    protected abstract void pauseApp();
    protected abstract void destroyApp(boolean u) throws MIDletStateChangeException;
    public final void notifyDestroyed() {}
    public final String getAppProperty(String key) { return null; }
}
