import Foundation
import UIKit
import WebKit
import XCTest
@testable import BoundaryProbe

/// Physical WK network attempts against an independent, nonce-scoped LAN receiver.
@MainActor
final class NetworkBoundaryTests: XCTestCase {
  private func endpoint(_ path: String) throws -> URL {
    let environment = ProcessInfo.processInfo.environment
    let origin = try XCTUnwrap(environment["HG_BOUNDARY_RECEIVER_URL"])
    let nonce = try XCTUnwrap(environment["HG_BOUNDARY_RECEIVER_NONCE"])
    return try XCTUnwrap(URL(string: origin + "/" + nonce + "/" + path))
  }

  private func control(_ name: String) async throws {
    let url = try endpoint("control/" + name)
    let owner = ControlNavigation()
    let view = WKWebView(frame: CGRect(x:0,y:0,width:320,height:320))
    let app = try XCTUnwrap(UIApplication.shared.delegate as? AppDelegate)
    let container = try XCTUnwrap(app.window?.rootViewController?.view)
    container.addSubview(view)
    view.navigationDelegate = owner
    defer { view.stopLoading(); view.navigationDelegate=nil; view.removeFromSuperview() }
    view.load(URLRequest(url:url))
    let deadline = Date().addingTimeInterval(10)
    while !owner.done && owner.error == nil {
      if Date() >= deadline { throw ProbeError.timedOut("external receiver positive control") }
      try await Task.sleep(for:.milliseconds(20))
    }
    XCTAssertNil(owner.error)
    guard owner.error == nil else { throw ProbeError.invalidResult }
    let body: String = try await withCheckedThrowingContinuation { continuation in
      view.evaluateJavaScript("document.body.textContent") { value,error in
        if let error { continuation.resume(throwing:error) }
        else if let value=value as? String { continuation.resume(returning:value) }
        else { continuation.resume(throwing:ProbeError.invalidResult) }
      }
    }
    XCTAssertEqual(body.trimmingCharacters(in:.whitespacesAndNewlines), "boundary-control-ok")
    let attachment = XCTAttachment(string:"Actual unrestricted WK receiver control: " + url.absoluteString)
    attachment.name=name;attachment.lifetime = .keepAlways;add(attachment)
  }

  func testExternalReceiverWithReachableWKControlsAndGuestCSPDenials() async throws {
    try await control("before")
    let p=Probe();defer {p.close()}
    try await p.ready()
    let target=try endpoint("guest").absoluteString
    let quoted=String(decoding:try JSONSerialization.data(withJSONObject:[target]),as:UTF8.self)
    let value=try await p.json("""
      const target=\(quoted)[0];
      const violations=[];addEventListener('securitypolicyviolation',e=>violations.push({directive:e.effectiveDirective,uri:e.blockedURI}));
      const denied={};
      const outcome=start=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No observable denial')),3000);start(v=>{clearTimeout(timer);resolve(v);});});
      try {await fetch(target+'/fetch');denied.fetch=false;}catch {denied.fetch=true;}
      denied.xhr=await outcome(done=>{const xhr=new XMLHttpRequest();xhr.onload=()=>done(false);xhr.onerror=()=>done(true);xhr.open('GET',target+'/xhr');xhr.send();});
      denied.websocket=await outcome(done=>{try {const ws=new WebSocket(target.replace('http:','ws:')+'/websocket');ws.onopen=()=>{ws.close();done(false);};ws.onerror=()=>done(true);}catch {done(true);}});
      denied.image=await outcome(done=>{const image=new Image();image.onload=()=>done(false);image.onerror=()=>done(true);image.src=target+'/image';});
      denied.script=await outcome(done=>{const script=document.createElement('script');script.onload=()=>done(false);script.onerror=()=>done(true);script.src=target+'/script';document.head.append(script);});
      denied.css=await outcome(done=>{const link=document.createElement('link');link.rel='stylesheet';link.onload=()=>done(false);link.onerror=()=>done(true);link.href=target+'/css';document.head.append(link);});
      denied.worker=await outcome(done=>{try {const worker=new Worker(target+'/worker');worker.onmessage=()=>{worker.terminate();done(false);};worker.onerror=e=>{e.preventDefault();worker.terminate();done(true);};}catch {done(true);}});
      const originalLocation=location.href;const form=document.createElement('form');form.method='POST';form.action=target+'/form';document.body.append(form);form.submit();
      const popup=window.open(target+'/popup','_blank');denied.popup=popup===null;if(popup)popup.close();
      await new Promise(resolve=>setTimeout(resolve,250));
      return {denied,violations,form:{action:form.action,method:form.method,connected:form.isConnected,locationUnchanged:location.href===originalLocation}};
      """,frame:p.guest)
    XCTAssertEqual(value["denied"] as? [String:Bool],["fetch":true,"xhr":true,"websocket":true,"image":true,"script":true,"css":true,"worker":true,"popup":true])
    let violations=try XCTUnwrap(value["violations"] as? [[String:String]])
    for (path,directives) in [("fetch",["connect-src"]),("xhr",["connect-src"]),("websocket",["connect-src"]),("image",["img-src"]),("script",["script-src","script-src-elem"]),("css",["style-src","style-src-elem"])] {
      XCTAssertTrue(violations.contains { directives.contains($0["directive"] ?? "") && $0["uri"]?.contains("/guest/"+path) == true },path)
    }
    let form=try XCTUnwrap(value["form"] as? [String:Any])
    XCTAssertEqual(form["action"] as? String,target + "/form")
    XCTAssertEqual(form["method"] as? String,"post")
    XCTAssertEqual(form["connected"] as? Bool,true)
    XCTAssertEqual(form["locationUnchanged"] as? Bool,true)
    let sandbox=try await p.json("return {sandbox:document.querySelector('#napplet').getAttribute('sandbox')};",frame:p.main)
    XCTAssertEqual(sandbox["sandbox"] as? String,"allow-scripts")
    try await p.barrier()
    try p.attach(to:self,name:name)
    try await control("after")
  }
}

@MainActor
private final class ControlNavigation: NSObject, WKNavigationDelegate {
  var done=false
  var error: Error?
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {done=true}
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {self.error=error}
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {self.error=error}
}
