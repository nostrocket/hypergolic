#!/usr/bin/env python3
"""Controlled host TLS EVENT/ACK proof; no public DNS, device, protected signing or guest admission claim."""
import argparse,base64,hashlib,importlib.util,json,os,socket,ssl,subprocess,threading
from pathlib import Path
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[3]
spec=importlib.util.spec_from_file_location('native_core',HERE/'run.py');core=importlib.util.module_from_spec(spec);spec.loader.exec_module(core)
INVALID_ACK_MODES=['invalid-single-quotes','invalid-bare-string','invalid-uppercase-boolean','invalid-semicolon','invalid-block-comment','invalid-line-comment','invalid-raw-control']
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def inputs():return {**core.inputs(),**{str(p.relative_to(ROOT)):digest(p) for p in [Path(__file__),HERE/'TLSProof.java',HERE/'TLSProof.swift',ROOT/'tests/native/android-published-https/PublishedHttpsTlsProof.java']}}
def run(command,out,name,cwd=ROOT):
 with (out/(name+'.log')).open('w') as log:subprocess.run(command,cwd=cwd,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=180)
def exact(peer,n):
 result=b''
 while len(result)<n:
  part=peer.recv(n-len(result))
  if not part:raise ConnectionError('closed')
  result+=part
 return result
def read_frame(peer):
 a,b=exact(peer,2);assert a==0x81 and b&0x80
 n=b&127
 if n==126:n=int.from_bytes(exact(peer,2),'big')
 elif n==127:n=int.from_bytes(exact(peer,8),'big')
 assert n<=65536
 mask=exact(peer,4);body=exact(peer,n)
 return bytes(v^mask[i%4] for i,v in enumerate(body)).decode()
def frame(value):
 body=value.encode();return b'\x81'+(bytes([len(body)]) if len(body)<126 else b'\x7e'+len(body).to_bytes(2,'big'))+body
