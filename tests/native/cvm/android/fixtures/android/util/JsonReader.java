package android.util;
/** Test-only Android JsonReader ABI adapter; device parser acceptance remains separate. */
public final class JsonReader implements java.io.Closeable {
  private final com.google.gson.stream.JsonReader reader;
  public JsonReader(java.io.Reader source){reader=new com.google.gson.stream.JsonReader(source);}
  public void setLenient(boolean value){reader.setStrictness(value?com.google.gson.Strictness.LENIENT:com.google.gson.Strictness.LEGACY_STRICT);}
  public JsonToken peek()throws java.io.IOException{return JsonToken.valueOf(reader.peek().name());}
  public void beginObject()throws java.io.IOException{reader.beginObject();}public void endObject()throws java.io.IOException{reader.endObject();}
  public void beginArray()throws java.io.IOException{reader.beginArray();}public void endArray()throws java.io.IOException{reader.endArray();}
  public boolean hasNext()throws java.io.IOException{return reader.hasNext();}public String nextName()throws java.io.IOException{return reader.nextName();}
  public String nextString()throws java.io.IOException{return reader.nextString();}public boolean nextBoolean()throws java.io.IOException{return reader.nextBoolean();}
  public void nextNull()throws java.io.IOException{reader.nextNull();}public void close()throws java.io.IOException{reader.close();}
}
