#!/usr/bin/env python3
"""Owning host Java/Swift resource-boundary proofs; these do not prove WebView/device execution."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
ANDROID = ROOT / 'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host'
IOS = ROOT / 'modules/napplet-host/ios'
HERE = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='hypergolic-resource-proof-') as temporary:
    out = Path(temporary)
    java = ['CapabilityLeaseRegistry', 'ResourceHttpsRequestOwner', 'PublishedHttpsRequestOwner',
            'PublishedHttpsTransport', 'PublishedHttpsResponseReader', 'PublicAddressPolicy']
    subprocess.run(['javac', '-Xlint:all', '-Werror', '-d', str(out),
                    *[str(ANDROID / (name+'.java')) for name in java], str(HERE/'ResourceOwnerProof.java')], check=True)
    subprocess.run(['java', '-cp', str(out), 'org.nostrocket.hypergolic.host.ResourceOwnerProof'], check=True)
    subprocess.run(['swiftc', '-swift-version', '6', '-warnings-as-errors', '-module-cache-path', str(out/'swift-cache'),
                    *[str(IOS/(name+'.swift')) for name in ['CapabilityLeaseRegistry','PublishedHTTPResponse']],
                    str(HERE/'ResourceProfileProof.swift'), '-o', str(out/'swift-proof')], check=True)
    subprocess.run([str(out/'swift-proof')], check=True)