def serve(listener,key,cert,mode,fixture,trace,errors):
 context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(cert,key)
 try:
  listener.settimeout(10);raw,_=listener.accept();raw.settimeout(4)
  with context.wrap_socket(raw,server_side=True) as peer:
   headers=b''
   while b'\r\n\r\n' not in headers:headers+=exact(peer,1);assert len(headers)<8192
   assert headers.startswith(b'GET /fixture HTTP/1.1\r\nHost: relay.example.org:')
   nonce=next(line.split(b':',1)[1].strip() for line in headers.split(b'\r\n') if line.lower().startswith(b'sec-websocket-key:'))
   accept=base64.b64encode(hashlib.sha1(nonce+b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
   trace.append({'phase':'verified-upgrade'})
   peer.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+b'\r\n\r\n')
   try:wire=read_frame(peer)
   except (ConnectionError,OSError):
    if mode=='revoke-before-send':return
    raise
   assert mode!='revoke-before-send','Revoked request emitted EVENT'
   value=json.loads(wire);assert value==['EVENT',fixture['primary']]
   trace.append({'phase':'exact-event','sha256':hashlib.sha256(wire.encode()).hexdigest(),'eventId':value[1]['id']})
   event_id=fixture['primary']['id']
   if mode=='missing':return
   if mode=='malformed':ack=['OK',event_id,1,'invalid boolean']
   elif mode=='wrong-id':ack=['OK','0'*64,True,'foreign']
   elif mode=='auth-required':ack=['AUTH','temporary-proof-challenge']
   else:ack=['OK',event_id,mode!='rejected','blocked' if mode=='rejected' else 'stored']
   if mode=='oversized-reason':ack=['OK',event_id,True,'x'*4097]
   elif mode=='multibyte-overflow':ack=['OK',event_id,True,'😀'*1025]
   ack_wire=json.dumps(ack,separators=(',',':'),ensure_ascii=False)
   if mode=='trailing-data':ack_wire+=' trailing data'
   elif mode=='trailing-nul':ack_wire+='\0 trailing data'
   elif mode=='concatenated':ack_wire+=json.dumps(['OK',event_id,False,'second response'],separators=(',',':'))
   if mode in INVALID_ACK_MODES:
    ack_wire={
     'invalid-single-quotes':"['OK','"+event_id+"',true,'stored']",
     'invalid-bare-string':'[OK,"'+event_id+'",true,stored]',
     'invalid-uppercase-boolean':'["OK","'+event_id+'",TRUE,"stored"]',
     'invalid-semicolon':'["OK";"'+event_id+'";true;"stored"]',
     'invalid-block-comment':'/* comment */ '+ack_wire,
     'invalid-line-comment':'// comment\n'+ack_wire,
     'invalid-raw-control':'["OK","'+event_id+'",true,"sto\tred"]'
    }[mode]
   peer.sendall(frame(json.dumps(['NOTICE','ordinary'],separators=(',',':')))+frame(ack_wire))
   trace.append({'phase':'ack','value':ack,'wire':ack_wire,'wireBytes':len(ack_wire.encode()),'wireSha256':hashlib.sha256(ack_wire.encode()).hexdigest()})
 except Exception as error:errors.append(str(error))
 finally:listener.close()
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,required=True);a=p.parse_args();out=a.output.resolve();out.mkdir(parents=True,exist_ok=False)
 receipt={'status':'failed','scope':__doc__,'sourceBefore':inputs(),'runs':[]}
 try:
  fixture=json.loads((HERE/'fixtures.json').read_text());key=out/'server.key';cert=out/'server.pem';der=out/'server.der';p12=out/'server.p12'
  run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(key),'-out',str(cert),'-subj','/CN=relay.example.org','-addext','subjectAltName=DNS:relay.example.org','-addext','extendedKeyUsage=serverAuth','-addext','keyUsage=digitalSignature,keyEncipherment'],out,'certificate')
  run(['openssl','x509','-in',str(cert),'-outform','DER','-out',str(der)],out,'certificate-der')
  run(['openssl','pkcs12','-export','-inkey',str(key),'-in',str(cert),'-out',str(p12),'-passout','pass:temporary-proof'],out,'certificate-p12')
  run(['./gradlew',':hypergolic-napplet-host:compileReleaseJavaWithJavac','--offline','--console=plain'],out,'android-compile',ROOT/'android')
  cache=ROOT/'.tools/gradle-home/caches/modules-2/files-2.1';jars=[next((cache/'org.json/json/20180813').rglob('*.jar')),next((cache/'org.jetbrains.kotlin/kotlin-stdlib/2.1.20').rglob('*.jar'))]
  classes=[core.ANDROID/'build/tmp/kotlin-classes/release',core.ANDROID/'build/intermediates/javac/release/compileReleaseJavaWithJavac/classes'];(out/'classes').mkdir();cp=os.pathsep.join(map(str,[*classes,*jars,out/'classes']))
  run(['javac','-Xlint:all','-Werror','-cp',cp,'-d',str(out/'classes'),str(HERE/'TLSProof.java'),str(ROOT/'tests/native/android-published-https/PublishedHttpsTlsProof.java')],out,'android-proof-compile')
  binary=out/'ios-proof';run(['xcrun','swiftc','-swift-version','6','-D','HYPERGOLIC_NETWORK_PROOF','-warnings-as-errors','-parse-as-library',*(str(core.IOS/n) for n in core.I_NAMES),str(HERE/'TLSProof.swift'),'-o',str(binary)],out,'ios-proof-compile')
  for platform in ['android','ios']:
   for mode in ['accepted','accepted-close','rejected','missing','wrong-id','malformed','revoke-before-send','trailing-data','trailing-nul','concatenated','oversized-reason','multibyte-overflow']+INVALID_ACK_MODES:
    listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(1);port=listener.getsockname()[1];trace=[];errors=[]
    thread=threading.Thread(target=serve,args=(listener,key,cert,mode,fixture,trace,errors),daemon=True);thread.start()
    command=['java','-cp',cp,'org.nostrocket.hypergolic.host.TLSProof',str(port),str(cert),str(p12),mode,str(HERE/'fixtures.json')] if platform=='android' else [str(binary),str(port),str(der),mode,str(HERE/'fixtures.json')]
    name=platform+'-'+mode;run(command,out,name);thread.join(timeout=8);assert not thread.is_alive() and not errors,(name,errors)
    result=json.loads((out/(name+'.log')).read_text());assert result['status']=='passed';receipt['runs'].append({'platform':platform,**result,'observed':trace});print('PASS '+name,flush=True)
  receipt['sourceAfter']=inputs();assert receipt['sourceBefore']==receipt['sourceAfter'];receipt['status']='passed'
 finally:
  # Disposable TLS private material is unnecessary for the retained proof.
  for name in ['server.key','server.p12']:(out/name).unlink(missing_ok=True)
  receipt['logs']={p.name:digest(p) for p in out.glob('*.log')};(out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
if __name__=='__main__':main()
