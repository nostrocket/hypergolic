import Foundation
import CryptoKit

/// Native-only credential/pair state. No bridge, signer, socket or proof factory is installed.
final class NativeMeshIdentityStore: @unchecked Sendable {
  static let maxBytes=131_072,maxDevices=32,maxAccounts=16,derMax=2048
  enum Failure:Error{case unavailable}
  final class AccountLease: @unchecked Sendable {
    let account:String,epoch:Int64,vaultRevision:Int64
    private let current:@Sendable()->Bool;private let leaseLock=NSLock();private var revoked=false
    init(account:String,epoch:Int64,vaultRevision:Int64,current:@escaping @Sendable()->Bool)throws{
      guard NativeMeshIdentityStore.hex(account),NativeMeshIdentityStore.revision(epoch),NativeMeshIdentityStore.revision(vaultRevision) else{throw Failure.unavailable}
      self.account=account;self.epoch=epoch;self.vaultRevision=vaultRevision;self.current=current
    }
    var isCurrent:Bool{leaseLock.lock();let stopped=revoked;leaseLock.unlock();guard !stopped,current() else{return false};leaseLock.lock();defer{leaseLock.unlock()};return !revoked}
    func revoke(){leaseLock.lock();revoked=true;leaseLock.unlock()}
    fileprivate var live:Bool{isCurrent}
  }
  protocol Backend:AnyObject{func read()throws->Data?;func write(_ clear:Data,initialize:Bool)throws}
  protocol Credential:AnyObject{func pin()throws->Data;func close()}
  protocol CredentialBorrow:Credential{func withNative(_ use:(any Credential)throws->Void)throws}
  protocol CredentialPort:AnyObject{func importDER(key:Data,certificate:Data)throws->any Credential}
  typealias CredentialProducer=(_ sink:(Data,Data)throws->Void)throws->Void
  /// Only the native coordinator may mint after both signatures/UI and fresh mTLS proof.
  final class VerifiedMembershipCommit {
    fileprivate let lease:AccountLease,circle:Int64,local:Data,remote:Data,proof:()->Bool
    private var used=false;private let tokenLock=NSRecursiveLock()
    init(lease:AccountLease,circleRevision:Int64,local:Data,remote:Data,proof:@escaping ()->Bool)throws{
      guard NativeMeshIdentityStore.revision(circleRevision),local.count==340,remote.count==340 else{throw Failure.unavailable}
      self.lease=lease;circle=circleRevision;self.local=local;self.remote=remote;self.proof=proof
    }
    fileprivate func take(_ owner:AccountLease,_ expectedCircle:Int64)->Bool{tokenLock.lock();defer{tokenLock.unlock()};guard !used else{return false};used=true;return lease===owner&&circle==expectedCircle&&owner.live&&proof()}
  }
  /// Explicit bilateral-completion proof; this operation never signs again.
  final class MembershipPromotion {
    fileprivate let lease:AccountLease,circle:Int64,id:Data,digest:Data,proof:()->Bool
    private var used=false;private let tokenLock=NSRecursiveLock()
    init(lease:AccountLease,circleRevision:Int64,pairingId:Data,bindingsDigest:Data,proof:@escaping ()->Bool)throws{
      guard NativeMeshIdentityStore.revision(circleRevision),pairingId.count==16,bindingsDigest.count==32 else{throw Failure.unavailable}
      self.lease=lease;circle=circleRevision;id=pairingId;digest=bindingsDigest;self.proof=proof
    }
    fileprivate func take(_ owner:AccountLease,_ expectedCircle:Int64)->Bool{tokenLock.lock();defer{tokenLock.unlock()};guard !used else{return false};used=true;return lease===owner&&circle==expectedCircle&&owner.live&&proof()}
  }
  struct Peer:Sendable{let account,pin,pairingId,bindingsDigest:String;let active:Bool}
  struct View:Sendable{let generation,circleRevision:Int64,localPin:String,peers:[Peer]
    var activeAccounts:Int{Set(peers.filter(\.active).map(\.account)).count}
  }
  private struct Record {
    let local,remote,id,pin,digest:Data,account:String
    var active:Bool
    init(local:Data,remote:Data,active:Bool,owner:String,localPin:Data)throws{
      let prefix=Data("hypergolic.mesh.pairing.v1\0".utf8)
      guard local.count==340,remote.count==340,local.prefix(27)==prefix,remote.prefix(27)==prefix else{throw Failure.unavailable}
      let role=local[27];guard (role==1||role==2),remote[27]==(role==1 ? 2:1) else{throw Failure.unavailable}
      for i in 0..<276 where i != 27{guard local[i]==remote[i] else{throw Failure.unavailable}}
      let user=local.subdata(in:role==1 ? 76..<108:108..<140),ownPin=local.subdata(in:role==1 ? 140..<172:172..<204)
      guard NativeMeshIdentityStore.encode(user)==owner,ownPin==localPin else{throw Failure.unavailable}
      pin=local.subdata(in:role==1 ? 172..<204:140..<172)
      guard pin != localPin,local.subdata(in:204..<236) != local.subdata(in:236..<268) else{throw Failure.unavailable}
      var expiry:UInt64=0;for i in 268..<276{expiry=(expiry<<8)|UInt64(local[i])};guard expiry>0,expiry<=9_007_199_254_740_991 else{throw Failure.unavailable}
      account=NativeMeshIdentityStore.encode(local.subdata(in:role==1 ? 108..<140:76..<108));id=local.subdata(in:28..<44)
      self.local=local;self.remote=remote;self.active=active;digest=Data(SHA256.hash(data:local+remote))
    }
    func same(_ other:Record)->Bool{local==other.local&&remote==other.remote}
  }
  private final class Snapshot {
    let account:String,pin:Data;var generation,circle:Int64,key,certificate:Data,records:[Record]=[]
    init(account:String,generation:Int64,circle:Int64,key:Data,certificate:Data,pin:Data){self.account=account;self.generation=generation;self.circle=circle;self.key=NativeMeshIdentityStore.owned(key);self.certificate=NativeMeshIdentityStore.owned(certificate);self.pin=pin}
    func wipe(){key.resetBytes(in:0..<key.count);certificate.resetBytes(in:0..<certificate.count)}
    var view:View{View(generation:generation,circleRevision:circle,localPin:NativeMeshIdentityStore.encode(pin),peers:records.map{Peer(account:$0.account,pin:NativeMeshIdentityStore.encode($0.pin),pairingId:NativeMeshIdentityStore.encode($0.id),bindingsDigest:NativeMeshIdentityStore.encode($0.digest),active:$0.active)})}
  }
  private final class OpenAccounts:@unchecked Sendable {let lock=NSLock();var accounts=Set<String>()}
  private static let opened=OpenAccounts()
  private let lock=NSRecursiveLock(),lease:AccountLease,backend:any Backend,port:any CredentialPort,revoke:()->Void
  private var snapshot:Snapshot?,closed=false,registered=false,heldCredential:(any Credential)?,borrows=0,nativeCalls=0
  init(lease:AccountLease,backend:any Backend,port:any CredentialPort,revoke:@escaping ()->Void)throws{
    self.lease=lease;self.backend=backend;self.port=port;self.revoke=revoke
    var clear:Data?;defer{if clear != nil{clear!.resetBytes(in:0..<clear!.count)}}
    do{Self.opened.lock.lock();let accepted=Self.opened.accounts.count<16&&Self.opened.accounts.insert(lease.account).inserted;Self.opened.lock.unlock();guard accepted else{throw Failure.unavailable};registered=true;try active();clear=try backend.read();try active();if let data=clear{let s=try Self.decode(data,account:lease.account);snapshot=s;let c=try port.importDER(key:s.key,certificate:s.certificate);defer{c.close()};guard try c.pin()==s.pin else{throw Failure.unavailable};try active()}}
    catch{close();throw Failure.unavailable}
  }
  private func locked<T>(_ body:()throws->T)rethrows->T{lock.lock();defer{lock.unlock()};return try body()}
  private func active()throws{guard !closed,lease.live,!closed else{close();throw Failure.unavailable}}
  private func expected(_ generation:Int64)throws{try active();guard snapshot?.generation==generation else{throw Failure.unavailable}}
  func view()throws->View{try locked{try active();guard let s=snapshot else{throw Failure.unavailable};return s.view}}
  func initialize(_ producer:CredentialProducer)throws{try locked{
    try active();guard snapshot==nil else{throw Failure.unavailable};var key=Data(),cert=Data(),calls=0
    defer{key.resetBytes(in:0..<key.count);cert.resetBytes(in:0..<cert.count)}
    try producer{k,c in calls+=1;guard calls==1,(1...Self.derMax).contains(k.count),(1...Self.derMax).contains(c.count) else{throw Failure.unavailable};key=Self.owned(k);cert=Self.owned(c)}
    try active();guard calls==1,!key.isEmpty else{throw Failure.unavailable};let credential=try port.importDER(key:key,certificate:cert);defer{credential.close()};let pin=try credential.pin();guard pin.count==32 else{throw Failure.unavailable}
    try persist(Snapshot(account:lease.account,generation:1,circle:0,key:key,certificate:cert,pin:pin),initialize:true)
  }}
  private final class CredentialLease:CredentialBorrow{
    private let owner:NativeMeshIdentityStore,value:any Credential;private var ended=false
    init(_ owner:NativeMeshIdentityStore,_ value:any Credential){self.owner=owner;self.value=value}
    func pin()throws->Data{try owner.locked{try owner.active();guard !ended else{throw Failure.unavailable};owner.nativeCalls+=1;defer{owner.nativeCalls-=1;owner.drainCredential()};let pin=try value.pin();try owner.active();return pin}}
    func withNative(_ use:(any Credential)throws->Void)throws{try owner.locked{try owner.active();guard !ended else{throw Failure.unavailable};owner.nativeCalls+=1;defer{owner.nativeCalls-=1;owner.drainCredential()};try use(value);try owner.active()}}
    func close(){owner.locked{if !ended{ended=true;if owner.borrows>0{owner.borrows-=1}}}}
    deinit{close()}
  }
  func withCredential()throws->any CredentialBorrow{try locked{
    try active();guard let s=snapshot,borrows<4 else{throw Failure.unavailable}
    if heldCredential==nil{var key=Self.owned(s.key),cert=Self.owned(s.certificate);defer{key.resetBytes(in:0..<key.count);cert.resetBytes(in:0..<cert.count)}
      let value=try port.importDER(key:key,certificate:cert);do{try active();guard try value.pin()==s.pin else{throw Failure.unavailable};try active();heldCredential=value}catch{value.close();throw Failure.unavailable}}
    guard let heldCredential else{throw Failure.unavailable};borrows+=1;return CredentialLease(self,heldCredential)
  }}
  func stage(generation:Int64,commit:VerifiedMembershipCommit)throws->View{try locked{
    try expected(generation);guard let initial=snapshot,commit.take(lease,initial.circle) else{throw Failure.unavailable};try expected(generation);guard let s=snapshot else{throw Failure.unavailable};let row=try Record(local:commit.local,remote:commit.remote,active:false,owner:lease.account,localPin:s.pin)
    for old in s.records{if old.id==row.id{guard old.same(row) else{throw Failure.unavailable};return s.view};guard old.pin != row.pin else{throw Failure.unavailable}}
    let next=try copy();defer{if snapshot !== next{next.wipe()}};next.records.append(row);try Self.validate(next);try persist(next,initialize:false);return next.view
  }}
  func promote(generation:Int64,promotion:MembershipPromotion)throws->View{try locked{
    try expected(generation);guard let initial=snapshot,promotion.take(lease,initial.circle) else{throw Failure.unavailable};try expected(generation);guard let s=snapshot,let index=s.records.firstIndex(where:{$0.id==promotion.id}),s.records[index].digest==promotion.digest else{throw Failure.unavailable}
    if s.records[index].active{return s.view};let next=try copy();defer{if snapshot !== next{next.wipe()}};next.records[index].active=true;revoke();try expected(generation);next.circle=try Self.increment(next.circle);try persist(next,initialize:false);return next.view
  }}
  func remove(generation:Int64,pin:String)throws->View{try locked{
    try expected(generation);guard Self.hex(pin),let s=snapshot,s.records.contains(where:{Self.encode($0.pin)==pin}) else{throw Failure.unavailable};let next=try copy();defer{if snapshot !== next{next.wipe()}};next.records.removeAll{Self.encode($0.pin)==pin}
    revoke();try expected(generation);next.circle=try Self.increment(next.circle);try persist(next,initialize:false);return next.view
  }}
  private func copy()throws->Snapshot{guard let s=snapshot else{throw Failure.unavailable};let next=Snapshot(account:s.account,generation:try Self.increment(s.generation),circle:s.circle,key:s.key,certificate:s.certificate,pin:s.pin);next.records=s.records;return next}
  private func persist(_ next:Snapshot,initialize:Bool)throws{
    var clear=Data(),prior=Data(),readback:Data?,observed:Data?;defer{clear.resetBytes(in:0..<clear.count);prior.resetBytes(in:0..<prior.count);if readback != nil{readback!.resetBytes(in:0..<readback!.count)};if observed != nil{observed!.resetBytes(in:0..<observed!.count)}}
    do{try active();try Self.validate(next);if let s=snapshot{prior=try Self.serialize(s);observed=try backend.read();guard prior==observed else{throw Failure.unavailable}};clear=try Self.serialize(next);try backend.write(clear,initialize:initialize);try active();readback=try backend.read();guard clear==readback else{throw Failure.unavailable};try active();snapshot?.wipe();snapshot=next}
    catch{next.wipe();close();throw Failure.unavailable}
  }
  // Logical revocation is immediate; reentrant close cannot destroy an in-flight native key.
  private func drainCredential(){if closed,nativeCalls==0{let held=heldCredential;heldCredential=nil;held?.close();if registered{Self.opened.lock.lock();Self.opened.accounts.remove(lease.account);Self.opened.lock.unlock();registered=false}}}
  func close(){lease.revoke();locked{if !closed{closed=true;borrows=0;snapshot?.wipe();revoke();drainCredential()}}}
  deinit{close()}
  private static func validate(_ s:Snapshot)throws{
    guard s.records.count<=maxDevices,Set(s.records.map(\.pin)).count==s.records.count,Set(s.records.map(\.id)).count==s.records.count,Set(s.records.map(\.account)).count<=maxAccounts else{throw Failure.unavailable}
  }
  private struct Reader{
    let data:Data;var offset=0
    mutating func take(_ count:Int)throws->Data{guard count>=0,offset<=data.count-count else{throw Failure.unavailable};let value=data.subdata(in:offset..<offset+count);offset+=count;return value}
    mutating func number(_ count:Int)throws->UInt64{var value:UInt64=0;for byte in try take(count){value=(value<<8)|UInt64(byte)};return value}
  }
  private static func decode(_ clear:Data,account:String)throws->Snapshot{
    guard clear.count>=88,clear.count<=maxBytes else{throw Failure.unavailable};var input=Reader(data:clear)
    guard try input.take(5)==Data([72,71,77,73,1]),try encode(input.take(32))==account else{throw Failure.unavailable}
    let generation=try input.number(8),circle=try input.number(8),kl=try input.number(2),cl=try input.number(2),pin=try input.take(32),count=try input.number(1)
    guard (1...9_007_199_254_740_991).contains(generation),circle<=9_007_199_254_740_991,(1...UInt64(derMax)).contains(kl),(1...UInt64(derMax)).contains(cl),count<=maxDevices else{throw Failure.unavailable}
    var key=try input.take(Int(kl)),cert=try input.take(Int(cl));defer{key.resetBytes(in:0..<key.count);cert.resetBytes(in:0..<cert.count)}
    let s=Snapshot(account:account,generation:Int64(generation),circle:Int64(circle),key:key,certificate:cert,pin:pin)
    do{for _ in 0..<count{let state=try input.number(1);guard state<=1 else{throw Failure.unavailable};s.records.append(try Record(local:input.take(340),remote:input.take(340),active:state==1,owner:account,localPin:pin))};guard input.offset==clear.count else{throw Failure.unavailable};try validate(s);return s}catch{s.wipe();throw Failure.unavailable}
  }
  private static func serialize(_ s:Snapshot)throws->Data{
    var result=Data([72,71,77,73,1]);result.append(decodeHex(s.account));append(UInt64(s.generation),8,to:&result);append(UInt64(s.circle),8,to:&result);append(UInt64(s.key.count),2,to:&result);append(UInt64(s.certificate.count),2,to:&result);result.append(s.pin);result.append(UInt8(s.records.count));result.append(s.key);result.append(s.certificate)
    for row in s.records{result.append(row.active ? 1:0);result.append(row.local);result.append(row.remote)};guard result.count<=maxBytes else{result.resetBytes(in:0..<result.count);throw Failure.unavailable};return result
  }
  private static func append(_ value:UInt64,_ count:Int,to data:inout Data){for shift in stride(from:(count-1)*8,through:0,by:-8){data.append(UInt8(truncatingIfNeeded:value>>shift))}}
  private static func increment(_ value:Int64)throws->Int64{guard revision(value),value<9_007_199_254_740_991 else{throw Failure.unavailable};return value+1}
  private static func revision(_ value:Int64)->Bool{(0...9_007_199_254_740_991).contains(value)}
  private static func hex(_ value:String)->Bool{value.utf8.count==64&&value.utf8.allSatisfy{(48...57).contains($0)||(97...102).contains($0)}}
  private static func encode(_ data:Data)->String{data.map{String(format:"%02x",$0)}.joined()}
  private static func decodeHex(_ value:String)->Data{var result=Data();let bytes=Array(value.utf8);for i in stride(from:0,to:bytes.count,by:2){let a=bytes[i],b=bytes[i+1];result.append((a<=57 ? a-48:a-87)*16+(b<=57 ? b-48:b-87))};return result}
  private static func owned(_ data:Data)->Data{data.withUnsafeBytes{Data(bytes:$0.baseAddress!,count:$0.count)}}
}
