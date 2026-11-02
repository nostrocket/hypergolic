import CryptoKit
import Foundation

/// Strict RFC 6455 server-upgrade response validator. Input must contain headers only.
enum PublishedRelayWebSocketHandshake {
    static let maxHeaderBytes = 16_384
    private static let guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    static func validate(_ response: Data, nonce: Data) throws {
        guard nonce.count == 16, !response.isEmpty, response.count <= maxHeaderBytes,
              let raw = String(bytes: response, encoding: .ascii),
              let marker = raw.range(of: "\r\n\r\n"), marker.upperBound == raw.endIndex else {
            throw invalid()
        }
        let lines = raw[..<marker.lowerBound].components(separatedBy: "\r\n")
        guard lines.count >= 2, validStatus(lines[0]) else { throw invalid() }
        var upgrade: String?
        var connection: String?
        var accept: String?
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else { throw invalid() }
            let name = String(line[..<colon])
            guard name.utf8.allSatisfy(isTokenByte) else { throw invalid() }
            let key = name.lowercased()
            let value = trimOWS(String(line[line.index(after: colon)...]))
            guard !value.utf8.contains(where: isForbiddenControl) else { throw invalid() }
            switch key {
            case "upgrade":
                guard upgrade == nil else { throw invalid() }
                upgrade = value
            case "connection":
                guard connection == nil else { throw invalid() }
                connection = value
            case "sec-websocket-accept":
                guard accept == nil else { throw invalid() }
                accept = value
            case "sec-websocket-extensions", "sec-websocket-protocol", "location",
                 "content-length", "transfer-encoding": throw invalid()
            // Unconsumed metadata may repeat (for example Server-Timing or Set-Cookie).
            default: break
            }
        }
        guard hasToken(upgrade, "websocket"), hasToken(connection, "upgrade"),
              let accept,
              constantTimeEqual(Array(accept.utf8), Array(expectedAccept(nonce).utf8)) else {
            throw invalid()
        }
    }

    private static func validStatus(_ value: String) -> Bool {
        guard value.hasPrefix("HTTP/1.1 101") else { return false }
        let suffix = value.dropFirst("HTTP/1.1 101".count)
        return suffix.isEmpty || (suffix.first == " " && suffix.utf8.allSatisfy { $0 >= 0x20 && $0 <= 0x7e })
    }
    private static func expectedAccept(_ nonce: Data) -> String {
        var source = Data(nonce.base64EncodedString().utf8)
        source.append(contentsOf: guid.utf8)
        return Data(Insecure.SHA1.hash(data: source)).base64EncodedString()
    }
    private static func hasToken(_ value: String?, _ token: String) -> Bool {
        value?.split(separator: ",", omittingEmptySubsequences: false)
            .contains { trimOWS(String($0)).caseInsensitiveCompare(token) == .orderedSame } ?? false
    }
    private static func trimOWS(_ value: String) -> String {
        var start = value.startIndex, end = value.endIndex
        while start < end && (value[start] == " " || value[start] == "\t") { start = value.index(after: start) }
        while end > start {
            let prior = value.index(before: end)
            guard value[prior] == " " || value[prior] == "\t" else { break }
            end = prior
        }
        return String(value[start..<end])
    }
    private static func isTokenByte(_ byte: UInt8) -> Bool {
        (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)
            || Array("!#$%&'*+-.^_|~".utf8).contains(byte) || byte == 96
    }
    private static func isForbiddenControl(_ byte: UInt8) -> Bool {
        (byte < 0x20 && byte != 0x09) || byte == 0x7f
    }
    private static func constantTimeEqual(_ lhs: [UInt8], _ rhs: [UInt8]) -> Bool {
        guard lhs.count == rhs.count else { return false }
        return zip(lhs, rhs).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
    private static func invalid() -> NSError {
        NSError(domain: "PublishedRelayWebSocketHandshake", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Invalid WebSocket upgrade response"])
    }
}
