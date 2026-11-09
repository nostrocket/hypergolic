import Foundation
import Security
import CryptoKit

@main struct IdentityProof {
  static let user=String(repeating:"11",count:32)
  nonisolated(unsafe) static var checks=0,imports=0,closed=0,key=Data(),cert=Data(),localPin=Data()
  static func check(_ b:Bool){checks+=1;precondition(b,"check \(checks)")}
  static func denied(_ action:()throws->Void){do{try action();preconditionFailure("expected denial")}catch{checks+=1}}
  final class Gate:@unchecked Sendable{var current=true}
  final class Memory:NativeMeshIdentityStore.Backend{var value:Data?,writes=0,fail=false;func read()throws->Data?{value};func write(_ clear:Data,initialize:Bool)throws{if fail{throw NativeMeshIdentityStore.Failure.unavailable};check(initialize==(value==nil));value=clear;writes+=1}}
  final class Port:NativeMeshIdentityStore.CredentialPort{
    func importDER(key:Data,certificate:Data)throws->any NativeMeshIdentityStore.Credential{
      let pointer=key.withUnsafeBytes{k in certificate.withUnsafeBytes{c in mesh_store_fixture_import(k.bindMemory(to:UInt8.self).baseAddress,k.count,c.bindMemory(to:UInt8.self).baseAddress,c.count)}}
      guard let pointer else{throw NativeMeshIdentityStore.Failure.unavailable};imports+=1;return Credential(pointer)
    }
  }
  final class Credential:NativeMeshIdentityStore.Credential{var pointer:UnsafeMutableRawPointer?
    init(_ p:UnsafeMutableRawPointer){pointer=p}
    func pin()throws->Data{guard let pointer else{throw NativeMeshIdentityStore.Failure.unavailable};var result=Data(repeating:0,count:32);let ok=result.withUnsafeMutableBytes{mesh_store_fixture_pin(pointer,$0.bindMemory(to:UInt8.self).baseAddress)};guard ok==1 else{throw NativeMeshIdentityStore.Failure.unavailable};return result}
    func close(){if let p=pointer{mesh_store_fixture_close(p);pointer=nil;closed+=1}}
  }
  static func lease(_ g:Gate)throws->NativeMeshIdentityStore.AccountLease{try .init(account:user,epoch:1,vaultRevision:1,current:{g.current})}
  static func store(_ l:NativeMeshIdentityStore.AccountLease,_ b:any NativeMeshIdentityStore.Backend,_ revoke:@escaping ()->Void={})throws->NativeMeshIdentityStore{try .init(lease:l,backend:b,port:Port(),revoke:revoke)}
  static func initialize(_ s:NativeMeshIdentityStore)throws{try s.initialize{sink in try sink(key,cert)}}
  static func binding(_ number:Int,_ account:Int)->(Data,Data){
    var a=Data(repeating:0,count:340);a.replaceSubrange(0..<27,with:Data("hypergolic.mesh.pairing.v1\0".utf8));a[27]=1
    for(range,byte)in[(28..<44,number),(44..<76,5),(76..<108,0x11),(108..<140,account),(172..<204,number+100),(204..<236,6),(236..<268,7),(276..<340,8)]{a.replaceSubrange(range,with:Data(repeating:UInt8(byte),count:range.count))};a.replaceSubrange(140..<172,with:localPin)
    var expiry:UInt64=1_795_000_000;for i in stride(from:275,through:268,by:-1){a[i]=UInt8(truncatingIfNeeded:expiry);expiry>>=8};var b=a;b[27]=2;b.replaceSubrange(276..<340,with:Data(repeating:9,count:64));return(a,b)
  }
  static func commit(_ l:NativeMeshIdentityStore.AccountLease,_ pair:(Data,Data),circle:Int64=0,_ current:@escaping ()->Bool={true})throws->NativeMeshIdentityStore.VerifiedMembershipCommit{try .init(lease:l,circleRevision:circle,local:pair.0,remote:pair.1,proof:current)}
  static func unhex(_ s:String)->Data{var data=Data();var i=s.startIndex;while i<s.endIndex{let end=s.index(i,offsetBy:2);data.append(UInt8(s[i..<end],radix:16)!);i=end};return data}
  static func promote(_ l:NativeMeshIdentityStore.AccountLease,_ p:NativeMeshIdentityStore.Peer)throws->NativeMeshIdentityStore.MembershipPromotion{try .init(lease:l,circleRevision:p.active ? 1:0,pairingId:unhex(p.pairingId),bindingsDigest:unhex(p.bindingsDigest),proof:{true})}
  static func lifecycle(_ output:URL)throws{
    let g=Gate(),b=Memory(),l=try lease(g);var revoked=0;let s=try store(l,b,{revoked+=1});try initialize(s);check(try s.view().generation==1);check(try unhex(s.view().localPin)==localPin);denied{_ = try store(lease(Gate()),Memory())}
    let credential=try s.withCredential();check(try credential.pin()==localPin);let before=imports;let borrow2=try s.withCredential(),borrow3=try s.withCredential(),borrow4=try s.withCredential();denied{_ = try s.withCredential()};check(imports==before);var uses=0;try credential.withNative{native in check(try native.pin()==localPin);uses+=1};check(uses==1);borrow2.close();borrow3.close();borrow4.close();let token=try commit(l,binding(1,0x22));let pending=try s.stage(generation:1,commit:token);check(pending.generation==2&&pending.circleRevision==0&&pending.activeAccounts==0&&pending.peers.count==1);denied{_ = try s.stage(generation:2,commit:token)}
    check(try s.stage(generation:2,commit:commit(l,binding(1,0x22))).generation==2&&b.writes==2);let staleCircle=try commit(l,binding(2,0x22));let promotion=try promote(l,pending.peers[0]);let active=try s.promote(generation:2,promotion:promotion);check(active.generation==3&&active.circleRevision==1&&active.activeAccounts==1);denied{_ = try s.promote(generation:3,promotion:promotion)};denied{_ = try s.stage(generation:3,commit:staleCircle)}
    check(try s.promote(generation:3,promotion:promote(l,active.peers[0])).generation==3);try b.value!.write(to:output.appendingPathComponent("swift-snapshot.bin"));denied{_ = try s.stage(generation:3,commit:commit(lease(Gate()),binding(2,0x33)))};denied{_ = try s.stage(generation:99,commit:commit(l,binding(2,0x33)))}
    var invalid=binding(2,0x33);invalid.1[76]^=1;denied{_ = try s.stage(generation:3,commit:commit(l,invalid,circle:1))};denied{_ = try s.stage(generation:3,commit:commit(l,binding(1,0x33),circle:1))}
    let removed=try s.remove(generation:3,pin:active.peers[0].pin);check(removed.peers.isEmpty&&removed.circleRevision==2&&revoked==2);g.current=false;denied{_ = try s.view()};denied{_ = try credential.pin()};check(revoked==3);s.close();credential.close();g.current=true;let reopened=try store(lease(g),b);check(try reopened.view().generation==4&&reopened.view().peers.isEmpty);reopened.close()
  }
  static func limits()throws{
    let l=try lease(Gate()),s=try store(l,Memory());try initialize(s)
    for i in 1...32{let account=i<=15 ? i:(i==16 ? 0x11:1);check(try s.stage(generation:s.view().generation,commit:commit(l,binding(i,account))).peers.count==i)}
    denied{_ = try s.stage(generation:s.view().generation,commit:commit(l,binding(33,1)))};s.close()
    let l2=try lease(Gate()),s2=try store(l2,Memory());try initialize(s2);for i in 1...16{_ = try s2.stage(generation:s2.view().generation,commit:commit(l2,binding(i,i)))};denied{_ = try s2.stage(generation:s2.view().generation,commit:commit(l2,binding(17,18)))};s2.close()
  }
  static func parser(_ output:URL)throws{
    let valid=try Data(contentsOf:output.appendingPathComponent("java-snapshot.bin"))
    for pos in [0,4,5,37,45,53,54,55,56,89]{let b=Memory();var changed=valid;changed[pos]^=0x80;b.value=changed;denied{_ = try store(lease(Gate()),b)}}
    for length in [0,4,36,87,valid.count-1,valid.count+1,131073]{let b=Memory();var value=Data(valid.prefix(length));if value.count<length{value.append(Data(repeating:0,count:length-value.count))};b.value=value;denied{_ = try store(lease(Gate()),b)}}
    let b=Memory();b.value=valid;let l=try lease(Gate()),s=try store(l,b);b.value![45]^=1;denied{_ = try s.stage(generation:s.view().generation,commit:commit(l,binding(2,1),circle:1))};denied{_ = try s.view()};s.close()
    let corrupt=Memory();corrupt.value=valid;corrupt.value![90]^=1;denied{_ = try store(lease(Gate()),corrupt)}
    let fail=Memory(),l2=try lease(Gate()),s2=try store(l2,fail);try initialize(s2);fail.fail=true;denied{_ = try s2.stage(generation:1,commit:commit(l2,binding(1,1)))};denied{_ = try s2.view()};s2.close()
    let deniedProof=Memory(),l3=try lease(Gate()),s3=try store(l3,deniedProof);try initialize(s3);let token=try commit(l3,binding(1,1),{false});denied{_ = try s3.stage(generation:1,commit:token)};check(try s3.view().peers.isEmpty);s3.close()
  }
  static func ownership()throws{
    let b=Memory(),gate=Gate(),old=try lease(gate),first=try store(old,b);try initialize(first);var pair=binding(7,0x22);let captured=try commit(old,pair);pair.0[172]^=1;check(try first.stage(generation:1,commit:captured).activeAccounts==0);first.close()
    let fresh=try lease(gate),reopened=try store(fresh,b);check(try reopened.view().activeAccounts==0 && !reopened.view().peers[0].active);denied{_ = try reopened.stage(generation:2,commit:commit(old,binding(8,0x22)))}
    let peer=try reopened.view().peers[0],rejected=try NativeMeshIdentityStore.MembershipPromotion(lease:fresh,circleRevision:0,pairingId:unhex(peer.pairingId),bindingsDigest:unhex(peer.bindingsDigest),proof:{false});denied{_ = try reopened.promote(generation:2,promotion:rejected)};denied{_ = try reopened.promote(generation:2,promotion:rejected)};check(try reopened.view().activeAccounts==0);check(try reopened.promote(generation:2,promotion:promote(fresh,peer)).activeAccounts==1)
    var conflict=binding(7,0x22);conflict.0[276]^=1;denied{_ = try reopened.stage(generation:3,commit:commit(fresh,conflict,circle:1))};reopened.close()
    let changed=Memory(),lost=Gate(),l=try lease(lost),stale=try store(l,changed);try initialize(stale);let token=try commit(l,binding(1,1),{lost.current=false;return true});denied{_ = try stale.stage(generation:1,commit:token)};denied{_ = try stale.view()};stale.close()
    let joinMemory=Memory(),joinLease=try lease(Gate()),joiner=try store(joinLease,joinMemory);try initialize(joiner);let source=binding(9,0x22)
    func swap(_ source:Data)->Data{var data=source;data.replaceSubrange(76..<108,with:source.subdata(in:108..<140));data.replaceSubrange(108..<140,with:source.subdata(in:76..<108));data.replaceSubrange(140..<172,with:source.subdata(in:172..<204));data.replaceSubrange(172..<204,with:source.subdata(in:140..<172));return data}
    var join=(swap(source.0),swap(source.1));join.0[27]=2;join.1[27]=1;check(try joiner.stage(generation:1,commit:commit(joinLease,join)).peers[0].account==String(repeating:"22",count:32));joiner.close()
  }
  final class CurrentHook:@unchecked Sendable{var action:(()->Void)?;func current()->Bool{let action=self.action;self.action=nil;action?();return true}}
  static func reentrantLifetime()throws{
    let ownHook=CurrentHook(),own=try NativeMeshIdentityStore.AccountLease(account:user,epoch:1,vaultRevision:1,current:{ownHook.current()});ownHook.action={own.revoke()};check(!own.isCurrent)
    let hook=CurrentHook(),l=try NativeMeshIdentityStore.AccountLease(account:user,epoch:1,vaultRevision:1,current:{hook.current()}),s=try store(l,Memory());try initialize(s);let borrow=try s.withCredential(),before=closed;var invoked=false;hook.action={s.close()}
    denied{try borrow.withNative{_ in invoked=true}};check(!invoked && !l.isCurrent && closed==before+1);borrow.close();s.close();check(closed==before+1)
    let b=Memory(),lease=try lease(Gate()),active=try store(lease,b);try initialize(active);let outer=try active.withCredential(),inner=try active.withCredential(),masterClosed=closed
    denied{try outer.withNative{native in
      denied{try inner.withNative{nested in active.close();check(!lease.isCurrent&&closed==masterClosed);check(try nested.pin()==localPin);denied{_ = try store(self.lease(Gate()),b)};throw NativeMeshIdentityStore.Failure.unavailable}}
      check(closed==masterClosed);check(try native.pin()==localPin);denied{_ = try inner.pin()}
    }}
    check(closed==masterClosed+1);active.close();outer.close();inner.close();check(closed==masterClosed+1)
    let reopened=try store(self.lease(Gate()),b);check(try reopened.view().generation==1);reopened.close()
  }
  static func concurrentLifetime()throws{
    let l=try lease(Gate()),s=try store(l,Memory());try initialize(s);let borrow=try s.withCredential(),before=closed,returned=DispatchSemaphore(value:0)
    denied{try borrow.withNative{native in
      DispatchQueue.global().async{s.close();returned.signal()}
      let deadline=DispatchTime.now().uptimeNanoseconds+2_000_000_000;while l.isCurrent && DispatchTime.now().uptimeNanoseconds<deadline{Thread.sleep(forTimeInterval:0.001)}
      check(!l.isCurrent);check(returned.wait(timeout:.now()) == .timedOut && closed==before);check(try native.pin()==localPin)
    }}
    check(returned.wait(timeout:.now()+2) == .success && closed==before+1);borrow.close();s.close();check(closed==before+1)
  }
  final class Keychain:NativeMeshIdentityKeychain.Port{
    var records:[String:Data]=[:],fail:OSStatus=errSecSuccess,queries:[[String:Any]]=[]
    func read(_ query:[String:Any])->(OSStatus,Data?){queries.append(query);if fail != errSecSuccess{return(fail,nil)};let data=records[query[kSecAttrAccount as String] as! String];return(data==nil ? errSecItemNotFound:errSecSuccess,data)}
    func add(_ query:[String:Any])->OSStatus{queries.append(query);if fail != errSecSuccess{return fail};let account=query[kSecAttrAccount as String] as! String;if records[account] != nil{return errSecDuplicateItem};records[account]=query[kSecValueData as String] as? Data;return errSecSuccess}
    func update(_ query:[String:Any],_ attributes:[String:Any])->OSStatus{queries.append(query);if fail != errSecSuccess{return fail};let account=query[kSecAttrAccount as String] as! String;guard records[account] != nil else{return errSecItemNotFound};records[account]=attributes[kSecValueData as String] as? Data;return errSecSuccess}
  }
  static func keychain()throws{
    let port=Keychain(),gate=Gate(),adapter=try NativeMeshIdentityKeychain(account:user,current:{gate.current},port:port);check(try adapter.read()==nil);try adapter.write(Data([1,2]),initialize:true);check(try adapter.read()==Data([1,2]));try adapter.write(Data([3,4]),initialize:false);check(try adapter.read()==Data([3,4]));let other=try NativeMeshIdentityKeychain(account:String(repeating:"22",count:32),current:{true},port:port);check(try other.read()==nil)
    for query in port.queries{check(query[kSecAttrService as String] as? String=="org.nostrocket.hypergolic.mesh.identity.v1");check(query[kSecAttrSynchronizable as String] as? Bool==false);check(query[kSecUseDataProtectionKeychain as String] as? Bool==true);check(query[kSecAttrAccessGroup as String]==nil)}
    check(port.queries.contains{($0[kSecAttrAccessible as String] as? String)==(kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)})
    port.fail=errSecInteractionNotAllowed;denied{_ = try adapter.read()};port.fail=errSecSuccess;denied{_ = try adapter.read()}
    let locked=try NativeMeshIdentityKeychain(account:user,current:{gate.current},port:port);gate.current=false;denied{try locked.write(Data([5]),initialize:false)};gate.current=true;denied{_ = try locked.read()}
    let mismatch=try NativeMeshIdentityKeychain(account:user,current:{true},port:port);denied{try mismatch.write(Data([1]),initialize:true)}
  }
  static func main()throws{
    let output=URL(fileURLWithPath:CommandLine.arguments[1]);var fixture=try Data(contentsOf:output.appendingPathComponent("credential.fixture"));defer{fixture.resetBytes(in:0..<fixture.count)};var offset=0
    func take(_ count:Int)->Data{defer{offset+=count};return fixture.subdata(in:offset..<offset+count)}
    func size()->Int{take(4).reduce(0){($0<<8)|Int($1)}}
    key=take(size());cert=take(size());localPin=take(32);check(offset==fixture.count)
    try lifecycle(output);try limits();try parser(output);try ownership();try reentrantLifetime();try concurrentLifetime();try keychain();check(imports==closed);let java=try Data(contentsOf:output.appendingPathComponent("java-snapshot.bin")),swift=try Data(contentsOf:output.appendingPathComponent("swift-snapshot.bin"));check(java==swift)
    let hash=Data(SHA256.hash(data:swift)).map{String(format:"%02x",$0)}.joined();print("{\"status\":\"passed\",\"checks\":\(checks),\"actualTLSImports\":\(imports),\"allCredentialsClosed\":true,\"snapshotSHA256\":\"\(hash)\",\"scope\":\"host strict snapshots and Security query/status ports plus actual C TLS DER; no Keychain OS write or device/pairing acceptance\"}")
    key.resetBytes(in:0..<key.count);cert.resetBytes(in:0..<cert.count)
  }
}
