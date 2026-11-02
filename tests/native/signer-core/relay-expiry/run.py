#!/usr/bin/env python3
"""Extract actual Swift Budget/live logic; explicit host state, no network/device."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import subprocess
import sys

sys.dont_write_bytecode = True
p = argparse.ArgumentParser()
p.add_argument('--source', type=Path, default=Path('modules/napplet-host/ios/NativeSignerRelayTransport.swift'))
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
source = a.source.resolve()
out = a.output.resolve()
out.mkdir(parents=True, exist_ok=False)
source_bytes = source.read_bytes()
source_hash = hashlib.sha256(source_bytes).hexdigest()
runner_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
text = source_bytes.decode('utf-8')

def block(marker):
    assert text.count(marker) == 1, marker
    start = text.index(marker)
    end = text.index('{', start) + 1
    depth = 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]

budget = block('  public final class Budget: Sendable')
live = block('    private func live() -> Bool').replace('private func live()', 'func live()')
harness = '''import Foundation
import Synchronization
enum Transport {
  enum Failure: Error { case unavailable, invalidResponse, expired, cancelled, uncertain }
  static let maximumWireBytes = 32 * 1024 * 1024
  static let maximumFrames = 64
  static let maximumMessages = 32
  BUDGET
  struct Control: Sendable { let budget: Budget; let current: @Sendable () -> Bool }
  final class Operation {
    var ended = false
    var dispatched: Bool
    let deadline: ContinuousClock.Instant
    let control: Control
    let cancellation = Mutex<(cancelled: Bool, connection: Int?)>((false, nil))
    var result: Result<String, Error>?
    init(deadline: ContinuousClock.Instant, dispatched: Bool, budget: Budget = Budget()) {
      self.deadline = deadline; self.dispatched = dispatched
      control = Control(budget: budget, current: { true })
    }
    func finish(_ result: Result<String, Error>) { ended = true; self.result = result }
    LIVE
  }
}
@main struct Tests {
  static func main() {
    var assertions = 0, failures: [String] = []
    func check(_ value: Bool, _ name: String) { assertions += 1; if !value { failures.append(name) } }
    func outcome(_ operation: Transport.Operation, _ expected: Transport.Failure) -> Bool {
      guard case .failure(let error) = operation.result, let actual = error as? Transport.Failure else { return false }
      switch (actual, expected) {
      case (.expired, .expired), (.cancelled, .cancelled), (.uncertain, .uncertain), (.invalidResponse, .invalidResponse): return true
      default: return false
      }
    }
    let expired = ContinuousClock.now.advanced(by: .seconds(-1))
    let pre = Transport.Operation(deadline: expired, dispatched: false)
    check(!pre.live(), "expired pre-send operation is stopped")
    check(outcome(pre, .expired) || outcome(pre, .cancelled), "pre-send expiry remains lifetime denial")
    let post = Transport.Operation(deadline: expired, dispatched: true)
    check(!post.live(), "expired dispatched operation is stopped")
    check(outcome(post, .uncertain), "post-send expiry is uncertain")
    do { try Transport.Budget().accept(deadline: expired); check(false, "expired budget admission fails") }
    catch Transport.Failure.expired { check(true, "expired budget admission retains expiry") }
    catch { check(false, "expired budget admission retains expiry") }
    let poisoned = Transport.Budget(); poisoned.invalidate()
    let malformed = Transport.Operation(deadline: .now.advanced(by: .seconds(60)), dispatched: true, budget: poisoned)
    check(!malformed.live() && outcome(malformed, .invalidResponse), "poisoned live budget remains invalid response")
    let valid = Transport.Operation(deadline: .now.advanced(by: .seconds(60)), dispatched: false)
    check(valid.live() && valid.result == nil, "valid operation remains live")
    let poisonExpired = Transport.Budget(); poisonExpired.invalidate()
    let poisonOperation = Transport.Operation(deadline: expired, dispatched: true, budget: poisonExpired)
    check(!poisonOperation.live() && outcome(poisonOperation, .invalidResponse), "poison wins over expiry in live")
    do { try poisonExpired.accept(deadline: expired); check(false, "poison plus expiry fails") }
    catch Transport.Failure.invalidResponse { check(true, "poison wins over expiry in accept") }
    catch { check(false, "poison wins over expiry in accept") }
    let mismatched = Transport.Budget()
    try! mismatched.accept(deadline: .now.advanced(by: .seconds(60)))
    let mismatchOperation = Transport.Operation(deadline: expired, dispatched: true, budget: mismatched)
    check(!mismatchOperation.live() && outcome(mismatchOperation, .invalidResponse), "mismatched deadline wins over expiry in live")
    do { try mismatched.accept(deadline: expired); check(false, "mismatch plus expiry fails") }
    catch Transport.Failure.invalidResponse { check(true, "mismatch wins over expiry in accept") }
    catch { check(false, "mismatch wins over expiry in accept") }
    do { try Transport.Budget().accept(deadline: expired, wire: -1); check(false, "negative plus expiry fails") }
    catch Transport.Failure.invalidResponse { check(true, "negative charge wins over expiry") }
    catch { check(false, "negative charge wins over expiry") }
    do { try Transport.Budget().accept(deadline: expired, wire: Transport.maximumWireBytes + 1); check(false, "exhaustion plus expiry fails") }
    catch Transport.Failure.invalidResponse { check(true, "capacity violation wins over expiry") }
    catch { check(false, "capacity violation wins over expiry") }
    let exhausted = Transport.Budget()
    do { try exhausted.accept(deadline: .now.advanced(by: .seconds(60)), wire: Transport.maximumWireBytes + 1) } catch {}
    let exhaustedOperation = Transport.Operation(deadline: expired, dispatched: true, budget: exhausted)
    check(!exhaustedOperation.live() && outcome(exhaustedOperation, .invalidResponse), "exhausted sticky budget wins over expiry")
    let result: [String: Any] = ["passed": failures.isEmpty, "assertions": assertions, "failures": failures]
    print(String(decoding: try! JSONSerialization.data(withJSONObject: result, options: .sortedKeys), as: UTF8.self))
    exit(failures.isEmpty ? 0 : 1)
  }
}
'''.replace('BUDGET', budget).replace('LIVE', live)
swift = out / 'ExpiryTests.swift'
swift.write_text(harness)
developer = Path('/Applications/Xcode.app/Contents/Developer')
command = [str(developer / 'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc'),
           '-swift-version', '6', '-parse-as-library', '-sdk',
           str(developer / 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk'),
           '-module-cache-path', str(out / 'module-cache'), str(swift), '-o', str(out / 'expiry-tests')]
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

receipt = {
    'passed': False,
    'source': str(source),
    'sourceSha256': source_hash,
    'runnerSha256': runner_hash,
    'scope': 'actual extracted Budget/live; explicit host operation state; no network/device',
    'compileCommand': command,
}
try:
    compiled = subprocess.run(command, capture_output=True,
                              env=dict(os.environ, DEVELOPER_DIR=str(developer)), timeout=60)
    (out / 'compile.log').write_bytes(compiled.stdout + compiled.stderr)
    receipt['compileExitCode'] = compiled.returncode
    if compiled.returncode != 0:
        raise RuntimeError('Host compilation failed')
    result = subprocess.run([str(out / 'expiry-tests')], capture_output=True, timeout=10)
    (out / 'test.stdout.log').write_bytes(result.stdout)
    (out / 'test.stderr.log').write_bytes(result.stderr)
    receipt['testExitCode'] = result.returncode
    receipt['result'] = json.loads(result.stdout)
    if result.returncode != 0:
        raise RuntimeError('Host tests failed')
    if receipt['result'].get('passed') is not True or receipt['result'].get('assertions') != 14:
        raise RuntimeError('Missing or incomplete host assertions')
    if receipt['result'].get('failures') != []:
        raise RuntimeError('Host assertions reported failures')
    receipt['sourceUnchanged'] = digest(source) == receipt['sourceSha256']
    receipt['runnerUnchanged'] = digest(Path(__file__)) == receipt['runnerSha256']
    if not receipt['sourceUnchanged'] or not receipt['runnerUnchanged']:
        raise RuntimeError('Source or runner changed during verification')
    receipt['passed'] = True
except Exception as error:
    receipt['error'] = str(error)
finally:
    (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'passed': receipt['passed'], 'result': receipt.get('result'),
                      'error': receipt.get('error'), 'receipt': str(out / 'receipt.json')}))
sys.exit(0 if receipt['passed'] else 1)
