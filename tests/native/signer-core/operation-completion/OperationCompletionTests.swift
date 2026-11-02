import Foundation
@main struct Tests {
 @MainActor static func main()async {
  var count=0,failures:[String]=[]
  func check(_ value:Bool,_ name:String){count+=1;if !value{failures.append(name)}}
  func drain()async{for _ in 0..<10{await Task.yield()}}
  // A cancellation does not join a real task. Its later error cannot finish replacement work.
  for signing in [false,true] {
   let s=Session(),oldID=UUID(),nextID=UUID(),latch=Latch(),replacementLatch=Latch()
   let oldReply=Task<String?,any Error> {if signing{return try await s.signReplyOnly(operation:oldID)};return try await s.remoteReplyOnly(operation:oldID)}
   while signing ? s.signReply==nil : s.remoteReply==nil {await Task.yield()}
   let old=Task {await latch.wait();if signing{s.finishSign(.failure(NativeVaultFailure.oldFailure),operation:oldID)}else{s.finishRemote(.failure(NativeVaultFailure.oldFailure),operation:oldID)}}
   if signing{s.signTask=old}else{s.remoteTask=old};while latch.waiter==nil{await Task.yield()}
   if signing{s.cancelSign(operation:oldID)}else{s.cancelRemote(operation:oldID)}
   do{let result=try await oldReply.value;check(!signing && result==nil,"current remote cancellation completes nil")}catch{check(signing,"current signing cancellation throws")}
   check(old.isCancelled,"old native task cancellation recorded")
   let next=Task<String?,any Error> {if signing{return try await s.signReplyOnly(operation:nextID)};return try await s.remoteReplyOnly(operation:nextID)}
   while signing ? s.signReply==nil : s.remoteReply==nil {await Task.yield()}
   let replacement=Task {await replacementLatch.wait()};if signing{s.signTask=replacement}else{s.remoteTask=replacement};while replacementLatch.waiter==nil{await Task.yield()}
   let timer=s.timer!,revocations=s.authority.revocations
   let remotePanel=s.remotePanel,signPanel=s.signPanel,source=s.signSource,state=s.signDispatchState
   latch.release();await old.value
   check(signing ? s.signReply != nil : s.remoteReply != nil,"old failure preserves replacement continuation")
   check(!timer.isCancelled && s.timer != nil,"old failure preserves replacement timer")
   check(signing ? s.signTask == replacement : s.remoteTask == replacement,"old failure preserves exact replacement task slot")
   check(!replacement.isCancelled,"old failure does not cancel replacement task")
   check(s.authority.revocations==revocations,"old failure leaves replacement authority unchanged")
   check(signing ? signPanel?.dismissals==0 : remotePanel?.clears==0,"old failure leaves replacement panel unchanged")
   if signing{check(source?.cancels==0 && s.signDispatchState===state,"old failure leaves replacement source/dispatch state unchanged");s.finishSign(.success("current"),operation:nextID)}else{s.finishRemote(.success("current"),operation:nextID)}
   do{check(try await next.value=="current","current replacement success delivered")}catch{check(false,"replacement must not receive old error")}
   replacementLatch.release();await replacement.value
  }
  // A delayed stale timer and stale native panel rejection cannot cancel current work.
  for signing in [false,true] {
   let s=Session(),old=UUID(),current=UUID();let reply=Task<String?,any Error>{if signing{return try await s.signReplyOnly(operation:current)};return try await s.remoteReplyOnly(operation:current)}
   while signing ? s.signReply==nil : s.remoteReply==nil{await Task.yield()}
   let timer=s.timer!,revocations=s.authority.revocations
   if signing{s.cancelSign(operation:old);s.decideNo(operation:old,source:NativeSigningSourceCapture())}else{s.cancelRemote(operation:old,failure:.signerExpired);s.startRemote(nil,operation:old)}
   check(signing ? s.signReply != nil : s.remoteReply != nil,"stale timer/panel preserves current reply")
   check(!timer.isCancelled && s.authority.revocations==revocations,"stale timer/panel leaves timer and authority unchanged")
   if signing{s.finishSign(.success("current"),operation:current)}else{s.finishRemote(.success("current"),operation:current)}
   do{check(try await reply.value=="current","current success survives stale panel/timer")}catch{check(false,"current reply failed after stale panel/timer")}
  }
  // A dismissal callback retained from the cancelled panel cannot occupy a new task slot.
  let dismissed=Session(),dismissReply=Task{try await dismissed.prepareRemote(vaultID:"public-vault",revision:1,attemptID:"same-caller-id")}
  while dismissed.remoteReply==nil{await Task.yield()};let dismissalID=dismissed.remoteOperation ?? UUID();dismissed.remoteOperation=dismissalID
  let previousPanel=dismissed.remotePanel!;previousPanel.delayDismiss=true;dismissed.startRemote(NativeBunkerConnection(),operation:dismissalID)
  check(previousPanel.dismissal != nil,"actual dismissal callback retained")
  dismissed.cancelRemote(operation:dismissalID);_=try? await dismissReply.value
  let afterDismissID=UUID(),afterDismiss=Task{try await dismissed.remoteReplyOnly(operation:afterDismissID)};while dismissed.remoteReply==nil{await Task.yield()}
  let replacementLatch=Latch(),replacement=Task{await replacementLatch.wait()};dismissed.remoteTask=replacement;while replacementLatch.waiter==nil{await Task.yield()};let dismissalTimer=dismissed.timer!
  previousPanel.dismissal?();await drain()
  check(dismissed.remoteTask==replacement,"stale dismissal cannot replace current task slot")
  check(dismissed.remoteCandidates.preparations==0 && dismissed.remoteReply != nil && !dismissalTimer.isCancelled,"stale dismissal leaves candidate/reply/timer untouched")
  dismissed.finishRemote(.success("current"),operation:afterDismissID);do{check(try await afterDismiss.value=="current","replacement survives stale dismissal")}catch{check(false,"stale dismissal finished replacement")}
  replacementLatch.release();await replacement.value
  // An old successful callback is also discarded; it cannot return data to a replacement.
  for signing in [false,true]{
   let session=Session(),current=UUID(),old=UUID();let reply=Task<String?,any Error>{if signing{return try await session.signReplyOnly(operation:current)};return try await session.remoteReplyOnly(operation:current)}
   while signing ? session.signReply==nil : session.remoteReply==nil{await Task.yield()};let timer=session.timer!
   if signing{session.finishSign(.success("stale"),operation:old)}else{session.finishRemote(.success("stale"),operation:old)}
   check(signing ? session.signReply != nil : session.remoteReply != nil,"stale success cannot take replacement continuation")
   check(!timer.isCancelled,"stale success preserves replacement timer")
   if signing{session.finishSign(.success("current"),operation:current)}else{session.finishRemote(.success("current"),operation:current)}
   do{check(try await reply.value=="current","only current success reaches replacement")}catch{check(false,"current success lost")}
  }
  // Current timeout must still cancel its owned pending preparation and clear only its panel.
  let timed=Session(),timedID=UUID();let timedReply=Task{try await timed.remoteReplyOnly(operation:timedID)};while timed.remoteReply==nil{await Task.yield()}
  let timedTimer=timed.timer!,timedPanel=timed.remotePanel!;timed.cancelRemote(operation:timedID,failure:.signerExpired)
  do{_=try await timedReply.value;check(false,"current timeout must throw")}catch NativeVaultFailure.signerExpired{check(true,"current timeout retained")}catch{check(false,"wrong timeout error")}
  check(timedTimer.isCancelled && timedPanel.clears==1 && timed.remoteReply==nil,"current timeout clears owned state")
  // Actual finishSigning captures the old reply, then rechecks ownership/foreground
  // only when UIKit's deferred dismissal invokes delivery. Dispatch is an explicit port.
  for possibleSend in [false,true] {
   for loss in ["none","owner","foreground"] {
    UIApplication.shared.applicationState = .active
    let session=Session(),oldID=UUID(),nextID=UUID(),authority=session.authority
    var oldDelivered=false,nextDelivered=false
    let old=Task {defer{oldDelivered=true};return try await session.signReplyOnly(operation:oldID)}
    while session.signReply==nil{await Task.yield()}
    let oldPanel=session.signPanel!,oldTimer=session.timer!
    oldPanel.delayDismiss=true;session.signDispatchState!.possible=possibleSend
    session.finishSign(.success("old-public-result"),operation:oldID,checker:{authority.current(1)})
    await drain()
    let label="deferred delivery possibleSend=\(possibleSend),loss=\(loss)"
    check(oldPanel.dismissal != nil && !oldDelivered,label+": success waits for dismissal")
    check(session.signReply==nil && session.signOperation==nil && oldTimer.isCancelled,label+": completed operation releases its own slots")
    let next=Task {defer{nextDelivered=true};return try await session.signReplyOnly(operation:nextID)}
    while session.signReply==nil{await Task.yield()}
    let nextPanel=session.signPanel!,nextSource=session.signSource!,nextState=session.signDispatchState!,nextTimer=session.timer!
    let workLatch=Latch(),work=Task{await workLatch.wait()};session.signTask=work
    while workLatch.waiter==nil{await Task.yield()}
    let revocations=authority.revocations
    if loss=="owner"{authority.retireOwner()}
    if loss=="foreground"{UIApplication.shared.applicationState = .background}
    oldPanel.dismissal?()
    do{let value=try await old.value;check(loss=="none" && value=="old-public-result",label+": only unchanged authority returns success")}
    catch NativeVaultFailure.signerUncertain{check(loss != "none" && possibleSend,label+": post-send loss is uncertain")}
    catch NativeVaultFailure.denied{check(loss != "none" && !possibleSend,label+": pre-send or local loss is denied")}
    catch{check(false,label+": unexpected failure")}
    check(oldDelivered && !nextDelivered && session.signReply != nil && session.signOperation==nextID,label+": old callback leaves replacement continuation pending")
    check(session.signTask==work && !work.isCancelled && !nextTimer.isCancelled,label+": replacement task and timer survive")
    check(session.signPanel===nextPanel && session.signSource===nextSource && session.signDispatchState===nextState,label+": replacement panel/source/dispatch survive")
    check(nextSource.cancels==0 && authority.revocations==revocations,label+": old delivery does not revoke replacement")
    UIApplication.shared.applicationState = .active
    session.finishSign(.success("replacement-public-result"),operation:nextID)
    do{check(try await next.value=="replacement-public-result",label+": replacement still completes independently")}
    catch{check(false,label+": replacement lost its result")}
    workLatch.release();await work.value
   }
  }
  // Caller kind/token targeted cancellation and possible-dispatch uncertainty remain unchanged.
  let uncertain=Session(),uncertainID=UUID();let uncertainReply=Task{try await uncertain.signReplyOnly(operation:uncertainID)};while uncertain.signReply==nil{await Task.yield()}
  uncertain.signDispatchState!.possible=true;let source=uncertain.signSource!;let beforeFacade=NativeSigningSourceFacade.cancels
  uncertain.cancelSigning(kind:"approval",token:"foreign-token")
  check(uncertain.signReply != nil && source.cancels==0 && NativeSigningSourceFacade.cancels==beforeFacade+1,"foreign targeted cancel does not cancel current signing")
  uncertain.cancelSigning(kind:"approval",token:"native-public-token")
  do{_=try await uncertainReply.value;check(false,"dispatched cancel must fail")}catch NativeVaultFailure.signerUncertain{check(true,"possible dispatch remains uncertain")}catch{check(false,"dispatch uncertainty changed")}
  // A cancelled handshake suspended in methodInfo must not install a candidate or finish new work.
  let info=Session(),infoLatch=Latch();info.methodLatch=infoLatch
  let first=Task{try await info.prepareRemote(vaultID:"public-vault",revision:1,attemptID:"same-caller-id")};while info.remoteReply==nil{await Task.yield()}
  let infoID=info.remoteOperation ?? UUID();info.remoteOperation=infoID;info.startRemote(NativeBunkerConnection(),operation:infoID);while infoLatch.waiter==nil{await Task.yield()};let task=info.remoteTask!
  info.cancelRemote(operation:infoID);_=try? await first.value
  let nextID=UUID(),next=Task{try await info.remoteReplyOnly(operation:nextID)};while info.remoteReply==nil{await Task.yield()};let timer=info.timer!
  infoLatch.release();await task.value
  check(info.remoteCandidates.preparations==0,"post-methodInfo stale handshake cannot create candidate")
  check(info.remoteReply != nil && !timer.isCancelled,"post-methodInfo stale handshake preserves replacement")
  info.finishRemote(.success("current"),operation:nextID);do{check(try await next.value=="current","replacement survives stale handshake")}catch{check(false,"stale handshake stole replacement")}
  // Refresh suspended in its final confirmation must likewise leave replacement untouched.
  let refresh=Session(),confirm=Latch();refresh.confirmationLatch=confirm;TransportPort.refreshResult=nil
  let refreshing=Task{try await refresh.prepareRemoteRefresh(pubkey:"public-account",vaultID:"public-vault",revision:1,attemptID:"same-caller-id")};while confirm.waiter==nil{await Task.yield()}
  let refreshID=refresh.remoteOperation ?? UUID();refresh.remoteOperation=refreshID;let refreshingTask=refresh.remoteTask!;refresh.cancelRemote(operation:refreshID);_=try? await refreshing.value
  let replacementID=UUID(),fresh=Task{try await refresh.remoteReplyOnly(operation:replacementID)};while refresh.remoteReply==nil{await Task.yield()};let refreshTimer=refresh.timer!
  confirm.release();await refreshingTask.value
  check(refresh.remoteReply != nil && !refreshTimer.isCancelled,"post-confirmation stale refresh preserves replacement")
  check(refresh.remoteCandidates.preparations==0,"stale refresh creates no candidate")
  refresh.finishRemote(.success("current"),operation:replacementID);do{check(try await fresh.value=="current","replacement survives stale refresh")}catch{check(false,"stale refresh stole replacement")}
  // Host task-install port sets cancellation before the queued task gets its first turn.
  // This checks the actual entry guard, not native OS cancellation scheduling.
  TransportPort.refreshResult=["wss://changed.example.org"]
  let queuedRefresh=Session();var queuedRemote:Task<Void,Never>?
  queuedRefresh.onRemoteInstall={task in queuedRemote=task;task.cancel()}
  let queuedReply=Task{try await queuedRefresh.prepareRemoteRefresh(pubkey:"public-account",vaultID:"public-vault",revision:1,attemptID:"same-caller-id")}
  while queuedRemote==nil{await Task.yield()};await queuedRemote!.value
  check(queuedRefresh.handoffsMade==0,"already-cancelled queued refresh cannot install a handoff")
  queuedRefresh.cancelRemote();_=try? await queuedReply.value
  let queuedSign=Session(),queuedSignID=UUID();var queuedSigning:Task<Void,Never>?
  let queuedSignReply=Task{try await queuedSign.signReplyOnly(operation:queuedSignID)};while queuedSign.signReply==nil{await Task.yield()}
  queuedSign.onSignInstall={task in queuedSigning=task;task.cancel()};queuedSign.decideYes(operation:queuedSignID,source:queuedSign.signSource!)
  await queuedSigning!.value
  check(queuedSign.core.signCalls==0,"already-cancelled queued signing cannot enter core")
  queuedSign.cancelSign(operation:queuedSignID);_=try? await queuedSignReply.value
  TransportPort.refreshResult=["wss://changed.example.org"];await drain()
  let result:[String:Any]=["passed":failures.isEmpty,"assertions":count,"failures":failures,"scope":"Actual owning methods with real Tasks/continuations and explicit UI/core/network/key/authority ports. No relay/device/crypto or authority-bypass proof."]
  print(String(decoding:try! JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]),as:UTF8.self));if !failures.isEmpty{exit(1)}
 }
}
