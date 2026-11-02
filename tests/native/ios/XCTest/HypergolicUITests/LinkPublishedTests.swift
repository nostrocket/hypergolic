import XCTest

final class LinkPublishedTests: XCTestCase {
 func testAdmission() throws {
  continueAfterFailure=false
  let app=XCUIApplication(bundleIdentifier:"org.nostrocket.hypergolic.linkpublishedfixture")
  let publisher="c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
  func wait(_ value:String){XCTAssertTrue(app.staticTexts[value].waitForExistence(timeout:30),app.debugDescription)}
  func capture(_ name:String){let shot=XCTAttachment(screenshot:app.screenshot());shot.name=name;shot.lifetime = .keepAlways;add(shot);let tree=XCTAttachment(string:app.debugDescription);tree.name=name+"-AX";tree.lifetime = .keepAlways;add(tree)}
  func passed(_ name:String){capture(name);print("LINK_PUBLISHED_CHECK:"+name);fflush(stdout)}
  func button(_ name:String){let control=app.buttons[name];XCTAssertTrue(control.waitForExistence(timeout:15),app.debugDescription);XCTAssertTrue(control.isHittable,app.debugDescription);control.tap()}
  func settings(_ element:XCUIElement){
   for _ in 0..<20 {if element.isHittable{return};let scroll=app.scrollViews.firstMatch
    if element.exists && element.frame.midY < scroll.frame.minY {scroll.swipeDown()}else{scroll.swipeUp()}}
   XCTFail("Settings control unavailable: "+app.debugDescription)
  }
  func settingsButton(_ name:String){let control=app.buttons[name];settings(control);control.tap()}
  func host()->XCUIElement{XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout:20),app.debugDescription)
   let views=app.webViews.allElementsBoundByIndex.filter{$0.frame.intersects(app.frame)&&$0.frame.height>1&&$0.frame.width>1}
   XCTAssertFalse(views.isEmpty,app.debugDescription);XCTAssertTrue(views.allSatisfy{$0.frame==views[0].frame},app.debugDescription);return views[0]
  }
  func guest(_ name:String){let view=host(),control=view.buttons[name]
   for direction in [true,false] {for _ in 0..<20 {if control.isHittable {control.tap();return}
    let high=view.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.15)),low=view.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.5))
    (direction ? low:high).press(forDuration:0.05,thenDragTo:direction ? high:low)}}
   XCTFail("Guest control unavailable: "+app.debugDescription)
  }
  func absent(){XCTAssertFalse(app.alerts["Open external link?"].exists,app.debugDescription)}
  func admitted(){wait("Ready to request a link.");absent();XCTAssertFalse(app.staticTexts["Link handed to your device."].exists);XCTAssertFalse(app.staticTexts["Link opening denied."].exists)}
  func receipt(_ status:String){let expected="{\"status\":\""+status+"\"}";wait(expected);print("LINK_PUBLISHED_SDK:"+app.staticTexts[expected].label);fflush(stdout)}
  func review(){guest("Open external link");XCTAssertTrue(app.alerts["Open external link?"].waitForExistence(timeout:15),app.debugDescription)
   let text=app.alerts["Open external link?"].staticTexts.allElementsBoundByIndex.map{$0.label}.joined(separator:"\n")
   XCTAssertTrue(text.contains("Napplet: signed-resource-link-lab"),text);XCTAssertTrue(text.contains("Publisher: "+publisher),text);XCTAssertTrue(text.contains("https://example.com/?hypergolic=link-tracer"),text);XCTAssertFalse(text.contains("Unsigned embedded"));XCTAssertFalse(text.contains("Read external page"));capture("signed-native-review")
  }
  func cancel(){app.alerts.buttons["Cancel"].tap();wait("Link opening denied.");receipt("denied");absent()}
  func openSigned(_ role:String,_ reject:Bool=false){
   let address=app.staticTexts["signed-"+role+"-address"];XCTAssertTrue(address.waitForExistence(timeout:30),app.debugDescription);let link=address.label;XCTAssertTrue(link.hasPrefix("naddr1"))
   button("shell-settings");let input=app.textFields["settings-napplet-address"];settings(input);input.tap()
   if let old=input.value as? String,!old.isEmpty {input.typeText(String(repeating:XCUIKeyboardKey.delete.rawValue,count:old.count))}
   input.typeText(link+"\n")
   let consent=app.staticTexts["Allow this napplet?"].firstMatch;XCTAssertTrue(consent.waitForExistence(timeout:30),app.debugDescription);settings(consent)
   wait("Requested access: "+(role=="link" ? "link, resource":"resource"));capture(role+"-domain-consent")
   if reject{settingsButton("settings-napplet-reject");XCTAssertFalse(app.webViews.firstMatch.exists);absent();passed("domain-consent-decline-no-host");settingsButton("settings-open-napplet");XCTAssertTrue(consent.waitForExistence(timeout:30),app.debugDescription)}
   settingsButton("settings-napplet-approve");admitted()
  }
  app.terminate();app.launch();openSigned("link",true);passed("signed-resource-normal-admission")
  review();cancel();passed("signed-native-cancel")
  review();app.alerts.buttons["Open once"].tap();let safari=XCUIApplication(bundleIdentifier:"com.apple.mobilesafari")
  XCTAssertTrue(safari.wait(for:.runningForeground,timeout:15),safari.debugDescription);let shot=XCTAttachment(screenshot:safari.screenshot());shot.name="signed-safari-handler";shot.lifetime = .keepAlways;add(shot)
  app.activate();wait("Link handed to your device.");receipt("opened");passed("signed-actual-os-handoff-return")
  review();cancel();passed("each-opening-needs-new-review")
  app.terminate();app.launch();admitted();review();cancel();passed("cold-grant-retained-new-review-required")
  button("shell-settings");settingsButton("identity-select-"+publisher);wait("Switch identity?");settingsButton("identity-change-confirm");wait("Open this napplet?");wait("Access: link, resource");capture("new-identity-domain-consent");button("Allow and open");admitted();review();cancel();passed("normal-confirmed-identity-fresh-review")
  openSigned("no-link");guest("Open external link");wait("Link request unavailable.");absent();passed("missing-link-domain-cannot-open")
 }
}
