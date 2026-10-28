package javax.microedition.io;
public interface HttpConnection extends ContentConnection {
    String GET = "GET";
    int HTTP_OK = 200;
    int HTTP_NO_CONTENT = 204;
    void setRequestMethod(String m) throws java.io.IOException;
    int getResponseCode() throws java.io.IOException;
    String getHeaderField(String n) throws java.io.IOException;
}
