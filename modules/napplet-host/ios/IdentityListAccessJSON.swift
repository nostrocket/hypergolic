import Foundation

extension IdentityListAccess {
  func replaceJSON(_ raw: String) throws {
    do {
      guard UploadWire.boundedJSON(raw, limit: 140000), let rows = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [[String: Any]], rows.count <= 64 else {throw Failure.invalid}
      let owners = try rows.map {row -> Owner in
        guard Set(row.keys) == Set(["user", "publisher", "appId"]), let user = row["user"] as? String,
          let publisher = row["publisher"] as? String, let appId = row["appId"] as? String else {throw Failure.invalid}
        return try Owner(user: user, publisher: publisher, appId: appId)
      }
      try replace(owners)
    } catch {clear(); throw error}
  }
  func captureJSON(_ snapshot: String) throws -> Ticket? {
    let data = try UploadWire.object(snapshot, limit: CapabilityLeaseRegistry.maxBytes)
    guard let raw = data["request"] as? String else {throw Failure.invalid}
    let request = try UploadWire.object(raw, limit: CapabilityLeaseRegistry.maxBytes, maximumDepth: 40)
    guard request["type"] as? String == "routing.call" || UploadWire.boundedJSON(raw, limit: CapabilityLeaseRegistry.maxBytes) else {throw Failure.invalid}
    guard ["identity.getMutes", "identity.getList"].contains(request["type"] as? String ?? "") else {return nil}
    guard let owner = data["registration"] as? [String: Any], let user = owner["user"] as? String,
      let publisher = owner["publisher"] as? String, let appId = owner["appId"] as? String else {throw Failure.invalid}
    return capture(try Owner(user: user, publisher: publisher, appId: appId))
  }
}
