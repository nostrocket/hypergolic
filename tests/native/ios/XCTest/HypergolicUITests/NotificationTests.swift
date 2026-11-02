import XCTest

final class NotificationTests: XCTestCase {
 func testTracer() throws {
  continueAfterFailure = false
  let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.presentationfixture")
  func capture(_ name: String) {let image=XCTAttachment(screenshot:app.screenshot());image.name=name;image.lifetime = .keepAlways;add(image);let tree=XCTAttachment(string:app.debugDescription);tree.name=name+"-AX";tree.lifetime = .keepAlways;add(tree)}
  func passed(_ name: String) {capture(name);print("NOTIFY_CHECK:"+name);fflush(stdout)}
  func wait(_ label: String) {XCTAssertTrue(app.staticTexts[label].firstMatch.waitForExistence(timeout:30),app.debugDescription)}
  func button(_ id: String) {let control=app.buttons[id].firstMatch;XCTAssertTrue(control.waitForExistence(timeout:15),app.debugDescription);XCTAssertTrue(control.isHittable,app.debugDescription);control.tap()}
  func settings(_ control: XCUIElement) {
   for direction in [true,false] {for _ in 0..<20 {if control.exists && control.isHittable {return};if direction {app.swipeUp()} else {app.swipeDown()}}};XCTFail("Settings control unavailable: "+app.debugDescription)
  }
  func guest(_ label: String) {
   let views=app.webViews.allElementsBoundByIndex.filter{$0.frame.intersects(app.frame)&&$0.frame.height>1&&$0.frame.width>1};XCTAssertFalse(views.isEmpty,app.debugDescription);let view=views[0],control=view.buttons[label].firstMatch
   for direction in [true,false] {for _ in 0..<20 {if control.exists && control.isHittable {control.tap();return};let high=view.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.15)),low=view.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.55));(direction ? low:high).press(forDuration:0.05,thenDragTo:direction ? high:low)}};XCTFail("Guest unavailable: "+app.debugDescription)
  }
  func json(_ prefix: String, _ marker: String, _ minimumEvents: Int = 0, _ previousID: String = "") throws -> Any {
   let control=app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@",prefix)).firstMatch;XCTAssertTrue(control.waitForExistence(timeout:20),app.debugDescription);if minimumEvents > 0 || !previousID.isEmpty {let completed=NSPredicate {_,_ in guard let value=try? JSONSerialization.jsonObject(with:Data(control.label.utf8)) else {return false};if minimumEvents > 0 {return ((value as? [Any])?.count ?? 0) >= minimumEvents};return (value as? [String:String])?["notificationId"] != previousID};XCTAssertEqual(XCTWaiter.wait(for:[XCTNSPredicateExpectation(predicate:completed,object:nil)],timeout:20),.completed,app.debugDescription)};let raw=control.label;print(marker+raw);fflush(stdout);return try JSONSerialization.jsonObject(with:Data(raw.utf8))
  }
  app.launch();let address=app.staticTexts["signed-caller-address"];XCTAssertTrue(address.waitForExistence(timeout:30),app.debugDescription);let link=address.label;XCTAssertTrue(link.hasPrefix("naddr1"));button("shell-settings")
  let input=app.textFields["settings-napplet-address"];settings(input);input.tap();if let old=input.value as? String,!old.isEmpty {input.typeText(String(repeating:XCUIKeyboardKey.delete.rawValue,count:old.count))}
  for offset in stride(from:0,to:link.count,by:12) {let end=min(offset+12,link.count),startIndex=link.index(link.startIndex,offsetBy:offset),endIndex=link.index(link.startIndex,offsetBy:end);input.typeText(String(link[startIndex..<endIndex]));XCTAssertEqual(input.value as? String,String(link.prefix(end)))}
  input.typeText("\n");wait("Allow this napplet?");wait("Requested access: notify");capture("normal-notify-domain-consent");let approve=app.buttons["settings-napplet-approve"];settings(approve);approve.tap();wait("SDK ready for routing.");passed("signed-notification-domain-admission")
  guest("Request notification permission");wait("Allow notifications?");wait("signed-notify-caller-lab");capture("trusted-notification-permission");button("notify-deny");wait("Notification permission denied.");XCTAssertEqual((try json("{\"granted\":", "NOTIFY_PERMISSION:")) as? [String:Bool],["granted":false]);passed("native-denied-original-sdk-permission")
  guest("Request notification permission");wait("Allow notifications?");button("notify-allow");wait("Notification permission granted.");XCTAssertEqual((try json("{\"granted\":", "NOTIFY_PERMISSION:")) as? [String:Bool],["granted":true]);passed("native-approved-original-sdk-permission")
  var previousID=""
  func send() throws -> String {guest("Send notification");capture("foreground-toast");let value=try json("{\"notificationId\":", "NOTIFY_RESULT:", 0, previousID) as! [String:String];XCTAssertFalse(value["notificationId"]!.isEmpty);previousID=value["notificationId"]!;button("notify-centre-open");let body=app.buttons["notify-click-"+value["notificationId"]!];XCTAssertTrue(body.waitForExistence(timeout:15),app.debugDescription);XCTAssertEqual(body.label,"Routing Lab alert\nExact SDK notification + ⚡");wait("From signed-notify-caller-lab");return value["notificationId"]!}
  let first=try send();capture("attributed-native-notification");passed("native-attributed-exact-sdk-notification");button("notify-action-reply");button("notify-centre-close");let action=try json("[{\"kind\":", "NOTIFY_EVENTS:", 1) as! [[String:Any]];XCTAssertEqual(action.count,1);XCTAssertEqual(action[0]["notificationId"] as? String,first);XCTAssertEqual(action[0]["actionId"] as? String,"reply");passed("native-action-original-sdk-callback")
  let second=try send();button("notify-click-"+second);button("notify-centre-close");let clicked=try json("[{\"kind\":", "NOTIFY_EVENTS:", 2) as! [[String:Any]];XCTAssertEqual(clicked.last?["kind"] as? String,"clicked");XCTAssertEqual(clicked.last?["notificationId"] as? String,second);passed("native-body-original-sdk-callback")
  let third=try send();button("notify-dismiss-"+third);button("notify-centre-close");let dismissed=try json("[{\"kind\":", "NOTIFY_EVENTS:", 3) as! [[String:Any]];XCTAssertEqual(dismissed.last?["kind"] as? String,"dismissed");XCTAssertEqual(dismissed.last?["notificationId"] as? String,third);XCTAssertEqual(dismissed.last?["reason"] as? String,"user");passed("native-dismiss-original-sdk-callback")
 }
}
