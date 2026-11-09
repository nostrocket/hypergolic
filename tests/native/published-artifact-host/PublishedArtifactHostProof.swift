import CryptoKit
import Foundation

@main private struct PublishedArtifactHostProof {
  static func main() throws {
    var checks = 0
    func check(_ condition: Bool, _ label: String) throws {
      guard condition else { throw NSError(domain: label, code: 1) }
      checks += 1
    }
    func hash(_ data: Data) -> String {
      SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    let html = Data(repeating: 0x61, count: PublishedArtifactRegistry.maximumHTMLBytes)
    let htmlHash = hash(html)
    let version = hash(Data("\(htmlHash) /index.html\n".utf8))
    let publisher = String(repeating: "a", count: 64)
    let eventId = String(repeating: "b", count: 64)
    let session = "session-a"
    let appId = "test-napplet"
    let generation = UUID().uuidString.lowercased()
    let registry = PublishedArtifactRegistry()
    try check(registry.registerSession(session), "register owner session")
    let claims = PublishedArtifactRegistry.Claims(sessionId: session, publisher: publisher,
      identifier: appId, eventId: eventId, aggregateHash: version, htmlHash: htmlHash)
    let handle = registry.stage(html, claims: claims)!
    let fields: [String: Any] = ["sessionId": session, "publisher": publisher,
      "appId": appId, "eventId": eventId, "version": version, "htmlHash": htmlHash, "handle": handle]
    func json(_ object: [String: Any]) throws -> String {
      String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }
    let leases = CapabilityLeaseRegistry()
    try check(leases.register(generation), "register query generation")
    var capabilitySequence: UInt64 = 0
    func issue(_ type: String, _ domains: [String]) throws -> String {
      capabilitySequence += 1
      let snapshot = try json(["registration": ["domains": domains], "request": try json(["type": type])])
      return leases.admit(generation, sequence: capabilitySequence, snapshot: snapshot)!
    }
    func allowsOutbox(_ token: String) -> Bool { CapabilityTransport.outboxAdmitted(token, leases: leases) }
    for (type, domains) in [("relay.query", ["outbox", "relay"]), ("outbox.resolveRelays", ["outbox"]), ("outbox.query", ["relay"]),
      ("common.getProfile", ["common"]), ("common.getProfile", ["outbox"]), ("common.follows", ["common", "outbox"])] {
      let token = try issue(type, domains)
      try check(leases.take(token) != nil && !allowsOutbox(token), "reject crossed query authority")
      try check(leases.finish(token), "finish denied query")
    }
    let query = try issue("outbox.query", ["outbox"])
    try check(!allowsOutbox(query) && leases.take(query) != nil && allowsOutbox(query), "only a claimed exact Outbox query can borrow")
    try check(leases.take(query) == nil, "one-use claim")
    try check(leases.finish(query) && !allowsOutbox(query), "finished query cannot borrow")
    let common = try issue("common.getProfile", ["common", "outbox"])
    try check(!allowsOutbox(common) && leases.take(common) != nil && allowsOutbox(common), "Common profile needs both actual grants and the exact claimed lease")
    try check(leases.finish(common) && !allowsOutbox(common), "finished Common profile cannot borrow")
    let event = try issue("outbox.getEvent", ["outbox"])
    try check(leases.take(event) != nil && allowsOutbox(event), "allow claimed exact getEvent")
    _ = leases.setForeground(false)
    _ = leases.setForeground(true)
    try check(!allowsOutbox(event), "foreground return cannot revive the old query")
    let revoked = try issue("outbox.query", ["outbox"])
    try check(leases.take(revoked) != nil && allowsOutbox(revoked), "allow live generation")
    leases.revoke(generation)
    try check(leases.register(generation) && !allowsOutbox(revoked), "generation replacement cannot revive the old query")
    try check(PublishedArtifactHostInput(try json(fields))?.configuration == nil,
      "legacy seven-field input has no capability")
    var publishedConfig: [String: Any] = ["sessionId": session, "epoch": 1, "user": String(repeating: "c", count: 64),
      "publisher": publisher, "appId": appId, "version": version, "instanceId": "instance-a",
      "fixture": "published", "domains": ["identity", "relay"]]
    var configuredFields = fields
    configuredFields["configuration"] = try json(publishedConfig)
    let configuredInput = PublishedArtifactHostInput(try json(configuredFields))!
    let boundConfiguration = try CapabilityConfiguration(configuredInput.configuration!, generation: generation)
    try check(boundConfiguration.matchesPublishedClaims(sessionId: configuredInput.claims.sessionId,
      publisher: configuredInput.claims.publisher, appId: configuredInput.claims.identifier,
      version: configuredInput.claims.aggregateHash), "published config binds exact claims")
    for (name, replacement) in [("sessionId", "another-session"), ("publisher", String(repeating: "d", count: 64)),
      ("appId", "other-app"), ("version", String(repeating: "e", count: 64))] {
      var mismatch = publishedConfig
      mismatch[name] = replacement
      configuredFields["configuration"] = try json(mismatch)
      let parsed = PublishedArtifactHostInput(try json(configuredFields))!
      let candidate = try CapabilityConfiguration(parsed.configuration!, generation: generation)
      try check(!candidate.matchesPublishedClaims(sessionId: parsed.claims.sessionId,
        publisher: parsed.claims.publisher, appId: parsed.claims.identifier,
        version: parsed.claims.aggregateHash), "reject mismatched published \(name)")
    }
    for domains in [["identity", "identity"], ["unknown"], ["identity", "storage", "theme", "relay", "extra"]] {
      publishedConfig["domains"] = domains
      configuredFields["configuration"] = try json(publishedConfig)
      let parsed = PublishedArtifactHostInput(try json(configuredFields))!
      try check((try? CapabilityConfiguration(parsed.configuration!, generation: generation)) == nil,
        "reject invalid published domain set")
    }
    publishedConfig["domains"] = ["keys"]
    let keysConfig = try CapabilityConfiguration(try json(publishedConfig), generation: generation)
    try check(keysConfig.domains == ["keys"], "Keys retains the exact granted domain")
    publishedConfig["domains"] = ["keys", "gamepad"]
    try check((try? CapabilityConfiguration(try json(publishedConfig), generation: generation)) == nil,
      "Keys does not allow Gamepad")
    publishedConfig["domains"] = ["outbox", "relay"]
    let outboxConfig = try CapabilityConfiguration(try json(publishedConfig), generation: generation)
    try check(outboxConfig.domains == ["outbox", "relay"], "published Outbox retains exact granted domains")
    try check(outboxConfig.matchesPublishedClaims(sessionId: session, publisher: configuredInput.claims.publisher,
      appId: configuredInput.claims.identifier, version: configuredInput.claims.aggregateHash), "Outbox binds exact published claims")
    publishedConfig["domains"] = ["outbox"]
    let isolatedOutbox = try CapabilityConfiguration(try json(publishedConfig), generation: generation)
    try check(!isolatedOutbox.domains.contains("relay"), "Outbox never silently adds relay authority")
    let mixed = ["intent", "keys", "media", "outbox"]
    publishedConfig["domains"] = mixed
    let mixedConfig = try CapabilityConfiguration(try json(publishedConfig), generation: generation)
    try check(mixedConfig.domains == Set(mixed), "Mixed published grants retain exact domains without adding Relay")
    publishedConfig["domains"] = mixed + ["gamepad"]
    try check((try? CapabilityConfiguration(try json(publishedConfig), generation: generation)) == nil,
      "Mixed grants do not enable Gamepad")
    publishedConfig["domains"] = ["outbox", "outbox", "relay"]
    try check((try? CapabilityConfiguration(try json(publishedConfig), generation: generation)) == nil, "duplicate Outbox grant rejected")
    publishedConfig["domains"] = ["identity", "relay"]
    configuredFields["configuration"] = try json(publishedConfig)
    let configured = PublishedArtifactHostInput(try json(configuredFields))!
    let configuredRegistry = PublishedArtifactRegistry()
    try check(configuredRegistry.registerSession(session), "register configured owner session")
    let configuredHandle = configuredRegistry.stage(html, claims: configured.claims)!
    var wrongAppConfig = publishedConfig
    wrongAppConfig["appId"] = "other-app"
    let mismatchedConfig = try CapabilityConfiguration(try json(wrongAppConfig), generation: generation)
    try check(!mismatchedConfig.matchesPublishedClaims(sessionId: configured.claims.sessionId,
      publisher: configured.claims.publisher, appId: configured.claims.identifier,
      version: configured.claims.aggregateHash), "mismatch checked before one-use claim")
    let configuredClaim = configuredRegistry.claim(configuredHandle, claims: configured.claims, viewGeneration: generation)
    try check(configuredClaim != nil, "invalid config did not consume staged artifact")
    let configuredReader = PublishedArtifactReadOwner(claimed: configuredClaim!, domains: boundConfiguration.domains)
    let configuredChunk = try JSONSerialization.jsonObject(with: Data(configuredReader.read(sequence: 0)!.utf8)) as! [String: Any]
    try check(configuredChunk["domains"] as? [String] == ["identity", "relay"], "configured domains delivered to runtime")
    let input = PublishedArtifactHostInput(try json(fields))
    try check(input?.claims == claims && input?.handle == handle, "exact bounded prop")
    let claimed = registry.claim(input!.handle, claims: input!.claims, viewGeneration: generation)
    try check(claimed != nil, "native host claim")
    try check(registry.claim(handle, claims: claims, viewGeneration: generation) == nil, "claim replay denied")
    let reader = PublishedArtifactReadOwner(claimed: claimed!, domains: ["theme"])
    var collected = Data()
    var sequence = 0
    while collected.count < html.count {
      let text = reader.read(sequence: sequence)
      try check(text != nil, "sequential read")
      let object = try JSONSerialization.jsonObject(with: Data(text!.utf8)) as! [String: Any]
      let base64 = object["base64"] as? String
      let bytes = base64.flatMap { Data(base64Encoded: $0) }
      try check(bytes != nil && bytes!.base64EncodedString() == base64, "canonical Base64")
      try check(bytes!.count >= 1 && bytes!.count <= PublishedArtifactTransfer.maximumChunkBytes,
        "48 KiB chunk ceiling")
      try check(object["type"] as? String == "artifact.chunk" && object["sessionId"] as? String == generation &&
        object["sequence"] as? Int == sequence && object["byteLength"] as? Int == bytes!.count &&
        object["totalBytes"] as? Int == html.count, "exact sequence and lengths")
      try check(object["publisher"] as? String == publisher && object["appId"] as? String == appId &&
        object["eventId"] as? String == eventId && object["version"] as? String == version &&
        object["htmlHash"] as? String == htmlHash && object["domains"] as? [String] == ["theme"],
        "immutable claims and capabilities returned")
      collected.append(bytes!)
      try check(object["done"] as? Bool == (collected.count == html.count), "final marker")
      sequence += 1
    }
    try check(collected == html, "all genuine bytes delivered")
    try check(reader.read(sequence: sequence) == nil, "bytes cleared after final read")
    var extra = fields
    extra["html"] = "do not accept"
    try check(PublishedArtifactHostInput(try json(extra)) == nil, "extra prop denied")
    extra = fields
    extra["publisher"] = publisher.uppercased()
    try check(PublishedArtifactHostInput(try json(extra)) == nil, "uppercase hash denied")
    extra = fields
    extra["appId"] = String(repeating: "x", count: 256)
    try check(PublishedArtifactHostInput(try json(extra)) == nil, "long app ID denied")
    extra = fields
    extra["handle"] = "public-path"
    try check(PublishedArtifactHostInput(try json(extra)) == nil, "nonopaque handle denied")
    let second = registry.stage(html, claims: claims)!
    let skipped = PublishedArtifactReadOwner(claimed: registry.claim(second, claims: claims, viewGeneration: "view-2")!, domains: ["theme"])
    try check(skipped.read(sequence: 1) == nil, "skipped read denied")
    try check(skipped.read(sequence: 0) == nil, "invalid read clears bytes")
    let third = registry.stage(html, claims: claims)!
    let duplicate = PublishedArtifactReadOwner(claimed: registry.claim(third, claims: claims, viewGeneration: "view-3")!, domains: ["theme"])
    try check(duplicate.read(sequence: 0) != nil, "first read")
    try check(duplicate.read(sequence: 0) == nil, "duplicate read denied")
    try check(duplicate.read(sequence: 1) == nil, "duplicate clears bytes")
    let snapshotTitle = "Verified café"
    let snapshot = PublishedArtifactRegistry.Snapshot(eventId: eventId, title: snapshotTitle)!
    let key = " 5129:" + eventId
    try check(snapshot.appKey == key, "snapshot derives exact reserved key")
    let snapshotBytes = Data(repeating: 0x61, count: PublishedArtifactTransfer.maximumChunkBytes + 1)
    let snapshotHash = hash(snapshotBytes)
    let snapshotVersion = hash(Data("\(snapshotHash) /index.html\n".utf8))
    let transfer = PublishedArtifactTransfer(registry: registry)
    func beginSnapshot(_ title: String = snapshotTitle, id: String = eventId, author: String = publisher) -> String? {
      transfer.beginPublishedSnapshot(sessionId: session, publisher: author, eventId: id,
        verifiedTitle: title, aggregateHash: snapshotVersion, htmlHash: snapshotHash, byteLength: snapshotBytes.count)
    }
    func stageSnapshot() throws -> String {
      let upload = beginSnapshot()!
      let cut = PublishedArtifactTransfer.maximumChunkBytes
      try check(transfer.appendPublishedArtifact(upload, sequence: 0,
        base64Chunk: snapshotBytes.prefix(cut).base64EncodedString()), "stage snapshot first chunk")
      try check(transfer.appendPublishedArtifact(upload, sequence: 1,
        base64Chunk: snapshotBytes.suffix(1).base64EncodedString()), "stage snapshot final chunk")
      return transfer.finishPublishedArtifact(upload)!
    }
    for title in ["", " a", " \u{301}a", "a  b", "a\nb", "a\u{202e}b", String(repeating: "é", count: 65)] {
      try check(beginSnapshot(title) == nil, "invalid snapshot title denied")
    }
    try check(beginSnapshot(id: eventId.uppercased()) == nil, "uppercase snapshot event ID denied")
    try check(beginSnapshot(author: publisher + "\n") == nil, "snapshot publisher requires exact lower hex bytes")
    try check(transfer.beginPublishedArtifact(sessionId: session, publisher: publisher, identifier: key,
      eventId: eventId, aggregateHash: snapshotVersion, htmlHash: snapshotHash, byteLength: snapshotBytes.count) == nil,
      "named ABI cannot stage a snapshot")
    let lookalike = String(key.dropFirst())
    let namedUpload = transfer.beginPublishedArtifact(sessionId: session, publisher: publisher, identifier: lookalike,
      eventId: eventId, aggregateHash: snapshotVersion, htmlHash: snapshotHash, byteLength: snapshotBytes.count)!
    let cut = PublishedArtifactTransfer.maximumChunkBytes
    try check(transfer.appendPublishedArtifact(namedUpload, sequence: 0,
      base64Chunk: snapshotBytes.prefix(cut).base64EncodedString()), "named lookalike first chunk")
    try check(transfer.appendPublishedArtifact(namedUpload, sequence: 1,
      base64Chunk: snapshotBytes.suffix(1).base64EncodedString()), "named lookalike final chunk")
    let namedHandle = transfer.finishPublishedArtifact(namedUpload)!
    let namedClaims = PublishedArtifactRegistry.Claims(sessionId: session, publisher: publisher, identifier: lookalike,
      eventId: eventId, aggregateHash: snapshotVersion, htmlHash: snapshotHash)
    let namedLookalike = registry.claim(namedHandle, claims: namedClaims, viewGeneration: generation)
    try check(namedLookalike?.claims.identifier == lookalike && namedLookalike?.claims.snapshot == nil,
      "named lookalike keeps named claims")
    let cancelled = beginSnapshot()!
    transfer.cancelPublishedArtifact(cancelled)
    try check(transfer.finishPublishedArtifact(cancelled) == nil, "cancelled snapshot transfer cannot finish")
    var snapshotConfig = publishedConfig
    snapshotConfig["appId"] = key
    snapshotConfig["version"] = snapshotVersion
    snapshotConfig["domains"] = ["inc", "resource"]
    snapshotConfig["snapshot"] = snapshot.wire
    var snapshotFields = fields
    snapshotFields["appId"] = key
    snapshotFields["version"] = snapshotVersion
    snapshotFields["htmlHash"] = snapshotHash
    snapshotFields["snapshot"] = snapshot.wire
    snapshotFields["configuration"] = try json(snapshotConfig)
    snapshotFields["handle"] = try stageSnapshot()
    let snapshotInput = PublishedArtifactHostInput(try json(snapshotFields))!
    let snapshotCapability = try CapabilityConfiguration(snapshotInput.configuration!, generation: generation,
      expectedSnapshot: snapshotInput.claims.snapshot?.wire)
    let registration = try JSONSerialization.jsonObject(with: Data(snapshotCapability.snapshot.utf8)) as! [String: Any]
    try check(registration["generation"] as? String == generation &&
      registration["snapshot"].flatMap(PublishedArtifactRegistry.Snapshot.init) == snapshot &&
      snapshotCapability.domains == ["inc", "resource"], "trusted registration retains exact snapshot and grants")
    try check((try? CapabilityConfiguration(snapshotInput.configuration!, generation: generation)) == nil,
      "embedded path cannot register snapshot metadata")
    for field in ["appData", "legacyReadOnly", "publishedOpen"] {
      var forbiddenConfig = snapshotConfig
      forbiddenConfig[field] = true
      try check((try? CapabilityConfiguration(try json(forbiddenConfig), generation: generation, expectedSnapshot: snapshot.wire)) == nil,
        "snapshot denies named-only profile \(field)")
    }
    for (name, replacement) in [("title", "Verified cafe\u{301}"), ("eventId", String(repeating: "c", count: 64)), ("kind", "5129")] {
      var wrongMetadata = snapshot.wire
      wrongMetadata[name] = replacement
      var wrongConfig = snapshotConfig
      wrongConfig["snapshot"] = wrongMetadata
      try check((try? CapabilityConfiguration(try json(wrongConfig), generation: generation, expectedSnapshot: snapshot.wire)) == nil,
        "snapshot configuration denies altered \(name)")
    }
    for (name, replacement) in [("appId", String(key.dropFirst())), ("eventId", String(repeating: "c", count: 64))] {
      var wrongFields = snapshotFields
      wrongFields[name] = replacement
      try check(PublishedArtifactHostInput(try json(wrongFields)) == nil, "snapshot host denies altered \(name)")
    }
    var missing = snapshotFields
    missing.removeValue(forKey: "configuration")
    try check(PublishedArtifactHostInput(try json(missing)) == nil, "snapshot cannot use default Theme grants")
    let restarted = PublishedArtifactRegistry()
    try check(restarted.registerSession(session), "snapshot owner can register on restart")
    try check(restarted.claim(snapshotInput.handle, claims: snapshotInput.claims, viewGeneration: generation) == nil,
      "restart cannot revive prior process handle")
    var changed = snapshotFields
    changed["snapshot"] = PublishedArtifactRegistry.Snapshot(eventId: eventId, title: "Verified cafe\u{301}")!.wire
    let altered = PublishedArtifactHostInput(try json(changed))!
    try check(registry.claim(snapshotInput.handle, claims: altered.claims, viewGeneration: generation) == nil,
      "claimed title binds exact UTF-8 bytes")
    try check(registry.claim(snapshotInput.handle, claims: snapshotInput.claims, viewGeneration: generation) == nil,
      "changed claim consumes handle")
    let stale = try stageSnapshot()
    transfer.revokePublishedSession(session)
    try check(transfer.registerPublishedSession(session), "explicit snapshot session restart")
    try check(registry.claim(stale, claims: snapshotInput.claims, viewGeneration: generation) == nil, "stale snapshot handle denied")
    let malformedGeneration = try stageSnapshot()
    try check(registry.claim(malformedGeneration, claims: snapshotInput.claims, viewGeneration: "legacy-generation") == nil,
      "invalid host generation denied")
    let liveSnapshot = registry.claim(try stageSnapshot(), claims: snapshotInput.claims, viewGeneration: generation)!
    let snapshotReader = PublishedArtifactReadOwner(claimed: liveSnapshot, domains: snapshotCapability.domains)
    for sequence in 0..<2 {
      let chunk = try JSONSerialization.jsonObject(with: Data(snapshotReader.read(sequence: sequence)!.utf8)) as! [String: Any]
      try check(chunk["sessionId"] as? String == generation &&
        chunk["publisher"] as? String == publisher && chunk["eventId"] as? String == eventId &&
        chunk["appId"] as? String == key && chunk["snapshot"].flatMap(PublishedArtifactRegistry.Snapshot.init) == snapshot,
        "each chunk carries immutable snapshot and generation")
    }
    try check(snapshotReader.read(sequence: 2) == nil, "snapshot bytes exhausted")
    try check(liveSnapshot.claims.snapshot?.requester(publisher: liveSnapshot.claims.publisher) ==
      "Snapshot (kind 5129): \(snapshotTitle)\nManifest event ID: \(eventId)\nPublisher: \(publisher)",
      "native requester displays trusted title, full event ID and publisher")
    print("{\"language\":\"Swift\",\"checks\":\(checks),\"failed\":0}")
  }
}
