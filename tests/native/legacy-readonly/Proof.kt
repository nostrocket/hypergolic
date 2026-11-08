package org.nostrocket.hypergolic.host
import org.json.JSONObject
import java.io.File
internal object Proof {
 @JvmStatic fun main(args: Array<String>) {
  val input = JSONObject(File(args[0]).readText()); var count=0
  val configs=input.getJSONArray("configs")
  for(i in 0 until configs.length()) { val c=configs.getJSONObject(i); val config=runCatching {CapabilityConfiguration(c.getJSONObject("value").toString(),"generation",true)}.getOrNull();check((config!=null)==c.getBoolean("ok")){c.getString("name")}; count++ }
  val config=CapabilityConfiguration(input.getJSONObject("base").toString(),"generation",true)
  check(!config.allowsRelayOperation("relay.publish") && !config.allowsRelayOperation("relay.subscribe") && config.grantedDomains.isEmpty()); count++
  val context=config.legacyReadOnly!!; check(context.matches(context.eventId,context.htmlHash));check(!context.matches("0".repeat(64),context.htmlHash));check(!context.matches(context.eventId,"0".repeat(64)));count+=3
  val rows=input.getJSONArray("requests")
  for(i in 0 until rows.length()){val row=rows.getJSONObject(i);val value=row.getJSONObject("value");check(context.allowsSubscribe(value)==row.getBoolean("subscribe")){row.getString("name")};check(context.allowsClose(value)==row.getBoolean("close")){row.getString("name")};count+=2}
  val wires=input.getJSONArray("wires");val snapshot=config.request(input.getJSONObject("request").toString())
  for(i in 0 until wires.length()){val row=wires.getJSONObject(i);check(LegacyReadOnlyContext.permitsWire(snapshot,row.getString("url"),row.getString("wire"),"native-sub")==row.getBoolean("ok")){row.getString("name")};count++}
  check(!LegacyReadOnlyContext.permitsWire(null,"wss://relay.damus.io","[]","native-sub"));count++
  var clock=0L;var active=true;val registry=RelaySubscriptionRegistry({clock},{active});registry.setForeground(true)
  val token=registry.admit("generation",snapshot)!!;check(registry.take(token)==snapshot);check(registry.accept(token));check(registry.capturedSnapshot(token)==snapshot);count+=3
  registry.setForeground(false);check(!registry.mayDeliver(token));check(registry.admit("generation",snapshot)==null);count+=2
  registry.setForeground(true);val second=registry.admit("generation",snapshot)!!;val third=registry.admit("generation",snapshot)!!;check(registry.admit("generation",snapshot)==null);count++
  clock=25000;check(registry.take(second)==null && registry.take(third)==null);count++
  active=false;check(!registry.isActive(token) && registry.capturedSnapshot(token)==null);count++
  val history=LegacyReadOnlyContext.HistoryBudget();repeat(32){check(history.receive("[\"EVENT\",\"sub\",{}]"))};check(!history.receive("[\"EVENT\",\"sub\",{}]"));count+=33
  val live=LegacyReadOnlyContext.HistoryBudget();check(live.receive("[\"EOSE\",\"sub\"]"));repeat(40){check(live.receive("[\"EVENT\",\"sub\",{}]"))};count+=41
  println("Android legacy read-only: $count checks passed")
 }
}
