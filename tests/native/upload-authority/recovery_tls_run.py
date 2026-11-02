#!/usr/bin/env python3
"""Real native Java/Swift fixed-hash TLS GETs; injected metadata store, no disk or app acceptance."""
import json,socket,ssl,subprocess,tempfile,threading,time
from pathlib import Path
from tls_run import certificate,ROOT,HERE,JAVA,SWIFT,HASH

def serve(listener,pem,key,mode,observed,errors,checkpoint):
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(str(pem),str(key));listener.settimeout(1.5)
    port=listener.getsockname()[1]
    hops=3 if mode in ['redirect-two','redirect-third'] else 2 if mode.startswith('redirect-') else 1
    try:
      for hop in range(hops):
        raw,_=listener.accept();observed['connections']+=1;raw.settimeout(5)
        with context.wrap_socket(raw,server_side=True) as peer:
            wire=bytearray()
            while b'\r\n\r\n' not in wire:
                chunk=peer.recv(8192)
                if not chunk:return
                wire.extend(chunk);assert len(wire)<32768
            head,body=wire.split(b'\r\n\r\n',1);assert not body
            lines=head.decode('ascii').split('\r\n');target='/'+HASH+('.wav' if hop==1 else '.bin' if hop==2 else '')
            assert lines[0]=='GET '+target+' HTTP/1.1'
            headers=dict(line.split(': ',1) for line in lines[1:]);assert len(headers)==len(lines)-1
            assert set(headers)=={'Host','Accept','Accept-Encoding','Connection'}
            assert headers['Accept-Encoding']=='identity' and headers['Connection']=='close'
            expected_host='files.example.com' if hop==0 or mode=='redirect-original404' else 'other.example.com'
            assert headers['Host']==expected_host+':'+str(port)
            observed['gets']+=1;observed.setdefault('targets',[]).append(lines[0])
            status=404 if mode=='absent' or hop and mode in ['redirect-alternate404','redirect-original404'] else 429 if mode=='quota' else 302 if mode=='redirect' else 200
            redirecting=mode.startswith('redirect-') and (hop==0 or mode in ['redirect-two','redirect-third'] and hop==1 or mode=='redirect-third' and hop==2)
            if redirecting:status=307
            data=bytes([1,2,4]) if mode in ['wrong-hash','redirect-wrong-hash'] else bytes([1,2,3,4]) if mode=='wrong-size' else b'not found' if status==404 else bytes([1,2,3])
            head=f'HTTP/1.1 {status} Test\r\nConnection: close\r\n'.encode()
            if redirecting:
                host='files.example.com' if mode=='redirect-original404' else 'other.example.com'
                extension='.wav' if hop==0 else '.bin' if hop==1 else '.txt'
                target_hash='0'*64 if mode=='redirect-changed-hash' else HASH
                location=f'https://{host}:{port}/{target_hash}{extension}'
                if mode=='redirect-loop':location=f'https://files.example.com:{port}/{HASH}'
                if mode=='redirect-credentials':location=location.replace('https://','https://secret@')
                if mode=='redirect-query':location+='?credential=secret'
                if mode=='redirect-private':location=location.replace(host,'127.0.0.1')
                if mode=='redirect-http':location=location.replace('https:','http:')
                head+=('Location: '+location+'\r\n').encode();data=b''
            if mode=='chunked':response=head+b'Transfer-Encoding: chunked\r\n\r\n3\r\n'+data+b'\r\n0\r\n\r\n'
            else:
                head+=b'Content-Length: '+str(len(data)).encode()+b'\r\n'
                if mode=='ambiguous':head+=b'Content-Length: 2\r\n'
                if mode=='redirect':head+=b'Location: https://other.example.com/unapproved\r\n'
                if mode=='encoding':head+=b'Content-Encoding: gzip\r\n'
                response=head+b'\r\n'+(data[:-1] if mode=='truncated' or mode=='redirect-truncated' and hop else data)+(b'extra' if mode=='trailing' else b'')
            if mode=='cancel-read' or mode=='redirect-cancel' and hop:checkpoint.write_text('GET received');time.sleep(.5)
            peer.sendall(response)
    except (socket.timeout,ssl.SSLError,BrokenPipeError,ConnectionResetError):pass
    except Exception as error:errors.append(repr(error))
    finally:listener.close()

