#!/usr/bin/env python3
"""Actual owning Swift publication receipts against an independent controlled TLS receiver."""
import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import ssl
import threading
import time

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[3]
spec=importlib.util.spec_from_file_location('tls_core',HERE/'tls_run.py')
tls=importlib.util.module_from_spec(spec);spec.loader.exec_module(tls)
spec=importlib.util.spec_from_file_location('controlled_owner_receiver',HERE/'android_owning_tls_run.py')
receiver=importlib.util.module_from_spec(spec);spec.loader.exec_module(receiver)
MODES=['accepted','accepted-close','rejected','missing','wrong-id','malformed','auth-required',
       'revoke-before-send','trailing-data','trailing-nul','concatenated','oversized-reason','multibyte-overflow',
       'task-cancel-before-send','revoke-after-send','task-cancel-after-send',
       'silent-timeout','slow-notices','notice-flood','oversized-frame'] + tls.INVALID_ACK_MODES


def inputs():
    files=[*(tls.core.IOS/n for n in tls.core.I_NAMES),HERE/'fixtures.json',HERE/'OwnerTLSProof.swift',
           HERE/'OwnerCapacityProof.swift',HERE/'OwnerProofSupport.swift',HERE/'tls_run.py',HERE/'run.py',
           HERE/'android_owning_tls_run.py',Path(__file__)]
    return {str(p.relative_to(ROOT)):tls.digest(p) for p in files}


