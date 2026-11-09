#!/usr/bin/env python3
"""Host compiler checks of production app-data policy/config and metadata projection.

No WebView, Expo module, signing operation, socket or device is instantiated.
Extracted production methods are preserved byte-for-byte and hashed in the receipt.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
HOST = ROOT / "modules/napplet-host"

def digest(data):
    return hashlib.sha256(data).hexdigest()

def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

def scope(publisher, identifier):
    return digest(encode(["soy.app-data/1", f"{publisher}:35129:{identifier}"]).encode())

def cases():
    publisher = "3aa5817273c3b2f94f491840e0472f049d0f10009e23de63006166bca9b36ea3"
    identifier = "n-b87c04571a9"
    expected = scope(publisher, identifier)
    assert expected == "a60a5107d883f838352fdab88a81d633d59625e7bde403e17406beddc3386243"
    policy = {"sourceKind": 35129, "policy": {"profile": "soy.app-data/1", "scope": expected,
        "maxContentBytes": 3072, "relays": ["wss://relay.example.com/"], "defaultRelays": ["wss://relay.example.com/"]}}
    base = {"sessionId": "source", "epoch": 2, "user": "1"*64, "publisher": publisher, "appId": identifier,
        "version": "3"*64, "instanceId": "instance", "fixture": "published", "domains": ["identity", "outbox"], "appData": policy}
    rows = []
    def add(name, ok=True, mutate=None, raw=None):
        value = copy.deepcopy(base)
        if mutate:
            mutate(value)
        rows.append({"name": name, "ok": ok, "raw": encode(value) if raw is None else raw,
            "configuration": value})
    add("original-outbreak")
    add("relay-only-grant", mutate=lambda v: v.update(domains=["identity", "relay"]))
    add("both-transport-grants", mutate=lambda v: v.update(domains=["identity", "relay", "outbox"]))
    add("release-update-stable-scope", mutate=lambda v: v.update(version="4"*64))
    add("different-selected-account-stable-scope", mutate=lambda v: v.update(user="5"*64))
    for name, identifier in [("unicode-composed", "nap-é"), ("unicode-decomposed", "nap-e\u0301"),
                             ("quoted-slash-and-astral", 'nap"</script>😀')]:
        def change(value, identifier=identifier):
            value["appId"] = identifier
            value["appData"]["policy"]["scope"] = scope(value["publisher"], identifier)
        add(name, mutate=change)
    for key, replacement in [("publisher", "6"*64), ("appId", "other-app")]:
        add("wrong-"+key, False, lambda v, key=key, replacement=replacement: v.update({key: replacement}))
    for domains in [[], ["outbox"], ["relay"], ["identity"], ["identity", "outbox", "outbox"]]:
        add("invalid-grants-"+"-".join(domains), False, lambda v, domains=domains: v.update(domains=domains))
    add("bundled-profile-denied", False, lambda v: v.update(fixture="feed-lab", domains=["identity", "outbox", "relay", "theme"]))
    add("legacy-no-policy", mutate=lambda v: v.pop("appData"))
    add("legacy-no-identity", mutate=lambda v: (v.pop("appData"), v.update(domains=["relay"])))
    add("guest-generation-field-denied", False, lambda v: v.update(generation="injected"))
    for value in [5129, True, "35129", 35129.5]:
        add("invalid-source-kind-"+str(value), False, lambda v, value=value: v["appData"].update(sourceKind=value))
    for key, value in [("profile", "soy.app-data/2"), ("scope", "0"*64), ("maxContentBytes", 3073),
                       ("maxContentBytes", True), ("maxContentBytes", "3072")]:
        add("invalid-"+key+"-"+str(value), False, lambda v, key=key, value=value: v["appData"]["policy"].update({key:value}))
    add("extra-context-field", False, lambda v: v["appData"].update(granted=True))
    add("extra-policy-field", False, lambda v: v["appData"]["policy"].update(granted=True))
    def peers(value, relays):
        value["appData"]["policy"].update(relays=relays, defaultRelays=relays[:1])
    add("empty-peers", False, lambda v: peers(v, []))
    add("duplicate-peers", False, lambda v: peers(v, ["wss://relay.example.com/"]*2))
    add("eight-peers", mutate=lambda v: peers(v, [f"wss://r{i}.example.com/" for i in range(8)]))
    add("nine-peers", False, lambda v: peers(v, [f"wss://r{i}.example.com/" for i in range(9)]))
    for length in [256, 257, 400]:
        relay = "wss://relay.example.com/" + "x"*(length-len("wss://relay.example.com/"))
        add(f"peer-{length}-bytes", length == 256, lambda v, relay=relay: peers(v, [relay]))
    long_peers = [f"wss://r{i}.example.com/"+"x"*(256-len(f"wss://r{i}.example.com/")) for i in range(8)]
    add("eight-max-length-peers-fit-existing-config", mutate=lambda v: peers(v, long_peers))
    add("wrong-default", False, lambda v: v["appData"]["policy"].update(defaultRelays=["wss://other.example.com/"]))
    add("two-defaults", False, lambda v: v["appData"]["policy"].update(defaultRelays=["wss://relay.example.com/"]*2))
    for name, relay in [("cleartext", "ws://relay.example.com/"), ("credentials", "wss://x@relay.example.com/"),
                        ("query", "wss://relay.example.com/?x=1"), ("fragment", "wss://relay.example.com/#x"),
                        ("backslash", "wss://relay.example.com/\\x"), ("oversize-port", "wss://relay.example.com:65536/")]:
        add("invalid-peer-"+name, False, lambda v, relay=relay: peers(v, [relay]))
    raw = encode(base)
    add("config-at-8192-bytes", raw=raw+" "*(8192-len(raw.encode())))
    add("config-over-8192-bytes", False, raw=raw+" "*(8193-len(raw.encode())))
    # The body is opaque JSON text. Its escaped surrogate must not be interpreted by native policy code.
    body = json.dumps({"schema":"example.level", "version":1, "title":"Unicode", "previous":None,
                       "deleted":False, "data":{"text":"\ud800", "label":"é/😀"}}, ensure_ascii=True, separators=(",", ":"))
    request = encode({"type":"outbox.publish", "id":"record", "event":{"kind":30078, "created_at":1, "tags":[], "content":body}})
    return rows, request

def extract(path, start, end):
    text = path.read_text()
    if text.count(start) != 1:
        raise RuntimeError("Expected exactly one production source marker: "+start)
    offset = text.index(start)
    return text[offset:text.index(end, offset)]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=ROOT/".tools/gradle-home/caches/modules-2/files-2.1")
    parser.add_argument("--checkpoint", type=Path)
    args = parser.parse_args()
    work = args.output.resolve()
    work.mkdir(parents=True, exist_ok=False)
    android = HOST/"android/src/main/java/org/nostrocket/hypergolic/host"
    ios = HOST/"ios"
    if args.checkpoint:
        for entry in json.loads(args.checkpoint.read_text())["files"]:
            assert digest((ROOT/entry["path"]).read_bytes()) == entry["sha256"], entry["path"]
    rows, request = cases()
    (work/"cases.json").write_text(encode({"cases":rows, "request":request})+"\n")
    fragments = {
        "android-metadata": extract(android/"NappletHostView.kt", '            val result = JSONObject().put("type", "artifact.chunk")', "            reply.postMessage(result.toString())"),
        "swift-config": extract(ios/"CapabilityTransport.swift", "struct CapabilityConfiguration {", "/// Lease queries are synchronous"),
    }
    (work/"Projection.kt").write_text('package org.nostrocket.hypergolic.host\nimport org.json.JSONObject\nimport org.json.JSONArray\ninternal object NativeChunkProjection {\n'+
        'data class Claims(val publisher:String,val appId:String,val eventId:String,val version:String,val htmlHash:String)\n'+
        'data class Chunk(val sequence:Int,val base64:String,val byteLength:Int,val totalBytes:Int,val done:Boolean)\n'+
        'fun project(configuration:CapabilityConfiguration?,generation:String):JSONObject {\n'+
        'val claims=Claims(configuration!!.publisher,configuration.appId,"b".repeat(64),configuration.version,"a".repeat(64))\n'+
        'val chunk=Chunk(0,"YQ==",1,1,true)\n'+fragments["android-metadata"]+'return result\n}\n}\n')
    (work/"Configuration.swift").write_text("import Foundation\nimport CoreFoundation\n"+fragments["swift-config"])
    def artifact(group, name, version):
        matches = list((args.cache/group/name/version).glob("*/*.jar"))
        if len(matches) != 1:
            raise RuntimeError(f"Expected pinned cached {group}:{name}:{version}")
        return matches[0]
    compiler = [artifact("org.jetbrains.kotlin", name, "2.1.20") for name in
                ["kotlin-compiler-embeddable", "kotlin-stdlib", "kotlin-script-runtime", "kotlin-daemon-embeddable"]]
    compiler += [artifact("org.jetbrains.kotlin", "kotlin-reflect", "1.6.10"), artifact("org.jetbrains.intellij.deps", "trove4j", "1.0.20200330"),
                 artifact("org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.8.0"), artifact("org.jetbrains", "annotations", "23.0.0")]
    stdlib = artifact("org.jetbrains.kotlin", "kotlin-stdlib", "2.1.20")
    jsonjar = artifact("org.json", "json", "20180813")
    classes = work/"classes"; classes.mkdir()
    runs = []
    def run(name, command):
        with (work/(name+".log")).open("w") as log:
            result = subprocess.run(list(map(str, command)), stdout=log, stderr=subprocess.STDOUT, cwd=ROOT, timeout=180,
                                    env={**os.environ,"CLANG_MODULE_CACHE_PATH":str(work/"clang-cache")})
        runs.append({"name":name,"exitCode":result.returncode})
        if result.returncode:
            raise RuntimeError(f"{name} failed; see {work/(name+'.log')}")
    sources = [android/name for name in ["PublishedCapabilityBinding.java", "CapabilityLeaseRegistry.java", "CapabilityConfiguration.kt", "NativeAppDataPolicy.kt", "NativeCanonicalJSON.kt"]]
    sources += [ios/name for name in ["NativeAppDataPolicy.swift", "NativeCanonicalJSON.swift", "PublishedArtifactRegistry.swift", "PublishedArtifactTransfer.swift", "PublishedArtifactHost.swift"]]
    try:
        run("android-java", ["javac", "-d", classes, *sources[:2]])
        run("android-compile", ["java", "-cp", ":".join(map(str,compiler)), "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect",
            "-classpath", f"{classes}:{stdlib}:{jsonjar}", "-d", classes, *sources[2:5], android/"LegacyReadOnlyContext.kt", work/"Projection.kt", HERE/"PolicyProof.kt"])
        run("android-test", ["java", "-cp", f"{classes}:{stdlib}:{jsonjar}", "org.nostrocket.hypergolic.host.PolicyProof", work/"cases.json"])
        run("swift-compile", ["xcrun", "swiftc", "-swift-version", "6", "-warnings-as-errors", "-parse-as-library", "-module-cache-path", work/"swift-cache",
            *sources[5:], ios/"LegacyReadOnlyContext.swift", work/"Configuration.swift", HERE/"PolicyProof.swift", "-o", work/"swift-proof"])
        run("swift-test", [work/"swift-proof", work/"cases.json"])
    finally:
        receipt = {"scope":"Host-executed production native policy/config and extracted projection checks; no WebView/device/effects", "casesPerPlatform":len(rows),
            "runs":runs,"passed":len(runs)==5 and all(row["exitCode"]==0 for row in runs),
            "sourceHashes":{str(p.relative_to(ROOT)):digest(p.read_bytes()) for p in sources},
            "fragmentHashes":{name:digest(value.encode()) for name,value in fragments.items()}, "fixtureSha256":digest((work/"cases.json").read_bytes()),
            "proofHashes":{p.name:digest(p.read_bytes()) for p in sorted(HERE.iterdir()) if p.is_file()},
            "checkpointSha256":digest(args.checkpoint.read_bytes()) if args.checkpoint else None}
        (work/"receipt.json").write_text(json.dumps(receipt,indent=2)+"\n")
    print(json.dumps(receipt))

if __name__ == "__main__":
    main()
