package javax.microedition.media.control;
public interface VideoControl extends GUIControl {
    int USE_DIRECT_VIDEO = 1;
    void setDisplayLocation(int x, int y);
    void setDisplaySize(int w, int h) throws javax.microedition.media.MediaException;
    void setVisible(boolean v);
    int getSourceWidth();
    int getSourceHeight();
}
