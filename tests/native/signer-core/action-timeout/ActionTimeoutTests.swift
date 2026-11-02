import Foundation
@main struct Tests {
 @MainActor static func main()async {
  var assertions=0,failures:[String]=[]
  func check(_ condition:Bool,_ name:String){assertions+=1;if !condition{failures.append(name)}}
  // No pending import owns the live authentication timer, including a stale key callback.
  let stale=Session();stale.authentication=(.backup,1);let timer=stale.installTimer(),key=NativeVaultKey()
  stale.lateImport(key)
  check(stale.timer != nil && !timer.isCancelled,"stale import callback must not cancel auth timer")
  check(key.destroyCount==1,"stale imported key destroyed")
  stale.lateImport(nil)
  check(stale.timer != nil && !timer.isCancelled,"nil callback must not cancel unrelated timer")
  // OS auth may make the app inactive; auth remains pending while import/sign inputs cancel.
  for action in [NativeSignerIdentityActions.Action.backup,.deletion] {
   let session=Session();session.authentication=(action,2);let owned=session.installTimer()
   session.inactive();session.inactive()
   check(session.timer != nil && !owned.isCancelled,"auth timer survives repeated expected inactive notifications")
   check(session.authentication?.1==2,"same auth attempt remains owned")
   check(session.authority.revocations==0 && session.authority.foreground,"inactive auth does not background-revoke")
   check(session.signCancels==2 && session.candidates.cancellations==2,"inactive auth still cancels other input/signing")
   session.cancelAll();check(owned.isCancelled && session.timer==nil,"explicit cancelAll cancels preserved timer")
   check(session.authentication==nil && session.authority.revocations==1,"explicit cancellation revokes auth")
  }
  // A genuine pending import still clears its own timer and completes cancellation exactly once.
  let importing=Session();let importTimer=importing.installTimer()
  var cancelledInput=false
  do {cancelledInput=try await importing.pendingInputCancel()==nil} catch {check(false,"pending import must not throw")}
  check(cancelledInput && importing.importReply==nil,"pending import returns cancellation")
  check(importTimer.isCancelled && importing.timer==nil && importing.importPanel==nil,"pending import owns timer cleanup")
  importing.cancelInput();check(importing.importReply==nil,"repeated import cancellation has no reply")
  // Real background must revoke auth, candidates, panel, browser and deadline, not preserve it.
  let bg=Session();bg.authentication=(.backup,3);let bgTimer=bg.installTimer();bg.safari=CancelPort();let browser=bg.safari!
  let confirms=Task<Void,Never>{try? await Task.sleep(for:.seconds(30))};bg.confirmationTimer=confirms;bg.confirmation=Confirmation();let panel=bg.confirmation!
  let before=NativeSignerIdentityActions.cancels;bg.enterBackground()
  check(!bg.authority.foreground && !bg.authority.protectedData && bg.authority.revocations==1,"background authority revoked")
  check(bgTimer.isCancelled && confirms.isCancelled && bg.timer==nil && bg.confirmationTimer==nil,"background all timers cancelled")
  check(bg.authentication==nil && NativeSignerIdentityActions.cancels==before+1,"background native auth cancelled")
  check(bg.candidates.cancellations>=1 && bg.remoteCandidates.cancellations==1 && bg.handoffs.cancellations==1,"background candidates/handoffs revoked")
  check(browser.cancellations==1 && bg.safari==nil && panel.dismissals==1,"background browser/confirmation dismissed")
  let noAuth=Session();let idleTimer=noAuth.installTimer();noAuth.inactive()
  check(noAuth.authority.revocations==1 && idleTimer.isCancelled,"inactive without auth still backgrounds")
  stale.cancelAll()
  // New deadline tests advance only the explicit host clock; real cancellation timers stay queued.
  func pending(_ id:UInt64)async->Bool{for _ in 0..<1000{if NativeSignerIdentityActions.pending[id] != nil{return true};await Task.yield()};return false}
  func effectPending(_ session:Session)async->Bool{for _ in 0..<1000{if session.core.effectReply != nil{return true};await Task.yield()};return false}
  func authTask(_ session:Session)->Task<Bool,Never>{Task{@MainActor in do{_ = try await session.requestAuth();return true}catch{return false}}}
  let deadline:Int64=60_000_000_000
  for (time,accepted) in [(deadline-1,true),(deadline,false),(deadline+1,false)] {
   ContinuousClock.set(0);NativeSignerIdentityActions.reset();let session=Session(),task=authTask(session)
   guard await pending(1)else{fatalError("Auth did not suspend")}
   ContinuousClock.set(time);NativeSignerIdentityActions.resolve(1)
   check(await task.value==accepted,"auth callback strict absolute boundary")
   session.cancelAll()
  }
  for failure in ["epoch","attempt","cancel"] {
   ContinuousClock.set(0);NativeSignerIdentityActions.reset();let session=Session(),task=authTask(session)
   guard await pending(1)else{fatalError("Auth did not suspend")}
   var replacementTimer:Task<Void,Never>?
   if failure=="epoch"{session.authority.invalidateActions()}
   if failure=="attempt"{session.timer?.cancel();session.authentication=(.backup,999);replacementTimer=session.installTimer()}
   if failure=="cancel"{task.cancel()}
   NativeSignerIdentityActions.resolve(1);check(await task.value==false,"epoch/attempt/task cancellation rejects auth")
   if let replacementTimer{check(session.authentication?.1==999 && !replacementTimer.isCancelled,"old auth rejection preserves replacement attempt/timer")}
   session.cancelAll()
  }
  // Delayed old error/success cannot tear down a new native auth attempt.
  for accepted in [false,true] {
   ContinuousClock.set(0);NativeSignerIdentityActions.reset();NativeSignerIdentityActions.ignoreCancellation=true
   let session=Session(),old=authTask(session);guard await pending(1)else{fatalError("Old auth missing")}
   session.cancelAll();let replacement=authTask(session);guard await pending(2)else{fatalError("Replacement auth missing")}
   let timer=session.timer!;NativeSignerIdentityActions.resolve(1,accepted:accepted)
   check(await old.value==false,"old auth result remains rejected")
   check(session.authentication?.1==2 && !timer.isCancelled,"old auth cleanup preserves new owner")
   NativeSignerIdentityActions.resolve(2);check(await replacement.value,"replacement auth succeeds")
   session.cancelAll()
  }
  ContinuousClock.set(deadline)
  let timeout=Session();timeout.authentication=(.backup,2);let timeoutTimer=timeout.installTimer()
  timeout.deliverAuthenticationTimeout(1)
  check(timeout.authentication?.1==2 && !timeoutTimer.isCancelled,"old timer callback cannot cancel replacement")
  timeout.deliverAuthenticationTimeout(2)
  check(timeout.authentication==nil && timeoutTimer.isCancelled,"owned timeout still cancels")
  // One exact deadline must survive authentication through backup read, reveal and both write permits.
  for stage in ["on-time","read","postread","reveal"] {
   ContinuousClock.set(0);NativeSignerIdentityActions.reset();let session=Session()
   if stage=="read"{session.core.beforeBackupRead={ContinuousClock.set(deadline)}}
   if stage=="postread"{session.core.beforeBackupReturn={ContinuousClock.set(deadline)}}
   if stage=="reveal"{NativeSignerIdentityActions.beforeReveal={ContinuousClock.set(deadline)}}
   let task=Task{@MainActor in do{try await session.backup(pubkey:"selected",vaultID:"public",revision:1);return true}catch{return false}}
   guard await pending(1)else{fatalError("Backup auth missing")};ContinuousClock.set(deadline-1);NativeSignerIdentityActions.resolve(1)
   check(await task.value==(stage=="on-time"),"backup effect strict deadline boundary")
   check(NativeSignerIdentityActions.reveals==(stage=="on-time" ? 1:0),"only on-time backup reveals")
   if stage=="read"{check(session.core.lastReadCurrent==false && session.core.backupReads==0,"backup read receives deadline guard")}
   if stage=="reveal"{check(NativeSignerIdentityActions.lastRevealCurrent==false,"backup presenter receives same deadline")}
   session.cancelAll()
  }
  for localKey in [false,true] {
   for expired in [false,true] {
    ContinuousClock.set(0);NativeSignerIdentityActions.reset();let session=Session();session.core.selectedPubkey=localKey ? "selected":"other"
    session.core.beforeMutation={ContinuousClock.set(expired ? deadline:deadline-1)}
    let task=Task{@MainActor in do{if localKey{_ = try await session.deleteLocalKey(pubkey:"selected",vaultID:"public",revision:1)}else{_ = try await session.delete(pubkey:"selected",vaultID:"public",revision:1)};return true}catch{return false}}
    guard await pending(1)else{fatalError("Deletion auth missing")};ContinuousClock.set(deadline-1);NativeSignerIdentityActions.resolve(1)
    check(await task.value == !expired,"deletion effect strict boundary")
    check(session.core.lastPermitDeadline?.nanoseconds==deadline,"deletion receives original exact auth deadline")
    check(session.core.lastMutationCurrent == !expired,"deletion current closure expires with auth")
    check(session.core.writes == (expired ? 0:1),"actual native mutation gate rejects expired permit")
    session.cancelAll()
   }
  }
  // Delayed sensitive-operation defers must not cancel/clear a replacement authentication.
  for action in ["backup","local-key","identity"] {
   ContinuousClock.set(0);NativeSignerIdentityActions.reset();let session=Session();session.core.pauseEffect=true;session.core.selectedPubkey=action=="identity" ? "other":"selected"
   let old=Task{@MainActor in do{if action=="backup"{try await session.backup(pubkey:"selected",vaultID:"public",revision:1)}else if action=="local-key"{_ = try await session.deleteLocalKey(pubkey:"selected",vaultID:"public",revision:1)}else{_ = try await session.delete(pubkey:"selected",vaultID:"public",revision:1)};return true}catch{return false}}
   guard await pending(1)else{fatalError("Sensitive auth missing")};NativeSignerIdentityActions.resolve(1)
   guard await effectPending(session)else{fatalError("Sensitive effect did not suspend")}
   session.cancelAll();let next=authTask(session);guard await pending(2)else{fatalError("Replacement auth missing")}
   let timer=session.timer!,clears=NativeSignerIdentityActions.clears;session.core.resumeEffect()
   check(await old.value==false,"revoked sensitive operation rejected")
   check(session.authentication?.1==2 && !timer.isCancelled,"old sensitive defer preserves new auth timer")
   check(NativeSignerIdentityActions.clears==clears,"old defer cannot clear replacement backup")
   NativeSignerIdentityActions.resolve(2);check(await next.value,"replacement survives sensitive defer")
   session.cancelAll()
  }
  NativeSignerIdentityActions.reset()
  let result:[String:Any]=["passed":failures.isEmpty,"assertions":assertions,"failures":failures,"scope":"Actual session methods with explicit host ports; no UIKit/LAContext/device/auth bypass proof"]
  print(String(decoding:try! JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]),as:UTF8.self))
  if !failures.isEmpty{exit(1)}
 }
}
