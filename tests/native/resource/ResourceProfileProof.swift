import Foundation

@main struct ResourceProfileProof {
  static func main() throws {
    var checks = 0
    func check(_ value: Bool) throws { checks += 1; if !value { throw NSError(domain: "Resource profile", code: checks) } }
    let leases = CapabilityLeaseRegistry()
    try check(leases.register("one"))
    let token = leases.admit("one", sequence: 1, snapshot: "immutable")!
    try check(leases.borrowedSnapshot(token) == nil)
    try check(leases.take(token) == "immutable")
    try check(leases.borrowedSnapshot(token) == "immutable")
    try check(leases.take(token) == nil)
    leases.revoke("one"); try check(leases.borrowedSnapshot(token) == nil)
    let body = Data(repeating: 97, count: 3 * 1024 * 1024)
    var wire = Data("HTTP/1.1 200 OK\r\nContent-Length: \(body.count)\r\n\r\n".utf8); wire.append(body)
    do { _ = try PublishedHTTPResponse.parse(wire); throw NSError(domain: "Published ceiling changed",code: 1) }
    catch PublishedHTTPResponse.Failure.tooLarge { checks += 1 }
    let resource = try PublishedHTTPResponse.parse(wire, maximumBodyBytes: 10 * 1024 * 1024, resourceProfile: true)
    try check(resource.body == body)
    let accumulator = try PublishedHTTPResponseAccumulator(maximumBodyBytes: 10 * 1024 * 1024, resourceProfile: true)
    for offset in stride(from: 0, to: wire.count, by: 8192) { try accumulator.append(wire.subdata(in: offset..<min(offset+8192,wire.count))) }
    let accumulated = try accumulator.finish(); try check(accumulated.body == body)
    do { _ = try PublishedHTTPResponseAccumulator(maximumBodyBytes: 10 * 1024 * 1024); throw NSError(domain: "Published ceiling changed",code: 2) }
    catch PublishedHTTPResponse.Failure.tooLarge { checks += 1 }
    let redirect = Data("HTTP/1.1 307 Redirect\r\nLocation: https://private.local/\r\nContent-Length: 0\r\n\r\n".utf8)
    do { _ = try PublishedHTTPResponse.parse(redirect, maximumBodyBytes: 10 * 1024 * 1024, resourceProfile: true); throw NSError(domain: "Redirect accepted",code: 3) }
    catch PublishedHTTPResponse.Failure.resourceRedirect(let location) { try check(location == "https://private.local/") }
    let repeated = Data("HTTP/1.1 200 OK\r\nContent-Length: 1\r\nX-Goog-Hash: crc32c=fixture\r\nX-Goog-Hash: md5=fixture\r\n\r\na".utf8)
    let repeatedResponse = try PublishedHTTPResponse.parse(repeated, maximumBodyBytes: 10 * 1024 * 1024, resourceProfile: true)
    try check(repeatedResponse.body == Data("a".utf8))
    do { _ = try PublishedHTTPResponse.parse(repeated); throw NSError(domain:"Published duplicate profile changed",code:4) }
    catch PublishedHTTPResponse.Failure.invalidResponse { checks += 1 }
    for header in ["Content-Length", "Transfer-Encoding", "Content-Encoding", "Location", "Connection"] {
      let duplicate = Data("HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\(header): one\r\n\(header): two\r\n\r\na".utf8)
      do { _ = try PublishedHTTPResponse.parse(duplicate, maximumBodyBytes: 10 * 1024 * 1024, resourceProfile: true); throw NSError(domain:"Ambiguous header accepted",code:5) }
      catch PublishedHTTPResponse.Failure.invalidResponse { checks += 1 }
    }
    print("{\"language\":\"Swift\",\"resourceProfileChecks\":\(checks),\"failed\":0}")
  }
}
