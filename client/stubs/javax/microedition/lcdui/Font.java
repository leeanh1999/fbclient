package javax.microedition.lcdui;
public final class Font {
    public static final int FACE_SYSTEM = 0, STYLE_PLAIN = 0, STYLE_BOLD = 1, SIZE_SMALL = 8, SIZE_MEDIUM = 0,
        SIZE_LARGE = 16, FACE_PROPORTIONAL = 64;
    public static Font getFont(int f, int s, int z) { return null; }
    public int stringWidth(String s) { return 0; }
    public int getHeight() { return 0; }
    public static Font getDefaultFont() { return null; }
    public int getBaselinePosition() { return 0; }
    public int charWidth(char c) { return 0; }
}
