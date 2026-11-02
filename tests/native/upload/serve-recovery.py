#!/usr/bin/env python3
"""Independent loopback TLS observer and controlled fault provider for native recovery journeys."""
import argparse,base64,hashlib,json,re,shutil,socket,ssl,subprocess,threading,time
from pathlib import Path
from evidence import large_wav
ROOT=Path(__file__).resolve().parents[3]; HERE=Path(__file__).resolve().parent
parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);parser.add_argument('--tls-material',type=Path);args=parser.parse_args();out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
png=base64.b64decode(re.search(r"const encoded = '([^']+)'",(ROOT/'napplets/upload-lab/src/main.ts').read_text()).group(1));large=large_wav()
expected={hashlib.sha256(png).hexdigest():(png,'image/png','png'),hashlib.sha256(large).hexdigest():(large,'audio/wav','wav')}
key,pem,der=out/'server.key',out/'server.pem',out/'anchor.der'
if args.tls_material:
    for name in ['server.key','server.pem','anchor.der']:
        source=args.tls_material/name;assert source.is_file() and not source.is_symlink();shutil.copy2(source,out/name)
else:
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(key),'-out',str(pem),'-subj','/CN=files.example.com','-addext','subjectAltName=DNS:files.example.com','-addext','extendedKeyUsage=serverAuth','-addext','keyUsage=digitalSignature,keyEncipherment'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
key.chmod(0o600)
actual=subprocess.check_output(['openssl','x509','-in',str(pem),'-outform','DER'])
if args.tls_material:assert actual==der.read_bytes()
else:der.write_bytes(actual)
(out/'anchor.b64').write_text(base64.b64encode(der.read_bytes()).decode())
(out/'control.json').write_text(json.dumps({'put':'normal','get':'normal','release':False}))
context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(str(pem),str(key));listener=socket.socket();listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);listener.bind(('127.0.0.1',19943));listener.listen(4)
lock=threading.Lock();stored={};observed={'schema':1,'connections':0,'putAttempts':[],'partialPuts':[],'requests':[],'gets':[],'errors':[],'transportClosed':0,'publicPuts':0}
def save():
    temporary=out/'observer.tmp';temporary.write_text(json.dumps(observed,indent=2)+'\n');temporary.replace(out/'observer.json')
def control():
    value=json.loads((out/'control.json').read_text());assert set(value)=={'put','get','release'};return value
def send(peer,status,body,extra=b'',declared=None):
    peer.sendall(f'HTTP/1.1 {status} Test\r\nConnection: close\r\nContent-Length: {len(body) if declared is None else declared}\r\n'.encode()+extra+b'\r\n'+body)
def hold():
    deadline=time.monotonic()+55
    while not control()['release'] and time.monotonic()<deadline:time.sleep(.02)
def serve(raw):
    try:
        raw.settimeout(75)
        # Force actual TCP backpressure, rather than letting the whole fixture
        # fit in loopback buffers before the observed trusted Cancel input.
        if control()['put']=='slow-stream':raw.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,8192)
        if control()['put']=='before-tls':hold()
        with context.wrap_socket(raw,server_side=True) as peer:
            wire=bytearray()
            while b'\r\n\r\n' not in wire:
                chunk=peer.recv(8192)
                if not chunk:return
                wire.extend(chunk);assert len(wire)<32768
            head,body=bytes(wire).split(b'\r\n\r\n',1);lines=head.decode('ascii').split('\r\n');headers=dict(line.split(': ',1) for line in lines[1:]);assert len(headers)==len(lines)-1
            mode=control()
            if lines[0].startswith('GET /'):
                target=lines[0].split(' ')[1];assert re.fullmatch('/[0-9a-f]{64}',target);assert not body and set(headers)=={'Host','Accept','Accept-Encoding','Connection'}
                with lock:observed['gets'].append({'target':target,'mode':mode['get'],'authorization':False});save();data=stored.get(target[1:])
                if mode['get']=='hold':hold()
                if mode['get']=='absent' or data is None:send(peer,404,b'not found')
                elif mode['get']=='wrong-hash':send(peer,200,bytes([data[0]^1])+data[1:])
                elif mode['get']=='truncated':send(peer,200,data[:-1],declared=len(data))
                elif mode['get']=='redirect':send(peer,302,b'',b'Location: https://other.example.com/unapproved\r\n')
                elif mode['get']=='quota':send(peer,429,b'no quota')
                else:send(peer,200,data)
                return
            assert lines[0]=='PUT /upload HTTP/1.1';hash_value=headers['X-SHA-256'];assert hash_value in expected
            expected_body,mime,extension=expected[hash_value];size=int(headers['Content-Length']);assert size==len(expected_body) and headers['Content-Type']==mime
            credential={'authorization':headers['Authorization'],'sha256':hash_value,'size':size}
            verified=json.loads(subprocess.check_output(['node',str(HERE/'verify-authorization.mjs')],input=json.dumps(credential),text=True,cwd=ROOT,stderr=subprocess.DEVNULL));verified['mimeType']=mime
            with lock:observed['putAttempts'].append({'sha256':hash_value,'size':size,'mode':mode['put'],'signatureVerified':verified['signatureVerified']});save()
            while len(body)<size:
                if mode['put']=='slow-stream':time.sleep(.04)
                try:chunk=peer.recv(min(8192,size-len(body)))
                except (ssl.SSLError,ConnectionResetError):chunk=b''
                if not chunk:
                    with lock:observed['partialPuts'].append({'sha256':hash_value,'declaredSize':size,'bytesReceived':len(body)});save()
                    return
                body+=chunk
            assert body==expected_body and hashlib.sha256(body).hexdigest()==hash_value
            if mode['put'] in ['reject','large','quota']:
                send(peer,413 if mode['put']=='large' else 429 if mode['put']=='quota' else 403,b'rejected');return
            if mode['put']=='drop-before-store':return
            with lock:
                stored[hash_value]=body;(out/f'stored-{len(observed["requests"])+1}.{extension}').write_bytes(body);verified['mode']=mode['put'];observed['requests'].append(verified);save()
            if mode['put']=='lost-ack':return
            if mode['put']=='timeout':time.sleep(65)
            elif mode['put']=='hold':hold()
            else:time.sleep(2)
            descriptor={'url':f'https://files.example.com:19943/{hash_value}.{extension}','sha256':hash_value,'size':size,'type':mime,'uploaded':int(time.time())}
            if mode['put']=='wrong-receipt':descriptor['sha256']='0'*64
            encoded=json.dumps(descriptor).encode()
            if mode['put']=='truncated-receipt':send(peer,201,encoded[:-1],declared=len(encoded))
            elif mode['put']=='malformed-receipt':send(peer,201,b'{')
            elif mode['put']=='redirect':send(peer,307,b'',b'Location: https://other.example.com/unapproved\r\n')
            else:send(peer,201,encoded)
    except (ssl.SSLError,BrokenPipeError,ConnectionResetError):
        with lock:observed['transportClosed']+=1;save()
    except Exception as error:
        with lock:observed['errors'].append(repr(error));save()
    finally:raw.close()
save();print(json.dumps({'ready':True,'origin':'https://files.example.com:19943','anchorFile':str(out/'anchor.b64'),'observer':str(out/'observer.json')}),flush=True)
try:
    while True:
        raw,_=listener.accept()
        with lock:observed['connections']+=1;save()
        threading.Thread(target=serve,args=(raw,),daemon=True).start()
finally:listener.close()
