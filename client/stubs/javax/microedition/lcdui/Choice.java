package javax.microedition.lcdui;
public interface Choice {
    int EXCLUSIVE = 1, IMPLICIT = 3;
    int getSelectedIndex();
    void setSelectedIndex(int i, boolean s);
}
