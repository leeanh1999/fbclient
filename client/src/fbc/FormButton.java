package fbc;

import javax.microedition.lcdui.Canvas;
import javax.microedition.lcdui.CustomItem;
import javax.microedition.lcdui.Font;
import javax.microedition.lcdui.Graphics;

/**
 * Self-drawn button for Forms. BlackBerry OS 7 does not run the default
 * command of a StringItem button, so this item handles the click (trackpad
 * or Enter) and the tap itself and calls FbMidlet.buttonPressed().
 * Top-level class: KEmulator fails on nested classes.
 */
class FormButton extends CustomItem {

    private final FbMidlet app;
    private final String text;
    private final Font font = Font.getFont(Font.FACE_SYSTEM, Font.STYLE_BOLD, Font.SIZE_MEDIUM);
    private boolean focused;
    private boolean pressed;

    FormButton(FbMidlet app, String text) {
        super(null);
        this.app = app;
        this.text = text;
    }

    protected int getMinContentWidth() {
        return font.stringWidth(text) + 40;
    }

    protected int getMinContentHeight() {
        return font.getHeight() + 20;
    }

    protected int getPrefContentWidth(int h) {
        return Math.max(getMinContentWidth(), 160);
    }

    protected int getPrefContentHeight(int w) {
        return getMinContentHeight();
    }

    protected void paint(Graphics g, int w, int h) {
        g.setColor(pressed ? 0x166FE5 : 0x1877F2);
        g.fillRoundRect(0, 0, w - 1, h - 1, 12, 12);
        if (focused) {
            g.setColor(0x0A4DB0);
            g.drawRoundRect(0, 0, w - 1, h - 1, 12, 12);
            g.drawRoundRect(1, 1, w - 3, h - 3, 10, 10);
        }
        g.setFont(font);
        g.setColor(0xFFFFFF);
        g.drawString(text, w / 2, (h - font.getHeight()) / 2, Graphics.TOP | Graphics.HCENTER);
    }

    protected boolean traverse(int dir, int vw, int vh, int[] rect) {
        if (!focused) {
            focused = true;
            repaint();
            return true;
        }
        return false;
    }

    protected void traverseOut() {
        focused = false;
        repaint();
    }

    protected void keyPressed(int k) {
        int ga = 0;
        try {
            ga = getGameAction(k);
        } catch (Exception e) {
            // Unknown key code on this device.
        }
        if (k == 10 || k == 13 || k == ' ' || ga == Canvas.FIRE) {
            app.buttonPressed(this);
        }
    }

    protected void pointerPressed(int x, int y) {
        pressed = true;
        repaint();
    }

    protected void pointerReleased(int x, int y) {
        pressed = false;
        repaint();
        app.buttonPressed(this);
    }
}
