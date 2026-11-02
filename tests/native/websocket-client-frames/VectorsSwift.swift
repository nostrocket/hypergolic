import Foundation

private var assertions = 0

func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    guard condition() else { fatalError("\(name) failed") }
    assertions += 1
}

func rejects(_ name: String, _ body: () throws -> Void) {
    do { try body(); fatalError("\(name) accepted") }
    catch { assertions += 1 }
}

let vectorURL = URL(fileURLWithPath: CommandLine.arguments[1])
let rows = try String(contentsOf: vectorURL, encoding: .utf8).split(whereSeparator: \.isNewline)
for row in rows where !row.hasPrefix("#") {
    let fields = row.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
    let input = Data(base64Encoded: fields[1])!
    let mask = Data(hex: fields[2])
    let actual: Data
    switch fields[0] {
    case "text-req", "empty-text":
        actual = try PublishedRelayWebSocketClientFrames.textReq(String(data: input, encoding: .utf8)!, mask: mask)
    case "pong": actual = try PublishedRelayWebSocketClientFrames.pong(input, mask: mask)
    case "close":
        let close = String(data: input, encoding: .utf8)!.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
        actual = try PublishedRelayWebSocketClientFrames.close(code: Int(close[0])!, reason: String(close[1]), mask: mask)
    default: fatalError("unknown vector \(fields[0])")
    }
    check(actual == Data(base64Encoded: fields[3])!, "\(fields[0]) frame")
}

rejects("short-mask") { _ = try PublishedRelayWebSocketClientFrames.pong(Data(), mask: Data([1, 2, 3])) }
rejects("long-pong") { _ = try PublishedRelayWebSocketClientFrames.pong(Data(repeating: 0, count: 126), mask: Data(repeating: 0, count: 4)) }
rejects("long-close-reason") { _ = try PublishedRelayWebSocketClientFrames.close(code: 1000, reason: String(repeating: "x", count: 124), mask: Data(repeating: 0, count: 4)) }
rejects("reserved-close-code") { _ = try PublishedRelayWebSocketClientFrames.close(code: 1005, reason: "", mask: Data(repeating: 0, count: 4)) }
rejects("oversized-text") { _ = try PublishedRelayWebSocketClientFrames.textReq(String(repeating: "x", count: 8193), mask: Data(repeating: 0, count: 4)) }
let extended = try PublishedRelayWebSocketClientFrames.textReq(String(repeating: "a", count: 126), mask: Data([1, 2, 3, 4]))
check(extended.count == 134 && extended[1] == 0xfe && extended[2] == 0 && extended[3] == 126, "extended-length-header")
for i in 0..<126 { check(extended[8 + i] ^ extended[4 + (i & 3)] == UInt8(ascii: "a"), "extended-length-payload") }

let randomFrame = try PublishedRelayWebSocketClientFrames.pong(Data([1, 2, 3]))
check(randomFrame.count == 9 && randomFrame[1] & 0x80 != 0, "random-mask-frame-shape")
let mask = Array(randomFrame[2..<6])
for i in 0..<3 { check(randomFrame[6 + i] ^ mask[i] == UInt8(i + 1), "random-mask-payload") }
print("Swift RFC6455 client frame vectors and limits: \(assertions) passed")

private extension Data {
    init(hex: String) {
        var bytes = [UInt8]()
        var index = hex.startIndex
        while index < hex.endIndex {
            let end = hex.index(index, offsetBy: 2)
            bytes.append(UInt8(hex[index..<end], radix: 16)!)
            index = end
        }
        self.init(bytes)
    }
}
