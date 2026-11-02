import Foundation
import Security

/// Bounded RFC 6455 client-to-server frame encoder. It performs no I/O or fragmentation.
final class PublishedRelayWebSocketClientFrames {
    static let maxRawBytes = 66_560
    static let maxTextBytes = 8_192
    private static let maxControlBytes = 125

    /// Encodes one final UTF-8 text frame for the bounded relay lookup path.
    static func textReq(_ text: String) throws -> Data {
        try textReq(text, mask: secureMask())
    }

    /// Deterministic proof overload. The mask must be exactly four bytes.
    static func textReq(_ text: String, mask: Data) throws -> Data {
        guard text.utf8.count <= maxTextBytes else { throw invalid() }
        let payload = Data(text.utf8)
        guard payload.count <= maxTextBytes, String(data: payload, encoding: .utf8) == text else { throw invalid() }
        return try encode(opcode: 0x1, payload: payload, mask: mask)
    }

    /// Encodes a pong echoing a received ping payload.
    static func pong(_ pingPayload: Data) throws -> Data {
        try pong(pingPayload, mask: secureMask())
    }

    /// Deterministic proof overload.
    static func pong(_ pingPayload: Data, mask: Data) throws -> Data {
        guard pingPayload.count <= maxControlBytes else { throw invalid() }
        return try encode(opcode: 0xA, payload: pingPayload, mask: mask)
    }

    /// Encodes a close frame with a status code and optional UTF-8 reason.
    static func close(code: Int, reason: String) throws -> Data {
        try close(code: code, reason: reason, mask: secureMask())
    }

    /// Deterministic proof overload.
    static func close(code: Int, reason: String, mask: Data) throws -> Data {
        guard validCloseCode(code), reason.utf8.count <= maxControlBytes - 2 else { throw invalid() }
        let reasonData = Data(reason.utf8)
        guard reasonData.count <= maxControlBytes - 2,
              String(data: reasonData, encoding: .utf8) == reason else { throw invalid() }
        var payload = Data([UInt8((code >> 8) & 0xff), UInt8(code & 0xff)])
        payload.append(reasonData)
        return try encode(opcode: 0x8, payload: payload, mask: mask)
    }

    private static func encode(opcode: UInt8, payload: Data, mask: Data) throws -> Data {
        let lengthBytes = payload.count <= 125 ? 0 : 2
        let payloadOffset = 2 + lengthBytes + 4
        guard mask.count == 4, payload.count + payloadOffset <= maxRawBytes,
              payload.count <= maxTextBytes,
              opcode < 8 || payload.count <= maxControlBytes else { throw invalid() }
        var output = Data([0x80 | opcode, 0x80 | UInt8(lengthBytes == 0 ? payload.count : 126)])
        if lengthBytes != 0 {
            output.append(UInt8((payload.count >> 8) & 0xff))
            output.append(UInt8(payload.count & 0xff))
        }
        output.append(mask)
        for (index, byte) in payload.enumerated() { output.append(byte ^ mask[index & 3]) }
        return output
    }

    private static func secureMask() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 4)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw invalid() }
        return Data(bytes)
    }

    private static func validCloseCode(_ code: Int) -> Bool {
        code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].contains(code) && !(1016..<3000).contains(code)
    }

    private static func invalid() -> NSError {
        NSError(domain: "PublishedRelayWebSocketClientFrames", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Invalid bounded WebSocket client frame"])
    }
}
