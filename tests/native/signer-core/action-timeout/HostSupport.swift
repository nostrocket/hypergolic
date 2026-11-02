import Foundation
import Synchronization
// Explicit monotonic host clock; real Swift Task timer delivery remains deferred.
enum ContinuousClock {
 struct Instant:Comparable,Sendable {
  let nanoseconds:Int64
  static func <(lhs:Self,rhs:Self)->Bool{lhs.nanoseconds<rhs.nanoseconds}
  func advanced(by duration:Duration)->Self {let p=duration.components;return .init(nanoseconds:nanoseconds+p.seconds*1_000_000_000+p.attoseconds/1_000_000_000)}
 }
 private static let value=Mutex<Int64>(0)
 static var now:Instant{value.withLock{.init(nanoseconds:$0)}}
 static func set(_ nanoseconds:Int64){value.withLock{$0=nanoseconds}}
}
@MainActor final class UIApplication {
 enum State {case active,inactive,background}
 static let shared=UIApplication();var applicationState:State = .active
}
@MainActor enum NativeSignerIdentityActions {
 enum Action:Sendable {case backup,deletion}
 struct Pending {let reply:CheckedContinuation<Void,any Error>;let canPresent:@Sendable()->Bool}
 static var clears=0,cancels=0,reveals=0
 static var pending:[UInt64:Pending]=[:],ignoreCancellation=false
 static var beforeReveal:(()->Void)?,lastRevealCurrent:Bool?
 static func clearBackup(){clears+=1}
 static func cancel(_ action:Action,attemptID:UInt64){
  cancels+=1
  if !ignoreCancellation{resolve(attemptID,accepted:false)}
 }
 static func authenticate(_ action:Action,attemptID:UInt64,canPresent:@escaping @Sendable()->Bool)async throws{
  guard canPresent() else{throw NativeVaultFailure.denied}
  try await withCheckedThrowingContinuation{pending[attemptID]=Pending(reply:$0,canPresent:canPresent)}
 }
 static func resolve(_ id:UInt64,accepted:Bool=true){
  guard let row=pending.removeValue(forKey:id)else{return}
  if accepted{row.reply.resume()}else{row.reply.resume(throwing:NativeVaultFailure.denied)}
 }
 static func showBackup(attemptID:UInt64,secret:Data,canPresent:@escaping @Sendable()->Bool)async throws{
  beforeReveal?();lastRevealCurrent=canPresent()
  guard lastRevealCurrent==true else{throw NativeVaultFailure.denied};reveals+=1
 }
 static func reset(){precondition(pending.isEmpty);ignoreCancellation=false;beforeReveal=nil;lastRevealCurrent=nil;reveals=0}
}
enum NativeVaultFailure:Error {case denied,stale,unavailable,busy,localKeyUnavailable,deleteSelected}
enum NativeSigningSourceFacade {static func revokeAll(){}}
final class NativeVaultKey:Sendable {
 private let count=NSLock();nonisolated(unsafe) private var destroyed=0
 func destroy(){count.lock();destroyed+=1;count.unlock()}
 var destroyCount:Int {count.lock();defer{count.unlock()};return destroyed}
}
@MainActor final class Pool {
 var cancellations=0
 func cancelAll(){cancellations+=1}
 func prepare(key:NativeVaultKey,vaultID:String,revision:UInt64,epoch:UInt64)throws->String {"public-candidate"}
}
// Real production mutation gate checks epoch/protection/deadline at the synthetic write boundary.
final class Authority:@unchecked Sendable {
 private struct State {var revocations=0,foreground=true,protectedData=true}
 private let state=Mutex(State()),gate=NativeVaultMutationGate()
 init(){gate.update(foreground:true,protectedData:true)}
 var revocations:Int{state.withLock{$0.revocations}}
 var foreground:Bool{state.withLock{$0.foreground}}
 var protectedData:Bool{state.withLock{$0.protectedData}}
 func epoch()throws->UInt64{try gate.epoch()}
 func current(_ epoch:UInt64)->Bool{gate.current(epoch)}
 func update(foreground:Bool,protectedData:Bool){state.withLock{$0.foreground=foreground;$0.protectedData=protectedData};gate.update(foreground:foreground,protectedData:protectedData)}
 func invalidateActions(){state.withLock{$0.revocations+=1};gate.invalidateActions()}
 func permit(_ epoch:UInt64,deadline:ContinuousClock.Instant?=nil)->Permit{.init(gate:gate,epoch:epoch,deadline:deadline)}
 struct Permit:Sendable {
  let gate:NativeVaultMutationGate,epoch:UInt64,deadline:ContinuousClock.Instant?
  func performMutation(_ operation:()throws->Void)throws{try gate.mutate(epoch,deadline:deadline,operation:operation)}
 }
}
@MainActor final class Core {
 var selectedPubkey="selected",backupReads=0,writes=0
 var beforeBackupRead:(()->Void)?,beforeBackupReturn:(()->Void)?,beforeMutation:(()->Void)?
 var pauseEffect=false,effectReply:CheckedContinuation<Void,Never>?
 private func waitEffect()async{if pauseEffect{await withCheckedContinuation{effectReply=$0}}}
 func resumeEffect(){let reply=effectReply;effectReply=nil;reply?.resume()}
 var lastReadCurrent:Bool?,lastMutationCurrent:Bool?,lastPermitDeadline:ContinuousClock.Instant?
 func selected(pubkey:String="",vaultID:String,revision:UInt64,current:@Sendable()->Bool)async throws->String{guard current()else{throw NativeVaultFailure.denied};return selectedPubkey}
 func requireIdentity(pubkey:String,vaultID:String,revision:UInt64,current:@Sendable()->Bool)async throws{guard current()else{throw NativeVaultFailure.denied}}
 func backupSecret(pubkey:String,vaultID:String,revision:UInt64,current:@Sendable()->Bool)async throws->Data{
  await waitEffect();beforeBackupRead?();lastReadCurrent=current();guard lastReadCurrent==true else{throw NativeVaultFailure.denied}
  backupReads+=1;beforeBackupReturn?();return Data([1,2,3])
 }
 private func mutate(authority:Authority.Permit,current:@Sendable()->Bool)async throws->String{
  await waitEffect();beforeMutation?();lastMutationCurrent=current();lastPermitDeadline=authority.deadline
  // Deliberately record (rather than enforce) the supplied current closure, so the actual
  // production gate independently proves the passed permit's deadline blocks the write.
  try authority.performMutation{writes+=1};return "public-snapshot"
 }
 func deleteLocalKey(pubkey:String,vaultID:String,revision:UInt64,authority:Authority.Permit,current:@Sendable()->Bool,revokePending:@Sendable()->Void)async throws->String{try await mutate(authority:authority,current:current)}
 func delete(pubkey:String,vaultID:String,revision:UInt64,authority:Authority.Permit,current:@Sendable()->Bool)async throws->String{try await mutate(authority:authority,current:current)}
}
@MainActor final class Panel {
 var presentingViewController:Bool?;var clears=0,dismissals=0
 func clear(){clears+=1}
 func dismiss(animated:Bool,completion:()->Void){dismissals+=1;completion()}
}
@MainActor final class CancelPort {var cancellations=0;func cancel(){cancellations+=1};func cancelAll(){cancellations+=1}}
@MainActor final class Confirmation {var dismissals=0;func dismiss(animated:Bool){dismissals+=1}}
@MainActor final class Session {
 var timer:Task<Void,Never>?,confirmationTimer:Task<Void,Never>?
 var authentication:(NativeSignerIdentityActions.Action,UInt64)?
 var importReply:CheckedContinuation<String?,any Error>?,importPanel:Panel?
 let candidates=Pool(),remoteCandidates=Pool(),authority=Authority(),launch=CancelPort(),handoffs=CancelPort()
 var safari:CancelPort?,confirmation:Confirmation?,confirmReply:CheckedContinuation<Bool,Never>?
 let core=Core();var nextAttempt:UInt64=0
 var remoteCancels=0,signCancels=0
 func cancelRemotePreparation(){remoteCancels+=1}
 func cancelSigning(){signCancels+=1}
 func installTimer()->Task<Void,Never>{let value=Task<Void,Never> {try? await Task.sleep(for:.seconds(30))};timer=value;return value}
 func inactive(){resignActive()}
 func enterBackground(){background()}
 func lateImport(_ key:NativeVaultKey?){completeImport(key,vaultID:"public-vault",revision:1,epoch:1)}
 func cancelInput(){cancelImport()}
 func pendingInputCancel()async throws->String? {
  try await withCheckedThrowingContinuation {reply in importReply=reply;importPanel=Panel();cancelImport()}
 }
 func idle()throws{guard authentication==nil else{throw NativeVaultFailure.busy}}
 func activeEpoch()throws->UInt64{let epoch=try authority.epoch();guard authority.current(epoch),UIApplication.shared.applicationState == .active else{throw NativeVaultFailure.denied};return epoch}
 func methodInfo(pubkey:String,vaultID:String,revision:UInt64,epoch:UInt64)async throws->(selected:String?,local:Bool,remote:[String:Any]?){("local",true,nil)}
 func confirm(title:String,message:String,approve:String)async->Bool{true}
 func requestAuth()async throws->UInt64{let result=try await authenticate(.backup,epoch:try activeEpoch());return AUTH_RESULT_ID}
 func deliverAuthenticationTimeout(_ attempt:UInt64){let delivered={ [weak self] in AUTH_TIMER_CALLBACK };delivered()}
 // ACTUAL_SESSION_METHODS
}
