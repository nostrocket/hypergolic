import Foundation
@main struct Proof {
  static func main() throws {
    var checks = 0
    func check(_ value: Bool) { precondition(value); checks += 1 }
    func denied(_ block: () throws -> Void) { do { try block(); fatalError("Expected denial") } catch { checks += 1 } }
    let head = "HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\n"
    func read(_ text: String, size: Int = 1) throws -> Data {
      var output = Data(); let parser = LiveMP3Response(budget: LiveMP3Budget(), active: {}, output: { output.append($0) })
      let bytes = Data(text.utf8);var offset = 0
      while offset < bytes.count { let end = min(bytes.count, offset + size);try parser.append(bytes.subdata(in: offset..<end));offset = end }
      try parser.finish();return output
    }
    for size in [1,2,3,17,8192] {
      check(try read(head+"\r\nabc",size:size)==Data("abc".utf8))
      check(try read(head+"Content-Length: 3\r\n\r\nabc",size:size)==Data("abc".utf8))
      check(try read(head+"Transfer-Encoding: chunked\r\n\r\n1\r\na\r\n2\r\nbc\r\n0\r\nX-Report: yes\r\n\r\n",size:size)==Data("abc".utf8))
    }
    for bad in ["Content-Length: +3", "Content-Length: 33554433", "Content-Length: 3\r\nContent-Length: 3", "Content-Length: 3\r\nTransfer-Encoding: chunked", "Content-Encoding: gzip", "icy-metaint: 1", "Content-Range: bytes 0-1/2", "Transfer-Encoding: gzip"] { denied { _ = try read(head+bad+"\r\n\r\nabc") } }
    for bad in ["1;foo=bar\r\na\r\n0\r\n\r\n", "80000000\r\n", "1\r\naXX", "0\r\nContent-Type: text/html\r\n\r\n", "0\r\n\r\nx"] { denied { _ = try read(head+"Transfer-Encoding: chunked\r\n\r\n"+bad) } }
    denied { _ = try read(head+"Content-Length: 4\r\n\r\nabc") };denied { _ = try read(head+"Content-Length: 2\r\n\r\nabc") }
    denied { _ = try read("HTTP/1.1 200 OK\r\nContent-Type: audio/ogg\r\n\r\nabc") }
    denied { _ = try read(head+"X-Long: "+String(repeating:"a",count:8192)+"\r\n\r\n") }
    let budget = LiveMP3Budget();try budget.charge(32*1024*1024);check(budget.count==32*1024*1024);denied { try budget.charge(1) }
    budget.cancel();denied { try budget.beginAttempt() }
    print("LiveMP3ResponseProof: \(checks) checks passed")
  }
}
