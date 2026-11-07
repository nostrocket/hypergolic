package org.nostrocket.hypergolic.host
import org.json.JSONObject
import org.json.JSONArray
import android.os.SystemClock
import android.os.Handler
import java.util.concurrent.CopyOnWriteArrayList

/** Test-only composition around actual host registration/ingress; no production test switch. */
object CvmHostFixture {
  private const val USER="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  const val PROVIDER="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  const val REQUEST="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"
  private val approved=mutableMapOf<String,MutableList<String>>()
  private val tokenGenerations=mutableMapOf<String,String>()
  private val revisions=mutableMapOf<String,String>()
  @JvmField val responses=CopyOnWriteArrayList<String>()
  @JvmStatic fun setup() {CvmTransport.foreground(true);CvmTransport.synchronizeOwner(USER,1,true);CvmTransport.synchronizeRelays(listOf("wss://relay.example.org"))}
  @JvmStatic fun register(generation:String,grant:Boolean=true,profile:Boolean=true):Boolean {
    val value=JSONObject().put("sessionId","endpoint-$generation").put("instanceId","instance-$generation").put("fixture","published").put("epoch",1)
      .put("user",USER).put("publisher","cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc").put("appId","app-$generation")
      .put("version","dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd").put("domains",JSONArray(if(grant)listOf("cvm")else emptyList<String>()))
    if(profile)value.put("cvmProfile","free-foreground-v1")
    return runCatching {CvmTransport.register(generation,CapabilityConfiguration(value.toString(),generation,true))}.getOrDefault(false)
  }
  @JvmStatic fun ingress(generation:String,id:String,initialize:Boolean=false,timeout:Long=30000):String? {
    val carrier=JSONObject().put("type","cvm.request").put("id",id).put("server",JSONObject().put("pubkey",PROVIDER)).put("message",REQUEST).put("operation","tools/list").put("progressTokenJSON",JSONObject.NULL)
      .put("options",JSONObject().put("timeoutMs",timeout).put("initialize",initialize).put("payment","deny"))
    return CvmTransport.receive(generation,carrier.toString(),{responses.add(it ?: "NULL")},{responses.add("PUSH:$it")})
  }
  @JvmStatic fun custom(generation:String,id:String,message:String,operation:String,tokenJSON:String?):String? {
    val carrier=JSONObject().put("type","cvm.request").put("id",id).put("server",JSONObject().put("pubkey",PROVIDER)).put("message",message)
      .put("operation",operation).put("progressTokenJSON",tokenJSON ?: JSONObject.NULL)
      .put("options",JSONObject().put("timeoutMs",30000).put("initialize",false).put("payment","deny"))
    return CvmTransport.receive(generation,carrier.toString(),{responses.add(it ?: "NULL")},{responses.add("PUSH:$it")})
  }
  @JvmStatic fun cancel(token:String){CvmTransport.finish(token,null);retired(token)}
  @JvmStatic fun take(token:String):String? {
    val value=CvmTransport.take(token) ?:return null
    val scope=JSONObject(value).getJSONObject("scope");revisions[scope.getString("generation")]=scope.getString("sourceRevision");tokenGenerations[token]=scope.getString("generation");return value
  }
  @JvmStatic fun revision(generation:String)=revisions[generation] ?: ""
  @JvmStatic fun currentRevision(generation:String,revision:String)=CvmTransport.current(generation,revision)
  @JvmStatic fun send(generation:String,revision:String,raw:String)=CvmTransport.send(generation,revision,approved[generation]?.firstOrNull() ?: "",eventCarrier(raw))
  @JvmStatic fun sendRequest(generation:String,revision:String,token:String,raw:String)=CvmTransport.send(generation,revision,token,eventCarrier(raw))
  private fun eventCarrier(raw:String)=JSONObject().put("provider",PROVIDER).put("message",raw).toString()
  @JvmStatic fun sendCarrier(generation:String,revision:String,token:String,carrier:String)=CvmTransport.send(generation,revision,token,carrier)
  @JvmStatic fun approve(token:String):String? {
    val result=CvmTransport.approve(token)
    if(result!=null)approved.getOrPut(tokenGenerations.getValue(token)){mutableListOf()}.add(token)
    return result
  }
  private fun retired(token:String){tokenGenerations[token]?.let { approved[it]?.remove(token) }}
  @JvmStatic fun reject(token:String){CvmTransport.reject(token);retired(token)}
  @JvmStatic fun finish(token:String){CvmTransport.finish(token,"{\"type\":\"cvm.request.result\",\"id\":\"done\"}");retired(token)}
  @JvmStatic fun closeProvider(generation:String) {approved.remove(generation);CvmTransport.receive(generation,JSONObject().put("type","cvm.close").put("id","close").put("server",JSONObject().put("pubkey",PROVIDER)).toString(),{responses.add(it ?: "NULL")},{})}
  @JvmStatic fun unsupported(generation:String,type:String):String? {var value:String?=null;CvmTransport.receive(generation,JSONObject().put("type",type).put("id","unsupported").toString(),{value=it},{});return value}
  @JvmStatic fun revoke(generation:String)=CvmTransport.revoke(generation)
  @JvmStatic fun background(){CvmTransport.foreground(false);approved.clear()}
  @JvmStatic fun foreground(){CvmTransport.foreground(true)}
  @JvmStatic fun current(generation:String)=CvmTransport.current(generation,revision(generation))
  @JvmStatic fun advance(milliseconds:Long){SystemClock.time+=milliseconds;Handler.due()}
}
