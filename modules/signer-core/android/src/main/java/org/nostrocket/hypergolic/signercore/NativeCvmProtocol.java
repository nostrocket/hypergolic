package org.nostrocket.hypergolic.signercore;

import org.json.JSONObject;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import org.nostrocket.hypergolic.host.NativeCvmSourceFacade;

/** Fixed native session setup and receiver-side controls, never a generic signing oracle. */
final class NativeCvmProtocol {
  private boolean initializationPrepared, initializationReplied, initialized;
  private long controls;
  private String initializationId;
  private final Object token;
  NativeCvmProtocol(String message) {
    JSONObject object=object(message), params=object==null?null:object.optJSONObject("params");
    JSONObject meta=params==null?null:params.optJSONObject("_meta");token=meta==null?null:meta.opt("progressToken");
  }
  static JSONObject object(String raw) { try{return new JSONObject(raw);}catch(Exception invalid){return null;} }
  private static IllegalStateException denied(){return new IllegalStateException("CVM message denied");}
  static boolean keys(JSONObject value,String... names){if(value==null)return false;Set<String> fields=new HashSet<>();java.util.Iterator<String> keys=value.keys();while(keys.hasNext())fields.add(keys.next());return fields.equals(new HashSet<>(Arrays.asList(names)));}
  void validate(String purpose,String raw,String replyTo,NativeCvmSourceFacade.Access access) {
    if(!access.current()||raw==null||raw.getBytes(java.nio.charset.StandardCharsets.UTF_8).length>32768)throw denied();
    if("approved".equals(purpose)){if(!raw.equals(access.message()))throw denied();return;}
    JSONObject row=object(raw);if(replyTo!=null||row==null||!"2.0".equals(row.opt("jsonrpc")))throw denied();
    if("initialize".equals(purpose)){
      JSONObject params=row.optJSONObject("params"),client=params==null?null:params.optJSONObject("clientInfo"),caps=params==null?null:params.optJSONObject("capabilities");
      Object initId=row.opt("id");
      if(!access.initialize()||initializationPrepared||!keys(row,"jsonrpc","id","method","params")||!(initId instanceof String)||!((String)initId).matches("hypergolic:init:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")||!"initialize".equals(row.opt("method"))||
        !keys(params,"protocolVersion","capabilities","clientInfo")||!"2025-06-18".equals(params.opt("protocolVersion"))||caps==null||caps.length()!=0||
        !keys(client,"name","version")||!"Hypergolic".equals(client.opt("name"))||!"1".equals(client.opt("version")))throw denied();
      initializationId=(String)initId;initializationPrepared=true;return;
    }
    if("initialized".equals(purpose)){
      if(!initializationPrepared||!initializationReplied||initialized||!keys(row,"jsonrpc","method")||!"notifications/initialized".equals(row.opt("method")))throw denied();
      initialized=true;return;
    }
    if(!"stream-control".equals(purpose))throw denied();
    JSONObject params=row.optJSONObject("params"),frame=params==null?null:params.optJSONObject("cvm");Object progress=params==null?null:params.opt("progress");Object received=params==null?null:params.opt("progressToken");
    if(token==null||token==JSONObject.NULL||received==null||token.getClass()!=received.getClass()||!token.equals(received)||
      !keys(row,"jsonrpc","method","params")||!"notifications/progress".equals(row.opt("method"))||!keys(params,"progressToken","progress","cvm")||
      !(progress instanceof Number)||!Double.isFinite(((Number)progress).doubleValue())||((Number)progress).doubleValue()!=controls+1||controls>=4096||
      frame==null||!"open-stream".equals(frame.opt("type")))throw denied();
    String kind=frame.optString("frameType");
    if("accept".equals(kind)){if(!keys(frame,"type","frameType"))throw denied();}
    else if("ping".equals(kind)||"pong".equals(kind)){
      Object nonce=frame.opt("nonce");if(!keys(frame,"type","frameType","nonce")||!(nonce instanceof String)||((String)nonce).isEmpty()||((String)nonce).getBytes(java.nio.charset.StandardCharsets.UTF_8).length>64)throw denied();
    }else throw denied();
    controls++;
  }
  void receive(String message){
    JSONObject row=object(message);if(!initializationPrepared||row==null||!"2.0".equals(row.opt("jsonrpc"))||!initializationId.equals(row.opt("id"))||row.has("method")||row.has("error"))return;
    JSONObject result=row.optJSONObject("result");if(result!=null&&"2025-06-18".equals(result.opt("protocolVersion"))&&result.optJSONObject("capabilities")!=null)initializationReplied=true;
  }
}
