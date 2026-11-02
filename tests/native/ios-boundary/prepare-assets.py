"""Prepare the exact verified fixture bundle; no build, install, network or simulator actions."""
from pathlib import Path
import hashlib,json,plistlib
HERE=Path(__file__).resolve().parent
REPO=HERE.parents[2]
def digest(data):return hashlib.sha256(data).hexdigest()
def prepare():
 expected=json.loads((HERE/'expected-runtime.json').read_text())
 native=REPO/'modules/napplet-host/ios'
 assert digest((native/'RestrictedNappletHost.swift').read_bytes())==expected['coreSha256'],'Owning core changed: review and rebaseline boundary tests'
 assert digest((native/'NappletHostView.swift').read_bytes())==expected['wrapperSha256'],'Expo wrapper changed: review integration scope'
 for name,key in [('CapabilityLeaseRegistry.swift','leaseSha256'),('CapabilityTransport.swift','transportSha256')]:
  assert digest((native/name).read_bytes())==expected[key],'Native capability authority changed: review boundary tests'
 for name,key in [('NativeApprovalAuthority.swift','approvalAuthoritySha256'),('ApprovalTransport.swift','approvalTransportSha256')]:
  assert digest((native/name).read_bytes())==expected[key],'Native approval authority changed: review boundary tests'
 inputs={name:(native/'Resources/runtime'/name).read_bytes() for name in ['index.html','host.js','assets-manifest.json']}
 assert digest(inputs['assets-manifest.json'])==expected['manifestSha256'],'Runtime manifest changed: review fixture scope'
 manifest=json.loads(inputs['assets-manifest.json']);assert manifest['assets']==expected['assets'];assert manifest['fixture']==expected['fixture'];assert manifest['fixtures']==expected['fixtures']
 assert set(manifest['assets'])=={'index.html','host.js'}
 for name,record in manifest['assets'].items():
  assert digest(inputs[name])==record['sha256'];assert len(inputs[name])==record['bytes']
 bundle=HERE/'Resources/HypergolicNappletHostAssets.bundle';bundle.mkdir(parents=True,exist_ok=True)
 for name,data in inputs.items(): (bundle/name).write_bytes(data)
 # Local signed fixture: signature/HTML verification is performed by the owning JS verifier before this native component proof.
 fixture=(REPO/'runtime/fixtures/ux-lab.html').read_bytes()
 signed=(HERE/'Fixtures/published-outbox-manifest.json').read_bytes()
 event=json.loads(signed);tags=event['tags']
 assert digest(signed)==expected['publishedOutboxManifestSha256']
 assert digest(fixture)==next(t[2] for t in tags if t[0]=='path' and t[1]=='/index.html')
 assert digest((digest(fixture)+' /index.html\n').encode())==next(t[1] for t in tags if t[0]=='x' and t[2]=='aggregate')
 (bundle/'published-outbox.html').write_bytes(fixture)
 (bundle/'published-outbox-manifest.json').write_bytes(signed)
 (bundle/'published-stream-event.json').write_bytes((REPO/'tests/native/feed-query/events.json').read_bytes())
 (bundle/'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'org.nostrocket.hypergolic.boundaryassets','CFBundleName':'HypergolicNappletHostAssets','CFBundlePackageType':'BNDL','CFBundleVersion':'1'}))
 print('Prepared verified native resource bundle from owning source; no device action.')
if __name__=='__main__':prepare()
