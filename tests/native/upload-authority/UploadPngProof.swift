import Foundation
import CryptoKit

@main struct UploadPngProof {
  static func main() throws {
    let root = URL(fileURLWithPath: CommandLine.arguments[1]); var checks = 0
    func check(_ value: Bool) {checks += 1; precondition(value, "PNG check \(checks)")}
    let accepted = ["valid","color"]
    let rejected = ["signature","truncated","crc","text","exif","icc","animation","unknown","duplicate-header","duplicate-color","late-color","interlaced","huge","bad-filter","short-pixels","extra-pixels","compressed-trailer","after-end","jpeg"]
    for name in accepted {let bytes = try Data(contentsOf: root.appendingPathComponent(name + ".png")); check(UploadPngProfile.prepare(bytes) == bytes)}
    for name in rejected {check(UploadPngProfile.prepare(try Data(contentsOf: root.appendingPathComponent(name + ".png"))) == nil)}
    let cases = try String(contentsOf: root.appendingPathComponent("png-metadata-cases.tsv"), encoding: .utf8)
    for line in cases.split(separator: "\n") {
      let fields = line.split(separator: "\t"); let input = try Data(contentsOf: root.appendingPathComponent(String(fields[0]))), captured = input
      let output = UploadPngMetadata.prepare(input); check(input == captured)
      if fields[1] == "DENY" {check(output == nil)}
      else { let expected = try Data(contentsOf: root.appendingPathComponent(String(fields[1]))); check(output != nil); check(output == expected); check(UploadPngProfile.prepare(output!) != nil) }
    }
    let authority = NativeUploadAuthority(clock: {0}), session = authority.register("png-session", identity: String(repeating: "11", count: 32))!
    authority.setForeground(true); authority.focus(session)
    var bytes = try Data(contentsOf: root.appendingPathComponent("valid.png")); let original = bytes
    let request = authority.admit(session, length: bytes.count, destination: "https://files.example.org", mimeType: "text/plain")!
    check(authority.append(request, offset: 0, chunk: bytes)); bytes.resetBytes(in: 0..<bytes.count)
    let review = authority.sealPreparedFile(request); check(review != nil); check(review?.mimeType == "image/png")
    check(authority.preview(request, expected: review!) == original); check(authority.sealPreparedFile(request) == nil)
    authority.cancel(request)
    let metadata = try Data(contentsOf: root.appendingPathComponent("text.png"))
    let denied = authority.admit(session, length: metadata.count, destination: "https://files.example.org", mimeType: "image/png")!
    check(authority.append(denied, offset: 0, chunk: metadata)); let sanitized = authority.sealPreparedFile(denied); check(sanitized != nil); check(authority.preview(denied, expected: sanitized!) == original)
    check(sanitized?.size == original.count)
    check(sanitized?.sha256 == SHA256.hash(data: original).map {String(format: "%02x", $0)}.joined())
    authority.cancel(denied)
    let stale = authority.admit(session, length: metadata.count, destination: "https://files.example.org", mimeType: "image/png")!
    check(authority.append(stale, offset: 0, chunk: metadata)); authority.setForeground(false)
    check(authority.sealPreparedFile(stale) == nil); check(!authority.contains(stale))
    print("{\"language\":\"Swift\",\"uploadPngChecks\":\(checks),\"failed\":0}")
  }
}
