package javax.microedition.lcdui;
public abstract class CustomItem extends Item {
    protected CustomItem(String label) {}
    protected abstract int getMinContentWidth();
    protected abstract int getMinContentHeight();
    protected abstract int getPrefContentWidth(int h);
    protected abstract int getPrefContentHeight(int w);
    protected abstract void paint(Graphics g, int w, int h);
    protected boolean traverse(int dir, int vw, int vh, int[] rect) { return false; }
    protected void traverseOut() {}
    protected void keyPressed(int k) {}
    protected void pointerPressed(int x, int y) {}
    protected void pointerReleased(int x, int y) {}
    protected final void repaint() {}
    public int getGameAction(int k) { return 0; }
}
