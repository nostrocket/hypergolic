#!/usr/bin/env python3
"""Host-executed native consent/pin/request/effect-binding/lifecycle proofs; no network or devices."""
import argparse, copy, json, os, subprocess
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
ANDROID=ROOT/'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host'
IOS=ROOT/'modules/napplet-host/ios'

def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--output',type=Path,required=True)
 args=parser.parse_args();out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
 profile=dict(profile='legacy-read-only-v1',consent=True,eventId='b70911af4382baded327ce6af4b595197ff7a4781e3704b9f066a74f68b48a07',htmlHash='9067048a9ce80d7e79ea76b960acc88aa53645754ec4e7549de1c1525a690194',relays=['wss://relay.damus.io','wss://nos.lol'])
 base=dict(sessionId='session',epoch=1,user='a'*64,publisher='c2f1ab4e6a577dd8980b57e15986ed92830b95a94f374192235563532b5cac20',appId='recipe-cards',version='92d5639e1da2a0b9ac6bbb9d41d67b0026c15ed614e2d553f8ad2e4e4e896ecc',instanceId='instance',fixture='published',domains=[],legacyReadOnly=profile)
 configs=[dict(name='exact pin',value=copy.deepcopy(base),ok=True)]
 for key,value in [('consent',False),('consent',1),('profile','other'),('eventId','0'*64),('htmlHash','0'*64),('relays',[]),('relays',['wss://nos.lol','wss://nos.lol']),('relays',['ws://nos.lol']),('relays',['wss://127.0.0.1']),('relays',['wss://relay.local']),('relays',['wss://nos.lol/']),('relays',['wss://nos.lol?x=1']),('relays',['wss://user@nos.lol']),('relays',['wss://nos.lol:443'])]:
  b=copy.deepcopy(base);b['legacyReadOnly'][key]=value;configs.append(dict(name='invalid '+key+repr(value),value=b,ok=False))
 for key,value in [('publisher','0'*64),('appId','other'),('version','0'*64),('domains',['relay']),('domains',['identity']),('fixture','ux-lab')]:
  b=copy.deepcopy(base);b[key]=value;configs.append(dict(name='invalid '+key,value=b,ok=False))
 longform=copy.deepcopy(base);longform.update(appId='longform',version='3ba5049444dd249abbe671f818d555b4e3c90b7cab88a70187bc3a012f9afd67');longform['legacyReadOnly'].update(eventId='5fff2ec459ffb1a2d2966fc9815bc8ba45db96a669dfe4924d6c63e65b08a24e',htmlHash='d5558df7e1f3823c0ad5c64273d57802fe304c1e2266bab8e5151fbf05ad51f4');configs.append(dict(name='longform exact pin',value=longform,ok=True))
 request=dict(type='legacy.subscribe',id='read',subId='guest-sub',filters=[dict(kinds=[30023],limit=32)],relay='wss://relay.damus.io')
 requests=[dict(name='read',value=request,subscribe=True,close=False),dict(name='close',value=dict(type='legacy.close',id='close',subId='guest-sub'),subscribe=False,close=True)]
 for key,value in [('type','relay.subscribe'),('type','relay.publish'),('type','EVENT'),('type','AUTH'),('type','upload.prepare'),('relay','wss://relay.nostr.band'),('id',''),('filters',[dict(kinds=[30023],limit=33)]),('filters',[dict(authors=['a'*64]*65,limit=32)]),('filters',[dict(kinds=[4],limit=32)]),('filters',[dict(kinds=[1059],limit=32)]),('filters',[dict(limit=True)]),('filters',[dict(limit=32,unknown=[])]),('filters',[dict(limit=32,since=10,until=1)]),('filters',[dict(kinds=[30023])])]:
  b=copy.deepcopy(request);b[key]=value;requests.append(dict(name='invalid '+key+repr(value),value=b,subscribe=False,close=False))
 wires=[]
 for name,url,wire,ok in [('captured','wss://relay.damus.io',['REQ','native-sub',*request['filters']],True),('destination substitution','wss://nos.lol',['REQ','native-sub',*request['filters']],False),('payload substitution','wss://relay.damus.io',['REQ','native-sub',dict(kinds=[1],limit=32)],False),('publish','wss://relay.damus.io',['EVENT',dict(content='no')],False),('AUTH','wss://relay.damus.io',['AUTH',dict(content='no')],False),('substitution id','wss://relay.damus.io',['REQ','other',*request['filters']],False)]:
  wires.append(dict(name=name,url=url,wire=json.dumps(wire),ok=ok))
 image=dict(type='legacy.image.bytes',id='image',url='https://cdn.primal.net/image.jpg')
 chunk=dict(type='legacy.image.__chunk',id='chunk',handle='12345678-1234-4234-8234-123456789abc',offset=0)
 images=[dict(name='HTTPS image',value=image,ok=True),dict(name='cancel',value=dict(type='legacy.image.cancel',id='image'),ok=True),dict(name='chunk',value=chunk,ok=True)]
 for key,value in [('url','http://cdn.primal.net/image.jpg'),('url','data:image/png;base64,AA=='),('url','https://cdn.primal.net/a\n'),('url','https://cdn.primal.net/'+'x'*8192),('type','resource.bytes'),('id',''),('servers',[])]:
  b=copy.deepcopy(image);b[key]=value;images.append(dict(name='image invalid '+key+repr(value),value=b,ok=False))
 for key,value in [('offset',-1),('offset',True),('offset',10485761),('handle','12345678-1234-1234-8234-123456789abc'),('extra',True)]:
  b=copy.deepcopy(chunk);b[key]=value;images.append(dict(name='chunk invalid '+key+repr(value),value=b,ok=False))
 effects=[dict(name='captured image',registration=base,request=image,url=image['url'],ok=True),dict(name='substituted URL',registration=base,request=image,url='https://cdn.primal.net/other.jpg',ok=False)]
 for row in configs:
  effects.append(dict(name='effect '+row['name'],registration=row['value'],request=image,url=image['url'],ok=row['ok']))
 for row in images:
  effects.append(dict(name='effect '+row['name'],registration=base,request=row['value'],url=image['url'],ok=row['ok'] and row['value']['type']=='legacy.image.bytes'))
 missing=copy.deepcopy(base);del missing['legacyReadOnly'];effects.append(dict(name='missing context',registration=missing,request=image,url=image['url'],ok=False))
 fixture=out/'cases.json';fixture.write_text(json.dumps(dict(base=base,configs=configs,requests=requests,wires=wires,request=request,images=images,effects=effects,image=image)))
 cache=ROOT/'.tools/gradle-home/caches/modules-2/files-2.1'
 def artifact(group,name,version):
  matches=list((cache/group/name/version).glob('*/*.jar'));assert len(matches)==1,(group,name);return matches[0]
 compiler=[artifact('org.jetbrains.kotlin',n,'2.1.20') for n in ['kotlin-compiler-embeddable','kotlin-stdlib','kotlin-script-runtime','kotlin-daemon-embeddable']]+[artifact('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),artifact('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),artifact('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),artifact('org.jetbrains','annotations','23.0.0')]
 stdlib=artifact('org.jetbrains.kotlin','kotlin-stdlib','2.1.20');jsonjar=artifact('org.json','json','20180813');classes=out/'classes';classes.mkdir();runs=[]
 def run(name,command):
  with (out/(name+'.log')).open('w') as log:
   result=subprocess.run(list(map(str,command)),cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,timeout=180,env={**os.environ,'CLANG_MODULE_CACHE_PATH':str(out/'clang-cache')})
  runs.append(dict(name=name,exitCode=result.returncode));assert result.returncode==0,str(out/(name+'.log'))
 run('java-compile',['javac','-d',classes,*[ANDROID/n for n in ['PublishedCapabilityBinding.java','RelaySubscriptionRegistry.java','CapabilityLeaseRegistry.java']]])
 stub=out/'CapabilityTransport.kt';stub.write_text('package org.nostrocket.hypergolic.host\ninternal object CapabilityTransport {var now=0L;val leases=CapabilityLeaseRegistry{now}}\n')
 run('android-compile',['java','-cp',':'.join(map(str,compiler)),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',f'{classes}:{stdlib}:{jsonjar}','-d',classes,*[ANDROID/n for n in ['CapabilityConfiguration.kt','LegacyReadOnlyContext.kt','NativeAppDataPolicy.kt','NativeCanonicalJSON.kt','ResourceCapability.kt']],stub,HERE/'Proof.kt'])
 run('android-proof',['java','-cp',f'{classes}:{stdlib}:{jsonjar}','org.nostrocket.hypergolic.host.Proof',fixture])
 production=(IOS/'CapabilityTransport.swift').read_text();config=out/'Configuration.swift';config.write_text('import Foundation\nimport CoreFoundation\n'+production[production.index('struct CapabilityConfiguration {'):production.index('/// Lease queries are synchronous')])
 resource=(IOS/'ResourceHTTPSBridgeOwner.swift').read_text();method=resource[resource.index('  static func admission('):resource.index('  func fetch(')]
 admission=out/'ResourceAdmission.swift';admission.write_text('import Foundation\nfinal class ResourceHTTPSBridgeOwner {enum Failure:Error {case policy}\n'+method+'}\nenum CapabilityTransport {static let clock=ClockBox();static let leases=CapabilityLeaseRegistry(now:{clock.instant})}\n')
 run('swift-compile',['xcrun','swiftc','-swift-version','6','-warnings-as-errors','-parse-as-library','-module-cache-path',out/'swift-cache',*[IOS/n for n in ['LegacyReadOnlyContext.swift','NativeAppDataPolicy.swift','NativeCanonicalJSON.swift','RelaySubscriptionRegistry.swift','CapabilityLeaseRegistry.swift']],config,admission,HERE/'Proof.swift','-o',out/'swift-proof'])
 run('swift-proof',[out/'swift-proof',fixture])
 receipt=dict(scope=__doc__,runs=runs,passed=True);(out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
if __name__=='__main__':main()
