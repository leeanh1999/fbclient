package javax.microedition.lcdui;
public abstract class Canvas extends Displayable {
    public static final int UP = 1, DOWN = 6, LEFT = 2, RIGHT = 5, FIRE = 8;
    public static final int KEY_NUM0 = 48, KEY_NUM1 = 49, KEY_NUM2 = 50, KEY_NUM3 = 51, KEY_NUM4 = 52,
        KEY_NUM5 = 53, KEY_NUM6 = 54, KEY_NUM7 = 55, KEY_NUM8 = 56, KEY_NUM9 = 57, KEY_STAR = 42, KEY_POUND = 35;
    protected Canvas() {}
    protected abstract void paint(Graphics g);
    public final void repaint() {}
    public final void repaint(int x, int y, int w, int h) {}
    public int getGameAction(int k) { return 0; }
    public void setFullScreenMode(boolean m) {}
    public boolean hasPointerEvents() { return false; }
    protected void showNotify() {}
    protected void keyPressed(int k) {}
    protected void keyReleased(int k) {}
    protected void pointerPressed(int x, int y) {}
    protected void pointerReleased(int x, int y) {}
    protected void pointerDragged(int x, int y) {}
    protected void hideNotify() {}
    protected void sizeChanged(int w, int h) {}
}
