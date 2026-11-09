package org.nostrocket.hypergolic.host

import org.json.JSONArray
import org.json.JSONObject

/** Exact original intent and derived template are captured before native review. App Schnorr verification remains required. */
internal class NativeCommonPlan private constructor(val publication: NativeOutboxPlan?, val template: JSONObject?) {
  fun matches(event: JSONObject,user: String,relays: List<String>,hash: String): Boolean =
    publication?.matchesSigning(event,user,relays,hash) == true
  companion object {
    val operations = setOf("common.follow", "common.unfollow", "common.react", "common.report")
    fun granted(registration: JSONObject): Boolean {
      val domains = strings(registration.getJSONArray("domains"))
      return registration.optString("fixture") == "published" && registration.optString("commonProfile") == "social-v1" &&
        domains.containsAll(listOf("common", "identity")) && domains.any { it == "relay" || it == "outbox" }
    }
    fun capture(snapshot: String,raw: String): NativeCommonPlan {
      require(UploadJsonBounds.accepts(raw,NativeApprovalAuthority.MAX_BYTES))
      val envelope=JSONObject(snapshot);val registration=envelope.getJSONObject("registration");require(granted(registration))
      val request=JSONObject(envelope.getString("request"));val plan=JSONObject(raw)
      require(plan.keys().asSequence().toSet()==setOf("request","route","basis","target","publication"))
      require(canonical(request)==canonical(plan.getJSONObject("request")))
      require(plan.getString("route")==if("outbox" in strings(registration.getJSONArray("domains")))"outbox" else "relay")
      val user=registration.getString("user");val type=request.getString("type");require(type in operations)
      val basis=if(plan.isNull("basis"))null else plan.getJSONObject("basis")
      val target=if(plan.isNull("target"))null else plan.getJSONObject("target")
      if(basis!=null){signed(basis);require(basis.getInt("kind")==3&&basis.getString("pubkey")==user)}
      if(target!=null)signed(target)
      val payload=if(plan.isNull("publication"))null else plan.getJSONObject("publication")
      if(payload!=null)require(payload.isNull("ancillary")&&payload.getJSONArray("requiredInboxes").length()==0)
      val event=payload?.getJSONObject("event")?.getJSONObject("event")
      val expected=derive(request,basis,target,event?.getLong("created_at")?:0)
      require((event==null)==(expected==null))
      if(expected==null)return NativeCommonPlan(null,null)
      require(NativeOutboxPlan.signingTemplate(event!!)==NativeOutboxPlan.signingTemplate(expected))
      return NativeCommonPlan(NativeOutboxPlan.captureCommon(snapshot,payload!!.toString(),expected),expected)
    }
    private fun derive(request: JSONObject,basis: JSONObject?,target: JSONObject?,created: Long): JSONObject? {
      val type=request.getString("type");val tags=mutableListOf<List<String>>();var content="";val kind:Int
      if(type=="common.follow"||type=="common.unfollow"){
        require(request.keys().asSequence().toSet()==setOf("type","id","pubkeys"))
        require(target==null)
        val raw=strings(request.getJSONArray("pubkeys"));require(raw.size in 1..16)
        val keys=raw.map { NativeCommonNpub.decode(it) }.distinct();val before=basis?.getJSONArray("tags")?:JSONArray()
        for(i in 0 until before.length()){
          val row=strings(before.getJSONArray(i));if(!(type=="common.unfollow"&&row.firstOrNull()=="p"&&row.getOrNull(1) in keys))tags.add(row)
        }
        if(type=="common.follow")for(key in keys)if(tags.none { it.firstOrNull()=="p"&&it.getOrNull(1)==key })tags.add(listOf("p",key))
        if(canonical(before)==canonical(JSONArray(tags)))return null
        content=basis?.getString("content")?:"";kind=3
        require(basis==null||created>basis.getLong("created_at"))
      }else if(type=="common.react"){
        require(request.keys().asSequence().toSet() in listOf(setOf("type","id","targetEventId","reaction"),setOf("type","id","targetEventId","reaction","customEmojiHref")))
        require(target!=null&&request.getString("targetEventId")==target.getString("id")&&basis==null)
        content=request.getString("reaction");require(content.toByteArray(Charsets.UTF_8).size in 1..256)
        tags.add(listOf("e",target.getString("id")));tags.add(listOf("p",target.getString("pubkey")))
        if(target.getInt("kind") in 30000..39999){
          val source=target.getJSONArray("tags");var d=""
          for(i in 0 until source.length()){val row=strings(source.getJSONArray(i));if(row.firstOrNull()=="d"){d=row.getOrNull(1)?:"";break}}
          tags.add(listOf("a","${target.getInt("kind")}:${target.getString("pubkey")}:$d"))
        }
        val code=Regex("^:([A-Za-z0-9_-]{1,64}):$").matchEntire(content)
        if(code!=null){val href=request.getString("customEmojiHref");val uri=java.net.URI(href);require(uri.scheme=="https"&&uri.host!=null&&uri.rawUserInfo==null&&href.toByteArray().size<=2048);tags.add(listOf("emoji",code.groupValues[1],href))}
        else require(!request.has("customEmojiHref"))
        kind=7
      }else{
        require(request.keys().asSequence().toSet()==setOf("type","id","target","reason","text")&&basis==null)
        val reason=request.getString("reason");require(reason in listOf("nudity","malware","profanity","illegal","spam","impersonation","other"))
        content=request.getString("text");require(content.toByteArray(Charsets.UTF_8).size<=4096)
        val value=request.getJSONObject("target")
        val required=if(value.optString("type")=="pubkey")setOf("type","pubkey") else setOf("type","id")
        val allowed=required+if(value.optString("type")=="pubkey")setOf("relay") else setOf("pubkey","relay")
        val fields=value.keys().asSequence().toSet();require(fields.containsAll(required)&&allowed.containsAll(fields))
        if(value.has("relay"))require((value.get("relay") as? String)?.toByteArray(Charsets.UTF_8)?.size?.let { it<=2048 }==true)
        if(value.getString("type")=="pubkey"){require(target==null);tags.add(listOf("p",NativeCommonNpub.publicKey(value.getString("pubkey")),reason))}
        else{require(value.getString("type")=="event"&&target!=null&&value.getString("id")==target.getString("id"));require(!value.has("pubkey")||NativeCommonNpub.publicKey(value.getString("pubkey"))==target.getString("pubkey"));tags.add(listOf("e",target.getString("id"),reason));tags.add(listOf("p",target.getString("pubkey")))}
        require(value.keys().asSequence().toSet().all { it in setOf("type","id","pubkey","relay") });kind=1984
      }
      return JSONObject().put("kind",kind).put("created_at",created).put("tags",JSONArray(tags)).put("content",content)
    }
    private fun signed(event:JSONObject){
      require(event.keys().asSequence().toSet()==setOf("kind","created_at","tags","content","id","pubkey","sig"))
      require(event.getString("pubkey").matches(Regex("[0-9a-f]{64}"))&&event.getString("sig").matches(Regex("[0-9a-f]{128}")))
      require(event.getString("id")==NativeOutboxPlan.signingHash(event,event.getString("pubkey")))
    }
    private fun strings(value:JSONArray):List<String> =(0 until value.length()).map { value.get(it) as? String?:error("Invalid string") }
    private fun canonical(value:Any?):String=when(value){
      is JSONObject->value.keys().asSequence().toList().sorted().joinToString(",","{","}"){JSONObject.quote(it)+":"+canonical(value.get(it))}
      is JSONArray->(0 until value.length()).joinToString(",","[","]"){canonical(value.get(it))}
      is String->JSONObject.quote(value)
      null,JSONObject.NULL->"null"
      else->value.toString()
    }
  }
}
