import Foundation
@main struct Proof {
  static func main() throws {
    var checks=0
    func check(_ value:Bool){precondition(value);checks += 1}
    func denied(_ block:() throws -> Void){do{try block();fatalError("Expected denial")}catch{checks += 1}}
    func frame(_ third:Int)->Data{
      let rates=[44100,48000,32000],bitrate=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0]
      var data=Data(repeating:0,count:144000*bitrate[third>>4]/rates[(third>>2)&3]+((third>>1)&1));data.replaceSubrange(0..<4,with:[255,251,UInt8(third),196]);return data
    }
    func feed(_ gate:LiveMP3Gate,_ bytes:Data,_ size:Int)throws{var n=0;while n<bytes.count{let end=min(bytes.count,n+size);try gate.append(bytes.subdata(in:n..<end));n=end}}
    for size in [1,3,4,7,417,8192]{var output=Data();let gate=LiveMP3Gate{output.append($0)};try feed(gate,frame(0x90),size);try feed(gate,frame(0x50),size);try gate.finish();check(output.count==625)}
    var id3=Data(repeating:0,count:65536);id3.replaceSubrange(0..<10,with:[73,68,51,4,0,0,0,3,127,118]);var size=65526
    for index in stride(from:9,through:6,by:-1){id3[index]=UInt8(size&127);size >>= 7}
    let exact=LiveMP3Gate{_ in};try feed(exact,id3,8192);try feed(exact,frame(0x90),417);try exact.finish();checks += 1
    var bigger=id3;bigger[9] += 1;denied{try feed(LiveMP3Gate{_ in},bigger,8192)}
    let partial=LiveMP3Gate{_ in};try feed(partial,frame(0x90).dropLast(),100);denied{try partial.finish()}
    let changed=LiveMP3Gate{_ in};try feed(changed,frame(0x90),417);denied{try feed(changed,frame(0x94),384)}
    let middle=LiveMP3Gate{_ in};try feed(middle,frame(0x90),417);denied{try feed(middle,Data([73,68,51,4,0,0,0,0,0,0]),10)}
    denied{try feed(LiveMP3Gate{_ in},Data("<html>xxxx".utf8),10)}
    print("LiveMP3GateProof: \(checks) checks passed")
  }
}
