import Foundation

@main private struct PublishedHTTPResponseProof {
  static func main() throws {
    var checks = 0
    func accept(_ wire: Data, body: String) throws {
      let response = try PublishedHTTPResponse.parse(wire)
      guard response.status == 200, response.body == Data(body.utf8) else { throw NSError(domain: "accepted response", code: 1) }
      checks += 1
    }
    func reject(_ wire: Data, maximumBodyBytes: Int = 20) throws {
      do {
        _ = try PublishedHTTPResponse.parse(wire, maximumBodyBytes: maximumBodyBytes)
        throw NSError(domain: "response accepted unexpectedly", code: 1)
      } catch is PublishedHTTPResponse.Failure { checks += 1 }
    }
    func data(_ text: String) -> Data { Data(text.utf8) }

    try accept(data("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello"), body: "hello")
    try accept(data("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhe\r\n3\r\nllo\r\n0\r\n\r\n"), body: "hello")
    try reject(data("HTTP/1.1 302 Found\r\nLocation: https://elsewhere.test/\r\nContent-Length: 0\r\n\r\n"))
    try reject(data("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhell"))
    try reject(data("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello!"))
    try reject(data("HTTP/1.1 200 OK\r\nContent-Length: 21\r\n\r\n" + String(repeating: "a", count: 21)))
    try reject(data("HTTP/1.1 200 OK\r\nContent-Length: 5\r\ncontent-length: 5\r\n\r\nhello"))
    try reject(data("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\nhello"))
    try reject(data("HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\nhello"))
    try reject(data("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 5\r\n\r\nhello"))
    try reject(data("HTTP/1.1 200 OK\r\n Content-Length: 5\r\n\r\nhello"))
    try reject(data("HTTP/1.1 200 OK\r\nContent-Length: 5\n\r\nhello"))
    try reject(data("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\ntrailer"))
    try reject(data("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;anything\r\nhello\r\n0\r\n\r\n"))
    try reject(data("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n15\r\n" + String(repeating: "a", count: 21) + "\r\n0\r\n\r\n"))
    try reject(data("HTTP/1.1 200 OK\r\n\r\nhello"))
    try reject(data("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello"), maximumBodyBytes: 0)
    try reject(data("HTTP/1.1 200X\r\nContent-Length: 5\r\n\r\nhello"))
    let hugeHeader = "HTTP/1.1 200 OK\r\nX-Value: " + String(repeating: "a", count: PublishedHTTPResponse.maximumHeaderBytes) + "\r\nContent-Length: 0\r\n\r\n"
    try reject(data(hugeHeader))
    try reject(Data(repeating: 0x61, count: PublishedHTTPResponse.maximumBodyBytes + PublishedHTTPResponse.maximumHeaderBytes + PublishedHTTPResponse.maximumFramingBytes + 1), maximumBodyBytes: PublishedHTTPResponse.maximumBodyBytes)
    let accumulator = try PublishedHTTPResponseAccumulator(maximumBodyBytes: 5)
    try accumulator.append(data("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n"))
    try accumulator.append(data("hello"))
    try checkResponse(accumulator.finish(), expected: data("hello"))
    checks += 1
    do {
      try accumulator.append(Data(repeating: 0x61, count: 8193))
      throw NSError(domain: "oversized native read accepted", code: 1)
    } catch is PublishedHTTPResponse.Failure { checks += 1 }
    let noHeaderEnd = try PublishedHTTPResponseAccumulator(maximumBodyBytes: 5)
    for _ in 0..<2 { try noHeaderEnd.append(Data(repeating: 0x61, count: 8192)) }
    do {
      try noHeaderEnd.append(Data(repeating: 0x61, count: 5))
      throw NSError(domain: "unbounded header accepted", code: 1)
    } catch is PublishedHTTPResponse.Failure { checks += 1 }
    var retry = VettedAddressCursor(["first", "second"])
    guard retry.next() == "first", retry.next() == "second", retry.next() == nil else {
      throw NSError(domain: "vetted address exhaustion", code: 1)
    }
    checks += 1
    var ready = VettedAddressCursor(["first", "second"])
    guard ready.next() == "first", ready.markReady(), !ready.markReady(), ready.next() == nil else {
      throw NSError(domain: "no failover after ready", code: 1)
    }
    checks += 1
    let request = try PublishedPinnedHTTPS.Request("https://blossom.example.net:8443/abc?format=html")
    try checkRequest(request, host: "blossom.example.net", port: 8443,
      wire: "GET /abc?format=html HTTP/1.1\r\nHost: blossom.example.net:8443\r\nAccept: text/html\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n")
    checks += 1
    for invalid in ["http://blossom.example.net/", "https://localhost/", "https://127.0.0.1/",
                    "https://user:pass@blossom.example.net/", "https://blossom.example.net/#fragment",
                    "https://blossom.example.net/%0d%0aInjected"] {
      do {
        _ = try PublishedPinnedHTTPS.Request(invalid)
        throw NSError(domain: "unsafe URL accepted", code: 1)
      } catch is PublishedPinnedHTTPS.Failure { checks += 1 }
    }
    do {
      _ = try PublishedPinnedHTTPS.resolve("localhost")
      throw NSError(domain: "private DNS address accepted", code: 1)
    } catch PublishedPinnedHTTPS.Failure.privateAddress { checks += 1 }
    print("{\"language\":\"Swift\",\"checks\":\(checks),\"failed\":0}")
  }

  private static func checkResponse(_ response: PublishedHTTPResponse, expected: Data) throws {
    guard response.body == expected else { throw NSError(domain: "bounded accumulator", code: 1) }
  }

  private static func checkRequest(_ request: PublishedPinnedHTTPS.Request, host: String, port: UInt16, wire: String) throws {
    guard request.host == host, request.port == port, request.wire == Data(wire.utf8) else {
      throw NSError(domain: "pinned request", code: 1)
    }
  }
}
