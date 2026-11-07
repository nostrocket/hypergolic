#!/usr/bin/env python3
"""Network-free parser/owner checks and owned loopback TLS; no public endpoint or device operation."""
from pathlib import Path
import os,subprocess,tempfile
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[2]
ANDROID=ROOT/'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host';IOS=ROOT/'modules/napplet-host/ios'
JDK=Path(os.environ['JAVA_HOME'])/'bin' if 'JAVA_HOME' in os.environ else Path('/usr/bin')
def run(args):subprocess.run(list(map(str,args)),check=True,timeout=90)
with tempfile.TemporaryDirectory(prefix='hypergolic-live-mp3-') as name:
 out=Path(name)
 sources=['PublicAddressPolicy','PublishedHttpsTransport','PublishedHttpsResponseReader','LiveMP3Budget','LiveMP3Headers','LiveMP3Response','LiveMP3Gate','LiveMP3Buffer','LiveMP3Owner','MediaPlaybackReservation','LiveMP3Cleanup','LiveMP3HTTPS']
 proofs=['LiveMP3ResponseProof','LiveMP3OwnerProof','LiveMP3BufferProof','LiveMP3CleanupProof','LiveMP3TLSProof']
 run([JDK/'javac','-Xlint:all','-Werror','-d',out,*[ANDROID/(n+'.java') for n in sources],*[HERE/(n+'.java') for n in proofs],ROOT/'tests/native/android-published-https/PublishedHttpsTlsProof.java'])
 for proof in proofs[:-1]:run([JDK/'java','-Xmx64m','-cp',out,'org.nostrocket.hypergolic.host.'+proof])
 cert=out/'server.pem';key=out/'server.key';p12=out/'server.p12'
 subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(key),'-out',str(cert),'-subj','/CN=napplets.example.org','-addext','subjectAltName=DNS:napplets.example.org'],check=True,capture_output=True)
 subprocess.run(['openssl','pkcs12','-export','-inkey',str(key),'-in',str(cert),'-out',str(p12),'-passout','pass:temporary-proof'],check=True,capture_output=True)
 run([JDK/'java','-cp',out,'org.nostrocket.hypergolic.host.LiveMP3TLSProof',cert,p12])
 for proof,sources in [('LiveMP3ResponseProof',['LiveMP3Budget','LiveMP3Response','PublishedHTTPResponse']),('LiveMP3GateProof',['LiveMP3Gate']),('LiveMP3OwnerProof',['LiveMP3Budget','LiveMP3Owner'])]:
  executable=out/proof
  run(['swiftc','-swift-version','6','-module-cache-path',out/'swiftcache',*[IOS/(n+'.swift') for n in sources],HERE/(proof+'.swift'),'-o',executable]);run([executable])

 # Use the unchanged production configuration struct, excluding only unrelated UIKit lifecycle and transport declarations.
 production=(IOS/'CapabilityTransport.swift').read_text()
 start='struct CapabilityConfiguration {';end='/// Lease queries are synchronous across threads;'
 assert production.count(start)==1 and production.count(end)==1
 configuration=out/'CapabilityConfiguration.swift'
 configuration.write_text('import Foundation\nimport CoreFoundation\n'+start+production.split(start,1)[1].split(end,1)[0])
 executable=out/'LiveMP3ConfigurationProof'
 run(['swiftc','-swift-version','6','-module-cache-path',out/'swiftcache',IOS/'NativeCanonicalJSON.swift',IOS/'NativeAppDataPolicy.swift',configuration,HERE/'LiveMP3ConfigurationProof.swift','-o',executable]);run([executable])
