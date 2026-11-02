#!/usr/bin/env python3
"""Independent isolated TLS observer for SDK/native upload journeys; never contacts a public provider."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import socket
import ssl
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
parser.add_argument('--expected-dir', type=Path)
parser.add_argument('--photo-dir', type=Path)
args = parser.parse_args()
out = Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=False)
expected = base64.b64decode(re.search(r"const encoded = '([^']+)'", (ROOT/'napplets/upload-lab/src/main.ts').read_text()).group(1))
expected_hash = hashlib.sha256(expected).hexdigest()
expected_files = {expected_hash: (expected, 'image/png', 'png')}
if args.expected_dir:
    for item in json.loads((args.expected_dir/'attachments.json').read_text())['files']:
        data = (args.expected_dir/item['file']).read_bytes()
        assert hashlib.sha256(data).hexdigest() == item['sha256'] and len(data) == item['size']
        expected_files[item['sha256']] = (data, item['mimeType'], item['file'].rsplit('.',1)[1])
photos = json.loads((args.photo_dir/'photos.json').read_text()) if args.photo_dir else None
if photos:
    import importlib.util
    photo_spec = importlib.util.spec_from_file_location('independent_photo_verifier', HERE/'verify-photo.py')
    photo_verifier = importlib.util.module_from_spec(photo_spec);photo_spec.loader.exec_module(photo_verifier)
key, pem, der = out/'server.key', out/'server.pem', out/'anchor.der'
subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(key),'-out',str(pem),
                '-subj','/CN=files.example.com','-addext','subjectAltName=DNS:files.example.com',
                '-addext','extendedKeyUsage=serverAuth','-addext','keyUsage=digitalSignature,keyEncipherment'],
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
key.chmod(0o600)
subprocess.run(['openssl','x509','-in',str(pem),'-outform','DER','-out',str(der)],check=True)
(out/'anchor.b64').write_text(base64.b64encode(der.read_bytes()).decode())
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(str(pem),str(key))
listener = socket.socket(); listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);listener.bind(('127.0.0.1',19943));listener.listen(4)
lock = threading.Lock()
observed = {'schema':1,'connections':0,'requests':[],'errors':[],'expectedHash':expected_hash,'expectedSize':len(expected),'publicPuts':0}
def save():
    temporary = out/'observer.tmp';temporary.write_text(json.dumps(observed,indent=2)+'\n');temporary.replace(out/'observer.json')
save()
def serve(raw):
    try:
        raw.settimeout(10)
        with context.wrap_socket(raw,server_side=True) as peer:
            wire=bytearray()
            while b'\r\n\r\n' not in wire:
                data=peer.recv(8192)
                if not data:return
                wire.extend(data)
                if len(wire)>32768:raise AssertionError('Oversized header')
            head,body=bytes(wire).split(b'\r\n\r\n',1)
            lines=head.decode('ascii').split('\r\n');assert lines[0]=='PUT /upload HTTP/1.1'
            headers=dict(line.split(': ',1) for line in lines[1:]);assert len(headers)==len(lines)-1
            hash_value=headers['X-SHA-256'];known=expected_files.get(hash_value)
            size=int(headers['Content-Length']);assert 1<=size<=10*1024*1024
            assert known or photos
            expected_body,mime,extension=known if known else (None,'image/png','png')
            if known:assert size==len(expected_body)
            while len(body)<size:
                data=peer.recv(min(8192,size-len(body)))
                if not data:raise AssertionError('Incomplete body')
                body+=data
            assert (expected_body is None or body==expected_body) and hashlib.sha256(body).hexdigest()==hash_value and headers['Content-Type']==mime
            matches=[]
            if not known:
                for item in photos['files']:
                    try:
                        photo_verifier.verify(body,args.photo_dir/(item['file']+'.expected.png'),item['gamut'],photos['metadataNeedles'],8 if item['file'].endswith('.heic') else 4);matches.append(item['file'])
                    except AssertionError:pass
                assert matches,'Stored photo differs from independent orientation/color/metadata recipes'
            credential={'authorization':headers['Authorization'],'sha256':hash_value,'size':size}
            verified=json.loads(subprocess.check_output(['node',str(HERE/'verify-authorization.mjs')],input=json.dumps(credential),text=True,cwd=ROOT,stderr=subprocess.DEVNULL))
            with lock:
                (out/f'stored-{len(observed["requests"])+1}.{extension}').write_bytes(body)
                verified['mimeType']=mime
                if matches:verified['photoMatches']=matches
                observed['requests'].append(verified);save()
            time.sleep(2) # Retains a visible in-flight progress interval before server confirmation.
            descriptor=json.dumps({'url':f'https://files.example.com:19943/{hash_value}.{extension}','sha256':hash_value,'size':size,'type':mime,'uploaded':int(time.time())}).encode()
            peer.sendall(b'HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: '+str(len(descriptor)).encode()+b'\r\nConnection: close\r\n\r\n'+descriptor)
    except Exception as error:
        with lock:observed['errors'].append(type(error).__name__);save()
    finally:raw.close()
print(json.dumps({'ready':True,'origin':'https://files.example.com:19943','anchorFile':str(out/'anchor.b64'),'observer':str(out/'observer.json'),'expectedHash':expected_hash,'size':len(expected)}),flush=True)
try:
    while True:
        raw,_=listener.accept()
        with lock:observed['connections']+=1;save()
        threading.Thread(target=serve,args=(raw,),daemon=True).start()
finally:listener.close()
