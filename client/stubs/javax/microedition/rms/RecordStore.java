package javax.microedition.rms;
public class RecordStore {
    public static RecordStore openRecordStore(String n, boolean c) { return null; }
    public int getNumRecords() { return 0; }
    public byte[] getRecord(int id) { return null; }
    public void setRecord(int id, byte[] b, int o, int l) {}
    public int addRecord(byte[] b, int o, int l) { return 0; }
    public void closeRecordStore() {}
}
