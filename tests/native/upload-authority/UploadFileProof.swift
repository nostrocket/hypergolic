import Foundation
@main struct UploadFileProof {
  static func htmlProof(_ check: (Bool) -> Void) {
    let bytes = Data("<!doctype html><html><body>Local selection</body></html>".utf8)
    for text in [String(decoding: bytes, as: UTF8.self), "\u{FEFF} \n<!DOCTYPE\tHTML >\n<title>Local</title>", "\u{FEFF} \t\r\n<!DOCTYPE\tHTML \r\n>"] {
      let prepared = UploadFileProfile.prepare(Data(text.utf8))
      check(prepared?.mimeType == "text/html"); check(prepared?.metadataPolicy == "attachment-unchanged")
      check(prepared?.bytes == Data(text.utf8))
    }
    var limit = Data(repeating: 32, count: 1024 * 1024); let prefix = Data("<!doctype html>".utf8)
    limit.replaceSubrange(0..<prefix.count, with: prefix)
    check(UploadFileProfile.prepare(limit)?.mimeType == "text/html")
    limit.append(32); check(UploadFileProfile.prepare(limit) == nil)
    for text in ["<html><body>No doctype</body></html>", "<svg/>", "\u{FEFF}<svg/>",
        "<?xml version=\"1.0\"?><html/>", "<!doctype svg><svg/>", "<!doctype htmlx><html/>",
        "<!doctype html PUBLIC \"unselected\"><html/>", "<!doctype html>\u{0000}", "<!doctype html>\u{007f}",
        "<!doc\u{FEFF}type html>", " \u{FEFF}<!doctype html>", "\u{FEFF}\u{FEFF}<!doctype html>", "<!doctype\u{000c}html>"] {
      check(UploadFileProfile.prepare(Data(text.utf8)) == nil)
    }
    var invalidUtf8 = bytes; invalidUtf8.append(contentsOf: [0xc3, 0x28]); check(UploadFileProfile.prepare(invalidUtf8) == nil)
    for revoke in [false, true] {
      let owner = NativeUploadAuthority(clock: {1000}), session = owner.register("html", identity: String(repeating: "a", count: 64))!
      owner.setForeground(true); owner.focus(session)
      let request = owner.admit(session, length: bytes.count, destination: "https://files.example.com", mimeType: "image/png")!
      check(owner.append(request, offset: 0, chunk: bytes))
      let review = owner.sealPreparedFile(request)!; check(review.mimeType == "text/html" && review.size == bytes.count)
      check(review.sha256 == "8e5a049a49491dbce8fb9f1e3b14856de88eefda52522e061079cd0ab49aa50b")
      check(owner.preview(request, expected: review) == bytes)
      owner.focus(nil); check(owner.approve(request, expected: review) == nil); owner.focus(session)
      let grant = owner.approve(request, expected: review)!
      check(owner.dispatch(grant) == nil && !owner.claimTransfer(grant))
      check(owner.claimSigning(grant) === review); check(owner.dispatch(grant) == nil)
      check(owner.claimTransfer(grant))
      if revoke {owner.setForeground(false); check(!owner.isApproved(grant)); check(owner.dispatch(grant) == nil)}
      else {check(owner.dispatch(grant) == bytes); check(owner.dispatch(grant) == nil)}
    }
  }
  static func main() throws {
    let root = URL(fileURLWithPath: CommandLine.arguments[1]); var checks = 0
    func check(_ value: Bool) {checks += 1; precondition(value, "Attachment check \(checks)")}
    htmlProof(check)
    for (ext, mime) in [("wav","audio/wav"),("mp4","video/mp4"),("pdf","application/pdf"),("zip","application/zip"),("txt","text/plain")] {
      let bytes = try Data(contentsOf: root.appendingPathComponent("fixture." + ext)), original = bytes
      let prepared = UploadFileProfile.prepare(bytes); check(prepared != nil); check(bytes == original); check(prepared?.bytes == bytes)
      check(prepared?.mimeType == mime); check(prepared?.metadataPolicy == "attachment-unchanged")
      var copy = prepared!.bytes; copy[0] ^= 1; check(bytes == original)
      let authority = NativeUploadAuthority(clock: {1000}), session = authority.register("attachment", identity: String(repeating: "a", count: 64))!
      authority.setForeground(true); authority.focus(session)
      let request = authority.admit(session, length: bytes.count, destination: "https://files.example.com", mimeType: "image/jpeg")
      check(request != nil); check(authority.append(request!, offset: 0, chunk: bytes))
      let review = authority.sealPreparedFile(request!); check(review != nil); check(review?.mimeType == mime); check(review?.metadataPolicy == "attachment-unchanged"); check(review?.size == bytes.count)
      check(review!.acceptsDescriptorType(mime)); check(review!.acceptsDescriptorType("audio/x-wav") == (ext == "wav")); check(!review!.acceptsDescriptorType("audio/mpeg-unknown"))
      check(authority.preview(request!, expected: review!) == bytes)
      let grant = authority.approve(request!, expected: review!); check(grant != nil); check(authority.claimSigning(grant!) === review)
      check(authority.claimTransfer(grant!)); check(authority.dispatch(grant!) == bytes)
      authority.setForeground(false); check(authority.preview(request!, expected: review!) == nil); check(!authority.isApproved(grant!))
    }
    let spoof = NativeUploadAuthority(clock: {1000}), spoofSession = spoof.register("spoof", identity: String(repeating: "a", count: 64))!
    spoof.setForeground(true); spoof.focus(spoofSession)
    let spoofRequest = spoof.admit(spoofSession, length: 3, destination: "https://files.example.com", mimeType: "audio/wav")!
    check(spoof.append(spoofRequest, offset: 0, chunk: Data([1,2,3])))
    check(!spoof.seal(spoofRequest)!.acceptsDescriptorType("audio/x-wav"))
    for value in ["<svg>private</svg>","\u{FEFF}<svg>private</svg>","GIF89aPHOTO","II*private","MMprivate"] {check(UploadFileProfile.prepare(Data(value.utf8)) == nil)}
    check(UploadFileProfile.prepare(Data(repeating: 0, count: NativeUploadAuthority.maxBytes + 1)) == nil)
    check(UploadFileProfile.prepare(Data([255,216,1,2])) == nil)
    for ext in ["wav","mp4"] {
      let bytes = try Data(contentsOf: root.appendingPathComponent("fixture." + ext))
      for length in 12..<bytes.count {check(UploadFileProfile.prepare(bytes.prefix(length)) == nil)}
    }
    var movie = try Data(contentsOf: root.appendingPathComponent("fixture.mp4")); movie.replaceSubrange(8..<12, with: Data("heic".utf8)); check(UploadFileProfile.prepare(movie) == nil)
    print("{\"language\":\"Swift\",\"uploadFileChecks\":\(checks),\"failed\":0}")
  }
}
