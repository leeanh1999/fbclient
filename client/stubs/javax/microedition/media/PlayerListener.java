package javax.microedition.media;
public interface PlayerListener {
    String END_OF_MEDIA = "endOfMedia";
    String ERROR = "error";
    void playerUpdate(Player p, String event, Object data);
}
