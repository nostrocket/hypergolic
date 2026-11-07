import Foundation

/// NIP19 npub only: case rule, original checksum, exact 32-byte public payload.
enum NativeCommonNpub {
  static func publicKey(_ value:String)throws->String{if value.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil{return value};return try decode(value)}
  static func decode(_ input:String)throws->String{
    guard input.utf8.count==63,input==input.lowercased() || input==input.uppercased(),input.lowercased().hasPrefix("npub1") else{throw NativeOutboxPlan.Failure.invalid}
    let alphabet=Array("qpzry9x8gf2tvdw0s3jn54khce6mua7l"),generators:[UInt32]=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3]
    let data=try input.lowercased().dropFirst(5).map { character->UInt32 in guard let n=alphabet.firstIndex(of:character) else{throw NativeOutboxPlan.Failure.invalid};return UInt32(n) }
    var checksum:UInt32=1
    for number in [3,3,3,3,0,14,16,21,2]+data{
      let high=checksum>>25;checksum=((checksum&0x1ffffff)<<5)^number
      for i in 0...4 where (high>>i)&1 != 0{checksum ^= generators[i]}
    }
    guard checksum==1 else{throw NativeOutboxPlan.Failure.invalid}
    var accumulator:UInt32=0,bits=0,bytes:[UInt8]=[]
    for number in data.dropLast(6){accumulator=((accumulator<<5)|number)&0xffff;bits+=5;while bits>=8{bits-=8;bytes.append(UInt8((accumulator>>bits)&255))}}
    guard bytes.count==32,bits<5,((accumulator<<(8-bits))&255)==0 else{throw NativeOutboxPlan.Failure.invalid}
    return bytes.map{String(format:"%02x",$0)}.joined()
  }
}
