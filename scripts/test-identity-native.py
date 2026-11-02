#!/usr/bin/env python3
"""Compile the owning native modules; generate disposable SwiftPM links only in the build directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_check(source_root, suite, frozen):
    manifest = json.loads((suite / "source-manifest.json").read_text())
    actual_sources = {path.relative_to(source_root).as_posix()
                      for module in ["identity-owner", "identity-store"]
                      for path in (source_root / "modules" / module / "ios").glob("*.swift")}
    if frozen and actual_sources != set(manifest["sources"]):
        raise RuntimeError("Frozen native source file set changed")
    changed = []
    for relative, expected in manifest["sources"].items():
        path = source_root / relative
        if not path.is_file() or path.is_symlink() or path.resolve() != path.absolute():
            raise RuntimeError(f"Owning native source is missing or redirected: {relative}")
        if digest(path) != expected:
            changed.append(relative)
    for name, expected in manifest["testSourceSha256"].items():
        path = suite / "Tests" / name
        if not path.is_file() or path.is_symlink():
            raise RuntimeError(f"Test source is missing or redirected: {name}")
        if frozen and digest(path) != expected:
            raise RuntimeError(f"Frozen test source changed: {name}")
    if frozen and changed:
        raise RuntimeError("Frozen native source changed: " + ", ".join(changed))
    return {"owningNativeFiles": len(manifest["sources"]), "nativeFilesChangedSinceFrozenReview": len(changed), "sourcePolicyCopies": 0}


def exact_link(link, destination):
    expected = os.path.relpath(destination, link.parent)
    if link.is_symlink():
        if os.readlink(link) != expected or link.resolve() != destination.resolve():
            raise RuntimeError("Existing generated link points at another source; use a fresh build directory")
    elif link.exists():
        raise RuntimeError("Generated package path contains a real source copy; use a fresh build directory")
    else:
        link.symlink_to(expected, target_is_directory=True)


def run(source_root, suite, build_root):
    package = build_root / "package"
    (package / "Sources").mkdir(parents=True, exist_ok=True)
    exact_link(package / "Sources" / "IdentityOwner", source_root / "modules/identity-owner/ios")
    exact_link(package / "Sources" / "IdentityStore", source_root / "modules/identity-store/ios")
    exact_link(package / "Tests", suite / "Tests")
    (package / "Package.swift").write_bytes((suite / "Package.swift.template").read_bytes())
    env = dict(os.environ)
    env["CLANG_MODULE_CACHE_PATH"] = str(build_root / "clang-cache")
    env["SWIFTPM_MODULECACHE_OVERRIDE"] = str(build_root / "swift-module-cache")
    command = ["xcrun", "swift", "test", "--package-path", str(package),
               "--scratch-path", str(build_root / "build"), "--cache-path", str(build_root / "cache"),
               "--config-path", str(build_root / "config"), "--security-path", str(build_root / "security")]
    result = subprocess.run(command, env=env)
    if (package / "Package.resolved").exists():
        raise RuntimeError("Unexpected dependency lockfile: this suite declares no external dependencies")
    return result.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-only", action="store_true", help="read-only ownership/source check")
    parser.add_argument("--check-frozen", action="store_true", help="also require the originally reviewed native/test hashes")
    parser.add_argument("--source-root", type=Path, help="optional production checkout for pre-integration review")
    parser.add_argument("--build-root", type=Path, help="optional disposable build directory; defaults to ignored .tools")
    args = parser.parse_args()
    checkout = Path(__file__).resolve().parent.parent
    source_root = (args.source_root or checkout).resolve()
    suite = checkout / "tests/native/identity-unit"
    result = source_check(source_root, suite, args.check_frozen)
    print(json.dumps(result), flush=True)
    if args.check_only:
        return 0
    build_root = (args.build_root or checkout / ".tools/identity-native-tests").resolve()
    if source_root == build_root or (source_root in build_root.parents and build_root.relative_to(source_root).parts[0] != ".tools"):
        raise RuntimeError("Build output inside production source must be under ignored .tools")
    return run(source_root, suite, build_root)


if __name__ == "__main__":
    raise SystemExit(main())
