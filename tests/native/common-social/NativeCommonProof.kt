package org.nostrocket.hypergolic.host

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicLong

private var checks=0
private fun checkThat(value:Boolean){check(value);checks++}
private fun denied(work:()->Unit){try{work();error("Expected native denial")}catch(expected:IllegalArgumentException){checks++}catch(expected:IllegalStateException){if(expected.message=="Expected native denial")throw expected;checks++}}
fun main(args:Array<String>){
  val cases=JSONArray(File(args[0]).readText())
  for(index in 0 until cases.length()){
    val item=cases.getJSONObject(index);val source=item.getString("snapshot");val raw=item.getString("plan")
    val plan=NativeCommonPlan.capture(source,raw);checkThat((plan.publication==null)==item.getBoolean("noop"))
    val changed=JSONObject(raw);changed.getJSONObject("request").put("id","foreign-request")
    denied{NativeCommonPlan.capture(source,changed.toString())}
    val old=JSONObject(source);old.getJSONObject("registration").remove("commonProfile");denied{NativeCommonPlan.capture(old.toString(),raw)}
    val missing=JSONObject(source);missing.getJSONObject("registration").put("domains",JSONArray(listOf("common","outbox")));denied{NativeCommonPlan.capture(missing.toString(),raw)}
    if(plan.publication!=null){
      val extra=JSONObject(raw);extra.getJSONObject("publication").put("ancillary",JSONObject());denied{NativeCommonPlan.capture(source,extra.toString())}
      val inbox=JSONObject(raw);inbox.getJSONObject("publication").put("requiredInboxes",JSONArray(listOf("wss://relay.damus.io/")));denied{NativeCommonPlan.capture(source,inbox.toString())}
      val value=JSONObject(raw).getJSONObject("publication").getJSONObject("event")
      val data=NativeApprovalSigningData.capture(source,value.toString(),plan);checkThat(data.eventId==value.getString("hash"))
      val template=JSONObject(data.unsigned());checkThat(template.getString("pubkey")==JSONObject(source).getJSONObject("registration").getString("user"))
      val tamper=JSONObject(raw);tamper.getJSONObject("publication").getJSONObject("event").getJSONObject("event").put("content","altered")
      denied{NativeCommonPlan.capture(source,tamper.toString())}
      val wrongTemplate=JSONObject(value.toString());wrongTemplate.getJSONObject("event").put("kind",1);denied{NativeApprovalSigningData.capture(source,wrongTemplate.toString(),plan)}
      val falseNoop=JSONObject(raw).put("publication",JSONObject.NULL);denied{NativeCommonPlan.capture(source,falseNoop.toString())}
    }else denied{NativeApprovalSigningData.capture(source,JSONObject().put("event",JSONObject()).toString(),plan)}
  }
  val fixture=cases.getJSONObject(0);val registration=JSONObject(fixture.getString("snapshot")).getJSONObject("registration")
  val config=JSONObject(registration.toString());config.remove("generation")
  checkThat(CapabilityConfiguration(config.toString(),"generation",true).allowsCommonSocial("common.follow"))
  config.remove("commonProfile");checkThat(!CapabilityConfiguration(config.toString(),"generation",true).allowsCommonSocial("common.follow"))
  config.put("commonProfile","unknown");denied{CapabilityConfiguration(config.toString(),"generation",true)}
  val clock=AtomicLong();val leases=ApprovalLeaseRegistry(clock::get);checkThat(leases.register("generation"));leases.foreground(true);leases.focus("generation",true)
  val token=leases.admit("generation",fixture.getString("snapshot"),true)!!;checkThat(leases.take(token)!=null)
  checkThat(!leases.mayReview(token));checkThat(!leases.approve(token))
  val prepared=NativeCommonPlan.capture(fixture.getString("snapshot"),fixture.getString("plan"));checkThat(leases.prepare(token,prepared));checkThat(!leases.prepare(token,prepared));checkThat(leases.mayReview(token));checkThat(leases.approve(token));checkThat(!leases.approve(token))
  leases.revoke("generation");checkThat(!leases.isApproved(token));checkThat(!leases.isLive(token))
  println("NativeCommonProof: $checks checks passed; no signer, socket or device effects")
}
