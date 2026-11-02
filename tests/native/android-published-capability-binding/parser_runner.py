#!/usr/bin/env python3
"""Compile and run the production Android Kotlin capability parser on the host JVM."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
CACHE = ROOT / ".tools/gradle-home/caches/modules-2/files-2.1"

def artifact(group, name, version):
    path = CACHE / group / name / version
    matches = list(path.glob("*/*.jar"))
    if len(matches) != 1:
        raise RuntimeError(f"Expected cached artifact {group}:{name}:{version}")
    return matches[0]

compiler_jars = [
    artifact("org.jetbrains.kotlin", "kotlin-compiler-embeddable", "2.1.20"),
    artifact("org.jetbrains.kotlin", "kotlin-stdlib", "2.1.20"),
    artifact("org.jetbrains.kotlin", "kotlin-script-runtime", "2.1.20"),
    artifact("org.jetbrains.kotlin", "kotlin-reflect", "1.6.10"),
    artifact("org.jetbrains.kotlin", "kotlin-daemon-embeddable", "2.1.20"),
    artifact("org.jetbrains.intellij.deps", "trove4j", "1.0.20200330"),
    artifact("org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.8.0"),
    artifact("org.jetbrains", "annotations", "23.0.0"),
]
COMPILER_CP = ":".join(map(str, compiler_jars))
JSON = artifact("org.json", "json", "20180813")
STDLIB = artifact("org.jetbrains.kotlin", "kotlin-stdlib", "2.1.20")
HOST = ROOT / "modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host"
TEST = ROOT / "modules/napplet-host/android/src/test/kotlin/org/nostrocket/hypergolic/host/CapabilityConfigurationProof.kt"

with tempfile.TemporaryDirectory(prefix="published-capability-parser-") as temp:
    classes = Path(temp) / "classes"
    classes.mkdir()
    subprocess.run(["javac", "-Xlint:all", "-Werror", "-d", str(classes),
                    str(HOST / "PublishedCapabilityBinding.java")], check=True)
    subprocess.run(["java", "-cp", COMPILER_CP, "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
                    "-no-stdlib", "-no-reflect", "-classpath", f"{classes}:{STDLIB}:{JSON}",
                    "-d", str(classes), str(HOST / "CapabilityConfiguration.kt"), str(TEST)], check=True)
    subprocess.run(["java", "-cp", f"{classes}:{STDLIB}:{JSON}",
                    "org.nostrocket.hypergolic.host.CapabilityConfigurationProof"], check=True)
