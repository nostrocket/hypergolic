#!/usr/bin/env python3
"""Compile actual native endpoint authority cores. This is not a device journey."""
import subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
with tempfile.TemporaryDirectory(prefix='hg-routing-core-') as tmp:
    out=Path(tmp);android=ROOT/'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host';ios=ROOT/'modules/napplet-host/ios';tests=ROOT/'tests/native/routing'
    subprocess.run(['javac','-d',str(out),str(android/'RoutingEndpointRegistry.java'),str(tests/'RoutingCoreTests.java')],check=True)
    subprocess.run(['java','-cp',str(out),'org.nostrocket.hypergolic.host.RoutingCoreTests'],check=True)
    subprocess.run(['xcrun','swiftc',str(ios/'RoutingEndpointRegistry.swift'),str(tests/'RoutingCoreTests.swift'),'-o',str(out/'ios-proof')],check=True)
    subprocess.run([str(out/'ios-proof')],check=True)
