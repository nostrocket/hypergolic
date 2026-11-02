#!/usr/bin/env python3
"""Compile actual trusted fixture authority cores; no UI, TLS or protected-signing claim."""
from pathlib import Path
import subprocess,tempfile
root=Path(__file__).resolve().parents[3]
a=root/'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host'
i=root/'modules/napplet-host/ios'
here=Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='hypergolic-fixture-release-') as name:
 out=Path(name)
 java=['NativeSigningHold','UploadFileProfile','UploadPngProfile','UploadExifMetadata','UploadPngMetadata','NativeUploadAuthority','NativeApprovalAuthority','FixtureReleaseAuthority','UploadRecoveryLedger','UploadRecoveryReadAuthority']
 subprocess.run(['javac','-Xlint:all','-Werror','-d',str(out),*[str(a/(file+'.java')) for file in java],str(here/'FixtureReleaseProof.java')],check=True)
 subprocess.run(['java','-cp',str(out),'org.nostrocket.hypergolic.host.FixtureReleaseProof'],check=True)
 swift=['UploadPngProfile','UploadPngMetadata','UploadFileProfile','NativeUploadAuthority','NativeApprovalAuthority','FixtureReleaseAuthority','UploadRecoveryLedger','UploadRecoveryReadAuthority']
 subprocess.run(['swiftc','-swift-version','6','-warnings-as-errors','-module-cache-path',str(out/'cache'),*[str(i/(file+'.swift')) for file in swift],str(here/'FixtureReleaseProof.swift'),'-o',str(out/'proof')],check=True)
 subprocess.run([str(out/'proof')],check=True)
