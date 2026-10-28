package javax.microedition.media;
public interface Player extends Controllable {
    void realize() throws MediaException;
    void prefetch() throws MediaException;
    void start() throws MediaException;
    void stop() throws MediaException;
    void close();
    long getDuration();
    long getMediaTime();
    long setMediaTime(long t) throws MediaException;
    void addPlayerListener(PlayerListener l);
}
