"""Build or explicitly run an isolated, source-owning iOS file-policy XCTest probe."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess

HERE = Path(__file__).resolve().parent
BUNDLE_ID = 'org.nostrocket.hypergolic.filepolicyprobe'
PRODUCTION = ('modules/identity-store/ios/Contracts.swift', 'modules/identity-store/ios/ExcludedAtomicFiles.swift')
HARNESS = ('App/AppDelegate.swift', 'Tests/SystemFilePolicyTests.swift', 'Templates/project.json',
           'Templates/FilePolicyProbe.xcscheme', 'source-manifest.json', 'runner.py')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inputs(repo):
    expected = json.loads((HERE / 'source-manifest.json').read_text())['files']
    current = {}
    for name in PRODUCTION:
        path = repo / name
        if path.is_symlink() or not path.is_file():
            raise RuntimeError('Missing regular owning production source: ' + name)
        current[name] = digest(path)
    if current != expected:
        raise RuntimeError('Owning source changed; review and update source-manifest.json explicitly before building')
    return {'production': current, 'harness': {name: digest(HERE / name) for name in HARNESS}}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def project_value(value):
    if isinstance(value, dict):
        return '{ ' + ' '.join(json.dumps(key) + ' = ' + project_value(item) + ';' for key, item in value.items()) + ' }'
    if isinstance(value, list):
        return '(' + ', '.join(project_value(item) for item in value) + ')'
    return json.dumps(str(value))


def prepare_project(output, repo):
    project = output / 'FilePolicyProbe.xcodeproj'
    schemes = project / 'xcshareddata/xcschemes'
    schemes.mkdir(parents=True)
    template = (HERE / 'Templates/project.json').read_text()
    for token, path in {
        '@APP_SOURCE@': HERE / 'App/AppDelegate.swift',
        '@TEST_SOURCE@': HERE / 'Tests/SystemFilePolicyTests.swift',
        '@CONTRACTS_SOURCE@': repo / PRODUCTION[0],
        '@FILES_SOURCE@': repo / PRODUCTION[1],
    }.items():
        template = template.replace(json.dumps(token), json.dumps(os.path.relpath(path, output)))
    (project / 'project.pbxproj').write_text('// !$*UTF8*$!\n' + project_value(json.loads(template)) + '\n')
    (schemes / 'FilePolicyProbe.xcscheme').write_bytes((HERE / 'Templates/FilePolicyProbe.xcscheme').read_bytes())
    return project


def tree_manifest(root):
    result = {}
    for path in sorted(root.rglob('*')):
        relative = str(path.relative_to(root))
        if path.is_symlink():
            if not path.resolve().is_relative_to(root.resolve()):
                raise RuntimeError('Product symlink escapes its app bundle')
            result[relative] = {'symlink': os.readlink(path)}
        elif path.is_file():
            result[relative] = {'sha256': digest(path)}
    return result


def generated_targets(document):
    if 'TestConfigurations' in document:
        return [target for config in document['TestConfigurations'] for target in config['TestTargets']]
    return [value for key, value in document.items() if not key.startswith('__') and isinstance(value, dict)]


def validate_xctestrun(path, app):
    document = plistlib.loads(path.read_bytes())
    targets = generated_targets(document)
    if len(targets) != 1:
        raise RuntimeError('Expected exactly one owned XCTest target')
    target = targets[0]
    expected_host = '__TESTROOT__/' + app.parent.name + '/FilePolicyProbe.app'
    if target.get('TestHostPath') != expected_host:
        raise RuntimeError('Generated XCTest host does not point to this probe')
    if target.get('TestHostBundleIdentifier') != BUNDLE_ID or target.get('DependentProductPaths') != [expected_host, expected_host + '/PlugIns/FilePolicyTests.xctest']:
        raise RuntimeError('Generated XCTest dependencies extend outside the owned probe')
    if target.get('TestBundlePath') != '__TESTHOST__/PlugIns/FilePolicyTests.xctest':
        raise RuntimeError('Generated XCTest bundle is not the owned file-policy suite')
    if target.get('IsUITestBundle') is True or target.get('OnlyTestIdentifiers') or target.get('SkipTestIdentifiers'):
        raise RuntimeError('Unexpected UI target or test filters')
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != BUNDLE_ID:
        raise RuntimeError('Unexpected probe app identifier')


def environment():
    return dict(os.environ, DEVELOPER_DIR=os.environ.get('DEVELOPER_DIR', '/Applications/Xcode.app/Contents/Developer'))


def build(args):
    repo, output = args.source_root.resolve(), args.output.resolve()
    before = inputs(repo)
    if output.is_relative_to(HERE) or output.is_relative_to(repo) and not output.is_relative_to(repo / '.tools'):
        raise RuntimeError('Build output must stay outside source or inside the ignored .tools directory')
    output.mkdir(parents=True, exist_ok=False)
    project = prepare_project(output, repo)
    destination = 'generic/platform=iOS Simulator' if args.platform == 'simulator' else 'generic/platform=iOS'
    command = ['xcodebuild', 'build-for-testing', '-project', str(project), '-scheme', 'FilePolicyProbe',
               '-configuration', 'Debug', '-destination', destination, '-derivedDataPath', str(output / 'derived')]
    if args.team:
        if args.platform != 'device' or not re.fullmatch(r'[A-Z0-9]{10}', args.team):
            raise RuntimeError('A signing team is only valid for a physical-device build')
        command += ['CODE_SIGNING_ALLOWED=YES', 'CODE_SIGN_STYLE=Automatic', 'DEVELOPMENT_TEAM=' + args.team]
    else:
        command += ['CODE_SIGNING_ALLOWED=NO']
    receipt = {'schema': 1, 'status': 'building', 'platform': args.platform,
               'deviceSigningRequested': bool(args.team), 'sourceRoot': str(repo), 'inputs': before, 'command': command}
    with (output / 'build.log').open('w') as log:
        process = subprocess.run(command, env=environment(), stdout=log, stderr=subprocess.STDOUT, timeout=600)
    receipt['exitCode'] = process.returncode
    receipt['sourceUnchanged'] = before == inputs(repo)
    write_json(output / 'build.json', receipt)
    if process.returncode or not receipt['sourceUnchanged']:
        raise RuntimeError('Build failed or source changed; see preserved build receipt/log')
    products = output / 'derived/Build/Products'
    configuration = 'Debug-iphonesimulator' if args.platform == 'simulator' else 'Debug-iphoneos'
    app = products / configuration / 'FilePolicyProbe.app'
    manifests = list(products.glob('*.xctestrun'))
    if len(manifests) != 1 or not (app / 'PlugIns/FilePolicyTests.xctest/FilePolicyTests').is_file():
        raise RuntimeError('Missing unique generated test manifest or compiled suite')
    validate_xctestrun(manifests[0], app)
    receipt.update(status='compiled-not-executed', app=str(app.relative_to(output)),
                   products=tree_manifest(app), xctestrun=str(manifests[0].relative_to(output)),
                   xctestrunSha256=digest(manifests[0]),
                   projectSha256=digest(project / 'project.pbxproj'))
    write_json(output / 'build.json', receipt)
    print(json.dumps({'status': receipt['status'], 'receipt': str(output / 'build.json')}))


def run_tests(args):
    build_dir, output = args.build.resolve(), args.output.resolve()
    receipt = json.loads((build_dir / 'build.json').read_text())
    repo = Path(receipt['sourceRoot'])
    if receipt['status'] != 'compiled-not-executed' or inputs(repo) != receipt['inputs']:
        raise RuntimeError('Missing attested build or changed owning source/harness')
    if receipt['platform'] == 'device' and not receipt['deviceSigningRequested']:
        raise RuntimeError('Unsigned device compilation cannot be executed')
    if not re.fullmatch(r'[A-Za-z0-9-]{8,80}', args.udid):
        raise RuntimeError('Use an explicit device or Simulator identifier')
    app, xctestrun = build_dir / receipt['app'], build_dir / receipt['xctestrun']
    validate_xctestrun(xctestrun, app)
    if digest(xctestrun) != receipt['xctestrunSha256'] or tree_manifest(app) != receipt['products']:
        raise RuntimeError('Compiled products changed after attestation')
    if output.is_relative_to(HERE) or output.is_relative_to(build_dir) or output.is_relative_to(repo) and not output.is_relative_to(repo / '.tools'):
        raise RuntimeError('Run output must be a separate artifact directory outside source or in ignored .tools')
    output.mkdir(parents=True, exist_ok=False)
    platform = 'iOS Simulator' if receipt['platform'] == 'simulator' else 'iOS'
    command = ['xcodebuild', 'test-without-building', '-xctestrun', str(xctestrun),
               '-destination', 'platform=' + platform + ',id=' + args.udid,
               '-parallel-testing-enabled', 'NO', '-resultBundlePath', str(output / 'Tests.xcresult')]
    with (output / 'test.log').open('w') as log:
        result = subprocess.run(command, env=environment(), stdout=log, stderr=subprocess.STDOUT, timeout=600)
    report = {'schema': 1, 'platform': receipt['platform'], 'xcodeExitCode': result.returncode,
              'sourceUnchanged': inputs(repo) == receipt['inputs'],
              'productsUnchanged': tree_manifest(app) == receipt['products'], 'passed': False, 'command': command}
    write_json(output / 'run.json', report)
    result.check_returncode()
    summary = subprocess.check_output(['xcrun', 'xcresulttool', 'get', 'test-results', 'summary',
                                       '--path', str(output / 'Tests.xcresult')], env=environment(), text=True)
    value = json.loads(summary)
    write_json(output / 'test-summary.json', value)
    count = 1 if receipt['platform'] == 'simulator' else 3
    if value.get('totalTestCount') != count or value.get('passedTests') != count or value.get('failedTests') != 0 or value.get('skippedTests') != 0:
        raise RuntimeError('Missing expected complete XCTest results; no skipped/empty suite counts as proof')
    if not report['sourceUnchanged'] or not report['productsUnchanged']:
        raise RuntimeError('Source or products changed during execution')
    report.update(passed=True, expectedTestCount=count,
                  evidence='simulator-unsupported' if receipt['platform'] == 'simulator' else 'physical-file-policy',
                  dateUTC=datetime.datetime.now(datetime.timezone.utc).isoformat())
    write_json(output / 'run.json', report)
    print(json.dumps({'passed': True, 'evidence': report['evidence'], 'receipt': str(output / 'run.json')}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    building = sub.add_parser('build')
    building.add_argument('--source-root', type=Path, required=True)
    building.add_argument('--output', type=Path, required=True)
    building.add_argument('--platform', choices=('simulator', 'device'), required=True)
    building.add_argument('--team')
    running = sub.add_parser('run', help='Explicitly installs and runs only the owned probe app on this destination')
    running.add_argument('--build', type=Path, required=True)
    running.add_argument('--output', type=Path, required=True)
    running.add_argument('--udid', required=True)
    args = parser.parse_args()
    build(args) if args.action == 'build' else run_tests(args)


if __name__ == '__main__':
    main()