def main():
    with tempfile.TemporaryDirectory(prefix='hg-recovery-tls-') as temporary:
        out=Path(temporary);key,pem,der=certificate(out,'files.example.com,DNS:other.example.com');wrong_key,wrong_pem,wrong_der=certificate(out,'other.example.com')
        names=['NativeSigningHold','UploadFileProfile','UploadPngProfile','UploadPngMetadata','NativeUploadAuthority','UploadRecoveryLedger','UploadRecoveryReadAuthority','UploadRecoveryHttps','PublishedHttpsRequestOwner','PublishedHttpsTransport','PublishedHttpsResponseReader','PublicAddressPolicy']
        subprocess.run(['javac','-Xlint:all','-Werror','-d',str(out),*[str(JAVA/(name+'.java')) for name in names],str(HERE/'UploadRecoveryTLSProof.java')],check=True)
        names=['UploadFileProfile','UploadPngProfile','UploadPngMetadata','NativeUploadAuthority','UploadRecoveryLedger','UploadRecoveryReadAuthority','PublishedHTTPResponse','PublishedPinnedHTTPS','PublicAddressPolicy']
        subprocess.run(['swiftc','-swift-version','6','-D','HYPERGOLIC_NETWORK_PROOF','-warnings-as-errors','-module-cache-path',str(out/'swift-cache'),*[str(SWIFT/(name+'.swift')) for name in names],str(HERE/'UploadRecoveryTLSProof.swift'),'-o',str(out/'swift-proof')],check=True)
        rows=[]
        for language in ['Java','Swift']:
            for mode in ['redirect-valid','redirect-two','redirect-third','redirect-loop','redirect-changed-hash','redirect-credentials','redirect-query','redirect-private','redirect-http','redirect-alternate404','redirect-original404','redirect-wrong-hash','redirect-truncated','redirect-mixed-dns','redirect-cancel','present','chunked','absent','wrong-hash','wrong-size','truncated','trailing','ambiguous','redirect','quota','encoding','cancel-before','cancel-read','mixed-dns','untrusted','wrong-host']:
                listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(1);port=listener.getsockname()[1]
                observed={'connections':0,'gets':0,'puts':0};errors=[]
                endpoint=(wrong_pem,wrong_key,wrong_der) if mode=='wrong-host' else (pem,key,der)
                checkpoint=out/(language+'-'+mode+'.checkpoint')
                server=threading.Thread(target=serve,args=(listener,*endpoint[:2],mode,observed,errors,checkpoint));server.start()
                command=['java','-cp',str(out),'org.nostrocket.hypergolic.host.UploadRecoveryTLSProof',str(port),str(endpoint[0]),mode,str(checkpoint)] if language=='Java' else [str(out/'swift-proof'),str(port),str(endpoint[2]),mode,str(checkpoint)]
                result=json.loads(subprocess.check_output(command,text=True,cwd=ROOT,timeout=12));server.join(6);assert not server.is_alive() and not errors,(language,mode,errors)
                state='present' if mode in ['present','chunked','redirect-valid','redirect-two'] else 'absent' if mode in ['absent','redirect-original404'] else 'unknown'
                assert result['state']==state and result['blocked']==(state=='unknown'),(language,mode,result)
                expected_gets=0 if mode in ['cancel-before','mixed-dns','untrusted','wrong-host'] else 3 if mode in ['redirect-two','redirect-third'] else 2 if mode in ['redirect-valid','redirect-alternate404','redirect-original404','redirect-wrong-hash','redirect-truncated','redirect-cancel'] else 1
                assert observed['gets']==expected_gets,(language,mode,observed)
                assert observed['puts']==0
                rows.append({'language':language,'mode':mode,**result,'observer':observed});print(json.dumps(rows[-1]),flush=True)
        print(json.dumps({'nativeTlsRecoveryCases':len(rows),'failed':0,'scope':'Real fixed-hash TLS reads with injected metadata store; no native app or durable disk proof'}))
if __name__=='__main__':main()
