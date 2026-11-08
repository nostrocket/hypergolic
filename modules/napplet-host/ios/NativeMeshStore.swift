import Foundation
import CryptoKit
import Darwin

/// Native-only account data. All synchronous filesystem work belongs on a native worker, never the UI thread.
public final class NativeMeshStore:@unchecked Sendable {
  public static let eventBytes:Int64=64*1024*1024,blobBytes:Int64=64*1024*1024,ledgerBytes:Int64=64*1024*1024,eventCount=20_000,frameBytes=8192,recordBytes=16_384
  public enum Code:Sendable {case invalid,denied,full,unavailable}
  public struct Failure:Error,Sendable {public let code:Code;public let mutationUnknown:Bool;init(_ code:Code,_ unknown:Bool=false){self.code=code;mutationUnknown=unknown}}
  public protocol Owner:AnyObject,Sendable {
    var account:String{get};var originalDeadlineMillis:Int64{get};var monotonicMillis:Int64{get};var wallSeconds:Int64{get};var current:Bool{get}
    func withCurrentMutation(_ action:()throws->Void)throws
  }
  public typealias Verifier=@Sendable(String,Data,String)->Bool
  enum Stage {case staged,fileSynced,renamed,directorySynced,ledgerAppended}
  public struct Limits:Sendable {
    public let events,blobs,ledger:Int64;public let count:Int
    public init(){events=NativeMeshStore.eventBytes;count=NativeMeshStore.eventCount;blobs=NativeMeshStore.blobBytes;ledger=NativeMeshStore.ledgerBytes}
    public init(events:Int64,count:Int,blobs:Int64,ledger:Int64)throws{guard events>0,events<=NativeMeshStore.eventBytes,count>0,count<=NativeMeshStore.eventCount,blobs>0,blobs<=NativeMeshStore.blobBytes,ledger>=64,ledger<=NativeMeshStore.ledgerBytes,ledger%64==0 else{throw Failure(.invalid)};self.events=events;self.count=count;self.blobs=blobs;self.ledger=ledger}
  }
  public struct EventHeader:Sendable {
    public let id,author,signature:String;public let createdAt:Int64;public let kind:Int
    public init(id:String,author:String,createdAt:Int64,kind:Int,signature:String){self.id=id;self.author=author;self.createdAt=createdAt;self.kind=kind;self.signature=signature}
  }
  public struct EventBody:Sendable {
    public let content:String,tags:[[String]]
    public init(content:String,tags:[[String]])throws{guard content.utf8.count<=frameBytes,tags.count<=256,tags.allSatisfy({$0.count<=64&&$0.allSatisfy({$0.utf8.count<=frameBytes})}) else{throw Failure(.invalid)};self.content=content;self.tags=tags}
  }
  public final class Event:Sendable {
    public let id,author,content,signature,canonical,wire:String,createdAt:Int64,kind:Int,tags:[[String]],expiration:Int64?
    fileprivate let brand:UUID
    fileprivate init(_ header:EventHeader,_ body:EventBody,_ brand:UUID)throws{
      guard NativeMeshStore.hex(header.id),NativeMeshStore.hex(header.author),NativeMeshStore.safe(header.createdAt),(0...65535).contains(header.kind),header.signature.utf8.count==128,header.signature.utf8.allSatisfy(NativeMeshStore.hexDigit) else{throw Failure(.invalid)}
      id=header.id;author=header.author;signature=header.signature;createdAt=header.createdAt;kind=header.kind;content=body.content;tags=body.tags;self.brand=brand
      let quoted=NativeCanonicalJSON.quote(content);var budget=quoted.utf8.count+2,encoded:[String]=[];var expires:Int64?
      for tag in tags{
        budget+=3;var fields:[String]=[]
        for field in tag{let value=NativeCanonicalJSON.quote(field);budget+=value.utf8.count+1;guard budget<=frameBytes else{throw Failure(.invalid)};fields.append(value)}
        if tag.first=="expiration"{guard expires==nil,tag.count==2,!tag[1].isEmpty,tag[1].utf8.count<=16,tag[1].utf8.allSatisfy({(48...57).contains($0)}),let value=Int64(tag[1]),NativeMeshStore.safe(value) else{throw Failure(.invalid)};expires=value}
        encoded.append("["+fields.joined(separator:",")+"]")
      }
      expiration=expires;let tagJSON="["+encoded.joined(separator:",")+"]"
      canonical="[0,\(NativeCanonicalJSON.quote(author)),\(createdAt),\(kind),\(tagJSON),\(quoted)]"
      guard NativeMeshStore.encode(NativeMeshStore.hash(Data(canonical.utf8)))==id else{throw Failure(.invalid)}
      wire="{\"id\":\"\(id)\",\"pubkey\":\"\(author)\",\"created_at\":\(createdAt),\"kind\":\(kind),\"tags\":\(tagJSON),\"content\":\(quoted),\"sig\":\"\(signature)\"}"
      guard ("[\"EVENT\","+wire+"]").utf8.count<=frameBytes else{throw Failure(.invalid)}
    }
    public var ephemeral:Bool{(20000...29999).contains(kind)}
    fileprivate func live(_ wall:Int64)->Bool{expiration.map{wall<$0} ?? true}
  }
  public struct FilterWindow:Sendable {public let since,until,limit:Int64?;public init(since:Int64?=nil,until:Int64?=nil,limit:Int64?=nil){self.since=since;self.until=until;self.limit=limit}}
  public final class Filter:Sendable {
    private let ids,authors:Set<String>?,kinds:Set<Int>?,tags:[String:Set<Data>]
    public let since,until:Int64?;public let limit:Int
    public init(ids:[String]?=nil,authors:[String]?=nil,kinds:[Int]?=nil,tags:[String:[String]]=[:],window:FilterWindow=FilterWindow())throws{
      self.ids=try Self.strings(ids,true);self.authors=try Self.strings(authors,true)
      if let kinds{guard !kinds.isEmpty,kinds.count<=64,kinds.allSatisfy({(0...65535).contains($0)}) else{throw Failure(.invalid)}};self.kinds=kinds.map(Set.init)
      guard [window.since,window.until,window.limit].allSatisfy({$0.map(NativeMeshStore.safe) ?? true}),window.since==nil||window.until==nil||window.since!<=window.until! else{throw Failure(.invalid)}
      since=window.since;until=window.until;limit=Int(min(32,window.limit ?? 32));guard tags.count<=52 else{throw Failure(.invalid)};var copied:[String:Set<Data>]=[:]
      for(key,values) in tags{let chars=Array(key.utf8);guard chars.count==2,chars[0]==35,((65...90).contains(chars[1])||(97...122).contains(chars[1])) else{throw Failure(.invalid)};_ = try Self.strings(values,key=="#e"||key=="#p");copied[String(key.dropFirst())]=Set(values.map{Data($0.utf8)})};self.tags=copied
    }
    private static func strings(_ values:[String]?,_ hexadecimal:Bool)throws->Set<String>?{guard let values else{return nil};guard !values.isEmpty,values.count<=64,values.allSatisfy({$0.utf8.count<=1024&&(!hexadecimal||NativeMeshStore.hex($0))}) else{throw Failure(.invalid)};return Set(values)}
    fileprivate func matches(_ event:Event,_ stored:Bool)->Bool{
      if stored&&limit==0 || ids.map({!$0.contains(event.id)})==true || authors.map({!$0.contains(event.author)})==true || kinds.map({!$0.contains(event.kind)})==true || since.map({event.createdAt<$0})==true || until.map({event.createdAt>$0})==true{return false}
      for(key,values)in tags{if !event.tags.contains(where:{$0.count>1&&$0[0]==key&&values.contains(Data($0[1].utf8))}){return false}};return true
    }
  }
  /// Independent per-sub dedup only; current-source checks and local/remote snapshot ordering belong to the coordinator.
  public final class DeliveryCursor:@unchecked Sendable {
    private let lock=NSLock(),filters:[Filter],maximum:Int;private var seen:Set<String>=[]
    public init(filters:[Filter],maximumSeen:Int)throws{self.filters=try NativeMeshStore.filters(filters);guard maximumSeen>0,maximumSeen<=eventCount else{throw Failure(.invalid)};maximum=maximumSeen}
    public func accept(_ event:Event,stored:Bool,wall:Int64)throws->Bool{lock.lock();defer{lock.unlock()};guard NativeMeshStore.safe(wall),event.live(wall),!(stored&&event.ephemeral),filters.contains(where:{$0.matches(event,stored)}),!seen.contains(event.id) else{return false};guard seen.count<maximum else{throw Failure(.full)};seen.insert(event.id);return true}
  }
  public enum Kept:Sendable {case durable,duplicate,ephemeral}
  private let directory,events,blobs,index,ledger,lockFile:URL,account:String,verifier:Verifier,limits:Limits,brand=UUID(),lock=NSRecursiveLock()
  private let fault:(Stage)throws->Void,lifecycleLock=NSLock()
  private var closed=false,poisoned=false
  private var forwarded=IdIndex(),ledgerLength:Int64 = -1
  private func state()->(Bool,Bool){lifecycleLock.lock();defer{lifecycleLock.unlock()};return(closed,poisoned)}
  private func poison(){lifecycleLock.lock();poisoned=true;lifecycleLock.unlock()}
  private init(root:URL,account:String,verifier:@escaping Verifier,limits:Limits,fault:@escaping(Stage)throws->Void)throws{
    guard Self.hex(account) else{throw Failure(.invalid)};self.account=account;self.verifier=verifier;self.limits=limits;self.fault=fault
    directory=root.resolvingSymlinksInPath().appendingPathComponent(account,isDirectory:true);events=directory.appendingPathComponent("events",isDirectory:true);blobs=directory.appendingPathComponent("blobs",isDirectory:true);index=directory.appendingPathComponent("shared",isDirectory:true);ledger=directory.appendingPathComponent("forward.bin");lockFile=directory.appendingPathComponent("lock")
  }
  public static func open(root:URL,owner:any Owner,verifier:@escaping Verifier,initialize:Bool,limits:Limits=Limits())throws->NativeMeshStore{try open(root:root,owner:owner,verifier:verifier,initialize:initialize,limits:limits,fault:{_ in})}
  static func open(root:URL,owner:any Owner,verifier:@escaping Verifier,initialize:Bool,limits:Limits,fault:@escaping(Stage)throws->Void)throws->NativeMeshStore{
    let store=try NativeMeshStore(root:root,account:owner.account,verifier:verifier,limits:limits,fault:fault),a=try Access(store,owner);try a.check()
    do{
      if !FileManager.default.fileExists(atPath:store.directory.path){guard initialize else{throw Failure(.unavailable)};try owner.withCurrentMutation{try a.check();try store.requireDirectory(root.resolvingSymlinksInPath());a.changed=true;for path in[store.directory,store.events,store.blobs,store.index]{try FileManager.default.createDirectory(at:path,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])};try store.atomic(a,store.directory.appendingPathComponent("format"),store.header("HGMS1"));try store.atomic(a,store.ledger,store.header("HGML1"));try store.syncDirectory(root.resolvingSymlinksInPath());try a.check()}}
      try store.operation(owner){access in try store.requireDirectory(store.directory);try store.requireDirectory(store.events);try store.requireDirectory(store.blobs);try store.requireDirectory(store.index);guard try store.read(access,store.directory.appendingPathComponent("format"),64)==store.header("HGMS1") else{throw Failure(.unavailable)};try store.loadLedger(access)}
      return store
    }catch let failure as Failure{throw Failure(failure.code,failure.mutationUnknown||a.changed)}catch{throw Failure(.unavailable,a.changed)}
  }
  private final class Access {
    unowned let store:NativeMeshStore;let owner:any Owner,deadline:Int64;var last:Int64 = -1,revoked=false,changed=false
    init(_ store:NativeMeshStore,_ owner:any Owner)throws{guard store.account==owner.account else{throw Failure(.denied)};self.store=store;self.owner=owner;deadline=owner.originalDeadlineMillis}
    func check()throws{let current=owner.current,ownerAccount=owner.account,now=owner.monotonicMillis,state=store.state();guard !revoked,!state.0,current,store.account==ownerAccount,now>=0,now>=last,now<deadline else{revoked=true;throw Failure(.denied,changed)};last=now;guard !state.1 else{throw Failure(.unavailable,changed)}}
    func wall()throws->Int64{try check();let value=owner.wallSeconds;try check();guard NativeMeshStore.safe(value) else{throw Failure(.denied,changed)};return value}
  }
  private func operation<T>(_ owner:any Owner,_ body:(Access)throws->T)throws->T{
    let a=try Access(self,owner);try a.check();while !lock.try(){try a.check();Thread.sleep(forTimeInterval:0.01)};defer{lock.unlock()};try a.check()
    do{let path=try checked(lockFile);let fd=Darwin.open(path.path,O_RDWR|O_CREAT|O_NOFOLLOW,0o600);guard fd>=0 else{throw Failure(.unavailable)};defer{_ = Darwin.close(fd)}
      while flock(fd,LOCK_EX|LOCK_NB) != 0{guard errno==EWOULDBLOCK else{throw Failure(.unavailable)};try a.check();Thread.sleep(forTimeInterval:0.01)};defer{_ = flock(fd,LOCK_UN)}
      try a.check();let result=try body(a);try a.check();return result
    }catch let failure as Failure{if failure.code == .unavailable{poison()};throw Failure(failure.code,failure.mutationUnknown||a.changed)}catch{poison();throw Failure(.unavailable,a.changed)}
  }
  public func captureVerified(_ owner:any Owner,header:EventHeader,body:EventBody)throws->Event{let a=try Access(self,owner);try a.check();let event=try Event(header,body,brand);try verify(a,event);return event}
  private func verify(_ a:Access,_ event:Event)throws{try a.check();guard event.live(try a.wall()),verifier(event.author,Self.decode(event.id),event.signature) else{throw Failure(.invalid)};try a.check();guard event.live(try a.wall()) else{throw Failure(.invalid,a.changed)}}
  private func requireEvent(_ a:Access,_ event:Event)throws{guard event.brand==brand else{throw Failure(.invalid)};try a.check();guard event.live(try a.wall()) else{throw Failure(.invalid,a.changed)}}
  public func keep(_ owner:any Owner,_ event:Event)throws->Kept{try operation(owner){a in try requireEvent(a,event);if event.ephemeral{return .ephemeral};let target=events.appendingPathComponent(event.id+".evt")
    if FileManager.default.fileExists(atPath:target.path){let prior=try decodeEvent(a,read(a,target,Self.recordBytes));guard prior.id==event.id else{throw Failure(.unavailable)};try verify(a,prior);return .duplicate}
    var used:Int64=0,count=0;for file in try list(events){try a.check();guard Self.eventName(file.lastPathComponent) else{throw Failure(.unavailable)};used+=try length(file);count+=1};let record=try encodeEvent(event);guard count<limits.count,Int64(record.count)<=limits.events-used else{throw Failure(.full)}
    try owner.withCurrentMutation{try requireEvent(a,event);try atomic(a,target,record);try requireEvent(a,event)};return .durable}}
  public func claimForward(_ owner:any Owner,_ event:Event)throws->Bool{try operation(owner){a in try requireEvent(a,event);try loadLedger(a);let id=Self.decode(event.id);if try forwarded.contains(id,a){return false};guard ledgerLength-Int64(header("HGML1").count)<limits.ledger else{throw Failure(.full)}
    let row=id+Self.hash(id);try owner.withCurrentMutation{try requireEvent(a,event);let file=try FileHandle(forWritingTo:checked(ledger));defer{try? file.close()};_ = try file.seekToEnd();a.changed=true;try file.write(contentsOf:row);try fault(.ledgerAppended);try file.synchronize();try requireEvent(a,event)};try forwarded.add(id,a);ledgerLength+=64;return true}}
  public func backlog(_ owner:any Owner,filters input:[Filter])throws->[Event]{let requested=try Self.filters(input);return try operation(owner){a in
    var selected=Array(repeating:[Event](),count:requested.count);var used:Int64=0;let files=try list(events);guard files.count<=limits.count else{throw Failure(.unavailable)}
    for file in files{try a.check();guard Self.eventName(file.lastPathComponent) else{throw Failure(.unavailable)};used+=try length(file);guard used<=limits.events else{throw Failure(.unavailable)};let event=try decodeEvent(a,read(a,file,Self.recordBytes));guard file.lastPathComponent==event.id+".evt",!event.ephemeral else{throw Failure(.unavailable)};guard event.live(try a.wall()) else{continue}
      for i in requested.indices where requested[i].matches(event,true){selected[i].append(event);selected[i].sort(by:Self.newest);if selected[i].count>requested[i].limit{selected[i].removeLast()}}
    }
    var unique:[String:Event]=[:];for rows in selected{for event in rows{unique[event.id]=event}};let result=unique.values.sorted(by:Self.newest);for event in result{try verify(a,event)};return result}}
  public func shareBlob(_ owner:any Owner,hash:String,bytes:Data)throws{guard Self.hex(hash),Int64(bytes.count)<=limits.blobs,Self.encode(Self.hash(bytes))==hash else{throw Failure(.invalid)}
    try operation(owner){a in let data=blobs.appendingPathComponent(hash+".blob"),marker=index.appendingPathComponent(hash+".idx");if FileManager.default.fileExists(atPath:marker.path){try checkBlob(a,hash);return}
      var used:Int64=0;for file in try list(blobs){try a.check();guard Self.blobName(file.lastPathComponent) else{throw Failure(.unavailable)};used+=try length(file)};if FileManager.default.fileExists(atPath:data.path){try checkHash(a,data,hash,Int64(bytes.count))}else{guard Int64(bytes.count)<=limits.blobs-used else{throw Failure(.full)}}
      try owner.withCurrentMutation{try a.check();if !FileManager.default.fileExists(atPath:data.path){try atomic(a,data,bytes)};try checkHash(a,data,hash,Int64(bytes.count));try atomic(a,marker,blobMarker(hash,Int64(bytes.count)));try a.check()}}}
  public func unshareBlob(_ owner:any Owner,hash:String)throws{guard Self.hex(hash) else{throw Failure(.invalid)};try operation(owner){a in let marker=index.appendingPathComponent(hash+".idx"),data=blobs.appendingPathComponent(hash+".blob");if FileManager.default.fileExists(atPath:marker.path){try checkBlob(a,hash)}
    try owner.withCurrentMutation{try a.check();if FileManager.default.fileExists(atPath:marker.path){a.changed=true;try FileManager.default.removeItem(at:checked(marker));try syncDirectory(index)};try a.check();if FileManager.default.fileExists(atPath:data.path){a.changed=true;try FileManager.default.removeItem(at:checked(data));try syncDirectory(blobs)};try a.check()}}}
  public func presence(_ owner:any Owner,hashes:[String])throws->[String:Int]{guard hashes.count<=64,hashes.allSatisfy(Self.hex) else{throw Failure(.invalid)};return try operation(owner){a in var result:[String:Int]=[:];for hash in hashes{try a.check();if FileManager.default.fileExists(atPath:index.appendingPathComponent(hash+".idx").path){try checkBlob(a,hash);result[hash]=1}else{result[hash]=0}};return result}}
  private func checkBlob(_ a:Access,_ id:String)throws{let marker=try read(a,index.appendingPathComponent(id+".idx"),160);guard marker.count==109,marker.starts(with:header("HGMB1")),marker.subdata(in:37..<69)==Self.decode(id),marker.suffix(32)==Self.hash(marker.prefix(77)) else{throw Failure(.unavailable)};var reader=Reader(marker.subdata(in:69..<77));let raw=try reader.u64();guard raw<=UInt64(limits.blobs) else{throw Failure(.unavailable)};try checkHash(a,blobs.appendingPathComponent(id+".blob"),id,Int64(raw))}
  private func checkHash(_ a:Access,_ file:URL,_ expected:String,_ size:Int64)throws{guard try length(file)==size else{throw Failure(.unavailable)};let handle=try FileHandle(forReadingFrom:checked(file));defer{try? handle.close()};var digest=SHA256();while let chunk=try handle.read(upToCount:16384),!chunk.isEmpty{try a.check();digest.update(data:chunk)};guard Self.encode(Data(digest.finalize()))==expected else{throw Failure(.unavailable)};try a.check()}
  private func blobMarker(_ id:String,_ size:Int64)->Data{var bytes=header("HGMB1")+Self.decode(id);Self.put64(&bytes,UInt64(size));return bytes+Self.hash(bytes)}
  private func loadLedger(_ a:Access)throws{let size=try length(ledger),head=header("HGML1");if size==ledgerLength{return};guard size>=Int64(head.count),(size-Int64(head.count))%64==0,size-Int64(head.count)<=limits.ledger else{throw Failure(.unavailable)}
    let file=try FileHandle(forReadingFrom:checked(ledger));defer{try? file.close()};guard try file.read(upToCount:head.count)==head else{throw Failure(.unavailable)};let loaded=IdIndex();var position=Int64(head.count)
    while position<size{try a.check();guard let row=try file.read(upToCount:64),row.count==64 else{throw Failure(.unavailable)};let id=row.prefix(32);guard row.suffix(32)==Self.hash(id),try !loaded.contains(id,a) else{throw Failure(.unavailable)};try loaded.add(id,a);position+=64};forwarded=loaded;ledgerLength=size
  }
  private func encodeEvent(_ event:Event)throws->Data{var bytes=header("HGME1")+Self.decode(event.id)+Self.decode(event.author);Self.put64(&bytes,UInt64(event.createdAt));Self.put32(&bytes,UInt32(event.kind));bytes+=Self.decode(event.signature);Self.putText(&bytes,event.content);Self.put32(&bytes,UInt32(event.tags.count));for tag in event.tags{Self.put32(&bytes,UInt32(tag.count));for value in tag{Self.putText(&bytes,value)}};guard bytes.count+32<=Self.recordBytes else{throw Failure(.invalid)};return bytes+Self.hash(bytes)}
  private func decodeEvent(_ a:Access,_ data:Data)throws->Event{guard data.count>=177,data.starts(with:header("HGME1")),data.suffix(32)==Self.hash(data.dropLast(32)) else{throw Failure(.unavailable)}
    do{var reader=Reader(data.subdata(in:37..<(data.count-32)));let id=Self.encode(try reader.bytes(32)),author=Self.encode(try reader.bytes(32)),created=try reader.u64(),kind=try reader.u32(),signature=Self.encode(try reader.bytes(64)),content=try reader.text();guard created<=9_007_199_254_740_991,kind<=65535 else{throw Failure(.unavailable)};let count=try reader.u32();guard count<=256 else{throw Failure(.unavailable)};var tags:[[String]]=[]
      for _ in 0..<count{try a.check();let fields=try reader.u32();guard fields<=64 else{throw Failure(.unavailable)};var tag:[String]=[];for _ in 0..<fields{tag.append(try reader.text())};tags.append(tag)};guard reader.remaining==0 else{throw Failure(.unavailable)}
      return try Event(EventHeader(id:id,author:author,createdAt:Int64(created),kind:Int(kind),signature:signature),EventBody(content:content,tags:tags),brand)
    }catch{throw Failure(.unavailable)}
  }
  private func atomic(_ a:Access,_ target:URL,_ data:Data)throws{try a.check();_ = try checked(target);let staged=target.deletingLastPathComponent().appendingPathComponent(".tmp-"+UUID().uuidString);let fd=Darwin.open(staged.path,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0o600);guard fd>=0 else{throw Failure(.unavailable)};var fileClosed=false,moved=false
    defer{if !fileClosed{_ = Darwin.close(fd)};if !moved{_ = unlink(staged.path)}}
    try data.withUnsafeBytes{raw in var offset=0;while offset<raw.count{try a.check();let n=Darwin.write(fd,raw.baseAddress!.advanced(by:offset),min(16384,raw.count-offset));guard n>0 else{throw Failure(.unavailable)};offset+=n}}
    try fault(.staged);try a.check();guard fsync(fd)==0 else{throw Failure(.unavailable)};try fault(.fileSynced);try a.check();guard Darwin.close(fd)==0 else{throw Failure(.unavailable)};fileClosed=true;a.changed=true;guard Darwin.rename(staged.path,target.path)==0 else{throw Failure(.unavailable,true)};moved=true;try fault(.renamed);try a.check();try syncDirectory(target.deletingLastPathComponent());try fault(.directorySynced);try a.check();guard try read(a,target,data.count)==data else{throw Failure(.unavailable,true)}
  }
  private func read(_ a:Access,_ file:URL,_ maximum:Int)throws->Data{let n=try length(file);guard n>=0,n<=Int64(maximum) else{throw Failure(.unavailable)};let handle=try FileHandle(forReadingFrom:checked(file));defer{try? handle.close()};var data=Data();while let chunk=try handle.read(upToCount:16384),!chunk.isEmpty{try a.check();guard data.count+chunk.count<=maximum else{throw Failure(.unavailable)};data+=chunk};try a.check();return data}
  private func checked(_ url:URL)throws->URL{guard url.standardizedFileURL==url.resolvingSymlinksInPath().standardizedFileURL else{throw Failure(.unavailable)};return url}
  private func requireDirectory(_ url:URL)throws{let path=try checked(url);var directory:ObjCBool=false;guard FileManager.default.fileExists(atPath:path.path,isDirectory:&directory),directory.boolValue else{throw Failure(.unavailable)}}
  private func list(_ url:URL)throws->[URL]{try requireDirectory(url);return try FileManager.default.contentsOfDirectory(at:checked(url),includingPropertiesForKeys:nil,options:[])}
  private func length(_ url:URL)throws->Int64{let path=try checked(url),attrs=try FileManager.default.attributesOfItem(atPath:path.path);guard attrs[.type] as? FileAttributeType == .typeRegular,let size=attrs[.size] as? NSNumber else{throw Failure(.unavailable)};return size.int64Value}
  private func syncDirectory(_ url:URL)throws{let path=try checked(url);let fd=Darwin.open(path.path,O_RDONLY|O_NOFOLLOW);guard fd>=0 else{throw Failure(.unavailable)};defer{_ = Darwin.close(fd)};var status=stat();guard fstat(fd,&status)==0,(status.st_mode&S_IFMT)==S_IFDIR,fsync(fd)==0 else{throw Failure(.unavailable)}}
  private func header(_ magic:String)->Data{Data(magic.utf8)+Self.decode(account)}
  private static func filters(_ input:[Filter])throws->[Filter]{guard !input.isEmpty,input.count<=4 else{throw Failure(.invalid)};return input}
  private static func newest(_ a:Event,_ b:Event)->Bool{a.createdAt==b.createdAt ? a.id<b.id:a.createdAt>b.createdAt}
  private static func safe(_ value:Int64)->Bool{(0...9_007_199_254_740_991).contains(value)}
  private static func hexDigit(_ b:UInt8)->Bool{(48...57).contains(b)||(97...102).contains(b)}
  private static func hex(_ value:String)->Bool{value.utf8.count==64&&value.utf8.allSatisfy(hexDigit)}
  private static func eventName(_ value:String)->Bool{value.hasSuffix(".evt")&&hex(String(value.dropLast(4)))}
  private static func blobName(_ value:String)->Bool{value.hasSuffix(".blob")&&hex(String(value.dropLast(5)))}
  private static func hash(_ data:Data)->Data{Data(SHA256.hash(data:data))}
  private static func encode(_ data:Data)->String{data.map{String(format:"%02x",$0)}.joined()}
  private static func decode(_ string:String)->Data{let bytes=Array(string.utf8);return Data(stride(from:0,to:bytes.count,by:2).map{i in let a=bytes[i],b=bytes[i+1];return(a<=57 ? a-48:a-87)*16+(b<=57 ? b-48:b-87)})}
  private static func put32(_ data:inout Data,_ value:UInt32){var v=value.bigEndian;withUnsafeBytes(of:&v){data.append(contentsOf:$0)}}
  private static func put64(_ data:inout Data,_ value:UInt64){var v=value.bigEndian;withUnsafeBytes(of:&v){data.append(contentsOf:$0)}}
  private static func putText(_ data:inout Data,_ value:String){let raw=Data(value.utf8);put32(&data,UInt32(raw.count));data+=raw}
  private struct Reader {
    let data:Data;var position=0;init(_ data:Data){self.data=data};var remaining:Int{data.count-position}
    mutating func bytes(_ n:Int)throws->Data{guard n>=0,n<=remaining else{throw Failure(.unavailable)};let result=data.subdata(in:position..<(position+n));position+=n;return result}
    mutating func u32()throws->UInt32{try bytes(4).reduce(UInt32(0)){($0<<8)|UInt32($1)}}
    mutating func u64()throws->UInt64{try bytes(8).reduce(UInt64(0)){($0<<8)|UInt64($1)}}
    mutating func text()throws->String{let n=try u32();guard n<=frameBytes,let result=String(data:try bytes(Int(n)),encoding:.utf8) else{throw Failure(.unavailable)};return result}
  }
  /// Compact exact append-only index; default full ledger uses32MiB IDs +8MiB Int32 slots.
  private final class IdIndex {
    var ids=[UInt8](repeating:0,count:32*16),slots=[Int32](repeating:0,count:32),count=0
    func slot(_ id:Data,_ a:Access)throws->Int{var hash:UInt32=1;for byte in id{hash=hash&*31&+UInt32(byte)};var slot=Int(hash)&(slots.count-1)
      for n in 0..<slots.count{if n&255==0{try a.check()};let value=Int(slots[slot]);if value==0{return slot};if id.elementsEqual(ids[((value-1)*32)..<(value*32)]){return slot};slot=(slot+1)&(slots.count-1)};throw Failure(.full)}
    func contains(_ id:Data,_ a:Access)throws->Bool{try slots[slot(id,a)] != 0}
    func add(_ id:Data,_ a:Access)throws{if try contains(id,a){return};if count==ids.count/32{ids += [UInt8](repeating:0,count:ids.count);slots=[Int32](repeating:0,count:slots.count*2);for i in 0..<count{if i&255==0{try a.check()};let value=Data(ids[(i*32)..<((i+1)*32)]);slots[try slot(value,a)]=Int32(i+1)}};ids.replaceSubrange((count*32)..<((count+1)*32),with:id);let location=try slot(id,a);count+=1;slots[location]=Int32(count)}
  }
  public func close(){lifecycleLock.lock();closed=true;lifecycleLock.unlock()}
}
