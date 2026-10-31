package fbc;

import javax.microedition.lcdui.Graphics;

/**
 * Bottom-sheet menu drawn over the page: dimmed background, grid of round
 * icon tiles. Works with keys (arrows + FIRE) and touch.
 */
class MenuOverlay {

    // Actions, handled by FbMidlet.menuAction().
    static final int TYPE = 0;
    static final int ENTER = 1;
    static final int URL = 2;
    static final int MESSENGER = 3;
    static final int VIDEO = 4;
    static final int FORWARD = 5;
    static final int RELOAD = 6;
    static final int SETTINGS = 7;
    static final int EXIT = 8;
    static final int HOME = 9;

    // Short labels: BlackBerry's smallest system font is large, and longer
    // ones forced fewer columns (more rows, so tiny icons).
    private static final String[] LABELS = {
        "Type", "Enter", "URL", "Messenger", "Video",
        "Forward", "Reload", "Settings", "Exit", "Home"
    };
    private static final int[] ICON = {
        Icons.KEYBOARD, Icons.ENTER, Icons.GLOBE, Icons.MESSENGER, Icons.VIDEO,
        Icons.FORWARD, Icons.RELOAD, Icons.SETTINGS, Icons.EXIT, Icons.HOME
    };

    private static final int C_PANEL = 0xFFFFFF;
    private static final int C_TEXT = 0x1C1E21;
    private static final int C_SUB = 0x65676B;
    private static final int C_TILE = 0xF0F2F5;
    private static final int C_BLUE = 0x1877F2;
    private static final int C_SEL = 0xE7F3FF;
    private static final int HEADER_H = 30;

    private final int[] items;
    private int[] dim;
    private int dimW;

    volatile boolean open;
    private int sel;
    private int slide; // remaining slide-in offset, px

    // Layout (recomputed on paint)
    private int cols, rows, tileW, tileH, panelY, iconD;

    MenuOverlay(boolean withHome) {
        // Devices without the touch footer also need Home in the menu.
        int[] base = {TYPE, ENTER, URL, MESSENGER, VIDEO, FORWARD, RELOAD, SETTINGS, EXIT};
        if (withHome) {
            items = new int[base.length + 1];
            items[0] = HOME;
            System.arraycopy(base, 0, items, 1, base.length);
        } else {
            items = base;
        }
    }

    void show(int viewH) {
        open = true;
        slide = viewH / 2;
    }

    void hide() {
        open = false;
    }

    /** Advance the slide-in animation; true if a repaint is needed. */
    boolean tick() {
        if (!open || slide == 0) {
            return false;
        }
        slide = slide < 4 ? 0 : slide / 2;
        return true;
    }

    int selectedAction() {
        return items[sel];
    }

    void move(int dx, int dy) {
        int c = sel % cols + dx;
        int r = sel / cols + dy;
        if (c < 0 || c >= cols || r < 0 || r >= rows) {
            return;
        }
        int i = r * cols + c;
        if (i < items.length) {
            sel = i;
        }
    }

    /** Action under (x, y), -1 inside the panel but not on a tile, -2 outside. */
    int hit(int x, int y) {
        if (y < panelY) {
            return -2;
        }
        int ty = y - panelY - HEADER_H;
        if (ty < 0) {
            return -1;
        }
        int i = (ty / tileH) * cols + x / tileW;
        return i >= 0 && i < items.length ? items[i] : -1;
    }

    private void layout(int w, int vh, TextFont font) {
        // As many columns as the widest label allows: BlackBerry's system
        // font is much wider than S60's at the same screen width.
        int widest = 0;
        for (int i = 0; i < items.length; i++) {
            widest = Math.max(widest, font.stringWidth(LABELS[items[i]]));
        }
        cols = Math.max(3, Math.min(5, w / (widest + 16)));
        rows = (items.length + cols - 1) / cols;
        tileW = w / cols;
        int fh = font.height();
        // Icon in proportion to the text (about twice its height), then
        // shrunk only if the rows would not fit in 85% of the view.
        iconD = Math.max(28, Math.min(72, Math.min(fh * 2, tileW - 16)));
        int maxTileH = (vh * 85 / 100 - HEADER_H - 8) / rows;
        tileH = Math.min(iconD + fh + 16, maxTileH);
        iconD = Math.max(20, Math.min(iconD, tileH - fh - 14));
        panelY = vh - HEADER_H - rows * tileH - 8;
    }

    void paint(Graphics g, int w, int vh, TextFont font, boolean showSel, String url) {
        layout(w, vh, font);
        dimPage(g, w, vh);

        int top = panelY + slide;
        g.setColor(C_PANEL);
        g.fillRoundRect(0, top, w, vh - top + 16, 24, 24);
        // Grab handle + title + current page.
        g.setColor(0xCED0D4);
        g.fillRoundRect(w / 2 - 18, top + 6, 36, 4, 4, 4);
        font.draw(g, "Menu", 12, top + 12, C_TEXT, C_PANEL, Graphics.TOP | Graphics.LEFT);
        if (url != null && url.length() > 0) {
            font.draw(g, font.shorten(url, w - font.stringWidth("Menu") - 36),
                    w - 12, top + 12, C_SUB, C_PANEL, Graphics.TOP | Graphics.RIGHT);
        }

        int d = iconD;
        for (int i = 0; i < items.length; i++) {
            int a = items[i];
            int tx = (i % cols) * tileW;
            int ty = top + HEADER_H + (i / cols) * tileH;
            int cx = tx + tileW / 2;
            int cy = ty + 4 + d / 2;
            if (showSel && i == sel) {
                g.setColor(C_SEL);
                g.fillRoundRect(tx + 3, ty, tileW - 6, tileH - 2, 14, 14);
            }
            int circle = a == MESSENGER ? 0xE7F0FF : C_TILE;
            Icons.drawSmooth(g, Icons.CIRCLE, cx, cy, d, circle, circle);
            int fg = a == MESSENGER ? C_BLUE : (a == EXIT ? 0xE41E3F : C_TEXT);
            Icons.drawSmooth(g, ICON[a], cx, cy, d * 11 / 20, fg, circle);
            font.draw(g, font.shorten(LABELS[a], tileW - 4), cx, cy + d / 2 + 4,
                    showSel && i == sel ? C_BLUE : C_TEXT, showSel && i == sel ? C_SEL : C_PANEL,
                    Graphics.TOP | Graphics.HCENTER);
        }
    }

    /** Darken the page behind the sheet (semi-transparent black). */
    private void dimPage(Graphics g, int w, int vh) {
        final int rowsPerStrip = 8;
        if (dim == null || dimW != w) {
            dimW = w;
            dim = new int[w * rowsPerStrip];
            for (int i = 0; i < dim.length; i++) {
                dim[i] = 0x88000000;
            }
        }
        try {
            for (int y = 0; y < vh; y += rowsPerStrip) {
                g.drawRGB(dim, 0, w, 0, y, w, Math.min(rowsPerStrip, vh - y), true);
            }
        } catch (Exception e) {
            // No alpha support: skip dimming.
        }
    }

}
