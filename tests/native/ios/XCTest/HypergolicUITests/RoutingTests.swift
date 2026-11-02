import XCTest

final class RoutingTests: XCTestCase {
 func testTracer() throws {
  continueAfterFailure=false
  let app=XCUIApplication(bundleIdentifier:"org.nostrocket.hypergolic.routingfixture")
  func wait(_ value:String){XCTAssertTrue(app.staticTexts[value].waitForExistence(timeout:30),app.debugDescription)}
  func capture(_ name:String){let shot=XCTAttachment(screenshot:app.screenshot());shot.name=name;shot.lifetime = .keepAlways;add(shot);let tree=XCTAttachment(string:app.debugDescription);tree.name=name+"-AX";tree.lifetime = .keepAlways;add(tree)}
  func passed(_ name:String){capture(name);print("ROUTING_CHECK:"+name);fflush(stdout)}
  func button(_ name:String){let control=app.buttons[name];XCTAssertTrue(control.waitForExistence(timeout:15),app.debugDescription);XCTAssertTrue(control.isHittable,app.debugDescription);control.tap()}
  func settings(_ element:XCUIElement){
   for _ in 0..<20 {if element.isHittable{return};let scroll=app.scrollViews.firstMatch
    if element.exists && element.frame.midY < scroll.frame.minY {scroll.swipeDown()}else{scroll.swipeUp()}}
   XCTFail("Settings control unavailable: "+app.debugDescription)
  }
  func settingsButton(_ name:String){let control=app.buttons[name];settings(control);control.tap()}
  func host()->XCUIElement{XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout:20),app.debugDescription)
   let views=app.webViews.allElementsBoundByIndex.filter{$0.frame.intersects(app.frame)&&$0.frame.height>1&&$0.frame.width>1}
   XCTAssertFalse(views.isEmpty,app.debugDescription);let frames=views.map{$0.frame},first=frames[0];XCTAssertTrue(frames.allSatisfy{abs($0.minX-first.minX)<1 && abs($0.minY-first.minY)<1 && abs($0.width-first.width)<1 && abs($0.height-first.height)<1},app.debugDescription);return views[0]
  }
  func guest(_ name:String){let view=host(),control=view.buttons[name]
   for direction in [true,false] {for _ in 0..<20 {if control.isHittable {control.tap();return}
    let high=view.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.15)),low=view.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.5))
    (direction ? low:high).press(forDuration:0.05,thenDragTo:direction ? high:low)}}
   XCTFail("Guest control unavailable: "+app.debugDescription)
  }
  func openSigned(_ role:String){
   let address=app.staticTexts["signed-"+role+"-address"];XCTAssertTrue(address.waitForExistence(timeout:30),app.debugDescription);let link=address.label;XCTAssertTrue(link.hasPrefix("naddr1"))
   button("shell-settings");let input=app.textFields["settings-napplet-address"];settings(input);input.tap()
   if let old=input.value as? String,!old.isEmpty {input.typeText(String(repeating:XCUIKeyboardKey.delete.rawValue,count:old.count))}
   for offset in stride(from:0,to:link.count,by:12) {
    let end=min(offset+12,link.count);let startIndex=link.index(link.startIndex,offsetBy:offset),endIndex=link.index(link.startIndex,offsetBy:end)
    input.typeText(String(link[startIndex..<endIndex]));XCTAssertEqual(input.value as? String,String(link.prefix(end)),"Native address input lost characters")
   }
   input.typeText("\n")
   let consent=app.staticTexts["Allow this napplet?"].firstMatch;XCTAssertTrue(consent.waitForExistence(timeout:30),app.debugDescription);settings(consent)
   wait("Requested access: inc, intent");capture(role+"-domain-consent");settingsButton("settings-napplet-approve");wait("SDK ready for routing.")
   XCTAssertEqual(app.staticTexts["focused-napplet-name"].label,"signed-routing-"+role+"-lab")
  }
  func readJSON(_ contains:String,_ prefix:String)->Any {
   let element=app.staticTexts.matching(NSPredicate(format:"label CONTAINS %@",contains)).firstMatch
   XCTAssertTrue(element.waitForExistence(timeout:20),app.debugDescription);let raw=element.label;print(prefix+raw);fflush(stdout)
   return try! JSONSerialization.jsonObject(with:Data(raw.utf8))
  }
  func review(){guest("Invoke handler");wait("Open with this napplet?");wait("signed-routing-caller-lab");XCTAssertTrue(app.descendants(matching:.any)["routing-candidate-c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5-signed-routing-peer-lab"].waitForExistence(timeout:5),app.debugDescription)
   let payload=app.staticTexts["routing-payload"].label;let value=try! JSONSerialization.jsonObject(with:Data(payload.utf8)) as! NSDictionary
   XCTAssertEqual(value,["text":"routing tracer + ⚡","nested":[NSNull(),false,3]] as NSDictionary);capture("dispatch-review")
  }
  app.terminate();app.launch();openSigned("peer");passed("signed-peer-normal-admission")
  guest("Subscribe to topic");wait("Allow this topic?");wait("napplet:note/open");capture("topic-review");button("routing-approve");passed("exact-topic-session-approval")
  openSigned("caller");passed("signed-caller-normal-admission");guest("Check availability")
  let availability=readJSON("\"candidates\"","ROUTING_AVAILABILITY:") as! [String:Any];XCTAssertEqual(availability["available"] as? Bool,true)
  let candidates=availability["candidates"] as! [[String:Any]];XCTAssertEqual(candidates.count,1);XCTAssertEqual(candidates[0]["dTag"] as? String,"signed-routing-peer-lab");passed("verified-handler-availability")
  review();button("routing-cancel");wait("Dispatch declined.");let denied=readJSON("\"handled\":false","ROUTING_DENIED:") as! [String:Any];XCTAssertEqual(denied["ok"] as? Bool,false);passed("dispatch-cancel-original-sdk-result")
  review();button("routing-approve");wait("Received topic message.")
  let events=readJSON("\"sender\":\"signed-routing-caller-lab\"","ROUTING_EVENTS:") as! [[String:Any]];XCTAssertEqual(events.count,1)
  XCTAssertEqual(events[0]["payload"] as? NSDictionary,["text":"routing tracer + ⚡","nested":[NSNull(),false,3]] as NSDictionary);passed("approved-dispatch-real-target-exact-payload")
  button("handle-right");button("Open signed-routing-caller-lab");wait("Dispatch accepted.")
  let result=readJSON("\"handled\":true","ROUTING_RESULT:") as! [String:Any];XCTAssertEqual(result["ok"] as? Bool,true);XCTAssertEqual(result["handler"] as? String,"signed-routing-peer-lab");XCTAssertEqual(result["convention"] as? String,"napplet:note/open");XCTAssertNotNil(result["windowId"]);passed("original-caller-structured-sdk-result")
  func focus(_ role:String){button("handle-right");button("Open signed-routing-"+role+"-lab");XCTAssertEqual(app.staticTexts["focused-napplet-name"].label,"signed-routing-"+role+"-lab")}
  guest("Subscribe to topic");wait("Allow this topic?");button("routing-approve");guest("Emit topic payload");focus("peer")
  let topicPeer=readJSON("\"sender\":\"signed-routing-caller-lab\"","ROUTING_TOPIC_PEER:") as! [[String:Any]];XCTAssertEqual(topicPeer.count,2);passed("foreground-topic-switch-exact-sender-no-echo")
  guest("Emit topic payload");focus("caller");let topicCaller=readJSON("\"sender\":\"signed-routing-peer-lab\"","ROUTING_TOPIC_CALLER:") as! [[String:Any]];XCTAssertEqual(topicCaller.count,1);passed("symmetric-topic-payload")
  func openChannel()->String {
   guest("Open channel");wait("Open this channel?");wait("signed-routing-caller-lab");wait("signed-routing-peer-lab");capture("channel-review");button("routing-approve");wait("Channel opened.")
   let info=readJSON("\"peer\":\"signed-routing-peer-lab\"","ROUTING_CHANNEL:") as! [String:Any];XCTAssertEqual(info["peer"] as? String,"signed-routing-peer-lab");return info["id"] as! String
  }
  var channel=openChannel();passed("new-channel-trusted-endpoint-review");focus("peer")
  let info=readJSON("\"peer\":\"signed-routing-caller-lab\"","ROUTING_INBOUND:") as! [String:Any];XCTAssertEqual(info["id"] as? String,channel);passed("target-original-sdk-inbound-handle")
  guest("Emit channel payload");focus("caller");let channelEvents=readJSON("\"channelId\"","ROUTING_CHANNEL_EVENTS:") as! [[String:Any]]
  XCTAssertEqual(channelEvents.count,1);XCTAssertEqual(channelEvents[0]["sender"] as? String,"signed-routing-peer-lab");XCTAssertEqual(channelEvents[0]["channelId"] as? String,channel);XCTAssertEqual(channelEvents[0]["payload"] as? NSDictionary,["text":"routing tracer + ⚡","nested":[NSNull(),false,3]] as NSDictionary);passed("peer-channel-message-exact-payload")
  guest("Broadcast channel payload");focus("peer");let broadcast=readJSON("\"channelId\"","ROUTING_BROADCAST:") as! [[String:Any]];XCTAssertEqual(broadcast.count,1);XCTAssertEqual(broadcast[0]["sender"] as? String,"signed-routing-caller-lab");passed("symmetric-channel-broadcast")
  guest("Close channel");wait("Channel closed.");let localClosed="{\"channelId\":\""+channel+"\"}";let closed=readJSON(localClosed,"ROUTING_CLOSED:") as! [String:Any];XCTAssertEqual(closed["channelId"] as? String,channel)
  guest("Attach late close handler");XCTAssertEqual(app.staticTexts.matching(NSPredicate(format:"label == %@",localClosed)).count,2);passed("original-sdk-late-terminal-record")
  focus("caller");wait("Channel closed.");let symmetric=readJSON("\"reason\":\"closed\"","ROUTING_SYMMETRIC_CLOSED:") as! [String:Any];XCTAssertEqual(symmetric["channelId"] as? String,channel);guest("List channels");wait("[]");passed("symmetric-close-empty-list")
  channel=openChannel();passed("fresh-channel-needs-new-review");XCUIDevice.shared.press(.home);sleep(1);app.activate();wait("Channel closed.")
  let background=readJSON("\"reason\":\"background\"","ROUTING_BACKGROUND:") as! [String:Any];XCTAssertEqual(background["channelId"] as? String,channel);guest("List channels");wait("[]");passed("native-background-closes-without-reopening")
  guest("Invoke handler");wait("Open with this napplet?");capture("native-expiring-review");let expiry=Date().addingTimeInterval(30)
  while Date()<expiry && app.otherElements["routing-review"].exists {usleep(200000)}
  XCTAssertFalse(app.otherElements["routing-review"].exists,app.debugDescription)
  let failed=app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@","Request failed:")).firstMatch;XCTAssertTrue(failed.waitForExistence(timeout:10),app.debugDescription);passed("native-deadline-revokes-unanswered-dispatch")
  focus("peer");let afterExpired=readJSON("\"sender\":\"signed-routing-caller-lab\"","ROUTING_AFTER_EXPIRY:") as! [[String:Any]];XCTAssertEqual(afterExpired.count,2);passed("expired-review-delivers-no-payload");focus("caller")
  channel=openChannel();guest("Request channel review flood");let floodDeadline=Date().addingTimeInterval(35)
  while Date()<floodDeadline {
   if app.buttons["routing-cancel"].exists {app.buttons["routing-cancel"].tap()}
   else if app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@","[{\"ok\":false")).firstMatch.exists {break}
   else {usleep(200000)}
  }
  let flood=readJSON("[{\"ok\":false","ROUTING_FLOOD:") as! [[String:Any]];XCTAssertEqual(flood.count,8);XCTAssertTrue(flood.allSatisfy{$0["ok"] as? Bool==false});passed("native-review-flood-has-no-approved-channel")
  openSigned("second-peer");guest("Send malformed guest requests");wait("Malformed guest requests sent.");focus("peer")
  let afterForged=readJSON("\"sender\":\"signed-routing-caller-lab\"","ROUTING_AFTER_FORGED:") as! [[String:Any]];XCTAssertEqual(afterForged.count,2);passed("native-guest-forged-sender-and-control-denied")
  focus("second-peer");let foreign=host().textFields["Observed foreign channel"]
  for direction in [true,false] {for _ in 0..<20 {if foreign.isHittable{break}
   let view=host(),high=view.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.15)),low=view.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.5))
   (direction ? low:high).press(forDuration:0.05,thenDragTo:direction ? high:low)}}
  XCTAssertTrue(foreign.isHittable,app.debugDescription);foreign.tap()
  if let old=foreign.value as? String {foreign.typeText(String(repeating:XCUIKeyboardKey.delete.rawValue,count:old.count))};foreign.typeText(channel+"\n");guest("Send foreign channel payload");wait("Foreign channel request sent.");focus("peer")
  let afterForeign=readJSON("\"channelId\"","ROUTING_AFTER_FOREIGN:") as! [[String:Any]];XCTAssertEqual(afterForeign.count,1);passed("native-third-view-cannot-use-active-channel-id")
  focus("second-peer");guest("Emit topic payload");focus("peer");let positive=readJSON("\"sender\":\"signed-routing-second-peer-lab\"","ROUTING_POSITIVE_PING:") as! [[String:Any]];XCTAssertEqual(positive.count,3);passed("native-negative-controls-have-live-positive-ping")
  focus("caller");button("handle-right");button("Close signed-routing-peer-lab");button("close-confirm");button("Open signed-routing-caller-lab");wait("Channel closed.")
  let peerClosed=readJSON("\"reason\":\"peer destroyed\"","ROUTING_PEER_CLOSED:") as! [String:Any];XCTAssertEqual(peerClosed["channelId"] as? String,channel);passed("native-peer-close-revokes-channel")
 }
 func testProtocol() throws {
  continueAfterFailure=false
  let app=XCUIApplication(bundleIdentifier:"org.nostrocket.hypergolic.routingfixture")
  func wait(_ value:String){XCTAssertTrue(app.staticTexts[value].waitForExistence(timeout:30),app.debugDescription)}
  func capture(_ name:String){let shot=XCTAttachment(screenshot:app.screenshot());shot.name=name;shot.lifetime = .keepAlways;add(shot);let tree=XCTAttachment(string:app.debugDescription);tree.name=name+"-AX";tree.lifetime = .keepAlways;add(tree)}
  func passed(_ name:String){capture(name);print("ROUTING_CHECK:"+name);fflush(stdout)}
  func button(_ name:String){let control=app.buttons[name];XCTAssertTrue(control.waitForExistence(timeout:15),app.debugDescription);XCTAssertTrue(control.isHittable,app.debugDescription);control.tap()}
  func settings(_ element:XCUIElement){
   for _ in 0..<20 {if element.isHittable{return};let scroll=app.scrollViews.firstMatch
    if element.exists && element.frame.midY < scroll.frame.minY {scroll.swipeDown()}else{scroll.swipeUp()}}
   XCTFail("Settings control unavailable: "+app.debugDescription)
  }
  func settingsButton(_ name:String){let control=app.buttons[name];settings(control);control.tap()}
  func host()->XCUIElement{XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout:20),app.debugDescription)
   let views=app.webViews.allElementsBoundByIndex.filter{$0.frame.intersects(app.frame)&&$0.frame.height>1&&$0.frame.width>1}
   XCTAssertFalse(views.isEmpty,app.debugDescription);let frames=views.map{$0.frame},first=frames[0];XCTAssertTrue(frames.allSatisfy{abs($0.minX-first.minX)<1 && abs($0.minY-first.minY)<1 && abs($0.width-first.width)<1 && abs($0.height-first.height)<1},app.debugDescription);return views[0]
  }
  func guest(_ name:String){let view=host(),control=view.buttons[name]
   for direction in [true,false] {for _ in 0..<20 {if control.isHittable {control.tap();return}
    let high=view.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.15)),low=view.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.5))
    (direction ? low:high).press(forDuration:0.05,thenDragTo:direction ? high:low)}}
   XCTFail("Guest control unavailable: "+app.debugDescription)
  }
  func openSigned(_ role:String){
   let address=app.staticTexts["signed-"+role+"-address"];XCTAssertTrue(address.waitForExistence(timeout:30),app.debugDescription);let link=address.label;XCTAssertTrue(link.hasPrefix("naddr1"))
   button("shell-settings");let input=app.textFields["settings-napplet-address"];settings(input);input.tap()
   if let old=input.value as? String,!old.isEmpty {input.typeText(String(repeating:XCUIKeyboardKey.delete.rawValue,count:old.count))}
   for offset in stride(from:0,to:link.count,by:12) {
    let end=min(offset+12,link.count);let startIndex=link.index(link.startIndex,offsetBy:offset),endIndex=link.index(link.startIndex,offsetBy:end)
    input.typeText(String(link[startIndex..<endIndex]));XCTAssertEqual(input.value as? String,String(link.prefix(end)),"Native address input lost characters")
   }
   input.typeText("\n")
   let consent=app.staticTexts["Allow this napplet?"].firstMatch;XCTAssertTrue(consent.waitForExistence(timeout:30),app.debugDescription);settings(consent)
   wait("Requested access: inc, intent");capture(role+"-domain-consent");settingsButton("settings-napplet-approve");wait("SDK ready for routing.")
   XCTAssertEqual(app.staticTexts["focused-napplet-name"].label,"signed-routing-"+(role=="collision-peer" ? "peer":role)+"-lab")
  }
  func readJSON(_ contains:String,_ prefix:String)->Any {
   let element=app.staticTexts.matching(NSPredicate(format:"label CONTAINS %@",contains)).firstMatch
   XCTAssertTrue(element.waitForExistence(timeout:20),app.debugDescription);let raw=element.label;print(prefix+raw);fflush(stdout)
   return try! JSONSerialization.jsonObject(with:Data(raw.utf8))
  }
  app.terminate();app.launch();openSigned("caller")
  guest("Invoke handler");wait("Dispatch declined.")
  let absent=readJSON("\"error\":\"no handler\"","ROUTING_PROTOCOL:") as! [String:Any];XCTAssertEqual(absent["ok"] as? Bool,false);XCTAssertEqual(absent["handled"] as? Bool,false);XCTAssertFalse(app.buttons["routing-approve"].exists);passed("native-absent-handler-original-sdk-result")
  guest("Open channel");wait("Request failed: peer unavailable");XCTAssertFalse(app.buttons["routing-approve"].exists);guest("List channels");wait("[]");passed("native-absent-peer-original-sdk-denial")
  openSigned("peer");guest("Subscribe to topic");wait("Allow this topic?");button("routing-approve")
  button("handle-right");button("Open signed-routing-caller-lab");guest("Emit topic payload");button("handle-right");button("Open signed-routing-peer-lab")
  let events=readJSON("\"sender\":\"signed-routing-caller-lab\"","ROUTING_PROTOCOL:") as! [[String:Any]];XCTAssertEqual(events.count,1);XCTAssertEqual(events[0]["payload"] as? NSDictionary,["text":"routing tracer + ⚡","nested":[NSNull(),false,3]] as NSDictionary);passed("native-protocol-negative-controls-positive-delivery")
  openSigned("collision-peer");button("handle-right");button("Open signed-routing-caller-lab")
  let field=host().textFields["Handler preference"]
  func revealField(){
   for _ in 0..<20 {
    let view=host(),frame=view.frame,keyboard=app.keyboards.firstMatch
    let bottom=keyboard.exists ? min(frame.maxY,keyboard.frame.minY):frame.maxY
    let visible=CGRect(x:frame.minX,y:frame.minY,width:frame.width,height:bottom-frame.minY)
    if field.isHittable && visible.contains(CGPoint(x:field.frame.midX,y:field.frame.midY)){return}
    XCTAssertGreaterThan(visible.height,60,app.debugDescription)
    let origin=view.coordinate(withNormalizedOffset:CGVector.zero)
    let high=origin.withOffset(CGVector(dx:frame.width*0.5,dy:visible.height*0.15)),low=origin.withOffset(CGVector(dx:frame.width*0.5,dy:visible.height*0.65))
    let below=field.frame.midY>visible.maxY;(below ? low:high).press(forDuration:0.05,thenDragTo:below ? high:low)
   };XCTFail("Field outside native guest viewport: "+app.debugDescription)
  }
  revealField();field.tap();revealField();field.press(forDuration:1.2)
  let all=app.descendants(matching:.any).matching(NSPredicate(format:"label == %@","Select All")).firstMatch;XCTAssertTrue(all.waitForExistence(timeout:5),app.debugDescription);all.tap();field.typeText("signed-routing-peer-lab")
  if app.keyboards.firstMatch.exists {let done=app.toolbars.buttons["Done"];XCTAssertTrue(done.waitForExistence(timeout:5),app.debugDescription);done.tap()}
  XCTAssertEqual(field.value as? String,"signed-routing-peer-lab",app.debugDescription);XCTAssertFalse(app.keyboards.firstMatch.exists,app.debugDescription);capture("actual-explicit-handler-input");guest("Invoke handler");wait("Dispatch declined.")
  let ambiguous=readJSON("\"error\":\"ambiguous handler\"","ROUTING_PROTOCOL:") as! [String:Any];XCTAssertEqual(ambiguous["ok"] as? Bool,false);XCTAssertEqual(ambiguous["handled"] as? Bool,false);XCTAssertFalse(app.buttons["routing-approve"].exists);passed("native-ambiguous-publisher-original-sdk-result")
  guest("Open channel");wait("Request failed: peer unavailable");XCTAssertFalse(app.buttons["routing-approve"].exists);guest("List channels");wait("[]");passed("native-ambiguous-live-peer-original-sdk-denial")
 }
 func testSettings() throws {
  continueAfterFailure=false
  let app=XCUIApplication(bundleIdentifier:"org.nostrocket.hypergolic.routingfixture")
  func wait(_ value:String){XCTAssertTrue(app.staticTexts[value].waitForExistence(timeout:30),app.debugDescription)}
  func capture(_ name:String){let shot=XCTAttachment(screenshot:app.screenshot());shot.name=name;shot.lifetime = .keepAlways;add(shot);let tree=XCTAttachment(string:app.debugDescription);tree.name=name+"-AX";tree.lifetime = .keepAlways;add(tree)}
  func passed(_ name:String){capture(name);print("ROUTING_CHECK:"+name);fflush(stdout)}
  func button(_ name:String){let control=app.buttons[name];XCTAssertTrue(control.waitForExistence(timeout:15),app.debugDescription);XCTAssertTrue(control.isHittable,app.debugDescription);control.tap()}
  func settings(_ element:XCUIElement){
   for _ in 0..<20 {if element.isHittable{return};let scroll=app.scrollViews.firstMatch
    if element.exists && element.frame.midY < scroll.frame.minY {scroll.swipeDown()}else{scroll.swipeUp()}}
   XCTFail("Settings control unavailable: "+app.debugDescription)
  }
  func settingsButton(_ name:String){let control=app.buttons[name];settings(control);control.tap()}
  func host()->XCUIElement{XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout:20),app.debugDescription)
   let views=app.webViews.allElementsBoundByIndex.filter{$0.frame.intersects(app.frame)&&$0.frame.height>1&&$0.frame.width>1}
   XCTAssertFalse(views.isEmpty,app.debugDescription);let frames=views.map{$0.frame},first=frames[0];XCTAssertTrue(frames.allSatisfy{abs($0.minX-first.minX)<1 && abs($0.minY-first.minY)<1 && abs($0.width-first.width)<1 && abs($0.height-first.height)<1},app.debugDescription);return views[0]
  }
  func guest(_ name:String){let view=host(),control=view.buttons[name]
   for direction in [true,false] {for _ in 0..<20 {if control.isHittable {control.tap();return}
    let high=view.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.15)),low=view.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.5))
    (direction ? low:high).press(forDuration:0.05,thenDragTo:direction ? high:low)}}
   XCTFail("Guest control unavailable: "+app.debugDescription)
  }
  func openSigned(_ role:String,_ domains:String){
   let address=app.staticTexts["signed-"+role+"-address"];XCTAssertTrue(address.waitForExistence(timeout:30),app.debugDescription);let link=address.label;XCTAssertTrue(link.hasPrefix("naddr1"))
   button("shell-settings");let input=app.textFields["settings-napplet-address"];settings(input);input.tap()
   if let old=input.value as? String,!old.isEmpty {input.typeText(String(repeating:XCUIKeyboardKey.delete.rawValue,count:old.count))}
   for offset in stride(from:0,to:link.count,by:12) {
    let end=min(offset+12,link.count);let startIndex=link.index(link.startIndex,offsetBy:offset),endIndex=link.index(link.startIndex,offsetBy:end)
    input.typeText(String(link[startIndex..<endIndex]));XCTAssertEqual(input.value as? String,String(link.prefix(end)),"Native address input lost characters")
   }
   input.typeText("\n")
   let consent=app.staticTexts["Allow this napplet?"].firstMatch;XCTAssertTrue(consent.waitForExistence(timeout:30),app.debugDescription);settings(consent)
   wait("Requested access: "+domains);capture(role+"-domain-consent");settingsButton("settings-napplet-approve");wait("SDK ready for routing.")
   XCTAssertEqual(app.staticTexts["focused-napplet-name"].label,"signed-routing-"+role+"-lab")
  }
  func readJSON(_ contains:String,_ prefix:String)->Any {
   let element=app.staticTexts.matching(NSPredicate(format:"label CONTAINS %@",contains)).firstMatch
   XCTAssertTrue(element.waitForExistence(timeout:20),app.debugDescription);let raw=element.label;print(prefix+raw);fflush(stdout)
   return try! JSONSerialization.jsonObject(with:Data(raw.utf8))
  }

  func focus(_ role:String){button("handle-right");button("Open signed-routing-"+role+"-lab");XCTAssertEqual(app.staticTexts["focused-napplet-name"].label,"signed-routing-"+role+"-lab")}
  func topic(){wait("Allow this topic?");wait("napplet:note/open");capture("cold-handler-topic-review");button("routing-approve")}
  func closePeer(){button("handle-right");button("Close signed-routing-auto-peer-lab");button("close-confirm");button("Open signed-routing-caller-lab")}
  let publisher="c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",key=publisher+"-signed-routing-auto-peer-lab"
  app.terminate();app.launch();openSigned("auto-peer","inc, intent, storage");topic();passed("signed-cold-handler-domain-topic-consent")
  openSigned("caller","inc, intent");button("shell-settings");settingsButton("routing-default-note-"+key);wait("Default handler saved.");capture("trusted-default-settings");button("settings-done");passed("trusted-settings-explicit-default")
  let changed=readJSON("\"hasDefault\":true","ROUTING_SETTINGS:") as! [String:Any];XCTAssertEqual(changed["archetype"] as? String,"note");passed("original-sdk-default-changed")
  closePeer();guest("Check availability");let closed=readJSON("\"hasDefault\":true","ROUTING_SETTINGS:") as! [String:Any];XCTAssertEqual(closed["available"] as? Bool,true);passed("closed-handler-remains-discoverable")
  app.terminate();app.launch();wait("SDK ready for routing.");guest("Check availability");let cold=readJSON("\"hasDefault\":true","ROUTING_SETTINGS:") as! [String:Any];XCTAssertEqual(cold["available"] as? Bool,true);passed("cold-process-default-persistence")
  guest("Invoke handler");wait("Open with this napplet?");XCTAssertTrue(app.descendants(matching:.any)["routing-candidate-"+publisher+"-signed-routing-auto-peer-lab"].waitForExistence(timeout:5),app.debugDescription);capture("cold-selected-handler-review");button("routing-approve");topic();wait("Received topic message.")
  let events=readJSON("\"sender\":\"signed-routing-caller-lab\"","ROUTING_SETTINGS:") as! [[String:Any]];XCTAssertEqual(events.count,1);XCTAssertEqual(events[0]["payload"] as? NSDictionary,["text":"routing tracer + ⚡","nested":[NSNull(),false,3]] as NSDictionary);passed("cold-handler-fresh-topic-before-exact-delivery")
  focus("caller");wait("Dispatch accepted.");let result=readJSON("\"handled\":true","ROUTING_SETTINGS:") as! [String:Any];XCTAssertEqual(result["ok"] as? Bool,true);passed("cold-original-caller-sdk-result")
  focus("auto-peer");guest("Save routing data");wait("Routing data saved.");passed("original-sdk-data-written")
  focus("caller");button("shell-settings");settingsButton("routing-remove-"+key);wait("Registration removed. Saved data remains.");capture("trusted-remove-registration");button("settings-done");passed("trusted-registration-removal")
  guest("Check availability");let removed=readJSON("\"available\":false","ROUTING_SETTINGS:") as! [String:Any];XCTAssertEqual(removed["hasDefault"] as? Bool,false);XCTAssertEqual((removed["candidates"] as! [Any]).count,0);XCTAssertGreaterThanOrEqual(app.staticTexts.matching(NSPredicate(format:"label CONTAINS %@","\"available\":false")).count,2);passed("removal-clears-default-and-original-sdk-availability")
  focus("auto-peer");guest("Read routing data");wait("saved before registration removal");passed("removal-preserves-original-sdk-data")
  closePeer();let address=app.staticTexts["signed-auto-peer-address"].label;button("shell-settings");let input=app.textFields["settings-napplet-address"];settings(input);input.tap();if let old=input.value as? String {input.typeText(String(repeating:XCUIKeyboardKey.delete.rawValue,count:old.count))}
  for offset in stride(from:0,to:address.count,by:12) {let end=min(offset+12,address.count),start=address.index(address.startIndex,offsetBy:offset),last=address.index(address.startIndex,offsetBy:end);input.typeText(String(address[start..<last]));XCTAssertEqual(input.value as? String,String(address.prefix(end)))}
  input.typeText("\n");wait("SDK ready for routing.");topic();guest("Read routing data");wait("saved before registration removal");focus("caller");guest("Check availability");let restored=readJSON("\"available\":true","ROUTING_SETTINGS:") as! [String:Any];XCTAssertEqual(restored["hasDefault"] as? Bool,false);passed("ordinary-reopen-restores-registration-and-data")
  openSigned("no-routing","theme");guest("Invoke handler");let denied=app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@","Request failed:")).firstMatch;XCTAssertTrue(denied.waitForExistence(timeout:15),app.debugDescription);guest("Open channel");XCTAssertGreaterThanOrEqual(app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@","Request failed:")).count,2);passed("missing-domain-original-sdk-denial")
  button("shell-settings");settingsButton("identity-select-"+publisher);wait("Switch identity?");settingsButton("identity-change-confirm");button("shell-settings");settings(app.staticTexts["routing-empty"]);XCTAssertTrue(app.staticTexts["routing-empty"].exists,app.debugDescription);passed("native-identity-catalog-isolation")
 }
}
