import Foundation
final class Clock: @unchecked Sendable {var now: UInt64 = 0}
final class Winners: @unchecked Sendable {
  private let lock=NSLock();private var value=0
  func add(){lock.lock();value += 1;lock.unlock()}
  var count:Int{lock.lock();defer{lock.unlock()};return value}
}
@main enum Proof {
  static func main() throws {
    var count=0
    func check(_ value: Bool) {precondition(value, "Link core case \(count)");count += 1}
    let lines=try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8).split(separator: "\n", omittingEmptySubsequences: true)
    for line in lines {let row=line.split(separator:"\t",omittingEmptySubsequences:false);let raw=String(decoding:Data(base64Encoded:String(row[0]))!,as:UTF8.self);check(LinkUrl.error(raw)==(row[1]=="ok" ? nil:String(row[1])))}
    check(LinkUrl.displayIdentity("signed-resource-link-lab") == "signed-resource-link-lab")
    check(LinkUrl.displayIdentity("消息 🚀") == "消息 🚀")
    check(LinkUrl.displayIdentity("app\nPublisher: fake\u{202E}\u{2028}\u{2066}") == "app\\u000APublisher: fake\\u202E\\u2028\\u2066")
    let clock=Clock(), r=LinkLeaseRegistry(clock:{clock.now})
    check(r.synchronizeOwner("owner",epoch:0,available:true) != nil);check(r.register("one",user:"owner",epoch:0));check(r.admit("one")==nil);_ = r.setForeground(true);check(r.admit("one")==nil);_ = r.focus("one",true)
    var token=r.admit("one")!;check(r.admit("one")==nil);check(r.claim(token));check(!r.claim(token));check(r.setForeground(false).isEmpty);check(r.finish(token));check(!r.finish(token));check(r.admit("one")==nil)
    _ = r.setForeground(true);token=r.admit("one")!;check(r.focus("one",false).contains(token));check(!r.claim(token));check(!r.finish(token));_ = r.focus("one",true)
    token=r.admit("one")!;check(r.claim(token));check(r.revoke("one").contains(token));check(!r.finish(token));check(r.admit("one")==nil)
    check(r.register("two",user:"owner",epoch:0));_ = r.focus("two",true);token=r.admit("two")!;clock.now=25_000;check(!r.claim(token));check(r.expire().contains(token));check(!r.finish(token));check(r.canDeliver("two"))
    clock.now=60_000;for _ in 0..<3 {token=r.admit("two")!;check(r.finish(token))};check(r.admit("two")==nil);clock.now=120_000;token=r.admit("two")!;check(r.setForeground(false).contains(token));check(!r.finish(token))
    _ = r.setForeground(true); clock.now=180_000;token=r.admit("two")!;check(r.claim(token))
    check(r.synchronizeOwner("owner",epoch:0,available:false)!.contains(token));check(!r.canDeliver("two"));check(!r.finish(token))
    check(r.synchronizeOwner("owner",epoch:0,available:true) != nil);check(r.canDeliver("two"));token=r.admit("two")!
    check(r.synchronizeOwner("other",epoch:1,available:true)!.contains(token));check(!r.canDeliver("two"));check(!r.claim(token));check(!r.finish(token))
    check(r.synchronizeOwner("owner",epoch:0,available:true) == nil);check(r.synchronizeOwner("owner",epoch:1,available:true) == nil)
    check(r.register("new",user:"other",epoch:1));_ = r.focus("new",true);check(!r.register("new",user:"owner",epoch:0));token=r.admit("new")!
    let raceToken=token, winners=Winners();DispatchQueue.concurrentPerform(iterations:20) {_ in if r.claim(raceToken) {winners.add()}}
    check(winners.count == 1);check(r.finish(token))
    let bounded=LinkLeaseRegistry(clock:{clock.now});_ = bounded.synchronizeOwner("owner",epoch:0,available:true);_ = bounded.setForeground(true)
    for n in 0..<64 {check(bounded.register("s\(n)",user:"owner",epoch:0))};check(!bounded.register("overflow",user:"owner",epoch:0))
    for n in 0..<12 {let g="s\(n)";_ = bounded.focus(g,true);let t=bounded.admit(g)!;check(bounded.finish(t))}
    _ = bounded.focus("s12",true);check(bounded.admit("s12") == nil);clock.now += 60_000;token=bounded.admit("s12")!;check(bounded.finish(token))
    print("PASS iOS owning link core \(count)")
  }
}
