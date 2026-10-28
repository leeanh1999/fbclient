package javax.microedition.lcdui;
public abstract class Item {
    public static final int PLAIN = 0;
    public static final int HYPERLINK = 1;
    public static final int BUTTON = 2;
    public static final int LAYOUT_CENTER = 3;
    public static final int LAYOUT_NEWLINE_BEFORE = 0x100;
    public static final int LAYOUT_NEWLINE_AFTER = 0x200;
    public void setLayout(int layout) {}
    public void setDefaultCommand(Command cmd) {}
    public void setItemCommandListener(ItemCommandListener l) {}
}
