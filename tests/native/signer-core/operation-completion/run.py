#!/usr/bin/env python3
"""Actual iOS remote/signing completion ownership; no UIKit, device or network."""
from pathlib import Path
import argparse,hashlib,json,os,subprocess,sys
sys.dont_write_bytecode=True
p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[4]);p.add_argument('--session-source',type=Path);p.add_argument('--output',type=Path,required=True);a=p.parse_args();H=Path(__file__).resolve().parent;S=(a.session_source or a.root/'modules/signer-core/ios/NativeVaultSession.swift').resolve();O=a.output.resolve();O.mkdir(parents=True,exist_ok=False)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def block(t,m):
 assert t.count(m)==1,m
 start=t.index(m);end=t.index('{',start)+1;d=1
 while d:d+=(t[end]=='{')-(t[end]=='}');end+=1
 return t[start:end]
r={'passed':False,'deviceOperations':0,'networkOperations':0,'source':str(S),'sourceSha256':sha(S)}
try:
 t=S.read_text();bound='private var remoteOperation: UUID?'in t;sign='private var signOperation: UUID?'in t
 methods='\n'.join(block(t,m) for m in ['  func prepareRemote(','  private func startRemoteHandshake(','  private func finishRemotePreparation(','  private func cancelRemotePreparation(','  func prepareRemoteRefresh(','  private func decideSigning(','  private func finishSigning(','  func cancelSigning('])
 calls={'REMOTE_FINISH_CALL':'finishRemotePreparation(result'+(', operation: operation'if bound else '')+')','REMOTE_CANCEL_CALL':'cancelRemotePreparation('+('operation: operation, 'if bound else '')+'failure: failure)','REMOTE_START_CALL':'startRemoteHandshake(connection,vaultID:"public-vault",revision:1,epoch:1,deadline:.now.advanced(by:.seconds(120)),attemptID:"same-caller-id"'+(',operation:operation'if bound else '')+')','SIGN_FINISH_CALL':'finishSigning(result'+(',operation:operation'if sign else '')+',checker:checker)','SIGN_CANCEL_CALL':'cancelSigning('+('operation:operation'if sign else '')+')','SIGN_DECIDE_CALL':'decideSigning(false,event:ExactSignerEvent(),source:source,vaultID:"public-vault",revision:1,epoch:1,deadline:.now.advanced(by:.seconds(120))'+(',operation:operation'if sign else '')+')'}
 calls['SIGN_APPROVE_CALL']=calls['SIGN_DECIDE_CALL'].replace('decideSigning(false,','decideSigning(true,')
 adapter=(H/'HostSupport.swift').read_text().replace('// ACTUAL_METHODS',methods)
 for name,value in calls.items():adapter=adapter.replace(name,value)
 (O/'SessionUnderTest.swift').write_text(adapter);r['oldSignatureAdapter']={'remote':not bound,'sign':not sign};r['inputHashes']={str(f):sha(f) for f in [S,H/'HostSupport.swift',H/'OperationCompletionTests.swift',Path(__file__)]}
 dev=Path('/Applications/Xcode.app/Contents/Developer');cmd=[str(dev/'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc'),'-swift-version','6','-sdk',str(dev/'Platforms/MacOSX.platform/Developer/SDKs/MacOSX27.0.sdk'),'-module-cache-path',str(O/'module-cache'),str(O/'SessionUnderTest.swift'),str(H/'OperationCompletionTests.swift'),'-o',str(O/'operation-tests')];r['compileCommand']=cmd
 c=subprocess.run(cmd,capture_output=True,timeout=60,env=dict(os.environ,DEVELOPER_DIR=str(dev)));(O/'compile.log').write_bytes(c.stdout+c.stderr);r['compileExitCode']=c.returncode;assert c.returncode==0,'Host compilation failed'
 q=subprocess.run([str(O/'operation-tests')],capture_output=True,timeout=15);(O/'test.log').write_bytes(q.stdout+q.stderr);r['testExitCode']=q.returncode;r['result']=json.loads(q.stdout);assert all(sha(Path(f))==h for f,h in r['inputHashes'].items());r['passed']=q.returncode==0 and r['result']['passed'] is True
except BaseException as e:r['error']=repr(e)
finally:
 r['artifactHashes']={str(f.relative_to(O)):sha(f) for f in O.rglob('*') if f.is_file() and 'module-cache'not in f.parts};(O/'receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({k:r.get(k) for k in ['passed','compileExitCode','testExitCode','result','error']}))
sys.exit(0 if r['passed'] else 1)
