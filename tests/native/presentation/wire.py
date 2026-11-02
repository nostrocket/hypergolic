#!/usr/bin/env python3
"""Compile the actual native routing carrier parser; this is not a device journey."""
import subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
ios=ROOT/'modules/napplet-host/ios'
with tempfile.TemporaryDirectory(prefix='hg-presentation-wire-') as temp:
 out=Path(temp)
 files=['UploadPngProfile.swift','UploadPngMetadata.swift','UploadFileProfile.swift','NativeUploadAuthority.swift','PublicAddressPolicy.swift','PublishedHTTPResponse.swift','PublishedPinnedHTTPS.swift','UploadWire.swift','CapabilityLeaseRegistry.swift','IdentityListAccess.swift','IdentityListAccessJSON.swift']
 subprocess.run(['xcrun','swiftc','-swift-version','6','-warnings-as-errors',*[str(ios/name) for name in files],str(ROOT/'tests/native/presentation/WireDepthTests.swift'),'-o',str(out/'proof')],check=True)
 subprocess.run([str(out/'proof')],check=True)

 with open(out/'RoutingWireBoundsProof.java','w') as proof:
  proof.write('package org.nostrocket.hypergolic.host;\npublic final class RoutingWireBoundsProof {\n public static void main(String[] args) {\n  int count=0;\n  for (int depth : new int[]{12,13,40,41}) {\n   String raw="[".repeat(depth)+"0"+"]".repeat(depth);\n   if(UploadJsonBounds.accepts(raw,1000)!=(depth<=12))throw new AssertionError("upload depth");count++;\n   if(UploadJsonBounds.accepts(raw,1000,40)!=(depth<=40))throw new AssertionError("routing depth");count++;\n  }\n  for(int invalid:new int[]{0,41}){if(UploadJsonBounds.accepts("{}",100,invalid))throw new AssertionError("invalid limit");count++;}\n  if(UploadJsonBounds.accepts("é".repeat(513),1024,40))throw new AssertionError("bytes");count++;\n  System.out.println("Android real UploadJsonBounds "+count+" routing/upload assertions passed");\n }\n}\n')
 android=ROOT/'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host'
 subprocess.run(['javac','-d',str(out),str(android/'UploadJsonBounds.java'),str(out/'RoutingWireBoundsProof.java')],check=True)
 subprocess.run(['java','-cp',str(out),'org.nostrocket.hypergolic.host.RoutingWireBoundsProof'],check=True)
