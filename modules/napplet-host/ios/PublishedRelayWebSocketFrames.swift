import Foundation

/// Bounded RFC 6455 server-to-client frame decoder. It deliberately performs no I/O.
final class PublishedRelayWebSocketFrames {
    static let maxBytes = 66_560
    static let maxRead = 8_192

    enum Event: Equatable {
        case text(String), ping(Data), pong(Data), close(Int, String), error(String)

        var normalized: String {
            switch self {
            case .text(let value): return "TEXT:\(Data(value.utf8).hex)"
            case .ping(let value): return "PING:\(value.hex)"
            case .pong(let value): return "PONG:\(value.hex)"
            case .close(let code, let reason): return "CLOSE:\(code):\(Data(reason.utf8).hex)"
            case .error(let value): return "ERROR:\(value)"
            }
        }
    }

    private let maximumBytes: Int
    init(maximumBytes: Int = PublishedRelayWebSocketFrames.maxBytes) { self.maximumBytes = maximumBytes }

    private enum State { case base, extended, payload }
    private var state = State.base
    private var base: [UInt8] = []
    private var extended: [UInt8] = []
    private var extNeeded = 0
    private var headerSize = 0
    private var opcode: UInt8 = 0
    private var frameLength = 0
    private var framePayload: [UInt8] = []
    private var message: [UInt8]?
    private var failed = false
    private var closed = false
    private(set) var completedFrames = 0
    private(set) var consumedInput = 0

    func feed(_ input: Data) -> [Event] {
        var events: [Event] = []
        consumedInput = 0
        guard input.count <= Self.maxRead else { fail(&events, "read-too-large"); return events }
        guard !failed && !closed else { fail(&events, "closed"); return events }
        for byte in input {
            if failed || closed { break }
            consumedInput += 1
            switch state {
            case .base:
                base.append(byte)
                if base.count == 2 { beginHeader(&events) }
            case .extended:
                extended.append(byte)
                if extended.count == extNeeded { finishLength(&events) }
            case .payload:
                framePayload.append(byte)
                if framePayload.count == frameLength { finishFrame(&events) }
            }
        }
        return events
    }

    private func beginHeader(_ events: inout [Event]) {
        let first = base[0], second = base[1]
        guard first & 0x70 == 0 else { fail(&events, "reserved-bits"); return }
        guard second & 0x80 == 0 else { fail(&events, "masked-server-frame"); return }
        opcode = first & 0x0f
        let fin = first & 0x80 != 0
        lastFrameWasFinal = fin
        let marker = Int(second & 0x7f)
        let control = opcode >= 8
        guard [UInt8(0), 1, 8, 9, 10].contains(opcode) else { fail(&events, "unsupported-opcode"); return }
        guard !control || (fin && marker <= 125) else { fail(&events, "invalid-control-frame"); return }
        guard opcode != 0 || message != nil else { fail(&events, "unexpected-continuation"); return }
        guard opcode != 1 || message == nil else { fail(&events, "nested-fragment"); return }
        base = []
        headerSize = 2
        if marker < 126 { frameLength = marker; acceptLength(&events) }
        else { extNeeded = marker == 126 ? 2 : 8; extended = []; state = .extended }
    }

    private func finishLength(_ events: inout [Event]) {
        if extNeeded == 8 && extended[0] & 0x80 != 0 { fail(&events, "frame-too-large"); return }
        var length: UInt64 = 0
        for byte in extended { length = (length << 8) | UInt64(byte) }
        if (extNeeded == 2 && length < 126) || (extNeeded == 8 && length < 65_536) {
            fail(&events, "noncanonical-length"); return
        }
        guard length <= UInt64(maximumBytes) else { fail(&events, "frame-too-large"); return }
        frameLength = Int(length)
        headerSize += extNeeded
        acceptLength(&events)
    }

    private func acceptLength(_ events: inout [Event]) {
        guard headerSize + frameLength <= maximumBytes else { fail(&events, "frame-too-large"); return }
        if opcode < 8 {
            let prior = opcode == 1 ? 0 : (message?.count ?? 0)
            guard frameLength <= maximumBytes - prior else { fail(&events, "message-too-large"); return }
        }
        // Reserve only after both the raw-frame and accumulated-message limits pass.
        framePayload = []
        framePayload.reserveCapacity(frameLength)
        state = .payload
        if frameLength == 0 { finishFrame(&events) }
    }

    private func finishFrame(_ events: inout [Event]) {
        completedFrames += 1
        switch opcode {
        case 1, 0:
            if opcode == 1 { message = [] }
            message!.append(contentsOf: framePayload)
            if lastFrameWasFinal {
                guard let text = String(data: Data(message!), encoding: .utf8) else { fail(&events, "invalid-utf8"); return }
                events.append(.text(text))
                message = nil
            }
        case 9: events.append(.ping(Data(framePayload)))
        case 10: events.append(.pong(Data(framePayload)))
        case 8:
            if framePayload.count == 1 { fail(&events, "invalid-close-payload"); return }
            var code = 1005
            var reason = ""
            if framePayload.count >= 2 {
                code = (Int(framePayload[0]) << 8) | Int(framePayload[1])
                guard Self.validCloseCode(code) else { fail(&events, "invalid-close-code"); return }
                guard let decoded = String(data: Data(framePayload.dropFirst(2)), encoding: .utf8) else { fail(&events, "invalid-utf8"); return }
                reason = decoded
            }
            events.append(.close(code, reason)); closed = true; message = nil
        default: fail(&events, "unsupported-opcode"); return
        }
        resetFrame()
    }

    // FIN is captured with the header because `base` is cleared while the payload streams in.
    private var lastFrameWasFinal = false

    private func resetFrame() {
        state = .base; base = []; extended = []; extNeeded = 0
        headerSize = 0; frameLength = 0; framePayload = []
    }

    private func fail(_ events: inout [Event], _ reason: String) {
        if !failed { events.append(.error(reason)) }
        failed = true; framePayload = []; message = nil
    }

    private static func validCloseCode(_ code: Int) -> Bool {
        code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].contains(code) && !(1016..<3000).contains(code)
    }
}

private extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
