import XCTest

final class ConfigurationTests: XCTestCase {
 func testTracer() throws {
  continueAfterFailure = false
  let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.presentationfixture")
  let token="public-config-test-token-20261004"
  func capture(_ name: String) {let image=XCTAttachment(screenshot:app.screenshot());image.name=name;image.lifetime = .keepAlways;add(image);let tree=XCTAttachment(string:app.debugDescription);tree.name=name+"-AX";tree.lifetime = .keepAlways;add(tree)}
  func passed(_ name: String) {capture(name);print("CONFIG_CHECK:"+name);fflush(stdout)}
  func wait(_ label: String) {XCTAssertTrue(app.staticTexts[label].firstMatch.waitForExistence(timeout:30),app.debugDescription)}
  func button(_ id: String) {let control=app.buttons[id].firstMatch;XCTAssertTrue(control.waitForExistence(timeout:15),app.debugDescription);XCTAssertTrue(control.isHittable,app.debugDescription);control.tap()}
  func settings(_ control: XCUIElement) {
   for direction in [true,false] {for _ in 0..<25 {if control.exists && control.isHittable {return};if direction {app.swipeUp()} else {app.swipeDown()}}};XCTFail("Settings control unavailable: "+app.debugDescription)
  }
  func settingsButton(_ id: String) {let control=app.buttons[id].firstMatch;settings(control);control.tap()}
  func guest(_ label: String) {
   let views=app.webViews.allElementsBoundByIndex.filter{$0.frame.intersects(app.frame)&&$0.frame.height>1&&$0.frame.width>1};XCTAssertFalse(views.isEmpty,app.debugDescription);let view=views[0],control=view.buttons[label].firstMatch
   for direction in [true,false] {for _ in 0..<25 {if control.exists && control.isHittable {control.tap();return};let high=view.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.15)),low=view.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.55));(direction ? low:high).press(forDuration:0.05,thenDragTo:direction ? high:low)}};XCTFail("Guest unavailable: "+app.debugDescription)
  }
  func json(_ prefix: String, _ count: Int = 0) throws -> Any {
   let control=app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@ AND label CONTAINS %@",prefix.hasPrefix("[") ? "[" : "{", "\"theme\":")).firstMatch;XCTAssertTrue(control.waitForExistence(timeout:20),app.debugDescription)
   if count>0 {let completed=NSPredicate {_,_ in guard let value=try? JSONSerialization.jsonObject(with:Data(control.label.utf8)) as? [Any] else {return false};return value.count>=count};XCTAssertEqual(XCTWaiter.wait(for:[XCTNSPredicateExpectation(predicate:completed,object:nil)],timeout:20),.completed,app.debugDescription)}
   print("CONFIG_VALUES:"+control.label);fflush(stdout);return try JSONSerialization.jsonObject(with:Data(control.label.utf8))
  }
  func openCaller(_ first: Bool) {
   let address=app.staticTexts["signed-config-caller-address"];XCTAssertTrue(address.waitForExistence(timeout:30),app.debugDescription);let link=address.label;XCTAssertTrue(link.hasPrefix("naddr1"));button("shell-settings")
   let input=app.textFields["settings-napplet-address"];settings(input);input.tap();if let old=input.value as? String,!old.isEmpty {input.typeText(String(repeating:XCUIKeyboardKey.delete.rawValue,count:old.count))}
   for offset in stride(from:0,to:link.count,by:12) {let end=min(offset+12,link.count),startIndex=link.index(link.startIndex,offsetBy:offset),endIndex=link.index(link.startIndex,offsetBy:end);input.typeText(String(link[startIndex..<endIndex]));XCTAssertEqual(input.value as? String,String(link.prefix(end)))}
   input.typeText("\n")
   if first {wait("Allow this napplet?");wait("Requested access: config");capture("normal-config-domain-consent");settingsButton("settings-napplet-approve")}
   wait("SDK ready for routing.");XCTAssertEqual(app.staticTexts["focused-napplet-name"].label,"signed-config-caller-lab")
  }
  func register() {guest("Register configuration");wait("Configuration schema accepted.")}
  func get() throws -> NSDictionary {guest("Read configuration");wait("Configuration snapshot received.");return try json("{\"theme\":") as! NSDictionary}
  func declinePasswordSuggestion() {
   let sheet=app.sheets["Save Password?"].firstMatch
   if sheet.waitForExistence(timeout:5) {capture("native-system-password-save-declined");let decline=sheet.buttons["Not Now"].firstMatch;XCTAssertTrue(decline.isHittable,app.debugDescription);decline.tap();print("CONFIG_PLATFORM_PROMPT_DECLINED:password-save");fflush(stdout)}
  }

  let defaults: NSDictionary=["theme":"dark","count":3,"enabled":true,"tags":["alpha"],"advanced":["density":"comfortable"]]
  app.launch();button("qa-reset-config");XCTAssertEqual(XCTWaiter.wait(for:[XCTNSPredicateExpectation(predicate:NSPredicate(format:"label == %@","Disposable configuration erased."),object:app.buttons["qa-reset-config"])],timeout:15),.completed,app.debugDescription);openCaller(true);passed("signed-configuration-domain-admission");register();XCTAssertEqual(try get(),defaults);passed("positive-sdk-schema-ack-exact-defaults")
  guest("Subscribe configuration");let initial=try json("[{\"theme\":",1) as! [NSDictionary];XCTAssertEqual(initial,[defaults]);passed("original-sdk-initial-configuration-subscription")
  guest("Open configuration settings");wait("Napplet configuration");wait("signed-config-caller-lab");capture("trusted-native-configuration");settingsButton("config-choice-theme-1")
  let secret=app.secureTextFields["config-secret-token"].firstMatch;settings(secret);XCTAssertTrue(secret.exists,app.debugDescription);secret.tap();secret.typeText(token);secret.typeText("\n");capture("masked-native-secret-input");XCTAssertFalse(app.debugDescription.contains(token),app.debugDescription);passed("trusted-editor-masks-explicit-secret")
  settingsButton("config-save");declinePasswordSuggestion();let expected: NSDictionary=["theme":"light","count":3,"enabled":true,"tags":["alpha"],"advanced":["density":"comfortable"],"token":token];let events=try json("[{\"theme\":",2) as! [NSDictionary];XCTAssertEqual(events,[defaults,expected]);XCTAssertEqual(try get(),expected);passed("trusted-save-original-sdk-live-values")
  app.terminate();app.launch();openCaller(false);register();XCTAssertEqual(try get(),expected);passed("native-cold-restart-original-sdk-persistence")
  guest("Reject secret default schema");wait("Request failed: Configuration schema was not applied.");guest("Reject pattern schema");wait("Request failed: Configuration schema was not applied.");XCTAssertEqual(try get(),expected);passed("negative-sdk-schema-ack-keeps-prior-configuration")
 }
}


