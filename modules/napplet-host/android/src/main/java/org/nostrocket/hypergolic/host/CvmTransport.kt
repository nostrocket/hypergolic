package org.nostrocket.hypergolic.host

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID

/** Exact native first-ingress snapshots. Focus is not an approved CVM service lifetime. */
internal object CvmTransport {
  private val authority = NativeCvmServiceAuthority(SystemClock::elapsedRealtime)
  private val main = Handler(Looper.getMainLooper())
  private data class Registration(val config: CapabilityConfiguration, var native: NativeCvmServiceAuthority.Registration?, var sourceRevision: String="", var push: ((String)->Unit)?=null)
  private data class Pending(val registration: Registration, val originalRegistration: NativeCvmServiceAuthority.Registration, val sourceRevision: String, val native: NativeCvmServiceAuthority.Request,
    val captured: JSONObject, val deadline: Long, val reply: (String?)->Unit, var taken: Boolean=false,
    var permit: NativeCvmServiceAuthority.Permit?=null, var timer: Runnable?=null)
  private class Delivery(val registration: Registration, val originalRegistration: NativeCvmServiceAuthority.Registration,
    val sourceRevision: String, val provider: String, val requestToken: String, val deadline: Long, val response: Boolean, var cancelled: Boolean=false)
  private val deliveries=mutableSetOf<Delivery>()
  private fun cancelDeliveries(generation:String?=null,provider:String?=null,requestToken:String?=null) {
    deliveries.forEach { delivery ->
      val nativeGeneration=JSONObject(delivery.registration.config.snapshot).getString("generation")
      if((generation==null||nativeGeneration==generation)&&(provider==null||delivery.provider==provider)&&(requestToken==null||delivery.requestToken==requestToken))delivery.cancelled=true
    }
  }
  private fun deliveryCurrent(delivery:Delivery):Boolean = !delivery.cancelled && foreground && ownerAvailable &&
    delivery.registration.native===delivery.originalRegistration && delivery.registration.sourceRevision==delivery.sourceRevision &&
    authority.current(delivery.originalRegistration) && SystemClock.elapsedRealtime()<delivery.deadline
  private fun responseCount()=deliveries.count { it.response }
  private val registrations=mutableMapOf<String,Registration>()
  private val requests=mutableMapOf<String,Pending>()
  private var foreground=false
  private var ownerAvailable=false
  private var ownerUser=""
  private var ownerEpoch=-1L
  private var network=emptyList<String>()
  private fun handle()=UUID.randomUUID().toString()
  @Synchronized fun synchronizeRelays(relays:List<String>) {
    require(relays.size<=4 && relays.toSet().size==relays.size)
    network=relays.map { NativeSignerRelay.canonical(it) }.toList()
  }
  @Synchronized fun synchronizeOwner(user:String,epoch:Long,available:Boolean) {
    if(user!=ownerUser||epoch!=ownerEpoch||!available) { cancelAll(); registrations.values.forEach { it.native=null } }
    ownerUser=user;ownerEpoch=epoch;ownerAvailable=available
    if(available)authority.account(user,epoch)
    else authority.foreground(false)
    authority.foreground(foreground&&available)
    restoreRegistrations()
  }
  private fun restoreRegistrations() {
    if(!foreground||!ownerAvailable)return
    registrations.forEach { (generation,row)->if(row.native==null && row.config.user==ownerUser && row.config.epoch==ownerEpoch){row.native=authority.register(source(generation,row.config));if(row.native!=null)row.sourceRevision=handle()} }
  }
  private fun source(generation:String,config:CapabilityConfiguration):NativeCvmServiceAuthority.Source {
    val snapshot=JSONObject(config.snapshot)
    return NativeCvmServiceAuthority.Source(config.sessionId,generation,config.user,config.epoch,config.publisher,config.appId,config.version,snapshot.getString("instanceId"))
  }
  @Synchronized fun register(generation:String,config:CapabilityConfiguration):Boolean {
    if("cvm" !in config.grantedDomains)return true
    if(config.cvmProfile!="free-foreground-v1"||registrations.containsKey(generation)||registrations.size>=64)return false
    val row=Registration(config,null);registrations[generation]=row;restoreRegistrations();return true
  }
  @Synchronized fun foreground(value:Boolean) {
    foreground=value;authority.foreground(value&&ownerAvailable)
    if(!value){cancelAll();registrations.values.forEach { it.native=null }}else restoreRegistrations()
  }
  @Synchronized fun revoke(generation:String) {
    cancelDeliveries(generation)
    NativeCvmSourceFacade.cancelSource(generation,null)
    val row=registrations.remove(generation) ?: return
    row.native?.let(authority::revoke)
    requests.filterValues { it.registration===row }.keys.toList().forEach { remove(it,false) }
  }
  private fun cancelAll() {
    cancelDeliveries()
    NativeCvmSourceFacade.cancelAll()
    requests.keys.toList().forEach { remove(it,false) }
  }
  private fun nativeLive(row:Registration)=row.native?.let(authority::current)==true
  @Synchronized fun receive(generation:String,raw:String,reply:(String?)->Unit,push:(String)->Unit):String? {
    val ingress=SystemClock.elapsedRealtime()
    requests.filterValues { !nativeLive(it.registration)||ingress>=it.deadline }.keys.toList().forEach { remove(it,false) }
    val row=registrations[generation] ?: run { reply(null);return null }
    if(!nativeLive(row)){reply(null);return null};row.push=push
    val carrier=runCatching { UploadWire.objectValue(raw,256*1024,maximumDepth=24) }.getOrNull() ?:run{reply(null);return null}
    val type=carrier.opt("type") as? String ?:run{reply(null);return null}
    val id=carrier.opt("id") as? String ?:run{reply(null);return null}
    if(id.isEmpty()||id.toByteArray().size>128){reply(null);return null}
    fun result(error:String?=null,has:Boolean?=null):String=JSONObject().put("type","$type.result").put("id",id).also { if(error!=null)it.put("error",error);if(has!=null)it.put("has",has) }.toString()
    if(type=="cvm.registry.has"){reply(result(has=false));return null}
    if(type in setOf("cvm.discover","cvm.registry.list","cvm.registry.describe","cvm.registry.call")){reply(result("unsupported method"));return null}
    if(type!="cvm.request"&&type!="cvm.close"){reply(null);return null}
    val server=carrier.optJSONObject("server") ?:run{reply(result("invalid request"));return null}
    if(server.keys().asSequence().toSet().any{it!in setOf("pubkey","relays")}){reply(result("invalid request"));return null}
    val provider=server.opt("pubkey") as? String
    if(provider==null||!provider.matches(Regex("[0-9a-f]{64}"))){reply(result("invalid request"));return null}
    if(type=="cvm.close"){
      cancelDeliveries(generation,provider)
      NativeCvmSourceFacade.cancelSource(generation,provider)
      requests.filterValues { it.registration===row&&it.captured.getJSONObject("server").getString("pubkey")==provider }.keys.toList().forEach { remove(it,false) }
      reply(result());return null
    }
    if(carrier.keys().asSequence().toSet()!=setOf("type","id","server","message","options","operation","progressTokenJSON")){reply(result("invalid request"));return null}
    val message=carrier.opt("message") as? String
    val options=carrier.optJSONObject("options")
    if(message==null||message.isEmpty()||message.toByteArray().size>32768||options==null||options.keys().asSequence().toSet()!=setOf("timeoutMs","initialize","payment")){reply(result("invalid request"));return null}
    val timeout=options.opt("timeoutMs");val initialize=options.opt("initialize");val payment=options.opt("payment")
    if((timeout !is Int&&timeout !is Long)||(timeout as Number).toLong() !in 1..120000||initialize !is Boolean||payment !in setOf("deny","prompt","allow")){reply(result("invalid request"));return null}
    val relays=runCatching {
      if(!server.has("relays"))network else server.getJSONArray("relays").let { list->require(list.length() in 1..4);(0 until list.length()).map { NativeSignerRelay.canonical(list.getString(it)) } }
    }.getOrNull()
    if(relays.isNullOrEmpty()||relays.toSet().size!=relays.size){reply(result("policy denied"));return null}
    // Opaque MCP bytes stay exact; private consent/control metadata must agree semantically.
    val method=runCatching { checkedMetadata(carrier,message) }.getOrNull() ?:run{reply(result("invalid request"));return null}
    val deadline=ingress+timeout.toLong();val remaining=deadline-SystemClock.elapsedRealtime()
    if(remaining<=0){reply(result("relay timeout"));return null}
    if(requests.size+responseCount()>=4){reply(result("policy denied"));return null}
    val originalRegistration=row.native ?:run{reply(result("session closed"));return null}
    val admitted=authority.admit(originalRegistration,provider,method,message,relays,remaining) ?:run{reply(result("policy denied"));return null}
    val token=handle();val scope=JSONObject(row.config.snapshot)
    val captured=JSONObject().put("token",token).put("scope",JSONObject().put("endpoint",row.config.sessionId).put("generation",generation)
      .put("sourceRevision",row.sourceRevision).put("identity",row.config.user).put("epoch",row.config.epoch).put("publisher",row.config.publisher).put("appId",row.config.appId).put("version",row.config.version).put("instance",scope.getString("instanceId")))
      .put("requestId",id).put("server",JSONObject().put("pubkey",provider).put("relays",JSONArray(relays))).put("message",message).put("options",JSONObject(options.toString())).put("operation",method).put("progressTokenJSON",carrier.get("progressTokenJSON"))
    val pending=Pending(row,originalRegistration,row.sourceRevision,admitted,captured,deadline,reply)
    requests[token]=pending
    val timer=Runnable { synchronized(this){ if(requests[token]?.let{SystemClock.elapsedRealtime()>=it.deadline}==true)remove(token,false,failure="relay timeout") } }
    pending.timer=timer;main.postDelayed(timer,remaining)
    return token
  }
  private fun checkedMetadata(carrier:JSONObject,message:String):String {
    val mcp=JSONObject(message)
    val operation=(mcp.opt("method") as? String) ?: "Send response"
    require(carrier.opt("operation")==operation)
    val expected=mcp.optJSONObject("params")?.optJSONObject("_meta")?.opt("progressToken")
    val raw=carrier.opt("progressTokenJSON")
    val actual=if(raw==JSONObject.NULL)null else {
      require(raw is String && raw.toByteArray().size<=1024)
      UploadWire.objectValue("{\"value\":$raw}",1050,maximumDepth=2).get("value")
    }
    fun safeNumber(value:Any?)=value is Number && value.toDouble().isFinite() &&
      value.toDouble()%1.0==0.0 && kotlin.math.abs(value.toDouble())<=9007199254740991.0
    require(when {
      expected==null||expected==JSONObject.NULL -> actual==null
      expected is String -> actual is String && expected==actual
      safeNumber(expected) -> safeNumber(actual) && (expected as Number).toDouble()==(actual as Number).toDouble()
      else -> false
    })
    return operation
  }
  @Synchronized fun take(token:String):String? {
    val row=requests[token] ?:return null
    if(row.taken||!authority.current(row.originalRegistration)||SystemClock.elapsedRealtime()>=row.deadline)return null
    row.taken=true
    return JSONObject(row.captured.toString()).put("remainingMs",row.deadline-SystemClock.elapsedRealtime()).toString()
  }
  @Synchronized fun approve(token:String):String? {
    val row=requests[token] ?:return null
    if(!row.taken||row.permit!=null||SystemClock.elapsedRealtime()>=row.deadline)return null
    val permit=authority.approve(row.native) ?:return null
    row.permit=permit
    NativeCvmSourceFacade.install(object:NativeCvmSourceFacade.Access {
      override fun token()=token
      override fun generation()=row.captured.getJSONObject("scope").getString("generation")
      override fun provider()=row.captured.getJSONObject("server").getString("pubkey")
      override fun message()=row.captured.getString("message")
      override fun relays():List<String> =permit.relays()
      override fun deadline()=minOf(row.deadline,permit.originalDeadline())
      override fun registration():Any=row.originalRegistration
      override fun initialize()=row.captured.getJSONObject("options").getBoolean("initialize")
      override fun current()=authority.current(permit)&&SystemClock.elapsedRealtime()<row.deadline
      override fun sourceCurrent()=permit.sourceCurrent()
      override fun consume(message:String,relay:String)=authority.consume(permit,provider(),message,relay)&&SystemClock.elapsedRealtime()<row.deadline
    })
    return token
  }
  @Synchronized fun reject(token:String){remove(token,false,failure="policy denied")}
  private fun remove(token:String,successful:Boolean,response:String?=null,failure:String="session closed") {
    val row=requests.remove(token) ?:return
    row.timer?.let(main::removeCallbacks)
    if(successful)NativeCvmSourceFacade.completed(token)
    else {
      cancelDeliveries(requestToken=token)
      row.permit?.let(authority::cancel);authority.cancel(row.native)
      NativeCvmSourceFacade.cancel(token)
    }
    if(successful){row.permit?.let(authority::cancel);authority.cancel(row.native)}
    val delivery=Delivery(row.registration,row.originalRegistration,row.sourceRevision,row.captured.getJSONObject("server").getString("pubkey"),token,row.deadline,true)
    check(responseCount()<4)
    deliveries.add(delivery)
    main.post { synchronized(this) {
      deliveries.remove(delivery)
      val result=response ?: JSONObject().put("type","cvm.request.result").put("id",row.captured.getString("requestId")).put("error",failure).toString()
      row.reply(if(deliveryCurrent(delivery))result else null)
    } }
  }
  @Synchronized fun finish(token:String,response:String?){
    val row=requests[token] ?:return
    val valid=response!=null&&response.toByteArray().size<=80*1024&&authority.current(row.originalRegistration)&&SystemClock.elapsedRealtime()<row.deadline
    remove(token,valid&&row.permit?.let(authority::current)==true,if(valid)response else null)
  }
  @Synchronized fun current(generation:String,sourceRevision:String):Boolean=registrations[generation]?.let { it.sourceRevision==sourceRevision&&nativeLive(it) }==true
  @Synchronized fun send(generation:String,sourceRevision:String,requestToken:String,response:String):Boolean {
    val row=registrations[generation] ?:return false
    if(!current(generation,sourceRevision)||response.toByteArray().size>80*1024||deliveries.count { !it.response }>=64)return false
    val carrier=runCatching { UploadWire.objectValue(response,80*1024,maximumDepth=2) }.getOrNull() ?:return false
    if(carrier.keys().asSequence().toSet()!=setOf("provider","message"))return false
    val provider=carrier.opt("provider") as? String ?:return false
    val message=carrier.opt("message") as? String ?:return false
    if(message.toByteArray().size>40*1024)return false
    val pending=requests[requestToken] ?:return false
    if(pending.registration!==row||pending.sourceRevision!=sourceRevision||pending.permit?.let(authority::current)!=true||
      pending.captured.getJSONObject("server").getString("pubkey")!=provider||SystemClock.elapsedRealtime()>=pending.deadline)return false
    val push=row.push ?:return false
    val delivery=Delivery(row,pending.originalRegistration,sourceRevision,provider,requestToken,pending.deadline,false)
    deliveries.add(delivery)
    main.post { synchronized(this) { deliveries.remove(delivery);if(deliveryCurrent(delivery))push(message) } };return true
  }
}
