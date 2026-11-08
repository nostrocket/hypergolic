import Foundation
import Security
import CryptoKit

/// Dedicated native transport-secret service, never the identity/signing Keychain namespace.
final class NativeMeshIdentityKeychain:NativeMeshIdentityStore.Backend {
  protocol Port:AnyObject{func read(_ query:[String:Any])->(OSStatus,Data?);func add(_ query:[String:Any])->OSStatus;func update(_ query:[String:Any],_ attributes:[String:Any])->OSStatus}
  final class SystemPort:Port{
    func read(_ query:[String:Any])->(OSStatus,Data?){var value:CFTypeRef?;let status=SecItemCopyMatching(query as CFDictionary,&value);return(status,value as? Data)}
    func add(_ query:[String:Any])->OSStatus{SecItemAdd(query as CFDictionary,nil)}
    func update(_ query:[String:Any],_ attributes:[String:Any])->OSStatus{SecItemUpdate(query as CFDictionary,attributes as CFDictionary)}
  }
  private let account:String,current:()->Bool,port:any Port
  private var failed=false
  init(account:String,current:@escaping ()->Bool,port:any Port=SystemPort())throws{
    guard account.utf8.count==64,account.utf8.allSatisfy({(48...57).contains($0)||(97...102).contains($0)}) else{throw NativeMeshIdentityStore.Failure.unavailable}
    self.account=Data(SHA256.hash(data:Data(account.utf8))).map{String(format:"%02x",$0)}.joined();self.current=current;self.port=port
  }
  private var query:[String:Any]{[
    kSecClass as String:kSecClassGenericPassword,
    kSecAttrService as String:"org.nostrocket.hypergolic.mesh.identity.v1",
    kSecAttrAccount as String:account,
    kSecAttrSynchronizable as String:false,
    kSecUseDataProtectionKeychain as String:true
  ]}
  private func active()throws{guard !failed,current(),!failed else{failed=true;throw NativeMeshIdentityStore.Failure.unavailable}}
  func read()throws->Data?{
    do{try active();var request=query;request[kSecMatchLimit as String]=kSecMatchLimitOne;request[kSecReturnData as String]=true
      let(status,result)=port.read(request);try active();if status==errSecItemNotFound{return nil}
      guard status==errSecSuccess,let data=result,!data.isEmpty,data.count<=NativeMeshIdentityStore.maxBytes else{throw NativeMeshIdentityStore.Failure.unavailable};return data
    }catch{failed=true;throw NativeMeshIdentityStore.Failure.unavailable}
  }
  func write(_ clear:Data,initialize:Bool)throws{
    do{try active();guard !clear.isEmpty,clear.count<=NativeMeshIdentityStore.maxBytes else{throw NativeMeshIdentityStore.Failure.unavailable}
      var existing=try read();defer{if existing != nil{existing!.resetBytes(in:0..<existing!.count)}};guard initialize==(existing==nil) else{throw NativeMeshIdentityStore.Failure.unavailable}
      let status:OSStatus
      if initialize{var add=query;add[kSecAttrAccessible as String]=kSecAttrAccessibleWhenUnlockedThisDeviceOnly;add[kSecValueData as String]=clear;status=port.add(add)}
      else{status=port.update(query,[kSecValueData as String:clear])}
      try active();guard status==errSecSuccess,try read()==clear else{throw NativeMeshIdentityStore.Failure.unavailable}
    }catch{failed=true;throw NativeMeshIdentityStore.Failure.unavailable}
  }
}
