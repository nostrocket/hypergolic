import Foundation
import UIKit
import WebKit
import XCTest
@testable import BoundaryProbe

/// Published byte/SDK/native admission component proof. No protected signer or real WSS connection is substituted.
@MainActor
final class PublishedOutboxTests: XCTestCase {
  private var probe: Probe?
  override func tearDown() async throws {
    if let probe {try probe.attach(to: self, name: name); probe.close()}
    probe = nil
    try await super.tearDown()
  }
  private func published() async throws -> Probe {
    let p = Probe(); probe = p
    let bundle = try XCTUnwrap(Bundle(url: XCTUnwrap(Bundle.main.url(forResource: "HypergolicNappletHostAssets", withExtension: "bundle"))))
    let html = try Data(contentsOf: XCTUnwrap(bundle.url(forResource: "published-outbox", withExtension: "html")))
    let manifest = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: XCTUnwrap(bundle.url(forResource: "published-outbox-manifest", withExtension: "json")))) as? [String: Any])
    let tags = try XCTUnwrap(manifest["tags"] as? [[String]])
    let publisher = try XCTUnwrap(manifest["pubkey"] as? String), eventId = try XCTUnwrap(manifest["id"] as? String)
    let version = try XCTUnwrap(tags.first {$0[0] == "x"}?[1]), hash = try XCTUnwrap(tags.first {$0[0] == "path"}?[2])
    let appId = try XCTUnwrap(tags.first {$0[0] == "d"}?[1])
    let claims = PublishedArtifactRegistry.Claims(sessionId: p.session, publisher: publisher, identifier: appId, eventId: eventId, aggregateHash: version, htmlHash: hash)
    XCTAssertTrue(PublishedArtifactTransfer.shared.registry.registerSession(p.session))
    let handle = try XCTUnwrap(PublishedArtifactTransfer.shared.registry.stage(html, claims: claims))
    let config: [String: Any] = ["sessionId": p.session, "epoch": 3, "user": String(repeating: "1", count: 64),
      "publisher": publisher, "appId": appId, "version": version, "instanceId": p.session, "fixture": "published", "domains": ["outbox", "relay", "theme"]]
    let input: [String: Any] = ["sessionId": p.session, "publisher": publisher, "appId": appId, "eventId": eventId,
      "version": version, "htmlHash": hash, "handle": handle, "configuration": String(decoding: try JSONSerialization.data(withJSONObject: config), as: UTF8.self)]
    try p.startPublished(String(decoding: try JSONSerialization.data(withJSONObject: input), as: UTF8.self))
    try await p.until("actual published native ready and opaque guest") {p.events.contains {$0["type"] as? String == "ready"} && p.guest != nil}
    XCTAssertEqual(p.events.first?["type"] as? String, "ready")
    return p
  }
  private func envelope(_ raw: String, _ p: Probe, _ type: String) throws -> [String: Any] {
    let value = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
    let registration = try XCTUnwrap(value["registration"] as? [String: Any])
    XCTAssertEqual(registration["fixture"] as? String, "published")
    XCTAssertEqual(registration["sessionId"] as? String, p.session)
    XCTAssertEqual(registration["generation"] as? String, try p.generation)
    XCTAssertEqual(Set(try XCTUnwrap(registration["domains"] as? [String])), ["outbox", "relay", "theme"])
    let request = try XCTUnwrap(value["request"] as? String)
    let message = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(request.utf8)) as? [String: Any])
    XCTAssertEqual(message["type"] as? String, type)
    return message
  }
  func testPublishedSDKQueryUsesNativeBoundClaimsAndOneUseReply() async throws {
    let p = try await published()
    _ = try await p.json("window.queryResult=null;napplet.outbox.query({kinds:[1],limit:0}).then(value=>window.queryResult=value);return {sent:true};", frame: p.guest)
    try await p.until("published query native token") {p.events.contains {$0["type"] as? String == "capability" && $0["lane"] == nil}}
    let token = try XCTUnwrap(p.events.last?["token"] as? String)
    let wire = try envelope(XCTUnwrap(CapabilityTransport.leases.take(token)), p, "outbox.query")
    XCTAssertNil(CapabilityTransport.leases.take(token))
    let id = try XCTUnwrap(wire["id"] as? String)
    let response: [String: Any] = ["type": "outbox.query.result", "id": id, "events": []]
    CapabilityTransport.finish(token, response: String(decoding: try JSONSerialization.data(withJSONObject: response), as: UTF8.self))
    let result = try await p.json("const deadline=performance.now()+2500;while(!window.queryResult){if(performance.now()>deadline)throw Error('Query reply timeout');await new Promise(resolve=>setTimeout(resolve,20));}return {result:window.queryResult};", frame: p.guest)
    XCTAssertEqual((result["result"] as? [String: Any])?["id"] as? String, id)
  }
  func testPublishedSDKPublicationRejectionRetainsNativeOriginAndCloseRevokes() async throws {
    let p = try await published()
    _ = try await p.json("window.publishResult=null;napplet.outbox.publish({kind:1,created_at:1800000000,tags:[],content:'Native published admission'}, {toOutbox:false,relays:['wss://relay.example.org']}).then(value=>window.publishResult=value);return {sent:true};", frame: p.guest)
    try await p.until("published approval native token") {p.events.contains {$0["lane"] as? String == "approval"}}
    let token = try XCTUnwrap(p.events.last?["token"] as? String)
    let wire = try envelope(XCTUnwrap(ApprovalTransport.take(token)), p, "outbox.publish")
    XCTAssertNil(ApprovalTransport.take(token))
    let options = try XCTUnwrap(wire["options"] as? [String: Any]); XCTAssertEqual(options["toOutbox"] as? Bool, false)
    let response: [String: Any] = ["type": "outbox.publish.result", "id": try XCTUnwrap(wire["id"] as? String), "ok": false, "error": "approval denied"]
    ApprovalTransport.finish(token, response: String(decoding: try JSONSerialization.data(withJSONObject: response), as: UTF8.self))
    let result = try await p.json("const deadline=performance.now()+2500;while(!window.publishResult){if(performance.now()>deadline)throw Error('Publication reply timeout');await new Promise(resolve=>setTimeout(resolve,20));}return {result:window.publishResult};", frame: p.guest)
    XCTAssertEqual((result["result"] as? [String: Any])?["error"] as? String, "approval denied")
    let before = p.events.count
    _ = try await p.json("napplet.outbox.publish({kind:1,created_at:1800000000,tags:[],content:'Close pending request'}, {toOutbox:false,relays:['wss://relay.example.org']});return {sent:true};", frame: p.guest)
    try await p.until("new independently correlated pending publication") {p.events.count > before && p.events.last?["lane"] as? String == "approval"}
    let pending = try XCTUnwrap(p.events.last?["token"] as? String)
    p.close(); XCTAssertFalse(ApprovalTransport.isLive(pending)); XCTAssertNil(ApprovalTransport.take(pending))
  }
  func testPublishedSDKStreamUsesBoundNativePushAndExplicitClose() async throws {
    let p = try await published()
    XCTAssertEqual(UIApplication.shared.applicationState, .active)
    // Explicit app-only lifecycle input supplies the Expo-module part of this component composition.
    RelaySubscriptionTransport.shared.foreground(true)
    _ = try await p.json("window.streamEvents=[];window.stream=napplet.outbox.subscribe({kinds:[1],limit:0});window.stream.on('event',value=>window.streamEvents.push(value));return {sent:true};", frame: p.guest)
    try await p.until("published stream native token") {p.events.contains {$0["lane"] as? String == "outbox-subscription"}}
    let token = try XCTUnwrap(p.events.last?["token"] as? String)
    let wire = try envelope(XCTUnwrap(RelaySubscriptionTransport.shared.registry.take(token)), p, "outbox.subscribe")
    XCTAssertNil(RelaySubscriptionTransport.shared.registry.take(token))
    XCTAssertTrue(RelaySubscriptionTransport.shared.registry.accept(token))
    let bundle = try XCTUnwrap(Bundle(url: XCTUnwrap(Bundle.main.url(forResource: "HypergolicNappletHostAssets", withExtension: "bundle"))))
    let events = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: XCTUnwrap(bundle.url(forResource: "published-stream-event", withExtension: "json")))) as? [[String: Any]])
    let event = try XCTUnwrap(events.first)
    let response: [String: Any] = ["type": "outbox.event", "subId": try XCTUnwrap(wire["subId"] as? String), "result": ["event": event]]
    XCTAssertGreaterThan(RelaySubscriptionTransport.shared.send(token, response: String(decoding: try JSONSerialization.data(withJSONObject: response), as: UTF8.self)), 0)
    let result = try await p.json("const deadline=performance.now()+2500;while(window.streamEvents.length===0){if(performance.now()>deadline)throw Error('Stream timeout');await new Promise(resolve=>setTimeout(resolve,20));}return {event:window.streamEvents[0].event};", frame: p.guest)
    XCTAssertEqual((result["event"] as? [String: Any])?["id"] as? String, event["id"] as? String)
    let before = p.events.count
    _ = try await p.json("window.stream.close();return {closed:true};", frame: p.guest)
    try await p.until("original SDK close reaches bound app broker lane") {p.events.count > before && p.events.last?["type"] as? String == "capability"}
    let closeToken = try XCTUnwrap(p.events.last?["token"] as? String)
    let closeWire = try envelope(XCTUnwrap(CapabilityTransport.leases.take(closeToken)), p, "outbox.close")
    XCTAssertEqual(closeWire["subId"] as? String, wire["subId"] as? String)
    XCTAssertNil(CapabilityTransport.leases.take(closeToken))
    // App-only completion supplies the separately tested shared broker's correlated close action.
    RelaySubscriptionTransport.shared.close(token)
    CapabilityTransport.finish(closeToken, response: nil)
    XCTAssertFalse(RelaySubscriptionTransport.shared.registry.isActive(token))
  }

}
