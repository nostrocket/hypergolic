import Foundation
final class Observation: @unchecked Sendable {
  private let lock=NSLock()
  private var feeding=true,enabled=true,callbacks=0,beforeEOF=false,ended=false
  func active()->Bool{lock.withLock{enabled}}
  func consumed(){lock.withLock{callbacks += 1;if feeding{beforeEOF=true}}}
  func eof(){lock.withLock{feeding=false}}
  func stop(){lock.withLock{enabled=false}}
  func didEnd(){lock.withLock{ended=true}}
  var result:(Int,Bool,Bool){lock.withLock{(callbacks,beforeEOF,ended)}}
}
@main struct Proof {
  static func main() throws {
    for cancel in [false,true] {
      let observation=Observation()
      let decoder=try LiveMP3AudioQueue(volume:0,active:observation.active,consumed:observation.consumed,ended:observation.didEnd)
      let gate=LiveMP3Gate(output:decoder.append)
      var frame=Data(repeating:0,count:417);frame.replaceSubrange(0..<4,with:[255,251,144,196])
      for _ in 0..<(cancel ? 58:160){try gate.append(frame);Thread.sleep(forTimeInterval:0.02)}
      precondition(observation.result.1,"Incremental queue callback must precede EOF and teardown")
      if !cancel {
        try gate.finish();observation.eof();try decoder.finish()
        let deadline=Date().addingTimeInterval(8)
        while !observation.result.2 && Date()<deadline{Thread.sleep(forTimeInterval:0.01)}
        precondition(observation.result.2,"Natural queue drain not observed within bounded proof")
      }
      observation.stop();decoder.cancel();try decoder.close()
      let callbacks=observation.result.0;Thread.sleep(forTimeInterval:0.1);precondition(observation.result.0==callbacks)
      print("{\"mode\":\"\(cancel ? "cancel":"eof")\",\"queueCallbacks\":\(callbacks),\"beforeEOFAndTeardown\":true,\"naturalQueueDrain\":\(observation.result.2),\"closeSucceeded\":true,\"noCallback100msAfterClose\":true,\"volume\":0,\"scope\":\"macOS host synthetic byte-only,not acoustic or iOS acceptance\"}")
    }
  }
}
