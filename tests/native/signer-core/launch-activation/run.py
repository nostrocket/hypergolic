#!/usr/bin/env python3
"""Host regression of actual native startup admission, without UIKit/device/storage."""
from pathlib import Path
import argparse, hashlib, json, os, subprocess, sys
sys.dont_write_bytecode = True
parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[4])
parser.add_argument('--session-source', type=Path)
parser.add_argument('--gate-source', type=Path)
parser.add_argument('--output', type=Path, required=True)
a = parser.parse_args(); root = a.root.resolve(); here = Path(__file__).resolve().parent
session = (a.session_source or root/'modules/signer-core/ios/NativeVaultSession.swift').resolve()
gate = (a.gate_source or session).resolve()
mutation = root/'modules/signer-core/ios/NativeVaultMutationGate.swift'
failures = root/'modules/signer-core/ios/NativeVaultKey.swift'
out = a.output.resolve(); out.mkdir(parents=True, exist_ok=False)
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def block(source, marker):
    assert source.count(marker) == 1, marker
    start = source.index(marker); brace = source.index('{', start); depth = 1; end = brace+1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}'); end += 1
    return source[start:end]
receipt = {'passed': False, 'deviceOperations': 0, 'root': str(root), 'sessionSource': str(session), 'gateSource': str(gate)}
try:
    methods = '\n'.join(block(session.read_text(), marker) for marker in [
        '  private func refresh()', '  private func activeEpoch()', '  private func current(', '  private func idle()', '  func open()'])
    adapter = (here/'HostSupport.swift').read_text().replace('  // ACTUAL_SESSION_METHODS', methods)
    (out/'SessionUnderTest.swift').write_text(adapter)
    (out/'NativeVaultFailure.swift').write_text(block(failures.read_text(), 'enum NativeVaultFailure:')+'\n')
    (out/'NativeVaultLaunchGate.swift').write_text('import Foundation\n'+block(gate.read_text(), '@MainActor final class NativeVaultLaunchGate')+'\n')
    inputs = [session, gate, mutation, failures, here/'HostSupport.swift', here/'LaunchActivationTests.swift', Path(__file__)]
    receipt['sourceHashes'] = {str(p): sha(p) for p in inputs}
    developer = Path('/Applications/Xcode.app/Contents/Developer')
    swift = developer/'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc'
    sdk = developer/'Platforms/MacOSX.platform/Developer/SDKs/MacOSX27.0.sdk'
    command = [str(swift), '-swift-version', '6', '-sdk', str(sdk), '-module-cache-path', str(out/'module-cache'),
        str(out/'NativeVaultLaunchGate.swift'), str(mutation), str(out/'NativeVaultFailure.swift'), str(out/'SessionUnderTest.swift'), str(here/'LaunchActivationTests.swift'), '-o', str(out/'launch-tests')]
    receipt['compileCommand'] = command
    result = subprocess.run(command, capture_output=True, timeout=60, env=dict(os.environ, DEVELOPER_DIR=str(developer)))
    (out/'compile.log').write_bytes(result.stdout+result.stderr); receipt['compileExitCode'] = result.returncode
    assert result.returncode == 0, 'Native host compilation failed'
    result = subprocess.run([str(out/'launch-tests')], capture_output=True, timeout=10)
    (out/'test.log').write_bytes(result.stdout+result.stderr); receipt['testExitCode'] = result.returncode
    receipt['result'] = json.loads(result.stdout)
    assert all(sha(Path(p)) == h for p,h in receipt['sourceHashes'].items()), 'Owning source drifted'
    receipt['passed'] = result.returncode == 0 and receipt['result']['passed'] is True
except BaseException as error:
    receipt['error'] = repr(error)
finally:
    receipt['artifactHashes'] = {str(p.relative_to(out)): sha(p) for p in out.rglob('*') if p.is_file() and 'module-cache' not in p.parts}
    (out/'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
    print(json.dumps({k:receipt.get(k) for k in ['passed','compileExitCode','testExitCode','error']}))
sys.exit(0 if receipt['passed'] else 1)
