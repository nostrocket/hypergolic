import CryptoKit
import Foundation
import SQLite3

@main
enum PublishedBodyProof {
  enum Failure: Error { case check(String) }
  static func check(_ value: Bool, _ purpose: String) throws { if !value { throw Failure.check(purpose) } }
  static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
  static func main() throws {
    let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: temporary) }
    let store = PublishedBodyStore(directory: temporary)
    let owner = String(repeating: "a", count: 64), publisher = String(repeating: "b", count: 64)
    let event = String(repeating: "c", count: 64), session = "published-body-proof-session"
    let prefix = "<!doctype html><html><head></head><body>", suffix = "</body></html>"
    for (fragment, allowed) in [("<svg><path d='M0 0'/></svg>", true), ("<script>if(a < b){}</script>", true),
      ("<svg><foreignObject><div>ok</div></foreignObject></svg>", true), ("<div/>", false), ("<a-long></a>", false),
      ("<svg><p>outside</p></svg>", false), ("<svg><font color='red'></font></svg>", false),
      ("<div><strong></div></strong>", false), ("<svg><path/ ></svg>", false)] {
      let data = Data((prefix + fragment + suffix).utf8)
      let valid = data.withUnsafeBytes { hg_published_html_valid($0.bindMemory(to: UInt8.self).baseAddress, data.count) != 0 }
      try check(valid == allowed, fragment)
    }
    for (document, allowed) in [
      ("<!doctype html><!-- intro --><title>Field guide</title><p>Ready</p>", true),
      ("<!doctype html><title>Field guide</title><main><p>Incomplete</p>", false),
      ("<!doctype html><title>Field guide</title><html><head></head><body></body></html>", false)
    ] {
      let data = Data(document.utf8)
      let valid = data.withUnsafeBytes { hg_published_html_valid($0.bindMemory(to: UInt8.self).baseAddress, data.count) != 0 }
      try check(valid == allowed, "implied document wrappers")
    }
    let deep = Data((prefix + String(repeating: "<a>", count: 100_000) + String(repeating: "</A>", count: 100_000) + suffix).utf8)
    try check(deep.withUnsafeBytes { hg_published_html_valid($0.bindMemory(to: UInt8.self).baseAddress, deep.count) != 0 }, "deep balanced nesting")
    let html = Data(("<!doctype html><html><head></head><body>" + String(repeating: "j", count: 19_200_000) + "</body></html>").utf8)
    let hash = digest(html), aggregate = digest(Data((hash + " /index.html\n").utf8))
    try check((try? store.issue()) == nil, "issuance requires initial native account binding")
    store.synchronize(owner, epoch: 1, available: true)
    let token = try store.issue()
    try check(try store.retainDownload(token, hash: hash, data: html) == html.count, "native 19.2 MB signed download")
    let path = try store.database(token, user: owner, length: html.count)
    try check(FileManager.default.fileExists(atPath: path), "private file is present while owned")
    let reread = try store.issue()
    let destination = try store.database(reread, user: owner, length: html.count)
    let cached = temporary.appendingPathComponent("persistent-v1.db").path
    try check(hg_proof_copy_cached_body(cached, path, destination) == 0, "Expo SQLite persists the original blob and reopens it offline")
    try check(try store.verifyCached(reread, hash: hash) == html.count, "OS SQLite reads bytes copied from the Expo SQLite v1 cache")
    store.release(reread)
    try check((try? store.database(token, user: publisher, length: html.count)) == nil, "different owner rejected")
    let registry = PublishedArtifactTransfer.shared.registry
    try check(registry.registerSession(session), "register")
    let claims = ["sessionId":session, "user":owner, "publisher":publisher, "identifier":"journal",
      "eventId":event, "aggregateHash":aggregate, "htmlHash":hash]
    func wire(_ value: [String:String]) throws -> String {
      String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }
    var wrong = claims; wrong["user"] = publisher
    try check((try? store.stage(token, json: wire(wrong))) == nil, "staging is scoped to reviewing account")
    let handle = try store.stage(token, json: wire(claims))
    try check(handle != nil, "registered native stage")
    store.release(token)
    try check(!FileManager.default.fileExists(atPath: path), "final release unlinks bytes")
    try check((try? store.stage(token, json: wire(claims))) == nil, "released token rejected")
    let invalid = Data("not a document".utf8), rejected = try store.issue()
    try check(try store.retainDownload(rejected, hash: hash, data: invalid) == -2, "mismatch")
    try check(try store.retainDownload(rejected, hash: digest(invalid), data: invalid) == -3, "unsafe HTML")
    let pending = try store.issue()
    store.synchronize(owner, epoch: 1, available: false)
    try check((try? store.issue()) == nil, "transition cannot issue")
    let reviewed = PublishedArtifactRegistry.Claims(sessionId: session, publisher: publisher, identifier: "journal",
      eventId: event, aggregateHash: aggregate, htmlHash: hash)
    try check(registry.claim(handle!, claims: reviewed, viewGeneration: "next-view") == nil,
      "unclaimed staged handle revoked before the account transition completes")
    store.synchronize(publisher, epoch: 2, available: true)
    try check((try? store.database(pending, user: publisher, length: 5)) == nil, "untouched download cannot rebind across accounts")
    let sameUserOldEpoch = try store.issue()
    store.synchronize(publisher, epoch: 3, available: true)
    try check((try? store.database(sameUserOldEpoch, user: publisher, length: 5)) == nil, "same account old epoch revoked")
    store.setForeground(false)
    try check((try? store.issue()) == nil, "background rejects tickets")
    store.setForeground(true)
    try check((try? store.database(rejected, user: owner, length: invalid.count)) == nil, "foreground does not revive expired ownership")
    print("Native 19.2 MB verification, account cache, stage, mismatch, revocation and cleanup passed")
  }
}
