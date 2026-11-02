#!/usr/bin/env python3
"""Actual pong/masking bodies with explicit host RNG, budget and connection ports."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import subprocess
import sys

sys.dont_write_bytecode = True
parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, default=Path('modules/napplet-host/ios/NativeSignerRelayTransport.swift'))
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
source = args.source.resolve()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
source_bytes = source.read_bytes()
source_hash = hashlib.sha256(source_bytes).hexdigest()
runner_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
text = source_bytes.decode('utf-8')

ping_marker = '        case .ping(let data):'
assert text.count(ping_marker) == 1, 'Missing or ambiguous pong path'
start = text.index(ping_marker) + len(ping_marker)
end = text.index('        case .pong:', start)
ping = text[start:end]
mask_marker = '    private static func masked('
assert text.count(mask_marker) == 1, 'Missing or ambiguous masking method'
start = text.index(mask_marker)
end = text.index('    private func finish(', start)
masked = text[start:end]

harness = '''import Foundation
import Synchronization
let rngSuccess = Mutex(false)
let kSecRandomDefault = 0
let errSecSuccess: Int32 = 0
func SecRandomCopyBytes(_ random: Int, _ count: Int, _ bytes: UnsafeMutableRawPointer) -> Int32 { if rngSuccess.withLock({$0}) { bytes.initializeMemory(as: UInt8.self,repeating: 0,count: count); return 0 }; return -1 }
enum Transport {
 static let maximumTextBytes = 6_992_652
 enum Failure: Error { case unavailable, invalidResponse, expired, uncertain }
 final class Budget { var failure: Failure?; func accept(deadline: ContinuousClock.Instant, wire: Int, frames: Int) throws { if let failure { throw failure } } }
 struct Control { let budget = Budget() }
 final class Connection {
  enum Completion { case contentProcessed((Error?) -> Void) }
  var sends = 0
  func send(content: Data, completion: Completion) { sends += 1 }
 }
 final class Operation {
  let control = Control(); let connection = Connection(); let deadline = ContinuousClock.now.advanced(by:.seconds(60))
  var result: Result<String,Error>?
  func finish(_ value:Result<String,Error>) {result=value}
  MASKED
  func ping(_ data: Data) { PING }
 }
}
@main struct Tests {
 static func main() {
  var failures:[String]=[]
  let unavailable = Transport.Operation(); unavailable.ping(Data([1]))
  if case .failure(Transport.Failure.invalidResponse) = unavailable.result {} else { failures.append("pong RNG failure must not escape as retryable unavailable") }
  if unavailable.connection.sends != 0 {failures.append("rng failure must send no pong")}
  rngSuccess.withLock {$0=true}
  let expired = Transport.Operation(); expired.control.budget.failure = .expired; expired.ping(Data([1]))
  if case .failure(Transport.Failure.expired) = expired.result {} else { failures.append("pong budget expiry must preserve lifetime classification") }
  if expired.connection.sends != 0 {failures.append("expired budget must send no pong")}
  let invalid = Transport.Operation(); invalid.control.budget.failure = .invalidResponse; invalid.ping(Data([1]))
  if case .failure(Transport.Failure.invalidResponse) = invalid.result {} else { failures.append("pong exhausted budget must remain invalid") }
  print(String(decoding:try! JSONSerialization.data(withJSONObject:["passed":failures.isEmpty,"assertions":5,"failures":failures],options:.sortedKeys),as:UTF8.self));exit(failures.isEmpty ? 0 : 1)
 }
}
'''.replace('MASKED', masked).replace('PING', ping)

swift = out / 'PongTests.swift'
swift.write_text(harness)
developer = Path('/Applications/Xcode.app/Contents/Developer')
command = [str(developer / 'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc'),
           '-swift-version', '6', '-parse-as-library', '-sdk',
           str(developer / 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk'),
           '-module-cache-path', str(out / 'module-cache'), str(swift), '-o', str(out / 'pong-tests')]

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

receipt = {
    'passed': False,
    'source': str(source),
    'sourceSha256': source_hash,
    'runnerSha256': runner_hash,
    'scope': 'actual extracted pong/masked; host RNG,budget,connection ports; no network/device',
    'compileCommand': command,
}
try:
    compiled = subprocess.run(command, capture_output=True,
                              env=dict(os.environ, DEVELOPER_DIR=str(developer)), timeout=60)
    (out / 'compile.log').write_bytes(compiled.stdout + compiled.stderr)
    receipt['compileExitCode'] = compiled.returncode
    if compiled.returncode != 0:
        raise RuntimeError('Host compilation failed')
    result = subprocess.run([str(out / 'pong-tests')], capture_output=True, timeout=10)
    (out / 'test.stdout.log').write_bytes(result.stdout)
    (out / 'test.stderr.log').write_bytes(result.stderr)
    receipt['testExitCode'] = result.returncode
    receipt['result'] = json.loads(result.stdout)
    if result.returncode != 0:
        raise RuntimeError('Host tests failed')
    if receipt['result'].get('passed') is not True or receipt['result'].get('assertions') != 5:
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