def after_send_receiver(listener,key,cert,mode,fixture,trace,errors,marker):
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(cert,key)
    try:
        listener.settimeout(12);raw,_=listener.accept();raw.settimeout(12)
        with context.wrap_socket(raw,server_side=True) as peer:
            headers=b''
            while b'\r\n\r\n' not in headers:
                headers+=tls.exact(peer,1);assert len(headers)<8192
            assert headers.startswith(b'GET /fixture HTTP/1.1\r\nHost: relay.example.org:')
            nonce=next(line.split(b':',1)[1].strip() for line in headers.split(b'\r\n')
                       if line.lower().startswith(b'sec-websocket-key:'))
            accept=base64.b64encode(hashlib.sha1(nonce+b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
            trace.append({'phase':'verified-upgrade'})
            peer.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+b'\r\n\r\n')
            wire=tls.read_frame(peer);assert json.loads(wire)==['EVENT',fixture['primary']]
            trace.append({'phase':'exact-event','wire':wire,'sha256':hashlib.sha256(wire.encode()).hexdigest(),'eventId':fixture['primary']['id']})
            marker.write_text('exact EVENT independently observed; no ACK sent\n')
            trace.append({'phase':'after-send-trigger-signalled','mode':mode})
            assert peer.recv(1)==b'','Unexpected additional client data'
            trace.append({'phase':'client-closed-after-trigger'})
    except Exception as error:errors.append(str(error))
    finally:listener.close()


def serve(listener,key,cert,mode,fixture,trace,errors,marker):
    if mode in ['revoke-after-send','task-cancel-after-send']:
        after_send_receiver(listener,key,cert,mode,fixture,trace,errors,marker)
    elif mode in ['silent-timeout','slow-notices','notice-flood','oversized-frame']:
        receiver.controlled_receiver(listener,key,cert,mode,fixture,trace,errors)
    else:
        receiver_mode='revoke-before-send' if mode=='task-cancel-before-send' else mode
        tls.serve(listener,key,cert,receiver_mode,fixture,trace,errors)


def compile_proof(out,name,source):
    binary=out/name
    tls.run(['xcrun','swiftc','-swift-version','6','-D','HYPERGOLIC_NETWORK_PROOF',
             '-warnings-as-errors','-parse-as-library',*(str(tls.core.IOS/n) for n in tls.core.I_NAMES),
             str(HERE/'OwnerProofSupport.swift'),str(HERE/source),'-o',str(binary)],out,name+'-compile')
    return binary


def capacity(out,binary,key,cert,der,fixture,receipt):
    listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(6)
    port=listener.getsockname()[1];trace=[];errors=[]
    ready=out/'capacity-ready.txt';release=out/'capacity-release.txt'
    threads=[threading.Thread(target=receiver.controlled_receiver,
             args=(listener,key,cert,'capacity',fixture,trace,errors,release,index),daemon=True) for index in range(5)]
    def ready_signal():
        end=time.monotonic()+8
        while time.monotonic()<end:
            if sum(row['phase']=='exact-event' for row in list(trace))>=4:
                ready.write_text('four exact EVENTs independently observed; ACKs withheld\n');return
            time.sleep(0.005)
        errors.append('Four exact EVENTs were not observed before readiness deadline')
    signal=threading.Thread(target=ready_signal,daemon=True)
    for thread in threads:thread.start()
    signal.start()
    try:
        tls.run([str(binary),str(port),str(der),'capacity',str(HERE/'fixtures.json'),str(ready),str(release)],out,'capacity')
    finally:
        if not release.exists():release.write_text('release on runner cleanup\n')
        signal.join(timeout=9)
        for thread in threads:thread.join(timeout=13)
        listener.settimeout(0.2)
        try:
            extra,_=listener.accept();extra.close();errors.append('Unexpected extra TCP connection')
        except socket.timeout:pass
        listener.close()
        (out/'capacity-receiver.json').write_text(json.dumps({'observed':trace,'errors':errors},indent=2)+'\n')
    assert not signal.is_alive() and all(not thread.is_alive() for thread in threads) and not errors,errors
    value=json.loads((out/'capacity.log').read_text())
    assert value['status']=='passed' and value['ownerIdle'] is True and value['replayDenied'] is True
    assert len(value['completed'])==4 and value['blocked']['status']=='cancelled-before-send'
    assert value['recovered']['status']=='accepted' and sum(row['phase']=='exact-event' for row in trace)==5
    receipt['capacity']={**value,'eventCount':5,'observed':trace}
    print('PASS swift-owner-capacity-and-recovery',flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
    receipt={'status':'failed','scope':'Controlled host loopback TLS: actual native owner/approval/WSS, public signed fixture, independent exact frames. No device, signer, guest/Expo or public DNS proof.',
             'inputsBefore':inputs(),'runs':[]}
    key=out/'server.key';cert=out/'server.pem';der=out/'server.der'
    try:
        tls.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(key),'-out',str(cert),
                 '-subj','/CN=relay.example.org','-addext','subjectAltName=DNS:relay.example.org',
                 '-addext','extendedKeyUsage=serverAuth','-addext','keyUsage=digitalSignature,keyEncipherment'],out,'certificate')
        tls.run(['openssl','x509','-in',str(cert),'-outform','DER','-out',str(der)],out,'certificate-der')
        binary=compile_proof(out,'owner-proof','OwnerTLSProof.swift')
        capacity_binary=compile_proof(out,'owner-capacity-proof','OwnerCapacityProof.swift')
        receipt['binaries']={binary.name:tls.digest(binary),capacity_binary.name:tls.digest(capacity_binary)}
        fixture=json.loads((HERE/'fixtures.json').read_text())
        for mode in MODES:
            listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(1)
            port=listener.getsockname()[1];trace=[];errors=[];marker=out/(mode+'-after-send.txt')
            thread=threading.Thread(target=serve,args=(listener,key,cert,mode,fixture,trace,errors,marker),daemon=True);thread.start()
            try:
                tls.run([str(binary),str(port),str(der),mode,str(HERE/'fixtures.json'),str(marker)],out,mode)
            finally:
                thread.join(timeout=14)
                if thread.is_alive():listener.close()
                (out/(mode+'-receiver.json')).write_text(json.dumps({'observed':trace,'errors':errors},indent=2)+'\n')
            assert not thread.is_alive() and not errors,(mode,errors)
            value=json.loads((out/(mode+'.log')).read_text())
            event_count=sum(row['phase']=='exact-event' for row in trace)
            assert value['status']=='passed' and value['ownerIdle'] is True
            assert event_count==(0 if mode in ['revoke-before-send','task-cancel-before-send'] else 1)
            assert any(row['phase']=='verified-upgrade' for row in trace)
            if mode in ['silent-timeout','slow-notices']:assert 9000<=value['elapsedMs']<=13000
            if mode in ['revoke-after-send','task-cancel-after-send']:
                assert value['afterSendTrigger'] is True and any(row['phase']=='client-closed-after-trigger' for row in trace)
            receipt['runs'].append({**value,'eventCount':event_count,'observed':trace})
            print('PASS swift-owner-'+mode,flush=True)
        capacity(out,capacity_binary,key,cert,der,fixture,receipt)
        receipt['inputsAfter']=inputs();assert receipt['inputsBefore']==receipt['inputsAfter']
        assert all(tls.digest(out/name)==digest for name,digest in receipt['binaries'].items())
        receipt['status']='passed'
    finally:
        key.unlink(missing_ok=True)
        receipt['logs']={p.name:tls.digest(p) for p in out.glob('*.log')}
        (out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')


if __name__=='__main__':main()
