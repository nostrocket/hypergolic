import UIKit
import AVFoundation

/// Foreground shell source card. Publisher Play/autoplay never starts a connection.
@MainActor final class NativeLiveRadio {
  @MainActor private final class Session {
    let id="media-"+UUID().uuidString.lowercased(),url:String,push:([String:Any])->Void
    var playback:LiveMP3Playback!
    var phase="paused",pauseReason="user"
    init(url:String,push:@escaping([String:Any])->Void){self.url=url;self.push=push}
  }
  private final class Weak { weak var value:NativeLiveRadio?;init(_ value:NativeLiveRadio){self.value=value} }
  private static var instances:[String:Weak]=[:]
  private weak var host:UIView?
  private let generation:String,profile:()->String?,scope:()->String?,permit:@Sendable()->String?,allowed:()->Bool
  private var session:Session?,panel:UIView?,heading:UILabel?,play:UIButton?
  private var created=0,disposed=false
  private var interruption:NSObjectProtocol?
  init(host:UIView,generation:String,profile:@escaping()->String?,scope:@escaping()->String?,permit:@escaping @Sendable()->String?,allowed:@escaping()->Bool){
    self.host=host;self.generation=generation;self.profile=profile;self.scope=scope;self.permit=permit;self.allowed=allowed
    Self.instances[generation]=Weak(self)
    interruption=NotificationCenter.default.addObserver(forName:AVAudioSession.interruptionNotification,object:nil,queue:.main){[weak self] notification in
      guard notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt == AVAudioSession.InterruptionType.began.rawValue else{return}
      MainActor.assumeIsolated{if let row=self?.session{row.pauseReason="focus-lost";row.playback.pause()}}
    }
  }
  var hasSession:Bool{session != nil}
  func ownsSession(_ value:String?)->Bool{value != nil && value == session?.id}
  func receive(_ request:[String:Any],push:@escaping([String:Any])->Void){
    if request["type"] as? String == "media.session.create"{create(request,push:push);return}
    guard let row=session,request["sessionId"] as? String == row.id else{return}
    let fields=Set(request.keys)
    if request["type"] as? String == "media.session.destroy",fields == ["type","sessionId"]{row.playback.retire("destroyed");return}
    guard allowed(),permit() != nil,request["type"] as? String == "media.command",fields == ["type","sessionId","action"] else{return}
    switch request["action"] as? String{
    case "pause":row.pauseReason="user";row.playback.pause()
    case "stop":row.playback.retire("user")
    default:break // Publisher Play cannot resume a connection; native source Play remains required.
    }
  }
  private func create(_ request:[String:Any],push:@escaping([String:Any])->Void){
    guard let id=request["id"] as? String,id.range(of:"^[!-~]{1,128}$",options:.regularExpression) != nil else{return}
    func reject(_ text:String){push(["type":"media.session.create.result","id":id,"error":text])}
    guard profile() == LiveMP3Owner.profile else{reject("Live radio needs renewed Media access. Close this napplet and reopen it from Discover.");return}
    guard !disposed,allowed(),permit() != nil,let scope=scope(),created<64 else{reject("Media is unavailable while this napplet is not active.");return}
    guard session == nil else{reject("Close the radio player before creating another source.");return}
    guard Set(request.keys) == ["type","id","url","live"],let live=request["live"] as? NSNumber,
      CFGetTypeID(live)==CFBooleanGetTypeID(),live.boolValue,let url=request["url"] as? String,
      (try? PublishedPinnedHTTPS.Request(url,liveMP3Profile:true)) != nil else{reject("Unsupported radio source.");return}
    let row=Session(url:url,push:push)
    row.playback=LiveMP3Playback(url:url,profile:profile(),scope:scope,permit:permit){[weak self,weak row] event in
      Task{@MainActor in if let self,let row{self.handle(row,event)}}
    }
    session=row;created += 1;show(row)
    push(["type":"media.session.create.result","id":id,"sessionId":row.id,"owner":"shell"]);state(row);capabilities(row)
  }
  private func show(_ row:Session){
    let card=UIView();card.backgroundColor = .black
    let title=UILabel();title.text="\(row.url)\nMP3 radio · 15 minutes / 32 MiB · foreground only";title.textColor = .white;title.numberOfLines=4
    let start=UIButton(type:.system);start.setTitle("Play radio",for:.normal)
    start.addAction(UIAction{[weak self,weak row] _ in
      guard let self,let row,self.session === row,self.allowed(),self.permit() != nil,self.panel?.window != nil,self.panel?.isHidden == false else{return}
      if row.phase == "playing" || row.phase == "buffering"{row.pauseReason="user";row.playback.pause()}
      else if !row.playback.nativePlay(){self.heading?.text=MediaPlaybackReservation.shared.hint}
    },for:.touchUpInside)
    let close=UIButton(type:.system);close.setTitle("Close radio",for:.normal)
    close.addAction(UIAction{[weak self,weak row] _ in if let row,self?.session === row{row.playback.retire("user")}},for:.touchUpInside)
    let buttons=UIStackView(arrangedSubviews:[start,close]);buttons.axis = .horizontal;buttons.distribution = .fillEqually
    let content=UIStackView(arrangedSubviews:[title,buttons]);content.axis = .vertical;content.spacing=4;content.translatesAutoresizingMaskIntoConstraints=false
    card.addSubview(content);host?.addSubview(card)
    NSLayoutConstraint.activate([content.leadingAnchor.constraint(equalTo:card.leadingAnchor,constant:12),content.trailingAnchor.constraint(equalTo:card.trailingAnchor,constant:-12),content.topAnchor.constraint(equalTo:card.topAnchor,constant:8),content.bottomAnchor.constraint(equalTo:card.bottomAnchor,constant:-4),buttons.heightAnchor.constraint(equalToConstant:44)])
    panel=card;heading=title;play=start;layout()
  }
  func layout(){guard let host,let panel else{return};let height=min(CGFloat(160),host.bounds.height);panel.frame=CGRect(x:0,y:max(0,host.bounds.height-height),width:host.bounds.width,height:height);panel.layoutIfNeeded()}
  private func handle(_ row:Session,_ event:LiveMP3Playback.Event){
    guard !disposed,session === row else{return}
    switch event{
    case .ended(let reason):
      row.push(["type":"media.session.ended","sessionId":row.id,"reason":reason]);panel?.removeFromSuperview();panel=nil;heading=nil;play=nil;session=nil;return
    case .buffering:row.phase="buffering"
    case .playing:row.phase="playing"
    case .paused:row.phase="paused"
    }
    play?.setTitle(row.phase == "paused" ? "Play radio":"Pause radio",for:.normal)
    heading?.text="\(row.url)\nMP3 radio · 15 minutes / 32 MiB · \(row.phase)";state(row);capabilities(row);layout()
  }
  private func state(_ row:Session){
    var value:[String:Any]=["type":"media.state","sessionId":row.id,"status":row.phase]
    if row.phase == "paused"{value["reason"]=row.pauseReason};row.push(value)
  }
  private func capabilities(_ row:Session){row.push(["type":"media.capabilities","sessionId":row.id,"actions":row.phase == "paused" ? ["pause","stop"]:["play","pause","stop"]])}
  func focusChanged(visible:Bool){guard let row=session else{return};let focused=visible&&allowed();panel?.isHidden = !focused;if !focused{row.pauseReason="focus-lost";row.playback.pause()}}
  func retire(_ reason:String="policy"){session?.playback.retire(reason)}
  func dispose(){retire();disposed=true;Self.instances.removeValue(forKey:generation);if let interruption{NotificationCenter.default.removeObserver(interruption)};interruption=nil;panel?.removeFromSuperview();panel=nil;session=nil}
  static func revokeGenerations(_ generations:Set<String>){for generation in generations{instances[generation]?.value?.retire("policy")}}
}
