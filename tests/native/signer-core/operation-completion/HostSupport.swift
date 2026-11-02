import Foundation
import Synchronization
@MainActor final class UIApplication { enum State{case active,background};static let shared=UIApplication();var applicationState:State = .active }
enum NativeVaultFailure:Error {case denied,signerExpired,signerAlreadyConnected,notFound,signerUncertain,oldFailure}
final class NativeVaultKey:@unchecked Sendable {init()throws{};var destroyed=false;func destroy(){destroyed=true}}
final class NativeSigningSourceCapture:@unchecked Sendable {var cancels=0,consumes=0;func cancel(){cancels+=1};func isLive()->Bool{cancels==0};func consumeForNativeSigning()->Bool{consumes+=1;return true}}
final class NativeNip46DispatchState:@unchecked Sendable {var possible=false}
struct ExactSignerEvent:Sendable {let digest:[UInt8]=[1]}
func nativeSigningDeadlineValid(_ event:ExactSignerEvent)->Bool{true}
@MainActor enum NativeSigningSourceFacade {static var cancels=0;static func cancel(kind:String,token:String){cancels+=1}}
struct NativeBunkerConnection {let peer="public-peer",relays=["wss://example.org"];var token=Data([1]);mutating func clear(){token.resetBytes(in:0..<token.count);token.removeAll()}}
@MainActor class Panel {
 var presentingViewController:Bool?=true;var clears=0,dismissals=0;var viewIfLoaded:Panel?{self};var window:Int?{1}
 var delayDismiss=false;var dismissal:(()->Void)?
 func clear(){clears+=1}
 func dismiss(animated:Bool,completion:@escaping()->Void={}){dismissals+=1;if delayDismiss{dismissal=completion}else{completion()}}
 func present(_ panel:Panel,animated:Bool){}
}
@MainActor final class NativeVaultRemotePanel:Panel {init(current:@escaping @Sendable()->Bool,complete:@escaping(NativeBunkerConnection?)->Void){super.init()}}
@MainActor final class Authority {
 var revocations=0
 private let owned=Mutex(true)
 nonisolated func current(_ epoch:UInt64)->Bool{owned.withLock{$0}}
 func retireOwner(){owned.withLock{$0=false}}
 func permit(_ epoch:UInt64,deadline:ContinuousClock.Instant)->Permit{Permit()}
}
struct Permit:Sendable {func performMutation(_ work:()->Void)throws{work()}}
struct NativeNip46Handoff {enum Binding{case preparation(vaultID:String,revision:UInt64,attemptID:String,refresh:Bool);case signing(kind:String,token:String,vaultID:String,revision:UInt64,eventID:String)}}
@MainActor final class Pool {
 var cancellations=0,preparations=0;func cancelAll(){cancellations+=1}
 enum Purpose{case refresh}
 func prepare(pubkey:String,peer:String,relays:[String],key:NativeVaultKey,vaultID:String,revision:UInt64,epoch:UInt64,expires:ContinuousClock.Instant,purpose:Purpose?=nil)throws->String{preparations+=1;return "public-candidate"}
}
@MainActor final class Latch {var waiter:CheckedContinuation<Void,Never>?;func wait()async{await withCheckedContinuation{waiter=$0}};func release(){let c=waiter;waiter=nil;c?.resume()}}
@MainActor enum TransportPort {static var handshake:Latch?,refresh:Latch?;static var refreshResult:[String]?=["wss://changed.example.org"]}
@MainActor struct NativeNip46Client {
 struct Bound{let pubkey="public-account",relays=["wss://example.org"]}
 init(key:NativeVaultKey,peer:String,handoff:NativeNip46Handoff){}
 func handshake(token:Data,relays:[String],deadline:ContinuousClock.Instant,current:@Sendable()->Bool,dispatch:(()->Void)throws->Void)async throws->Bound{if let latch=TransportPort.handshake{await latch.wait()};return Bound()}
 func refresh(pubkey:String,relays:[String],deadline:ContinuousClock.Instant,current:@Sendable()->Bool,dispatch:(()->Void)throws->Void)async throws->[String]?{if let latch=TransportPort.refresh{await latch.wait()};return TransportPort.refreshResult}
}
@MainActor final class Core {
 var signCalls=0
 struct Capability{let key=try! NativeVaultKey(),peer="public-peer",relays=["wss://example.org"]}
 func snapshot(vaultID:String,revision:UInt64,current:@Sendable()->Bool)async throws->String{"public"}
 func remoteCapability(pubkey:String,vaultID:String,revision:UInt64,current:@Sendable()->Bool)async throws->Capability{Capability()}
 func sign(event:ExactSignerEvent,vaultID:String,revision:UInt64,current:@escaping @Sendable()->Bool,deadline:ContinuousClock.Instant,dispatch:@escaping @Sendable(@Sendable()->Void)throws->Void,state:NativeNip46DispatchState,handoff:NativeNip46Handoff?)async throws->String{signCalls+=1;return "signed-public"}
}
@MainActor final class Session {
 var remoteOperation:UUID?,signOperation:UUID?
 var remoteReply:CheckedContinuation<String?,any Error>?,remotePanel:NativeVaultRemotePanel?
 var onRemoteInstall:((Task<Void,Never>)->Void)?,onSignInstall:((Task<Void,Never>)->Void)?
 var remoteTask:Task<Void,Never>?{didSet{if let value=remoteTask,let hook=onRemoteInstall{onRemoteInstall=nil;hook(value)}}}
 var signTask:Task<Void,Never>?{didSet{if let value=signTask,let hook=onSignInstall{onSignInstall=nil;hook(value)}}}
 var signReply:CheckedContinuation<String,any Error>?,signPanel:Panel?,signSource:NativeSigningSourceCapture?,signKind:String?,signToken:String?,signDispatchState:NativeNip46DispatchState?
 var timer:Task<Void,Never>?,signTaskValue:Task<Void,Never>?
 var handoffsMade=0
 let authority=Authority(),core=Core(),candidates=Pool(),remoteCandidates=Pool(),host=Panel()
 var methodLatch:Latch?,confirmationLatch:Latch?
 func idle()throws{};func activeEpoch()throws->UInt64{1};func current(_ epoch:UInt64)->@Sendable()->Bool{{true}};func presenter()throws->Panel{host}
 struct Info{let remote:Int?=nil}
 func methodInfo(pubkey:String,vaultID:String,revision:UInt64,epoch:UInt64)async throws->Info{if let methodLatch{await methodLatch.wait()};return Info()}
 func confirm(title:String,message:String,approve:String,deadline:ContinuousClock.Instant)async->Bool{if let confirmationLatch,title=="No relay changes"{await confirmationLatch.wait()};return true}
 func makeHandoff(binding:NativeNip46Handoff.Binding,deadline:ContinuousClock.Instant,current:@escaping @Sendable()->Bool,source:NativeSigningSourceCapture?=nil)->NativeNip46Handoff{handoffsMade+=1;return NativeNip46Handoff()}
 // Explicit native revocation port; request finish/cancel bodies below are actual owning code.
 func cancelAll(){authority.revocations+=1;timer?.cancel();timer=nil;cancelRemotePreparation();cancelSigning()}
 func remoteReplyOnly(operation:UUID)async throws->String?{try await withCheckedThrowingContinuation{remoteOperation=operation;remoteReply=$0;remotePanel=NativeVaultRemotePanel(current:{true},complete:{_ in});timer=Task{try? await Task.sleep(for:.seconds(30))}}}
 func signReplyOnly(operation:UUID)async throws->String{try await withCheckedThrowingContinuation{signOperation=operation;signReply=$0;signPanel=Panel();signSource=NativeSigningSourceCapture();signDispatchState=NativeNip46DispatchState();signKind="approval";signToken="native-public-token";timer=Task{try? await Task.sleep(for:.seconds(30))}}}
 func finishRemote(_ result:Result<String?,any Error>,operation:UUID){REMOTE_FINISH_CALL}
 func cancelRemote(operation:UUID?=nil,failure:NativeVaultFailure?=nil){REMOTE_CANCEL_CALL}
 func startRemote(_ connection:NativeBunkerConnection?,operation:UUID){REMOTE_START_CALL}
 func finishSign(_ result:Result<String,any Error>,operation:UUID,checker:@escaping @Sendable()->Bool={true}){SIGN_FINISH_CALL}
 func cancelSign(operation:UUID?=nil){SIGN_CANCEL_CALL}
 func decideNo(operation:UUID,source:NativeSigningSourceCapture){SIGN_DECIDE_CALL}
 func decideYes(operation:UUID,source:NativeSigningSourceCapture){SIGN_APPROVE_CALL}
 // ACTUAL_METHODS
}
