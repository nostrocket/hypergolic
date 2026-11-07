import Foundation
import CryptoKit

/// Native-only Mesh accounting and exact captures. This component installs no signer or transport.
public final class NativeMeshAuthority: @unchecked Sendable {
  public static let jobMillis:Int64=15_000, pairingMillis:Int64=120_000
  public static let runningLimit=2, waitingLimit=4, publishTtl=2, subscribeTtl=1, incomingTtl=2
  public static let consent="Read this account's stored and live paired-circle events and repeatedly sign Mesh events as this account without a prompt for each event. Open napplets may continue while unfocused. Background, account changes, closing this napplet or revoking Mesh stops its work. Peers may keep and forward events within your hop limits."
  enum Failure:Error{case invalid}
  public final class Source:Sendable {
    public let endpoint,generation,user,vault,publisher,appId,version,instance:String
    public let epoch,vaultRevision,grantRevision,circleRevision:Int64
    init(endpoint:String,generation:String,user:String,epoch:Int64,vault:String,vaultRevision:Int64,publisher:String,appId:String,version:String,instance:String,grantRevision:Int64,circleRevision:Int64)throws{
      guard NativeMeshAuthority.handle(endpoint),NativeMeshAuthority.handle(generation),NativeMeshAuthority.hex(user),NativeMeshAuthority.handle(vault),NativeMeshAuthority.hex(publisher),NativeMeshAuthority.text(appId,1024),NativeMeshAuthority.hex(version),NativeMeshAuthority.handle(instance),[epoch,vaultRevision,grantRevision,circleRevision].allSatisfy(NativeMeshAuthority.validRevision) else{throw Failure.invalid}
      self.endpoint=endpoint;self.generation=generation;self.user=user;self.epoch=epoch;self.vault=vault;self.vaultRevision=vaultRevision;self.publisher=publisher;self.appId=appId;self.version=version;self.instance=instance;self.grantRevision=grantRevision;self.circleRevision=circleRevision
    }
  }
  public final class Registration:@unchecked Sendable {
    fileprivate let owner:NativeMeshAuthority;public let source:Source
    fileprivate var tokens:Int64=40_000,refill:Int64
    fileprivate init(_ owner:NativeMeshAuthority,_ source:Source,_ now:Int64){self.owner=owner;self.source=source;refill=now}
  }
  public final class Publication:Sendable {
    public let requestId,user,unsigned,canonical,eventId:String
    public let kind,ttl:Int;public let createdAt:Int64;public let expiresAt:Int64?
    fileprivate init(id:String,user:String,kind:Int,content:String,tags:[[String]],ttl:Int,created:Int64)throws{
      guard (0...65535).contains(kind),kind != 22242,kind != 24242,content.utf8.count<=8192,tags.count<=256,tags.allSatisfy({(1...64).contains($0.count)}) else{throw Failure.invalid}
      var expiration:Int64?
      for tag in tags where tag[0]=="expiration"{guard expiration==nil,tag.count==2,!tag[1].isEmpty,tag[1].utf8.count<=16,tag[1].utf8.allSatisfy({(48...57).contains($0)}),let value=Int64(tag[1]),NativeMeshAuthority.validRevision(value),value>created else{throw Failure.invalid};expiration=value}
      expiresAt=expiration
      let body=NativeCanonicalJSON.quote(content),quoted=NativeCanonicalJSON.quote(user)
      var encodedTags:[String]=[],payloadBytes=body.utf8.count+2
      for tag in tags{
        payloadBytes+=2+(encodedTags.isEmpty ? 0:1);var fields:[String]=[]
        for field in tag{guard field.utf8.count<=8192 else{throw Failure.invalid};let encoded=NativeCanonicalJSON.quote(field);payloadBytes+=encoded.utf8.count+(fields.isEmpty ? 0:1);guard payloadBytes<=8192 else{throw Failure.invalid};fields.append(encoded)}
        encodedTags.append("["+fields.joined(separator:",")+"]")
      }
      let tagJSON="["+encodedTags.joined(separator:",")+"]"
      requestId=id;self.user=user;self.kind=kind;self.ttl=ttl;createdAt=created
      canonical="[0,\(quoted),\(created),\(kind),\(tagJSON),\(body)]";eventId=NativeMeshAuthority.sha(Data(canonical.utf8))
      unsigned="{\"pubkey\":\(quoted),\"created_at\":\(created),\"kind\":\(kind),\"tags\":\(tagJSON),\"content\":\(body)}"
      let frame="[\"EVENT\",{\"id\":\"\(eventId)\",\"pubkey\":\(quoted),\"created_at\":\(created),\"kind\":\(kind),\"tags\":\(tagJSON),\"content\":\(body),\"sig\":\"\(String(repeating:"0",count:128))\"}]"
      guard frame.utf8.count<=8192 else{throw Failure.invalid}
    }
  }
  public final class Pairing:Sendable {
    public let transcriptHex,digest,localUser,remoteUser,localDevice,remoteDevice:String
    public let expiresAt:Int64;public let inviter:Bool;private let bytes:Data
    fileprivate init(user:String,localDevice:String,remoteUser:String,remoteDevice:String,invite:String,secretHash:String,localNonce:String,remoteNonce:String,expires:Int64,inviter:Bool)throws{
      guard [localDevice,remoteUser,remoteDevice,secretHash,localNonce,remoteNonce].allSatisfy(NativeMeshAuthority.hex),localDevice != remoteDevice,localNonce != remoteNonce,invite.utf8.count==32,invite.utf8.allSatisfy({(48...57).contains($0)||(97...102).contains($0)}) else{throw Failure.invalid}
      self.localUser=user;self.remoteUser=remoteUser;self.localDevice=localDevice;self.remoteDevice=remoteDevice;expiresAt=expires;self.inviter=inviter
      var result=Data("hypergolic.mesh.pairing.v1".utf8);result.append(0);result.append(inviter ? 1:2)
      for value in [invite,secretHash,inviter ? user:remoteUser,inviter ? remoteUser:user,inviter ? localDevice:remoteDevice,inviter ? remoteDevice:localDevice,inviter ? localNonce:remoteNonce,inviter ? remoteNonce:localNonce]{result.append(NativeMeshAuthority.decode(value))}
      var expiry=UInt64(expires).bigEndian;withUnsafeBytes(of:&expiry){result.append(contentsOf:$0)}
      bytes=result;transcriptHex=NativeMeshAuthority.encode(result);digest=NativeMeshAuthority.sha(result)
    }
    public func transcript()->Data{bytes}
  }
  /// Exact native signed wire capture; only this owner constructs it after signing the permit capture.
  public final class SignedPublication:Sendable {
    public let publication:Publication,signature,event,frame:String;private let bytes:Data
    fileprivate init(_ capture:Publication,_ signature:String)throws{
      publication=capture;self.signature=signature
      event="{\"id\":\"\(capture.eventId)\","+capture.unsigned.dropFirst().dropLast()+",\"sig\":\"\(signature)\"}"
      frame="[\"EVENT\",\(event)]";bytes=Data(frame.utf8);guard bytes.count<=8192 else{throw Failure.invalid}
    }
    public func frameBytes()->Data{bytes}
  }
  /// This local role binding does not authorize completed membership before remote proof verification.
  public final class SignedPairing:Sendable {
    public let pairing:Pairing,signature:String;private let binding:Data
    fileprivate init(_ capture:Pairing,_ signature:String){pairing=capture;self.signature=signature;binding=capture.transcript()+NativeMeshAuthority.decode(signature)}
    public func bindingBytes()->Data{binding}
  }
  private struct Grant{let revision:Int64;let enabled:Bool}
  public final class Request:Hashable,@unchecked Sendable {
    fileprivate let owner:NativeMeshAuthority;fileprivate init(_ owner:NativeMeshAuthority){self.owner=owner}
    public static func ==(a:Request,b:Request)->Bool{a===b};public func hash(into h:inout Hasher){h.combine(ObjectIdentifier(self))}
  }
  fileprivate final class Row:@unchecked Sendable {
    let source:Registration?,publication:Publication?,pairing:Pairing?,revision:UInt64,deadline:Int64
    var approved:Bool,cancelled=false,deliveryIssued=false
    init(source:Registration?,publication:Publication?,pairing:Pairing?,revision:UInt64,deadline:Int64){self.source=source;self.publication=publication;self.pairing=pairing;self.revision=revision;self.deadline=deadline;approved=pairing==nil}
  }
  public final class Permit:Hashable,@unchecked Sendable {
    fileprivate let owner:NativeMeshAuthority,row:Row;fileprivate var begun=false,claimed=false,emitted=false,finished=false
    fileprivate var signedPublicationCapture:SignedPublication?,signedPairingCapture:SignedPairing?
    fileprivate init(_ owner:NativeMeshAuthority,_ row:Row){self.owner=owner;self.row=row}
    public var originalDeadline:Int64{row.deadline};public var publication:Publication?{row.publication};public var pairing:Pairing?{row.pairing}
    public var signedPublication:SignedPublication?{owner.locked{signedPublicationCapture}}
    public var signedPairing:SignedPairing?{owner.locked{signedPairingCapture}}
    public static func ==(a:Permit,b:Permit)->Bool{a===b};public func hash(into h:inout Hasher){h.combine(ObjectIdentifier(self))}
  }
  public final class Delivery:Hashable,@unchecked Sendable {
    fileprivate let owner:NativeMeshAuthority,row:Row;fileprivate init(_ owner:NativeMeshAuthority,_ row:Row){self.owner=owner;self.row=row}
    public static func ==(a:Delivery,b:Delivery)->Bool{a===b};public func hash(into h:inout Hasher){h.combine(ObjectIdentifier(self))}
  }
  private let lock=NSRecursiveLock(),clock:@Sendable()->Int64,wallSeconds:@Sendable()->Int64
  private var sources:[String:Registration]=[:],grants:[String:Grant]=[:],waitingRows:[(Request,Row)]=[],runningRows:[Permit:Row]=[:],deliveries:[Delivery:Row]=[:]
  private var user:String?,vault:String?,epoch:Int64 = -1,vaultRevision:Int64 = -1,circleRevision:Int64 = -1,last:Int64 = -1
  private var revision:UInt64=0,foregrounded=false,localSigner=false,closed=false,clockFailed=false
  public init(clock:@escaping @Sendable()->Int64,wallSeconds:@escaping @Sendable()->Int64){self.clock=clock;self.wallSeconds=wallSeconds}
  private func locked<T>(_ body:()throws->T)rethrows->T{lock.lock();defer{lock.unlock()};return try body()}
  private static func sha(_ value:Data)->String{encode(Data(SHA256.hash(data:value)))}
  private static func encode(_ value:Data)->String{value.map{String(format:"%02x",$0)}.joined()}
  private static func decode(_ value:String)->Data{let chars=Array(value.utf8);var result=Data();for i in stride(from:0,to:chars.count,by:2){let a=chars[i],b=chars[i+1];result.append((a<=57 ? a-48:a-87)*16+(b<=57 ? b-48:b-87))};return result}
  private static func hex(_ value:String)->Bool{value.utf8.count==64&&value.utf8.allSatisfy{(48...57).contains($0)||(97...102).contains($0)}}
  private static func handle(_ value:String)->Bool{(1...80).contains(value.utf8.count)&&value.utf8.allSatisfy{(48...57).contains($0)||(65...90).contains($0)||(97...122).contains($0)||$0==45||$0==95}}
  private static func text(_ value:String,_ max:Int)->Bool{!value.isEmpty&&value.utf8.count<=max && !value.unicodeScalars.contains{$0.value<32||$0.value==127}}
  private static func validRevision(_ value:Int64)->Bool{(0...9_007_199_254_740_991).contains(value)}
  private static func grantKey(_ publisher:String,_ appId:String)->String{sha(Data((publisher+"\n"+appId).utf8))}
  private func time()->Int64{let now=clock();if now<0||now<last||now>Int64.max-Self.pairingMillis{clockFailed=true};if !clockFailed{last=now};return last}
  private func available()->Bool{!closed && !clockFailed && foregrounded && localSigner && user != nil}
  private func live(_ source:Registration)->Bool{
    guard source.owner===self,available(),sources[source.source.generation]===source else{return false};let s=source.source,grant=grants[Self.grantKey(s.publisher,s.appId)]
    return s.user==user&&s.epoch==epoch&&s.vault==vault&&s.vaultRevision==vaultRevision&&s.circleRevision==circleRevision&&grant?.enabled==true&&grant?.revision==s.grantRevision
  }
  private func pairingLive(_ pair:Pairing?)->Bool{guard let pair else{return true};let wall=wallSeconds();return Self.validRevision(wall)&&wall<pair.expiresAt}
  private func eventLive(_ event:Publication?)->Bool{guard let expires=event?.expiresAt else{return true};let wall=wallSeconds();return Self.validRevision(wall)&&wall<expires}
  private func live(_ row:Row)->Bool{
    return eventLive(row.publication)&&pairingLive(row.pairing)&&available() && !row.cancelled&&row.revision==revision&&last<row.deadline&&(row.source.map(live) ?? true)}
  private func prune(){_ = time();waitingRows.removeAll{!live($0.1)};for row in runningRows.values where !live(row){row.cancelled=true};deliveries=deliveries.filter{live($0.value)}}
  private func invalidate(){if revision==UInt64.max{closed=true}else{revision+=1};waitingRows.removeAll();sources.removeAll();for row in runningRows.values{row.cancelled=true};deliveries.removeAll()}
  public func account(user:String,epoch:Int64,vault:String,vaultRevision:Int64,selectedLocal:Bool,circleRevision:Int64){locked{
    guard Self.hex(user),Self.handle(vault),[epoch,vaultRevision,circleRevision].allSatisfy(Self.validRevision) else{close();return}
    if self.user != user||self.epoch != epoch||self.vault != vault||self.vaultRevision != vaultRevision||selectedLocal != localSigner||circleRevision != self.circleRevision{invalidate();grants.removeAll()}
    self.user=user;self.epoch=epoch;self.vault=vault;self.vaultRevision=vaultRevision;localSigner=selectedLocal;self.circleRevision=circleRevision;prune()
  }}
  public func grant(publisher:String,appId:String,revision value:Int64,enabled:Bool){locked{
    prune();guard Self.hex(publisher),Self.text(appId,1024),Self.validRevision(value),available() else{return};let key=Self.grantKey(publisher,appId),old=grants[key]
    if let old, value<old.revision || value==old.revision&&enabled && !old.enabled{return};if old==nil&&grants.count>=64{return};grants[key]=Grant(revision:value,enabled:enabled);prune()
  }}
  public func register(_ source:Source)->Registration?{locked{prune();guard available(),sources.count<64,sources[source.generation]==nil else{return nil};let row=Registration(self,source,last);sources[source.generation]=row;if !live(row){sources.removeValue(forKey:source.generation);return nil};return row}}
  private func rate(_ source:Registration)->Bool{let elapsed=last-source.refill;source.tokens=elapsed>=2000 ? 40_000:min(40_000,source.tokens+elapsed*20);source.refill=last;return source.tokens>=1000}
  public func admitPublication(_ source:Registration,id:String,kind:Int,content:String,tags:[[String]],ttl:Int?)->Request?{locked{
    prune();guard live(source),Self.text(id,128),waitingRows.count<Self.waitingLimit,ttl==nil||(0...255).contains(ttl!),rate(source) else{return nil};let wall=wallSeconds();guard Self.validRevision(wall),let capture=try? Publication(id:id,user:source.source.user,kind:kind,content:content,tags:tags,ttl:min(ttl ?? Self.publishTtl,Self.publishTtl),created:wall) else{return nil}
    source.tokens-=1000;let request=Request(self),row=Row(source:source,publication:capture,pairing:nil,revision:revision,deadline:last+Self.jobMillis);waitingRows.append((request,row));return request
  }}
  public func admitPairing(localDevice:String,remoteUser:String,remoteDevice:String,invite:String,secretHash:String,localNonce:String,remoteNonce:String,expiresAt:Int64,inviter:Bool)->Request?{locked{
    prune();guard available(),waitingRows.count<Self.waitingLimit,!waitingRows.contains(where:{$0.1.pairing != nil}),!runningRows.values.contains(where:{$0.pairing != nil}) else{return nil};let wall=wallSeconds()
    guard Self.validRevision(wall),expiresAt>wall,expiresAt-wall<=120,let capture=try? Pairing(user:user!,localDevice:localDevice,remoteUser:remoteUser,remoteDevice:remoteDevice,invite:invite,secretHash:secretHash,localNonce:localNonce,remoteNonce:remoteNonce,expires:expiresAt,inviter:inviter) else{return nil}
    let request=Request(self);waitingRows.append((request,Row(source:nil,publication:nil,pairing:capture,revision:revision,deadline:last+min(Self.pairingMillis,(expiresAt-wall)*1000))));return request
  }}
  public func approvePairing(_ request:Request)->Bool{locked{prune();guard request.owner===self,let row=waitingRows.first(where:{$0.0===request})?.1,row.pairing != nil,!row.approved else{return false};row.approved=true;return true}}
  public func startNext()->Permit?{locked{prune();guard runningRows.count<Self.runningLimit,let i=waitingRows.firstIndex(where:{$0.1.approved}) else{return nil};let row=waitingRows.remove(at:i).1,permit=Permit(self,row);runningRows[permit]=row;return permit}}
  public func current(_ source:Registration)->Bool{locked{prune();return live(source)}}
  public func current(_ permit:Permit)->Bool{locked{guard permit.owner===self else{return false};prune();return !permit.finished&&runningRows[permit]===permit.row&&live(permit.row)}}
  public func begin(_ permit:Permit)->Bool{locked{guard current(permit),!permit.begun else{return false};permit.begun=true;return true}}
  public func signPublication(_ permit:Permit,_ signer:(Publication)throws->String)throws->SignedPublication?{try locked{
    guard current(permit),permit.begun,!permit.claimed,let capture=permit.row.publication else{return nil};permit.claimed=true
    let signature=try signer(capture);guard current(permit),signature.utf8.count==128,signature.utf8.allSatisfy({(48...57).contains($0)||(97...102).contains($0)}) else{return nil};let signed=try SignedPublication(capture,signature);permit.signedPublicationCapture=signed;return signed
  }}
  public func signPairing(_ permit:Permit,_ signer:(Pairing)throws->String)throws->SignedPairing?{try locked{
    guard current(permit),permit.begun,!permit.claimed,let capture=permit.row.pairing else{return nil};permit.claimed=true
    let signature=try signer(capture);guard current(permit),signature.utf8.count==128,signature.utf8.allSatisfy({(48...57).contains($0)||(97...102).contains($0)}) else{return nil};let signed=SignedPairing(capture,signature);permit.signedPairingCapture=signed;return signed
  }}
  private func perform(_ permit:Permit,_ effect:()throws->Void)rethrows->Bool{try locked{guard current(permit),permit.begun,(permit.signedPublicationCapture != nil||permit.signedPairingCapture != nil),!permit.emitted else{return false};permit.emitted=true;try effect();return true}}
  public func performPublication(_ permit:Permit,signed:SignedPublication?,frame:Data,_ effect:(SignedPublication)throws->Void)rethrows->Bool{try locked{guard permit.owner===self,let signed,permit.signedPublicationCapture===signed,signed.frameBytes()==frame else{return false};return try perform(permit){try effect(signed)}}}
  public func performPairing(_ permit:Permit,signed:SignedPairing?,binding:Data,_ effect:(SignedPairing)throws->Void)rethrows->Bool{try locked{guard permit.owner===self,let signed,permit.signedPairingCapture===signed,signed.bindingBytes()==binding else{return false};return try perform(permit){try effect(signed)}}}
  public func emissionAttempted(_ permit:Permit)->Bool{locked{permit.owner===self&&permit.emitted}}
  public func delivery(_ permit:Permit)->Delivery?{locked{guard current(permit),!permit.row.deliveryIssued,deliveries.count<32 else{return nil};permit.row.deliveryIssued=true;let receipt=Delivery(self,permit.row);deliveries[receipt]=permit.row;return receipt}}
  public func deliver(_ receipt:Delivery,_ effect:()->Void)->Bool{locked{guard receipt.owner===self else{return false};prune();guard let row=deliveries.removeValue(forKey:receipt),live(row) else{return false};effect();return true}}
  public func cancel(_ request:Request){locked{if request.owner===self{waitingRows.removeAll{$0.0===request}}}}
  public func cancel(_ permit:Permit){locked{if permit.owner===self{permit.row.cancelled=true};prune()}}
  /// Only the owning worker's actual finally/unwind releases its resource reservation.
  public func drained(_ permit:Permit){locked{if permit.owner===self && !permit.finished{permit.finished=true;runningRows.removeValue(forKey:permit)}}}
  public func revoke(_ source:Registration){locked{if source.owner===self&&sources[source.source.generation]===source{sources.removeValue(forKey:source.source.generation)};prune()}}
  public func circle(_ value:Int64){locked{guard Self.validRevision(value),value>=circleRevision else{close();return};if value != circleRevision{circleRevision=value;invalidate()};prune()}}
  public func unpair(_ value:Int64){locked{guard value>circleRevision else{close();return};circle(value)}}
  public func foreground(_ value:Bool){locked{foregrounded=value;if !value{invalidate()};prune()}}
  public func running()->Int{locked{prune();return runningRows.count}}
  public func waiting()->Int{locked{prune();return waitingRows.count}}
  public func close(){locked{closed=true;foregrounded=false;invalidate();grants.removeAll()}}
}
