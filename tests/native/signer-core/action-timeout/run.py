#!/usr/bin/env python3
"""Actual owning iOS action/auth lifetime regression; host doubles only, no device."""
from pathlib import Path
import argparse,hashlib,json,os,signal,subprocess,sys,time
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def block(text,marker):
 assert text.count(marker)==1,marker
 start=text.index(marker);brace=text.index('{',start);depth=1;end=brace+1
 while depth:depth+=(text[end]=='{')-(text[end]=='}');end+=1
 return text[start:end]
def generate(text):
 markers=['  private func resignActive()','  private func background()','  private func completeImport(','  private func cancelImport()','  func cancelAll()','  private func authenticate(','  func backup(','  func deleteLocalKey(','  func delete(','  private func current(']
 methods='\n'.join(block(text,m) for m in markers)
 auth=block(text,'  private func authenticate(')
 bound='-> (id: UInt64, deadline: ContinuousClock.Instant)' in auth
 assert bound or 'async throws -> UInt64' in auth,'Unknown auth result shape'
 timer=block(auth,'    timer = Task')
 sleep='do { try await Task.sleep(for: .seconds(60)) } catch { return }'
 assert timer.count(sleep)==1
 callback=timer.split(sleep,1)[1][:-1].strip().lstrip(';').strip()
 adapter=(HERE/'HostSupport.swift').read_text().replace('AUTH_RESULT_ID','result.id' if bound else 'result').replace('AUTH_TIMER_CALLBACK',callback)
 return adapter.replace(' // ACTUAL_SESSION_METHODS',methods)
def compiler_command(toolchain,sdk,target,out,gate):
 tools=toolchain/'usr/bin';resource=toolchain/'usr/lib/swift'
 command=[str(tools/'swiftc'),'-swift-version','6','-sdk',str(sdk),'-resource-dir',str(resource),'-tools-directory',str(tools),'-use-ld='+str(tools/'ld')]
 if target:command+=['-target',target]
 return command+['-module-cache-path',str(out/'module-cache'),str(out/'SessionUnderTest.swift'),str(gate),str(HERE/'ActionTimeoutTests.swift'),'-o',str(out/'action-tests')]
def owned(command,env,timeout):
 child=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env=env,start_new_session=True)
 try:
  data=child.communicate(timeout=timeout)[0];code=child.returncode
 except subprocess.TimeoutExpired:
  os.killpg(child.pid,signal.SIGTERM)
  try:data=child.communicate(timeout=2)[0]
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);data=child.communicate(timeout=2)[0]
  code=None
 def alive():
  try:os.killpg(child.pid,0);return True
  except ProcessLookupError:return False
 if alive():
  os.killpg(child.pid,signal.SIGTERM);end=time.monotonic()+2
  while alive() and time.monotonic()<end:time.sleep(.02)
  if alive():os.killpg(child.pid,signal.SIGKILL);end=time.monotonic()+2
  while alive() and time.monotonic()<end:time.sleep(.02)
 return code,data,not alive()
def main():
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=HERE.parents[3]);p.add_argument('--session-source',type=Path);p.add_argument('--output',type=Path,required=True);p.add_argument('--driver-print-jobs',action='store_true');p.add_argument('--toolchain-root',type=Path,required=True);p.add_argument('--sdk',type=Path,required=True);p.add_argument('--target');a=p.parse_args()
 source=(a.session_source or a.root/'modules/signer-core/ios/NativeVaultSession.swift').resolve();out=a.output.resolve();out.mkdir(parents=True,exist_ok=False);(out/'tmp').mkdir()
 gate=a.root/'modules/signer-core/ios/NativeVaultMutationGate.swift'
 r={'passed':False,'deviceOperations':0,'source':str(source),'sourceSha256':sha(source),'scope':'Actual session methods and mutation gate with explicit clock/UI/auth/core ports; no UIKit/LAContext/protected-device proof.','driverPrintJobsOnly':a.driver_print_jobs}
 try:
  (out/'SessionUnderTest.swift').write_text(generate(source.read_text()))
  inputs=[source,gate,HERE/'HostSupport.swift',HERE/'ActionTimeoutTests.swift',Path(__file__)];r['inputHashes']={str(f):sha(f)for f in inputs}
  toolchain=a.toolchain_root.resolve();sdk=a.sdk.resolve();tools=toolchain/'usr/bin'
  assert (tools/'swiftc').is_file() and (tools/'ld').is_file() and sdk.is_dir() and (toolchain/'usr/lib/swift').is_dir(),'Explicit local toolchain/SDK required'
  command=compiler_command(toolchain,sdk,a.target,out,gate)
  if a.driver_print_jobs:command.insert(1,'-driver-print-jobs')
  r['compileCommand']=command
  env={k:v for k,v in os.environ.items()if k in ['HOME','USER','LOGNAME','LANG','LC_ALL','LC_CTYPE','__CF_USER_TEXT_ENCODING']};env.update(PATH=str(tools)+':/usr/bin:/bin:/usr/sbin:/sbin',DEVELOPER_DIR=str(toolchain),TMPDIR=str(out/'tmp'),CLANG_MODULE_CACHE_PATH=str(out/'module-cache'))
  r['environmentPolicy']='Basic user/locale allowlist only plus explicit toolchain PATH/DEVELOPER_DIR/private TMPDIR+cache; no other SDK/tool/plugin/DYLD inheritance'
  code,data,stopped=owned(command,env,15 if a.driver_print_jobs else 60);(out/'compile.log').write_bytes(data);r.update(compileExitCode=code,compilerGroupStopped=stopped);assert code==0 and stopped,'Host compiler/job-plan failure'
  if not a.driver_print_jobs:
   code,data,stopped=owned([str(out/'action-tests')],env,10);(out/'test.log').write_bytes(data);r.update(testExitCode=code,testGroupStopped=stopped,result=json.loads(data));assert code==0 and stopped and r['result']['passed'] is True,'Host regression failed'
  assert all(sha(Path(f))==h for f,h in r['inputHashes'].items()),'Inputs changed'
  r['passed']=True
 except BaseException as error:r['error']=repr(error)
 finally:
  r['artifactHashes']={str(f.relative_to(out)):sha(f)for f in out.rglob('*')if f.is_file()and'module-cache'not in f.parts}
  (out/'receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({k:r.get(k)for k in ['passed','compileExitCode','testExitCode','result','error']}))
 return 0 if r['passed'] else 1
if __name__=='__main__':sys.exit(main())
