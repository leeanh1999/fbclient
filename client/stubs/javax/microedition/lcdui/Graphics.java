package javax.microedition.lcdui;
public class Graphics {
    public static final int HCENTER = 1, VCENTER = 2, LEFT = 4, RIGHT = 8, TOP = 16, BOTTOM = 32, BASELINE = 64;
    public void setColor(int c) {}
    public void setFont(Font f) {}
    public void setClip(int x, int y, int w, int h) {}
    public void clipRect(int x, int y, int w, int h) {}
    public void fillRect(int x, int y, int w, int h) {}
    public void fillRoundRect(int x, int y, int w, int h, int a, int b) {}
    public void fillTriangle(int a, int b, int c, int d, int e, int f) {}
    public void drawLine(int a, int b, int c, int d) {}
    public void drawRect(int x, int y, int w, int h) {}
    public void drawRoundRect(int x, int y, int w, int h, int a, int b) {}
    public void drawRGB(int[] rgb, int off, int scan, int x, int y, int w, int h, boolean alpha) {}
    public void fillArc(int x, int y, int w, int h, int s, int a) {}
    public void drawArc(int x, int y, int w, int h, int s, int a) {}
    public void drawString(String s, int x, int y, int a) {}
    public void drawImage(Image i, int x, int y, int a) {}
}
