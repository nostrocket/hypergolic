import Foundation

@main
struct FrameVectorsSwift {
    static var assertions = 0
    static func main() throws {
        let contents = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
        for line in contents.split(whereSeparator: \.isNewline) {
            if line.hasPrefix("#") || line.isEmpty { continue }
            let fields = line.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
            let parser = PublishedRelayWebSocketFrames()
            let bytes = data(hex: fields[1])
            let chunk = fields[0] == "one-byte-incremental" ? 1 : 3
            var events: [PublishedRelayWebSocketFrames.Event] = []
            var offset = 0
            while offset < bytes.count {
                let end = min(bytes.count, offset + chunk)
                events += parser.feed(bytes.subdata(in: offset..<end))
                offset = end
            }
            equal(fields[2], normalized(events), fields[0])
        }
        exactMessageBoundary()
        overMessageBoundary()
        rawFrameBoundary()
        oversizedRead()
        print("Swift shared vectors and bounds: \(assertions) assertions passed")
    }

    static func exactMessageBoundary() {
        let parser = PublishedRelayWebSocketFrames()
        var events = feed(parser, firstFragment())
        events += parser.feed(Data([0x80, 10, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98]))
        guard events.count == 1, case .text(let value) = events[0] else { fail("exact 66560-byte text message event") }
        check(value.utf8.count == 66_560, "exact 66560-byte fragmented UTF-8 text accepted")
    }

    static func overMessageBoundary() {
        let parser = PublishedRelayWebSocketFrames()
        var events = feed(parser, firstFragment())
        events += parser.feed(Data([0x80, 11, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98]))
        equal("ERROR:message-too-large", normalized(events), "fragmented message overflow")
    }

    static func rawFrameBoundary() {
        let parser = PublishedRelayWebSocketFrames()
        equal("ERROR:frame-too-large", normalized(parser.feed(Data([0x81, 127, 0, 0, 0, 0, 0, 1, 3, 247]))),
              "66,561-byte raw frame rejected from header alone")
    }

    static func oversizedRead() {
        let parser = PublishedRelayWebSocketFrames()
        equal("ERROR:read-too-large", normalized(parser.feed(Data(repeating: 0, count: 8_193))), "read chunk limit")
    }

    static func firstFragment() -> Data {
        var bytes = Data([0x01, 127, 0, 0, 0, 0, 0, 1, 3, 246])
        bytes.append(Data(repeating: 97, count: 66_550))
        return bytes
    }

    static func feed(_ parser: PublishedRelayWebSocketFrames, _ data: Data) -> [PublishedRelayWebSocketFrames.Event] {
        var events: [PublishedRelayWebSocketFrames.Event] = []
        var offset = 0
        while offset < data.count {
            let end = min(data.count, offset + 8_192)
            events += parser.feed(data.subdata(in: offset..<end))
            offset = end
        }
        return events
    }

    static func data(hex: String) -> Data {
        var result = Data(); var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            result.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        return result
    }
    static func normalized(_ events: [PublishedRelayWebSocketFrames.Event]) -> String {
        events.map(\.normalized).joined(separator: ";")
    }
    static func equal(_ expected: String, _ actual: String, _ name: String) {
        check(expected == actual, "\(name) expected=\(expected) actual=\(actual)")
    }
    static func check(_ ok: Bool, _ name: String) { assertions += 1; if !ok { fail(name) } }
    static func fail(_ name: String) -> Never { fatalError(name) }
}
