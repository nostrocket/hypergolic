#!/usr/bin/env python3
"""Compile the actual native view defer selectors with their production configurations.
No WebView, Expo module, socket or device is instantiated. Method bodies are
extracted byte-for-byte into a test wrapper with their existing private visibility.
"""
from pathlib import Path
import hashlib
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
HOST = ROOT / "modules/napplet-host"
CACHE = ROOT / ".tools/gradle-home/caches/modules-2/files-2.1"

def artifact(group, name, version):
    rows = list((CACHE / group / name / version).glob("*/*.jar"))
    if len(rows) != 1:
        raise RuntimeError(f"Expected cached {group}:{name}:{version}")
    return rows[0]

def method(path, start, end):
    text = path.read_text()
    body = text[text.index(start):text.index(end, text.index(start))]
    return body

def run(args):
    subprocess.run(list(map(str,args)),check=True)

android = HOST / "android/src/main/java/org/nostrocket/hypergolic/host"
ios = HOST / "ios"
kotlin = method(android / "NappletHostView.kt", "  private fun mayDeferCapability(", "  private fun receiveCapability(")
swift = method(ios / "RestrictedNappletHost.swift", "  private func mayDeferCapability(", "  private func receiveCapability(")
# The same test cases exercise each actual selector and the actual trusted config parser.
config = {"sessionId":"source","epoch":0,"user":"1"*64,"publisher":"2"*64,"appId":"proof",
          "version":"3"*64,"instanceId":"instance","fixture":"published","domains":["outbox"]}
cases = []
for domains in [["outbox"],["relay"],[],["outbox","relay"]]:
    for operation in ["outbox.query","outbox.getEvent","outbox.resolveRelays","outbox.publish","outbox.subscribe","outbox.close","outbox.query.result"]:
        cases.append(({"type":operation,"id":"read"},domains, "outbox" in domains and operation in ["outbox.query","outbox.getEvent","outbox.resolveRelays"]))
for request in [{"type":"outbox.query","id":""},{"type":"outbox.query","id":"x"*129},{"type":"outbox.query","id":1},{"id":"read"}]:
    cases.append((request,["outbox"],False))
with tempfile.TemporaryDirectory(prefix="defer-selector-") as temp:
    work=Path(temp);classes=work/"classes";classes.mkdir()
    encoded=json.dumps(cases,separators=(",",":"))
    kt=work/"DeferSelectorProof.kt"
    kt.write_text('package org.nostrocket.hypergolic.host\nimport org.json.JSONObject\nimport org.json.JSONArray\nobject DeferSelectorProof {\n'+kotlin+
      '@JvmStatic fun main(args:Array<String>){\nval rows=JSONArray('+json.dumps(encoded)+')\nfor(i in 0 until rows.length()){val row=rows.getJSONArray(i);val raw=JSONObject('+json.dumps(json.dumps(config))+');raw.put("domains",row.getJSONArray(1));val config=CapabilityConfiguration(raw.toString(),"generation",true);check(mayDeferCapability(row.getJSONObject(0),config)==row.getBoolean(2)){"selector case $i"}}\nprintln("Android defer selector: ${rows.length()} assertions passed")\n}}')
    compiler=[artifact("org.jetbrains.kotlin",name,"2.1.20") for name in ["kotlin-compiler-embeddable","kotlin-stdlib","kotlin-script-runtime","kotlin-daemon-embeddable"]]
    compiler += [artifact("org.jetbrains.kotlin","kotlin-reflect","1.6.10"),artifact("org.jetbrains.intellij.deps","trove4j","1.0.20200330"),artifact("org.jetbrains.kotlinx","kotlinx-coroutines-core-jvm","1.8.0"),artifact("org.jetbrains","annotations","23.0.0")]
    stdlib=artifact("org.jetbrains.kotlin","kotlin-stdlib","2.1.20");jsonjar=artifact("org.json","json","20180813")
    run(["javac","-d",classes,android/"PublishedCapabilityBinding.java",android/"CapabilityLeaseRegistry.java"])
    run(["java","-cp",":".join(map(str,compiler)),"org.jetbrains.kotlin.cli.jvm.K2JVMCompiler","-no-stdlib","-no-reflect","-classpath",f"{classes}:{stdlib}:{jsonjar}","-d",classes,android/"NativeCanonicalJSON.kt",android/"NativeAppDataPolicy.kt",android/"CapabilityConfiguration.kt",android/"LegacyReadOnlyContext.kt",kt])
    run(["java","-cp",f"{classes}:{stdlib}:{jsonjar}","org.nostrocket.hypergolic.host.DeferSelectorProof"])
    proof=work/"DeferSelectorProof.swift"
    proof.write_text('import Foundation\n@main struct DeferSelectorProof {\n'+swift+
      'static func main() throws {\nlet rows = try JSONSerialization.jsonObject(with: Data('+json.dumps(encoded)+'.utf8)) as! [[Any]]\nfor (index,row) in rows.enumerated(){var config = try JSONSerialization.jsonObject(with: Data('+json.dumps(json.dumps(config))+'.utf8)) as! [String:Any];config["domains"]=row[1];let raw=String(decoding:try JSONSerialization.data(withJSONObject:config),as:UTF8.self);let configuration=try CapabilityConfiguration(raw,generation:"generation");let message=String(decoding:try JSONSerialization.data(withJSONObject:row[0]),as:UTF8.self);precondition(DeferSelectorProof().mayDeferCapability(message,configuration:configuration)==(row[2] as! Bool),"selector case \(index)")}\nprint("Swift defer selector: \(rows.count) assertions passed")\n}}')
    run(["xcrun","swiftc","-swift-version","6","-warnings-as-errors","-parse-as-library","-module-cache-path",work/"swift-module-cache",ios/"NativeCanonicalJSON.swift",ios/"NativeAppDataPolicy.swift",ios/"CapabilityLeaseRegistry.swift",ios/"CapabilityTransport.swift",ios/"LegacyReadOnlyContext.swift",*[ios/name for name in ["UploadPngProfile.swift","UploadPngMetadata.swift","UploadFileProfile.swift","NativeUploadAuthority.swift","PublicAddressPolicy.swift","PublishedHTTPResponse.swift","PublishedPinnedHTTPS.swift","UploadWire.swift"]],proof,"-o",work/"swift-proof"])
    run([work/"swift-proof"])
print(json.dumps({"androidSelectorSha256":hashlib.sha256(kotlin.encode()).hexdigest(),"swiftSelectorSha256":hashlib.sha256(swift.encode()).hexdigest(),"casesPerPlatform":len(cases)}))
