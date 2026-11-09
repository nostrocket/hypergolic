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
  private var metadata:UIStackView?,actions:UIStackView?,bodyHeight:NSLayoutConstraint?
  private static let surface=UIColor(red:17/255,green:29/255,blue:41/255,alpha:1)
  private static let ink=UIColor(red:238/255,green:243/255,blue:247/255,alpha:1)
  private static let muted=UIColor(red:175/255,green:189/255,blue:203/255,alpha:1)
  private static let accent=UIColor(red:245/255,green:160/255,blue:75/255,alpha:1)
  private var created=0,disposed=false
  private var interruption:NSObjectProtocol?
  private var textSizeObserver:NSObjectProtocol?
  init(host:UIView,generation:String,profile:@escaping()->String?,scope:@escaping()->String?,permit:@escaping @Sendable()->String?,allowed:@escaping()->Bool){
    self.host=host;self.generation=generation;self.profile=profile;self.scope=scope;self.permit=permit;self.allowed=allowed
    Self.instances[generation]=Weak(self)
    interruption=NotificationCenter.default.addObserver(forName:AVAudioSession.interruptionNotification,object:nil,queue:.main){[weak self] notification in
      guard notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt == AVAudioSession.InterruptionType.began.rawValue else{return}
      MainActor.assumeIsolated{if let row=self?.session{row.pauseReason="focus-lost";row.playback.pause()}}
    }
    textSizeObserver=NotificationCenter.default.addObserver(forName:UIContentSizeCategory.didChangeNotification,object:nil,queue:.main){[weak self] _ in
      Task{@MainActor [weak self] in self?.layout()}
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
  private func panelTitle(_ row:Session)->String{
    let status=row.phase == "playing" ? "Playing":row.phase == "buffering" ? "Buffering":"Paused"
    return "Hypergolic · Radio · \(status)"
  }
  private func action(_ title:String,primary:Bool)->UIButton{
    let button=UIButton(type:.system)
    var style=UIButton.Configuration.filled();style.title=title
    style.baseBackgroundColor=primary ? Self.accent:UIColor(red:28/255,green:43/255,blue:59/255,alpha:1)
    style.baseForegroundColor=primary ? UIColor(red:24/255,green:17/255,blue:11/255,alpha:1):Self.ink
    style.contentInsets=NSDirectionalEdgeInsets(top:10,leading:12,bottom:10,trailing:12);style.titleLineBreakMode = .byWordWrapping
    style.titleTextAttributesTransformer=UIConfigurationTextAttributesTransformer{ incoming in
      var attributes=incoming;attributes.font=UIFont.preferredFont(forTextStyle:.subheadline);return attributes
    }
    button.configuration=style;button.titleLabel?.numberOfLines=0
    button.titleLabel?.adjustsFontForContentSizeCategory=true
    return button
  }
  private func show(_ row:Session){
    let card=UIView();card.backgroundColor=Self.surface;card.clipsToBounds=true
    card.layer.borderWidth=1;card.layer.borderColor=UIColor(red:60/255,green:76/255,blue:93/255,alpha:1).cgColor
    func text(_ value:String,style:UIFont.TextStyle,color:UIColor)->UILabel{
      let label=UILabel();label.text=value;label.textColor=color;label.numberOfLines=0
      label.font=UIFont.preferredFont(forTextStyle:style);label.adjustsFontForContentSizeCategory=true;return label
    }
    let title=text(panelTitle(row),style:.caption1,color:Self.accent)
    let source=text(row.url,style:.subheadline,color:Self.ink)
    source.lineBreakMode = .byWordWrapping;source.accessibilityLabel="Source: \(row.url)"
    let limits=text("MP3 · 15 minutes / 32 MiB · foreground only",style:.caption1,color:Self.muted)
    let details=UIStackView(arrangedSubviews:[title,source,limits]);details.axis = .vertical;details.spacing=2
    details.translatesAutoresizingMaskIntoConstraints=false
    let scroll=UIScrollView();scroll.contentInsetAdjustmentBehavior = .never;scroll.addSubview(details)
    let start=action("Play radio",primary:true)
    start.addAction(UIAction{[weak self,weak row] _ in
      guard let self,let row,self.session === row,self.allowed(),self.permit() != nil,self.panel?.window != nil,self.panel?.isHidden == false else{return}
      if row.phase == "playing" || row.phase == "buffering"{row.pauseReason="user";row.playback.pause()}
      else if !row.playback.nativePlay(){self.heading?.text="Hypergolic · Radio\n\(MediaPlaybackReservation.shared.hint)";self.layout()}
    },for:.touchUpInside)
    let close=action("Close radio",primary:false)
    close.addAction(UIAction{[weak self,weak row] _ in if let row,self?.session === row{row.playback.retire("user")}},for:.touchUpInside)
    let buttons=UIStackView(arrangedSubviews:[start,close]);buttons.axis = .horizontal;buttons.spacing=8;buttons.distribution = .fillEqually
    let content=UIStackView(arrangedSubviews:[scroll,buttons]);content.axis = .vertical;content.spacing=6;content.translatesAutoresizingMaskIntoConstraints=false
    let scrollHeight=scroll.heightAnchor.constraint(equalToConstant:1)
    let minimum=buttons.heightAnchor.constraint(greaterThanOrEqualToConstant:44);minimum.priority = .defaultHigh
    card.addSubview(content);host?.addSubview(card)
    NSLayoutConstraint.activate([content.leadingAnchor.constraint(equalTo:card.leadingAnchor,constant:12),content.trailingAnchor.constraint(equalTo:card.trailingAnchor,constant:-12),content.topAnchor.constraint(equalTo:card.topAnchor,constant:10),content.bottomAnchor.constraint(equalTo:card.bottomAnchor,constant:-10),
      details.leadingAnchor.constraint(equalTo:scroll.contentLayoutGuide.leadingAnchor),details.trailingAnchor.constraint(equalTo:scroll.contentLayoutGuide.trailingAnchor),details.topAnchor.constraint(equalTo:scroll.contentLayoutGuide.topAnchor),details.bottomAnchor.constraint(equalTo:scroll.contentLayoutGuide.bottomAnchor),details.widthAnchor.constraint(equalTo:scroll.frameLayoutGuide.widthAnchor),scrollHeight,minimum])
    panel=card;heading=title;play=start;metadata=details;actions=buttons;bodyHeight=scrollHeight;layout()
  }
  func layout(){
    guard let host,let panel,let metadata,let actions,let bodyHeight else{return}
    let area=host.bounds.inset(by:host.safeAreaInsets)
    guard area.width>0,area.height>0 else{return}
    let target=CGSize(width:max(0,area.width-24),height:UIView.layoutFittingCompressedSize.height)
    let details=metadata.systemLayoutSizeFitting(target,withHorizontalFittingPriority:.required,verticalFittingPriority:.fittingSizeLevel).height
    let buttons=max(44,actions.systemLayoutSizeFitting(target,withHorizontalFittingPriority:.required,verticalFittingPriority:.fittingSizeLevel).height)
    let chrome:CGFloat=26
    let limit=min(area.height,max(area.height*0.45,buttons+chrome+32))
    let height=min(details+buttons+chrome,limit)
    bodyHeight.constant=max(0,height-buttons-chrome)
    panel.frame=CGRect(x:area.minX,y:area.maxY-height,width:area.width,height:height);panel.layoutIfNeeded()
  }
  private func handle(_ row:Session,_ event:LiveMP3Playback.Event){
    guard !disposed,session === row else{return}
    switch event{
    case .ended(let reason):
      row.push(["type":"media.session.ended","sessionId":row.id,"reason":reason]);panel?.removeFromSuperview();panel=nil;heading=nil;play=nil;metadata=nil;actions=nil;bodyHeight=nil;session=nil;return
    case .buffering:row.phase="buffering"
    case .playing:row.phase="playing"
    case .paused:row.phase="paused"
    }
    if var style=play?.configuration{style.title=row.phase == "paused" ? "Play radio":"Pause radio";play?.configuration=style}
    heading?.text=panelTitle(row);state(row);capabilities(row);layout()
  }
  private func state(_ row:Session){
    var value:[String:Any]=["type":"media.state","sessionId":row.id,"status":row.phase]
    if row.phase == "paused"{value["reason"]=row.pauseReason};row.push(value)
  }
  private func capabilities(_ row:Session){row.push(["type":"media.capabilities","sessionId":row.id,"actions":row.phase == "paused" ? ["pause","stop"]:["play","pause","stop"]])}
  func focusChanged(visible:Bool){guard let row=session else{return};let focused=visible&&allowed();panel?.isHidden = !focused;if !focused{row.pauseReason="focus-lost";row.playback.pause()}}
  func retire(_ reason:String="policy"){session?.playback.retire(reason)}
  func dispose(){retire();disposed=true;Self.instances.removeValue(forKey:generation);if let interruption{NotificationCenter.default.removeObserver(interruption)};interruption=nil;if let textSizeObserver{NotificationCenter.default.removeObserver(textSizeObserver)};textSizeObserver=nil;panel?.removeFromSuperview();panel=nil;heading=nil;play=nil;metadata=nil;actions=nil;bodyHeight=nil;session=nil}
  static func revokeGenerations(_ generations:Set<String>){for generation in generations{instances[generation]?.value?.retire("policy")}}
}
