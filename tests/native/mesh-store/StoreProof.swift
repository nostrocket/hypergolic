import Foundation
import CryptoKit
import Dispatch

@main enum StoreProof {
  static let account=String(repeating:"1",count:64),signature=String(repeating:"0",count:128)
  nonisolated(unsafe) static var checks=0
  final class Owner:NativeMeshStore.Owner,@unchecked Sendable {
    let account=StoreProof.account,originalDeadlineMillis:Int64
    let gate=NSRecursiveLock();var revision=1,currentRevision=1,now:Int64=0,wallSeconds:Int64=1794100100,tick:Int64=0
    init(_ deadline:Int64=15000){originalDeadlineMillis=deadline}
    var monotonicMillis:Int64{defer{now+=tick};return now}
    var onCurrent:(()->Void)?
    var current:Bool{onCurrent?();return revision==currentRevision}
    func withCurrentMutation(_ action:()throws->Void)throws{gate.lock();defer{gate.unlock()};guard current else{throw NativeMeshStore.Failure(.denied)};try action();guard current else{throw NativeMeshStore.Failure(.denied,true)}}
  }
  static func check(_ value:Bool)throws{checks+=1;if !value{throw NSError(domain:"StoreProof",code:checks)}}
  static func failure(_ code:NativeMeshStore.Code,_ action:()throws->Void)throws->NativeMeshStore.Failure{do{try action()}catch let error as NativeMeshStore.Failure{try check(error.code==code);return error};throw NSError(domain:"expected failure",code:checks)}
  static func hash(_ bytes:Data)->String{SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined()}
  static func open(_ root:URL,_ owner:Owner,_ fresh:Bool=false,_ limits:NativeMeshStore.Limits=NativeMeshStore.Limits(),_ fault:@escaping(NativeMeshStore.Stage)throws->Void={_ in})throws->NativeMeshStore{try NativeMeshStore.open(root:root,owner:owner,verifier:{$2==signature},initialize:fresh,limits:limits,fault:fault)}
  static func event(_ store:NativeMeshStore,_ owner:Owner,_ content:String,_ kind:Int=1,_ created:Int64=1,_ tags:[[String]]=[] )throws->NativeMeshStore.Event{
    let encoded="["+tags.map{"["+$0.map(NativeCanonicalJSON.quote).joined(separator:",")+"]"}.joined(separator:",")+"]"
    let canonical="[0,\"\(account)\",\(created),\(kind),\(encoded),\(NativeCanonicalJSON.quote(content))]"
    return try store.captureVerified(owner,header:.init(id:hash(Data(canonical.utf8)),author:account,createdAt:created,kind:kind,signature:signature),body:.init(content:content,tags:tags))
  }
  final class Outcome:@unchecked Sendable {var error:Error?}
  static func sameHandleDeadline(_ root:URL)throws{
    try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false)
    let owner=Owner(),staged=DispatchSemaphore(value:0),release=DispatchSemaphore(value:0),done=DispatchSemaphore(value:0),outcome=Outcome()
    let initial=try open(root,owner,true);initial.close()
    let store=try open(root,owner,false,NativeMeshStore.Limits()){if $0 == .staged{staged.signal();if release.wait(timeout:.now()+3) != .success{throw NSError(domain:"release timed out",code:1)}}}
    let value=try event(store,owner,"held")
    DispatchQueue.global().async{do{_ = try store.keep(owner,value)}catch{outcome.error=error};done.signal()}
    do{try check(staged.wait(timeout:.now()+2) == .success);let short=Owner(3);short.tick=1;_ = try failure(.denied){_ = try store.backlog(short,filters:[NativeMeshStore.Filter()])};try check(done.wait(timeout:.now()) == .timedOut)}catch{release.signal();_ = done.wait(timeout:.now()+4);store.close();throw error}
    release.signal();try check(done.wait(timeout:.now()+4) == .success);try check(outcome.error==nil);store.close()
  }
  static func typedMutationFailures(_ out:URL)throws{
    for code in [NativeMeshStore.Code.unavailable,.denied]{
      for (label,stage,changed) in [("staged",NativeMeshStore.Stage.staged,false),("synced",.fileSynced,false),("renamed",.renamed,true),("directory",.directorySynced,true)]{
        let root=out.appendingPathComponent("typed-\(code)-\(label)"),owner=Owner();try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false);var store=try open(root,owner,true);store.close();store=try open(root,owner,false,NativeMeshStore.Limits()){if $0==stage{throw NativeMeshStore.Failure(code)}};let e=try event(store,owner,"typed fault");let result=try failure(code){_ = try store.keep(owner,e)};try check(result.mutationUnknown==changed);store.close();store=try open(root,owner);try check(store.backlog(owner,filters:[NativeMeshStore.Filter()]).count==(changed ? 1:0));store.close()
      }
      let root=out.appendingPathComponent("typed-ledger-\(code)"),owner=Owner();try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false);var store=try open(root,owner,true);store.close();store=try open(root,owner,false,NativeMeshStore.Limits()){if $0 == .ledgerAppended{throw NativeMeshStore.Failure(code)}};let e=try event(store,owner,"typed ledger");let result=try failure(code){_ = try store.claimForward(owner,e)};try check(result.mutationUnknown);store.close()
      let fresh=out.appendingPathComponent("typed-open-\(code)");try FileManager.default.createDirectory(at:fresh,withIntermediateDirectories:false);let opening=try failure(code){_ = try open(fresh,owner,true,NativeMeshStore.Limits()){if $0 == .renamed{throw NativeMeshStore.Failure(code)}}};try check(opening.mutationUnknown)
    }
    let root=out.appendingPathComponent("typed-already-unknown"),owner=Owner();try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false);var store=try open(root,owner,true);store.close();store=try open(root,owner,false,NativeMeshStore.Limits()){if $0 == .staged{throw NativeMeshStore.Failure(.denied,true)}};let e=try event(store,owner,"already unknown");let result=try failure(.denied){_ = try store.keep(owner,e)};try check(result.mutationUnknown);store.close()
  }
  static func reentrantCurrent(_ out:URL)throws{
    let root=out.appendingPathComponent("current-close-capture"),owner=Owner();try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false);let store=try open(root,owner,true);let e=try event(store,owner,"capture"),header=NativeMeshStore.EventHeader(id:e.id,author:e.author,createdAt:e.createdAt,kind:e.kind,signature:e.signature),body=try NativeMeshStore.EventBody(content:e.content,tags:e.tags);var calls=0;owner.onCurrent={calls+=1};_ = try store.captureVerified(owner,header:header,body:body);let captureChecks=calls;try check(captureChecks>0);calls=0;owner.onCurrent={calls+=1;if calls==captureChecks{store.close()}};let captured=try failure(.denied){_ = try store.captureVerified(owner,header:header,body:body)};try check(!captured.mutationUnknown);owner.onCurrent=nil;_ = try failure(.denied){_ = try store.backlog(owner,filters:[NativeMeshStore.Filter()])}
    let baselineRoot=out.appendingPathComponent("current-close-baseline"),baselineOwner=Owner();try FileManager.default.createDirectory(at:baselineRoot,withIntermediateDirectories:false);let baseline=try open(baselineRoot,baselineOwner,true),base=try event(baseline,baselineOwner,"keep");calls=0;baselineOwner.onCurrent={calls+=1};try check(baseline.keep(baselineOwner,base) == .durable);let keepChecks=calls;baseline.close();baselineOwner.onCurrent=nil
    let mutationRoot=out.appendingPathComponent("current-close-mutation"),mutationOwner=Owner();try FileManager.default.createDirectory(at:mutationRoot,withIntermediateDirectories:false);var mutation=try open(mutationRoot,mutationOwner,true);let kept=try event(mutation,mutationOwner,"keep"),closing=mutation;calls=0;mutationOwner.onCurrent={calls+=1;if calls==keepChecks{closing.close()}};let result=try failure(.denied){_ = try mutation.keep(mutationOwner,kept)};try check(result.mutationUnknown);mutationOwner.onCurrent=nil;mutation=try open(mutationRoot,mutationOwner);try check(mutation.backlog(mutationOwner,filters:[NativeMeshStore.Filter()]).count==1);mutation.close()
  }
  static func run(_ out:URL)throws{
    try FileManager.default.createDirectory(at:out,withIntermediateDirectories:false)
    try sameHandleDeadline(out.appendingPathComponent("lock-deadline"))
    try typedMutationFailures(out)
    try reentrantCurrent(out)
    let owner=Owner(),all=try NativeMeshStore.Filter();var store=try open(out,owner,true)
    let permanent=try event(store,owner,"kept quote\"/雪",1,1,[["t","é"]])
    try check(store.keep(owner,permanent) == .durable);try check(store.keep(owner,permanent) == .duplicate);try check(store.claimForward(owner,permanent));try check(!store.claimForward(owner,permanent));store.close()
    store=try open(out,owner);let rows=try store.backlog(owner,filters:[all]);try check(rows.count==1&&rows[0].wire==permanent.wire);try check(!store.claimForward(owner,rows[0]))
    let ephemeral=try event(store,owner,"EPHEMERAL-CONTENT-NEVER-DISK",20431,2,[["t","EPHEMERAL-TAG-NEVER-DISK"]]);try check(store.keep(owner,ephemeral) == .ephemeral);try check(store.claimForward(owner,ephemeral))
    for case let path as URL in FileManager.default.enumerator(at:out,includingPropertiesForKeys:[.isRegularFileKey])!{if try path.resourceValues(forKeys:[.isRegularFileKey]).isRegularFile==true{let bytes=try Data(contentsOf:path);try check(bytes.range(of:Data("EPHEMERAL-".utf8))==nil)}}
    store.close();store=try open(out,owner);let repeatEphemeral=try event(store,owner,"EPHEMERAL-CONTENT-NEVER-DISK",20431,2,[["t","EPHEMERAL-TAG-NEVER-DISK"]]);try check(!store.claimForward(owner,repeatEphemeral));try check(store.backlog(owner,filters:[all]).count==1)
    let exact=try NativeMeshStore.Filter(tags:["#t":["é"]],window:.init(since:1,until:1));let mismatch=try NativeMeshStore.Filter(tags:["#t":["é"]]);try check(store.backlog(owner,filters:[exact]).count==1);try check(store.backlog(owner,filters:[mismatch]).isEmpty)
    let zero=try NativeMeshStore.Filter(window:.init(limit:0));try check(store.backlog(owner,filters:[zero]).isEmpty);let cursor=try NativeMeshStore.DeliveryCursor(filters:[zero],maximumSeen:1);try check(cursor.accept(rows[0],stored:false,wall:owner.wallSeconds));try check(!cursor.accept(rows[0],stored:false,wall:owner.wallSeconds))
    let bytes=Data("EXPLICIT SHARED BLOB".utf8),id=hash(bytes),missing=String(repeating:"f",count:64);try check(store.presence(owner,hashes:[id])[id]==0);_ = try failure(.invalid){try store.shareBlob(owner,hash:missing,bytes:bytes)};try store.shareBlob(owner,hash:id,bytes:bytes);store.close();store=try open(out,owner);try check(store.presence(owner,hashes:[id])[id]==1);try store.unshareBlob(owner,hash:id);try check(store.presence(owner,hashes:[id])[id]==0)
    let empty=hash(Data());try store.shareBlob(owner,hash:empty,bytes:Data());try check(store.presence(owner,hashes:[empty])[empty]==1);try store.shareBlob(owner,hash:id,bytes:bytes);try FileManager.default.removeItem(at:out.appendingPathComponent(account+"/blobs/"+id+".blob"));_ = try failure(.unavailable){_ = try store.presence(owner,hashes:[id])};store.close()
    let quotaRoot=out.appendingPathComponent("quota");try FileManager.default.createDirectory(at:quotaRoot,withIntermediateDirectories:false);let limits=try NativeMeshStore.Limits(events:8192,count:1,blobs:8,ledger:64),quota=try open(quotaRoot,owner,true,limits);let a=try event(quota,owner,"a"),b=try event(quota,owner,"b");_ = try quota.keep(owner,a);_ = try failure(.full){_ = try quota.keep(owner,b)};try check(quota.claimForward(owner,a));_ = try failure(.full){_ = try quota.claimForward(owner,b)};try check(!quota.claimForward(owner,a));quota.close()
    for stage in [NativeMeshStore.Stage.staged,.renamed]{let root=out.appendingPathComponent(stage == .staged ? "before":"after");try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false);var store=try open(root,owner,true);store.close();store=try open(root,owner,false,NativeMeshStore.Limits()){if $0==stage{throw NSError(domain:"controlled",code:1)}};let e=try event(store,owner,"fault");let result=try failure(.unavailable){_ = try store.keep(owner,e)};try check(result.mutationUnknown==(stage == .renamed));store.close();store=try open(root,owner);try check(store.backlog(owner,filters:[all]).count==(stage == .renamed ? 1:0));store.close()}
    let revokeRoot=out.appendingPathComponent("revocation");try FileManager.default.createDirectory(at:revokeRoot,withIntermediateDirectories:false);var revoked=try open(revokeRoot,owner,true);revoked.close();revoked=try open(revokeRoot,owner,false,NativeMeshStore.Limits()){if $0 == .staged{owner.currentRevision+=1}};let rev=try event(revoked,owner,"revoked");_ = try failure(.denied){_ = try revoked.keep(owner,rev)};revoked.close();owner.revision=owner.currentRevision;revoked=try open(revokeRoot,owner);try check(revoked.backlog(owner,filters:[all]).isEmpty);owner.tick=1;owner.now=14999;_ = try failure(.denied){_ = try revoked.backlog(owner,filters:[all])};revoked.close()
  }
  static func main()throws{try run(URL(fileURLWithPath:CommandLine.arguments[1]));print("{\"status\":\"passed\",\"checks\":\(checks),\"scope\":\"durable files/restart/faults; fixture verifier only, no signer/device acceptance\"}")}
}
