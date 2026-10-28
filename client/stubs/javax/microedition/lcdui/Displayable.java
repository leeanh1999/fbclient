package javax.microedition.lcdui;
public abstract class Displayable {
    public void addCommand(Command c) {}
    public void setCommandListener(CommandListener l) {}
    public int getWidth() { return 0; }
    public int getHeight() { return 0; }
    protected void sizeChanged(int w, int h) {}
}