/// Owning native input journeys: genuine signed local SDK calls, no synthetic native ACK.
final class PresentationLifecycleTests: XCTestCase {
 let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.presentationfixture")
 let token = "public-config-test-token-20261004"
 let defaults: NSDictionary = ["theme":"dark","count":3,"enabled":true,"tags":["alpha"],"advanced":["density":"comfortable"]]
 func capture(_ name: String) {let image=XCTAttachment(screenshot:app.screenshot());image.name=name;image.lifetime = .keepAlways;add(image);let tree=XCTAttachment(string:app.debugDescription);tree.name=name+"-AX";tree.lifetime = .keepAlways;add(tree)}
 func passed(_ name: String) {capture(name);print("PRESENTATION_CHECK:"+name);fflush(stdout)}
 func wait(_ label: String) {XCTAssertTrue(app.staticTexts[label].firstMatch.waitForExistence(timeout:30),app.debugDescription)}
 func button(_ id: String) {let control=app.buttons[id].firstMatch;XCTAssertTrue(control.waitForExistence(timeout:15),app.debugDescription);XCTAssertTrue(control.isHittable,app.debugDescription);control.tap()}
 func scroll(_ control: XCUIElement) {for direction in [true,false] {for _ in 0..<25 {if control.exists && control.isHittable {return};if direction {app.swipeUp()} else {app.swipeDown()}}};XCTFail("Native control unavailable: "+app.debugDescription)}
 func settingsButton(_ id: String) {let control=app.buttons[id].firstMatch;scroll(control);control.tap()}
 func guestControl(_ id: String, button: Bool = true) -> XCUIElement {
  let views=app.webViews.allElementsBoundByIndex.filter{$0.frame.intersects(app.frame)&&$0.frame.height>1&&$0.frame.width>1};XCTAssertFalse(views.isEmpty,app.debugDescription);let view=views[0],control=button ? view.buttons[id].firstMatch : view.textFields[id].firstMatch
  for direction in [true,false] {for _ in 0..<25 {if control.exists && control.isHittable {return control};let high=view.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.15)),low=view.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.55));(direction ? low:high).press(forDuration:0.05,thenDragTo:direction ? high:low)}};XCTFail("Guest control unavailable: "+app.debugDescription);return control
 }
 func guest(_ label: String) {guestControl(label).tap()}
 func open(_ role: String, _ domain: String) {
  let address=app.staticTexts["signed-"+role+"-address"];XCTAssertTrue(address.waitForExistence(timeout:30),app.debugDescription);let link=address.label;XCTAssertTrue(link.hasPrefix("naddr1"));button("shell-settings");let input=app.textFields["settings-napplet-address"];scroll(input);input.tap()
  if let old=input.value as? String,!old.isEmpty {input.typeText(String(repeating:XCUIKeyboardKey.delete.rawValue,count:old.count))}
  for offset in stride(from:0,to:link.count,by:12) {let end=min(offset+12,link.count),startIndex=link.index(link.startIndex,offsetBy:offset),endIndex=link.index(link.startIndex,offsetBy:end);input.typeText(String(link[startIndex..<endIndex]));XCTAssertEqual(input.value as? String,String(link.prefix(end)))}
  input.typeText("\n");wait("Allow this napplet?");wait("Requested access: "+domain);settingsButton("settings-napplet-approve");wait("SDK ready for routing.")
 }
 func focus(_ name: String) {button("handle-right");wait("Loaded napplets");let open=app.buttons["Open "+name];scroll(open);open.tap();XCTAssertEqual(app.staticTexts["focused-napplet-name"].label,name)}
 func background() {XCUIDevice.shared.press(.home);app.activate();XCTAssertTrue(app.staticTexts["focused-napplet-name"].waitForExistence(timeout:15),app.debugDescription)}
 func edit(_ id: String, _ value: String, secret: Bool = false) {let input=secret ? app.secureTextFields[id].firstMatch : app.textFields[id].firstMatch;scroll(input);input.tap();if let old=input.value as? String,!old.isEmpty {input.typeText(String(repeating:XCUIKeyboardKey.delete.rawValue,count:old.count))};input.typeText(value);input.typeText("\n")}
 func declinePassword() {let sheet=app.sheets["Save Password?"].firstMatch;if sheet.waitForExistence(timeout:3) {capture("native-system-password-save-declined");sheet.buttons["Not Now"].tap();print("PRESENTATION_PLATFORM_PROMPT_DECLINED:password-save");fflush(stdout)}}
 func save() {settingsButton("config-save");declinePassword()}
 func json(_ marker: String, array: Bool = false) throws -> Any {
  let predicate=NSPredicate(format:"label BEGINSWITH %@ AND label CONTAINS %@",array ? "[" : "{",marker),control=app.staticTexts.matching(predicate).firstMatch;XCTAssertTrue(control.waitForExistence(timeout:20),app.debugDescription);let value=try JSONSerialization.jsonObject(with:Data(control.label.utf8));print("PRESENTATION_SDK:"+control.label);fflush(stdout);return value
 }
 func get() throws -> NSDictionary {
  let counter=app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@","{\"reads\":")).firstMatch;XCTAssertTrue(counter.waitForExistence(timeout:15),app.debugDescription)
  let previous=(try JSONSerialization.jsonObject(with:Data(counter.label.utf8)) as! [String:Int])["reads"]!
  guest("Read configuration");let completed=NSPredicate {_,_ in guard let value=try? JSONSerialization.jsonObject(with:Data(counter.label.utf8)) as? [String:Int] else {return false};return (value["reads"] ?? -1)>previous}
  XCTAssertEqual(XCTWaiter.wait(for:[XCTNSPredicateExpectation(predicate:completed,object:nil)],timeout:20),.completed,app.debugDescription)
  return try json("\"theme\":") as! NSDictionary
 }
 func register() {guest("Register configuration");wait("Configuration schema accepted.")}
 func updateCheck() {
  let title=app.staticTexts["signed-config-caller-lab"].firstMatch;scroll(title)
  // UIKit flattens card children. Match the observed, attributed row by geometry.
  let controls=app.buttons.matching(NSPredicate(format:"identifier BEGINSWITH %@","published-update-check-")).allElementsBoundByIndex
  let candidates=controls.filter {$0.exists && $0.frame.minY >= title.frame.maxY && $0.frame.minY < title.frame.maxY + 160 && $0.frame.minX >= title.frame.minX - 1 && $0.frame.maxX <= title.frame.maxX + 1}
  XCTAssertEqual(candidates.count,1,app.debugDescription);let control=candidates[0];scroll(control);control.tap()
 }
 func testConfiguration() throws {
  continueAfterFailure=false;app.launch();button("qa-reset-config");XCTAssertEqual(XCTWaiter.wait(for:[XCTNSPredicateExpectation(predicate:NSPredicate(format:"label == %@","Disposable configuration erased."),object:app.buttons["qa-reset-config"])],timeout:15),.completed,app.debugDescription);open("config-caller","config");register();XCTAssertEqual(try get(),defaults)
  guest("Open configuration settings");settingsButton("config-choice-theme-1");edit("config-secret-token",token,secret:true);save();let expected:NSDictionary=["theme":"light","count":3,"enabled":true,"tags":["alpha"],"advanced":["density":"comfortable"],"token":token];XCTAssertEqual(try get(),expected);passed("native-original-sdk-explicit-config-save-control")
  guest("Open configuration settings");settingsButton("config-choice-theme-0");settingsButton("config-cancel");XCTAssertEqual(try get(),expected);passed("native-config-cancel-does-not-write")
  guest("Open configuration settings");edit("config-field-count","0");settingsButton("config-save");XCTAssertTrue(app.staticTexts["config-save-error"].waitForExistence(timeout:15),app.debugDescription);settingsButton("config-cancel");XCTAssertEqual(try get(),expected);passed("native-invalid-save-keeps-valid-values")
  guest("Subscribe configuration");guest("Open configuration settings");settingsButton("config-choice-theme-0");background();XCTAssertFalse(app.staticTexts["Napplet configuration"].exists,app.debugDescription);XCTAssertEqual(try get(),expected);passed("native-background-revokes-unsaved-editor")
  open("config-peer","config");register();XCTAssertEqual(try get(),defaults);passed("native-different-app-secret-isolation");focus("signed-config-caller-lab");XCTAssertEqual(try get(),expected);passed("native-foreground-switch-retains-config-scope")
  guest("Send invalid configuration requests");wait("Invalid guest configuration requests sent.");XCTAssertEqual(try get(),expected);passed("native-forged-config-authority-and-push-denied")
  guest("Register depth-four schema");wait("Depth-four schema accepted.");let deep=try get();XCTAssertEqual(deep["deep"] as? NSDictionary,["child":["leaf":["values":["native-depth-four"]]]] as NSDictionary);XCTAssertEqual(deep["token"] as? String,token);passed("native-supported-depth-four-array-enum-carrier")
  guest("Remove secret from schema");wait("Secret field removed.");let ordinary:NSDictionary=["theme":"light","count":3,"enabled":true,"tags":["alpha"],"advanced":["density":"comfortable"]];XCTAssertEqual(try get(),ordinary);guest("Restore secret in schema");wait("Secret field restored without saved value.");XCTAssertEqual(try get(),ordinary);passed("native-schema-orphan-secret-is-purged")
  guest("Open configuration settings");edit("config-secret-token",token,secret:true);save();XCTAssertEqual(try get(),expected)
  button("qa-offer-config-update");button("shell-settings");updateCheck();wait("Use this verified update?");capture("native-distinct-config-update-review");settingsButton("Keep current version");button("settings-done");XCTAssertEqual(try get(),expected);passed("native-declined-update-keeps-config-hash-scope")
  button("shell-settings");updateCheck();wait("Use this verified update?");settingsButton("Close and use update");wait("SDK ready for routing.");register();XCTAssertEqual(try get(),defaults);passed("native-accepted-new-hash-starts-fresh-config")
  guest("Open configuration settings");edit("config-secret-token",token,secret:true);save();XCTAssertEqual((try get())["token"] as? String,token);guest("Open configuration settings");settingsButton("config-secret-clear-token");save();XCTAssertEqual(try get(),defaults);passed("native-explicit-secret-clear")
  guest("Open configuration settings");settingsButton("config-choice-theme-1");save();XCTAssertEqual(try get(),ordinary);passed("native-config-matrix-live-positive-save")
 }
 func testNotifications() throws {
  continueAfterFailure=false;app.launch();open("caller","notify");guest("Request notification permission");wait("Allow notifications?");button("notify-allow");wait("Notification permission granted.")
  guest("Set notification badge");wait("Badge requested.");button("notify-centre-open");XCTAssertTrue(app.otherElements["notify-badge-signed-notify-caller-lab"].waitForExistence(timeout:15),app.debugDescription);wait("Badge count: 3");capture("native-attributed-badge");button("notify-centre-close");passed("native-badge-verified-source-attribution")
  guest("Register messages channel");wait("Channel registration sent.");let channel=guestControl("Notification channel",button:false);channel.tap();channel.typeText("messages");let done=app.toolbars.buttons["Done"].firstMatch;XCTAssertTrue(done.waitForExistence(timeout:10),app.debugDescription);XCTAssertTrue(done.isHittable,app.debugDescription);done.tap();XCTAssertEqual(channel.value as? String,"messages");guest("Send notification");wait("Request failed: permission denied");passed("native-general-grant-does-not-allow-named-channel")
  guest("Request notification permission");wait("Allow notifications?");wait("messages");capture("native-exact-channel-review");button("notify-allow");wait("Notification permission granted.");guest("Send notification");wait("Notification sent.");passed("native-exact-channel-positive-sdk-send")
  open("peer","notify");guest("Send notification");wait("Request failed: permission denied");focus("signed-notify-caller-lab");button("notify-centre-open");wait("From signed-notify-caller-lab");button("notify-centre-close");passed("native-permission-app-isolation-and-foreground-card-retention")
  guest("Send invalid notification controls");wait("Invalid guest notification controls sent.");button("notify-centre-open");wait("From signed-notify-caller-lab");button("notify-centre-close");passed("native-forged-notification-authority-denied")
  background();XCTAssertFalse(app.buttons["notify-centre-open"].exists,app.debugDescription);guest("Request notification permission");wait("Notification permission granted.");XCTAssertFalse(app.staticTexts["Allow notifications?"].exists);passed("native-background-clears-alerts-badges-no-backlog-keeps-exact-grant")
  button("shell-settings");settingsButton("notify-permissions-open");settingsButton("notify-revoke-signed-notify-caller-lab-messages");wait("Notification permission revoked.");capture("native-settings-exact-channel-revoke");button("notify-permissions-close");button("settings-done");guest("Send notification");wait("Request failed: permission denied");passed("native-settings-channel-revoke-denies-sdk-send")
  guest("Request notification permission");wait("Allow notifications?");button("notify-allow");wait("Notification permission granted.");guest("Send notification");wait("Notification sent.");passed("native-revoked-channel-needs-fresh-approval-positive-control")
  button("shell-settings");settingsButton("identity-select-c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5");wait("Switch identity?");settingsButton("identity-change-confirm");button("shell-settings");settingsButton("notify-permissions-open");wait("No saved notification permissions for this identity.");capture("native-notification-other-identity-empty");button("notify-permissions-close");button("settings-done");open("caller","notify");guest("Send notification");wait("Request failed: permission denied");passed("native-identity-change-has-no-old-grant-alert-or-recipient")
  guest("Request notification permission");wait("Allow notifications?");button("notify-allow");wait("Notification permission granted.");guest("Send notification");wait("Notification sent.")
  guest("Send oversized notification");let oversized=app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@","{\"accepted\":")).firstMatch;XCTAssertTrue(oversized.waitForExistence(timeout:35),app.debugDescription);let denied=try JSONSerialization.jsonObject(with:Data(oversized.label.utf8)) as! [String:Any];XCTAssertEqual(denied["accepted"] as? Bool,false);passed("native-oversized-notification-denied")
  guest("Run notification flood");let flood=app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@","{\"results\":")).firstMatch;XCTAssertTrue(flood.waitForExistence(timeout:30),app.debugDescription);let rows=(try JSONSerialization.jsonObject(with:Data(flood.label.utf8)) as! [String:Any])["results"] as! [[String:Any]],accepted=rows.filter{$0["ok"] as? Bool == true},rejected=rows.filter{$0["ok"] as? Bool == false};XCTAssertEqual(rows.count,20);XCTAssertGreaterThan(accepted.count,0);XCTAssertLessThanOrEqual(accepted.count,7);XCTAssertEqual(Set(accepted.compactMap{$0["notificationId"] as? String}).count,accepted.count);XCTAssertTrue(rejected.allSatisfy{$0["error"] as? String == "rate limited"});print("PRESENTATION_SDK:"+flood.label);fflush(stdout);passed("native-sdk-notification-flood-bounded")
  let statuses=app.staticTexts.matching(NSPredicate(format:"identifier BEGINSWITH %@","runtime-status-")).allElementsBoundByIndex.filter{$0.isHittable};XCTAssertEqual(statuses.count,1,app.debugDescription);let liveID=String(statuses[0].identifier.dropFirst("runtime-status-".count));print("PRESENTATION_LIVE_CLOSE:"+liveID);fflush(stdout)
  button("handle-right");wait("Loaded napplets");settingsButton("overview-close-"+liveID);button("close-confirm")
  XCTAssertEqual(XCTWaiter.wait(for:[XCTNSPredicateExpectation(predicate:NSPredicate(format:"exists == false"),object:app.buttons["notify-centre-open"])],timeout:15),.completed,app.debugDescription);XCTAssertFalse(app.buttons["overview-close-"+liveID].exists,app.debugDescription);passed("native-close-clears-notification-recipient")
 }
}
