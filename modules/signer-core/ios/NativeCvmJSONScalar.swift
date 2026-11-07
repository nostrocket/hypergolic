import Foundation

/// Counts a single JSON string literal without decoding/replacing escaped lone UTF-16 surrogates.
/// This is not a general MCP parser; full MCP validation stays in the trusted immutable app capture.
enum NativeCvmJSONScalar {
  static func stringBytes(_ literal: String) -> Int? {
    let bytes=Array(literal.utf8)
    guard bytes.count>=2,bytes.first==34,bytes.last==34 else{return nil}
    var index=1,count=0
    func unit(_ start:Int)->UInt16?{
      guard start+4<=bytes.count-1 else{return nil};var value:UInt16=0
      for at in start..<start+4{let byte=bytes[at],digit:UInt16
        if (48...57).contains(byte){digit=UInt16(byte-48)}else if(65...70).contains(byte){digit=UInt16(byte-55)}else if(97...102).contains(byte){digit=UInt16(byte-87)}else{return nil}
        value=value*16+digit
      };return value
    }
    while index<bytes.count-1{
      let byte=bytes[index];index+=1
      if byte==92{
        guard index<bytes.count-1 else{return nil};let escape=bytes[index];index+=1
        if escape==117{
          guard let value=unit(index)else{return nil};index+=4
          if(0xd800...0xdbff).contains(value),index+6<=bytes.count-1,bytes[index]==92,bytes[index+1]==117,
            let low=unit(index+2),(0xdc00...0xdfff).contains(low){index+=6;count+=4}
          else if(0xd800...0xdfff).contains(value){count+=3}
          else{count+=value<128 ? 1:value<2048 ? 2:3}
        }else{guard [34,92,47,98,102,110,114,116].contains(escape)else{return nil};count+=1}
      }else{guard byte>=32,byte != 34 else{return nil};count+=1}
    }
    return count
  }
}
