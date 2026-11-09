import Foundation

private final class Transfer: @unchecked Sendable {
  // The test drives the sink and callbacks synchronously on the calling thread.
  var active = true
  var received = -1
  var total = 0
}

@main
struct MediaFileProof {
  static let head = "HTTP/1.1 200 OK\r\n"
  static func response(_ raw: String) -> Data { Data((raw + "\r\n").utf8) }

  static func main() throws {
    let root = URL(fileURLWithPath: CommandLine.arguments[1])
    let directory = root.appendingPathComponent("swift-sink")
    let destination = directory.appendingPathComponent("video.mp4")
    let fm = FileManager.default
    let fixtures = CommandLine.arguments.dropFirst(2).map { URL(fileURLWithPath: $0) }
    for url in fixtures {
      var windows = 0
      let valid = FiniteMP4.accepts(url) { windows += 1 }
      precondition(valid == url.lastPathComponent.hasPrefix("ok-"), url.lastPathComponent)
      if url.lastPathComponent == "ok-mdat-before-moov" { precondition(windows <= 3, "large mdat was not skipped") }
    }
    let invalid = [
      head, head + "Content-Length: 3\r\nContent-Length: 3\r\n",
      head + "Content-Length: 0\r\n", head + "Content-Length: 268435457\r\n",
      head + "Content-Length: +3\r\n", head + "Content-Length: 3,3\r\n",
      head + "Transfer-Encoding: chunked\r\n",
      head + "Content-Length: 3\r\nTransfer-Encoding: chunked\r\n",
      head + "Content-Length: 3\r\nContent-Encoding: gzip\r\n",
      head + "Content-Length: 3\r\nContent-Range: bytes 0-2/3\r\n",
      head + "Content-Length: 3\r\nConnection: keep-alive\r\n",
      head + "Content-Length: 3\r\nX-Invalid: \0\r\n",
      "HTTP/1.0 200 OK\r\nContent-Length: 3\r\n",
      "HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\n",
      "HTTP/1.1 302 Found\r\nLocation: https://other.example.org/video.mp4\r\nLocation: /other\r\n"
    ]
    func make(_ state: Transfer = Transfer(), until deadline: DispatchTime = .now() + .seconds(300)) -> MediaHTTPSFile {
      MediaHTTPSFile(directory: directory, deadline: deadline, active: { state.active }) { n, total in
        precondition(n > state.received && total >= n)
        state.received = n; state.total = total
      }
    }
    func reject(_ sink: MediaHTTPSFile, _ consume: () throws -> Void) {
      do { try consume(); preconditionFailure("Invalid body accepted") }
      catch {}
      sink.discard()
      precondition(!fm.fileExists(atPath: destination.path), "failed transfer retained its file")
    }
    for headers in invalid {
      let sink = make()
      reject(sink) { try sink.append(response(headers)) }
    }
    for count in [2, 4] {
      let sink = make()
      reject(sink) {
        try sink.append(response(head + "Content-Length: 3\r\n"))
        try sink.append(Data(repeating: 0, count: count))
        _ = try sink.finish()
      }
    }
    let expired = make(until: .now() - .seconds(1))
    reject(expired) { try expired.append(response(head + "Content-Length: 3\r\n")) }
    let invalidFile = make()
    reject(invalidFile) {
      try invalidFile.append(response(head + "Content-Length: 3\r\n") + Data([0, 0, 0]))
      _ = try invalidFile.finish()
    }

    let redirect = make()
    do {
      try redirect.append(response("HTTP/1.1 302 Found\r\nLocation: /target\r\n"))
      preconditionFailure("Expected redirect")
    } catch PublishedHTTPResponse.Failure.resourceRedirect(let location) {
      precondition(location == "/target" && !fm.fileExists(atPath: destination.path))
    }
    let revoked = Transfer(), cancelled = make(revoked)
    reject(cancelled) {
      try cancelled.append(response(head + "Content-Length: 168532851\r\n"))
      try cancelled.append(Data(repeating: 0, count: 8192))
      revoked.active = false
      try cancelled.append(Data(repeating: 0, count: 8192))
    }
    precondition(revoked.received == 8192, "revoked copy wrote another chunk")

    try Data([1]).write(to: destination)
    let sibling = directory.appendingPathComponent("unrelated")
    try Data([2]).write(to: sibling)
    let state = Transfer(), sink = make(state)
    let headers = response(head + "Content-Length: 168532851\r\nContent-Encoding: identity\r\n")
    try sink.append(headers.dropLast(1))
    precondition(state.received == -1, "truncated header started a transfer")
    try sink.append(headers.suffix(1))
    let input = try FileHandle(forReadingFrom: root.appendingPathComponent("ok-mdat-before-moov"))
    defer { try? input.close() }
    while let chunk = try input.read(upToCount: 8192), !chunk.isEmpty { try sink.append(chunk) }
    let staged = try sink.finish()
    sink.discard()
    let size = try fm.attributesOfItem(atPath: staged.path)[.size] as? NSNumber
    precondition(staged == destination && size?.intValue == 168532851 && state.received == state.total)
    let unrelated = try Data(contentsOf: sibling)
    precondition(unrelated == Data([2]), "orphan cleanup changed a sibling")
    try fm.removeItem(at: staged)
    print("Swift bounded 161 MiB copy and file validation passed with malformed, expiry, cancellation and orphan cleanup cases.")
  }
}
