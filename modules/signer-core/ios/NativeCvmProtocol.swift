import Foundation
import CoreFoundation
import HypergolicNappletHost

/// Only fixed session setup and receiver-side CEP-41 controls may supplement the exact approved bytes.
final class NativeCvmProtocol {
  enum Failure: Error { case denied }
  private var initializationPrepared = false, initialized = false
  private var controls: Int64 = 0
  private let tokenJSON: String?
  init(approved: NativeCvmSourceFacade.Approved) { tokenJSON=approved.progressTokenJSON }
  static func object(_ raw: String) -> [String: Any]? { (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] }
  func validate(_ purpose: String, raw: String, replyTo: String?, approved: NativeCvmSourceFacade.Approved) throws {
    guard approved.permit.current(), raw.utf8.count <= NativeCvmEnvelope.maximumMessage else { throw Failure.denied }
    if purpose == "approved" {
      guard raw.utf8.elementsEqual(approved.message.utf8) else { throw Failure.denied }; return
    }
    if purpose == "stream-control" { guard replyTo == nil else { throw Failure.denied }; try control(raw); return }
    guard replyTo == nil, let object = Self.object(raw), object["jsonrpc"] as? String == "2.0" else { throw Failure.denied }
    switch purpose {
    case "initialize":
      guard approved.initialize, !initializationPrepared, Set(object.keys) == ["jsonrpc","id","method","params"],
        let initializationId=object["id"] as? String, initializationId.range(of:"^hypergolic:init:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",options:.regularExpression) != nil, object["method"] as? String == "initialize",
        let params = object["params"] as? [String: Any], Set(params.keys) == ["protocolVersion","capabilities","clientInfo"],
        params["protocolVersion"] as? String == "2025-06-18", let caps = params["capabilities"] as? [String: Any], caps.isEmpty,
        let client = params["clientInfo"] as? [String: Any], Set(client.keys) == ["name","version"],
        client["name"] as? String == "Hypergolic", client["version"] as? String == "1" else { throw Failure.denied }
      initializationPrepared = true
    case "initialized":
      guard initializationPrepared, !initialized, Set(object.keys) == ["jsonrpc","method"],
        object["method"] as? String == "notifications/initialized" else { throw Failure.denied }; initialized = true
    default: throw Failure.denied
    }
  }
  private func control(_ raw: String) throws {
    guard let tokenJSON, tokenJSON.utf8.count<=1024, controls<4096 else{throw Failure.denied}
    let prefix="{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{\"progressToken\":"+tokenJSON+",\"progress\":"+String(controls+1)+",\"cvm\":{\"type\":\"open-stream\",\"frameType\":"
    guard raw.hasPrefix(prefix),raw.hasSuffix("}}}")else{throw Failure.denied}
    let frame=String(raw.dropFirst(prefix.count).dropLast(3))
    if frame=="\"accept\""{controls+=1;return}
    for kind in ["ping","pong"]{
      let first="\""+kind+"\",\"nonce\":"
      if frame.hasPrefix(first),let count=NativeCvmJSONScalar.stringBytes(String(frame.dropFirst(first.count))),(1...64).contains(count){controls+=1;return}
    }
    throw Failure.denied
  }
}
