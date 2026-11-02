#!/usr/bin/env python3
"""Build exact owning iOS signer sources, run native XCTest and touch UI, then verify with nostr-tools."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
BUNDLE = 'org.nostrocket.hypergolic.signerprobe'
SOURCES = [
    'modules/signer-core/ios/NativeSignerCore.swift',
    'modules/signer-core/ios/ExactSignerEvent.swift',
    'modules/signer-core/ios/NativeSignerReviewPanel.swift',
    'modules/signer-core/shared/hypergolic_signer.c',
    'modules/signer-core/shared/hypergolic_nip44.c',
    'modules/signer-core/vendor/monocypher/src/monocypher.c',
    'modules/signer-core/vendor/secp256k1/src/secp256k1.c',
    'modules/signer-core/vendor/secp256k1/src/precomputed_ecmult.c',
    'modules/signer-core/vendor/secp256k1/src/precomputed_ecmult_gen.c',
]
DEFINES = ['ENABLE_MODULE_SCHNORRSIG=1', 'ENABLE_MODULE_EXTRAKEYS=1', 'ENABLE_MODULE_ECDH=1', 'ECMULT_WINDOW_SIZE=15',
           'COMB_BLOCKS=43', 'COMB_TEETH=6', 'SECP256K1_NO_API_VISIBILITY_ATTRIBUTES=1']


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def inputs():
    paths = sorted(set([REPO / path for path in SOURCES] + list((REPO / 'modules/signer-core/shared').rglob('*'))
        + list((REPO / 'modules/signer-core/vendor').rglob('*')) + list(HERE.rglob('*'))
        + list((REPO / 'modules/signer-core/ios').glob('*'))))
    return {str(path.relative_to(REPO)): digest(path) for path in paths if path.is_file()}

def pbx(value):
    if isinstance(value, dict): return '{ ' + ' '.join(json.dumps(key) + ' = ' + pbx(item) + ';' for key, item in value.items()) + ' }'
    if isinstance(value, list): return '(' + ', '.join(pbx(item) for item in value) + ')'
    return json.dumps(str(value))

def project(output, bridge=False):
    objects = {}; count = 0
    def add(value):
        nonlocal count
        count += 1; key = f'{count:024X}'; objects[key] = value; return key
    products = add({'isa': 'PBXGroup', 'name': 'Products', 'sourceTree': '<group>', 'children': []})
    root = add({'isa': 'PBXGroup', 'sourceTree': '<group>', 'children': [products]})
    settings = {'SDKROOT': 'iphoneos', 'IPHONEOS_DEPLOYMENT_TARGET': '18.4', 'SWIFT_VERSION': '6.0',
        'SWIFT_STRICT_CONCURRENCY': 'complete', 'ENABLE_TESTABILITY': 'YES', 'SWIFT_OPTIMIZATION_LEVEL': '-Onone',
        'CODE_SIGNING_ALLOWED': 'NO', 'ONLY_ACTIVE_ARCH': 'YES', 'CLANG_ENABLE_MODULES': 'YES', 'TARGETED_DEVICE_FAMILY': '1,2',
        'GCC_PREPROCESSOR_DEFINITIONS': DEFINES, 'HEADER_SEARCH_PATHS': [str(REPO / 'modules/signer-core/shared/include'),
            str(REPO / 'modules/signer-core/vendor/secp256k1/include'),
            str(REPO / 'modules/signer-core/vendor/monocypher/src')], 'OTHER_CFLAGS': ['-fvisibility=hidden'],
        'SWIFT_TREAT_WARNINGS_AS_ERRORS': 'YES'}
    def config(value):
        item = add({'isa': 'XCBuildConfiguration', 'name': 'Debug', 'buildSettings': value})
        return add({'isa': 'XCConfigurationList', 'buildConfigurations': [item], 'defaultConfigurationName': 'Debug', 'defaultConfigurationIsVisible': '0'})
    def target(name, bundle, kind, sources, extra):
        files = []
        for path in sources:
            reference = add({'isa': 'PBXFileReference', 'path': str(path), 'sourceTree': '<absolute>',
                'lastKnownFileType': 'sourcecode.swift' if path.suffix == '.swift' else 'sourcecode.c.c'})
            objects[root]['children'].append(reference)
            files.append(add({'isa': 'PBXBuildFile', 'fileRef': reference}))
        phase = add({'isa': 'PBXSourcesBuildPhase', 'buildActionMask': '2147483647', 'files': files, 'runOnlyForDeploymentPostprocessing': '0'})
        frameworks = add({'isa': 'PBXFrameworksBuildPhase', 'buildActionMask': '2147483647', 'files': [], 'runOnlyForDeploymentPostprocessing': '0'})
        resources = []
        if kind == 'application':
            for license_path in ['modules/signer-core/vendor/secp256k1/COPYING', 'modules/signer-core/vendor/monocypher/LICENCE.md']:
                reference = add({'isa': 'PBXFileReference', 'path': str(REPO / license_path), 'sourceTree': '<absolute>', 'lastKnownFileType': 'text'})
                objects[root]['children'].append(reference)
                resources.append(add({'isa': 'PBXBuildFile', 'fileRef': reference}))
        resource_phase = add({'isa': 'PBXResourcesBuildPhase', 'buildActionMask': '2147483647', 'files': resources, 'runOnlyForDeploymentPostprocessing': '0'})
        suffix = '.app' if kind == 'application' else '.xctest'
        product = add({'isa': 'PBXFileReference', 'path': name + suffix, 'sourceTree': 'BUILT_PRODUCTS_DIR',
            'explicitFileType': 'wrapper.application' if suffix == '.app' else 'wrapper.cfbundle'})
        objects[products]['children'].append(product)
        cfg = config(dict(settings, GENERATE_INFOPLIST_FILE='YES', PRODUCT_NAME='$(TARGET_NAME)',
            PRODUCT_BUNDLE_IDENTIFIER=bundle, **extra))
        return add({'isa': 'PBXNativeTarget', 'name': name, 'productName': name, 'productReference': product,
            'productType': 'com.apple.product-type.' + kind, 'buildConfigurationList': cfg,
            'buildPhases': [phase, frameworks, resource_phase], 'dependencies': [], 'buildRules': []})
    bridging_header = output / 'NativeSignerBridge.h'
    bridging_header.write_text('#include "hypergolic_signer.h"\n#include "hypergolic_nip44.h"\n')
    app = target('SignerProbe', BUNDLE, 'application', [HERE / 'App/AppDelegate.swift'] + [REPO / p for p in SOURCES],
        {'INFOPLIST_KEY_UILaunchScreen_Generation': 'YES', 'INFOPLIST_KEY_UIApplicationSceneManifest_Generation': 'YES', 'SWIFT_OBJC_BRIDGING_HEADER': str(bridging_header)})
    unit = target('SignerCoreTests', BUNDLE + '.unit', 'bundle.unit-test', [HERE / 'Tests/SignerCoreTests.swift'],
        {'TEST_HOST': '$(BUILT_PRODUCTS_DIR)/SignerProbe.app/SignerProbe', 'BUNDLE_LOADER': '$(TEST_HOST)'})
    ui = target('SignerUITests', BUNDLE + '.ui', 'bundle.ui-testing', [HERE / ('Tests/BridgeSignerUITests.swift' if bridge else 'Tests/SignerUITests.swift')],
        {'TEST_TARGET_NAME': 'SignerProbe'})
    proj = add({'isa': 'PBXProject', 'buildConfigurationList': config(settings), 'mainGroup': root, 'productRefGroup': products,
        'compatibilityVersion': 'Xcode 14.0', 'developmentRegion': 'en', 'knownRegions': ['en', 'Base'],
        'projectDirPath': '', 'projectRoot': '', 'targets': [app, unit, ui],
        'attributes': {'TargetAttributes': {unit: {'TestTargetID': app}, ui: {'TestTargetID': app}}}})
    for test in [unit, ui]:
        proxy = add({'isa': 'PBXContainerItemProxy', 'containerPortal': proj, 'remoteGlobalIDString': app, 'remoteInfo': 'SignerProbe', 'proxyType': '1'})
        objects[test]['dependencies'].append(add({'isa': 'PBXTargetDependency', 'target': app, 'targetProxy': proxy}))
    path = output / 'SignerProbe.xcodeproj'; scheme_dir = path / 'xcshareddata/xcschemes'; scheme_dir.mkdir(parents=True)
    (path / 'project.pbxproj').write_text('// !$*UTF8*$!\n' + pbx({'archiveVersion': '1', 'objectVersion': '56', 'classes': {}, 'objects': objects, 'rootObject': proj}) + '\n')
    def ref(key, name, suffix): return f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{key}" BuildableName="{name}{suffix}" BlueprintName="{name}" ReferencedContainer="container:SignerProbe.xcodeproj"/>'
    scheme = '<Scheme version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries>'
    for key, name, suffix in [(app, 'SignerProbe', '.app'), (unit, 'SignerCoreTests', '.xctest'), (ui, 'SignerUITests', '.xctest')]:
        scheme += '<BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">' + ref(key, name, suffix) + '</BuildActionEntry>'
    scheme += '</BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" shouldUseLaunchSchemeArgsEnv="YES"><Testables>'
    for key, name in ([(ui, 'SignerUITests')] if bridge else [(unit, 'SignerCoreTests'), (ui, 'SignerUITests')]):
        scheme += '<TestableReference skipped="NO">' + ref(key, name, '.xctest') + '</TestableReference>'
    scheme += '</Testables></TestAction><LaunchAction buildConfiguration="Debug"><BuildableProductRunnable>' + ref(app, 'SignerProbe', '.app') + '</BuildableProductRunnable></LaunchAction></Scheme>'
    (scheme_dir / 'SignerProbe.xcscheme').write_text(scheme)
    return path

def run(command, environment, log):
    with log.open('w') as stream:
        process = subprocess.run(command, env=environment, stdout=stream, stderr=subprocess.STDOUT, timeout=600)
    if process.returncode: raise RuntimeError('Native signer command failed; see ' + str(log))

def apps(environment, udid):
    raw = subprocess.check_output(['xcrun', 'simctl', 'listapps', udid], env=environment)
    return json.loads(subprocess.check_output(['plutil', '-convert', 'json', '-o', '-', '-'], input=raw))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--udid')
    args = parser.parse_args()
    output = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix='hypergolic-signer-ios-'))
    if args.output: output.mkdir(parents=True, exist_ok=False)
    environment = dict(os.environ, DEVELOPER_DIR=os.environ.get('DEVELOPER_DIR', '/Applications/Xcode.app/Contents/Developer'))
    devices = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'booted', '-j'], env=environment, text=True))
    booted = [item['udid'] for values in devices['devices'].values() for item in values if item['state'] == 'Booted']
    udid = args.udid or (booted[0] if len(booted) == 1 else None)
    if not udid or udid not in booted: raise RuntimeError('Need one explicit booted iOS Simulator; no missing environment can pass')
    inventory = set(apps(environment, udid))
    if BUNDLE in inventory or BUNDLE + '.ui.xctrunner' in inventory: raise RuntimeError('Existing probe IDs must be reconciled before this batch')
    before = inputs(); project_path = project(output)
    command = ['xcodebuild', 'test-without-building', '-project', str(project_path), '-scheme', 'SignerProbe', '-configuration', 'Debug',
        '-destination', 'platform=iOS Simulator,id=' + udid, '-derivedDataPath', str(output / 'derived'),
        '-parallel-testing-enabled', 'NO', '-resultBundlePath', str(output / 'Tests.xcresult'), 'CODE_SIGNING_ALLOWED=NO']
    report = {'environment': 'iOS Simulator', 'udid': udid, 'owningSources': before, 'command': command,
        'ownerAdapterLimit': 'Disposable native UIKit caller; actual Expo AppContext adapter compiled separately', 'passed': False}
    try:
        build_command = ['xcodebuild', 'build-for-testing', '-project', str(project_path), '-scheme', 'SignerProbe',
            '-configuration', 'Debug', '-destination', 'platform=iOS Simulator,id=' + udid,
            '-derivedDataPath', str(output / 'derived'), 'CODE_SIGNING_ALLOWED=NO']
        report['buildCommand'] = build_command
        run(build_command, environment, output / 'build.log')
        products = output / 'derived/Build/Products/Debug-iphonesimulator'
        for name, bundle in [('SignerProbe.app', BUNDLE), ('SignerUITests-Runner.app', BUNDLE + '.ui.xctrunner')]:
            subprocess.run(['xcrun', 'simctl', 'install', udid, str(products / name)], env=environment, check=True, capture_output=True)
            subprocess.check_output(['xcrun', 'simctl', 'get_app_container', udid, bundle, 'app'], env=environment)
        # Confirm FrontBoard knows the owned host before XCTest starts its installation lane.
        subprocess.run(['xcrun', 'simctl', 'launch', udid, BUNDLE], env=environment, check=True, capture_output=True)
        subprocess.run(['xcrun', 'simctl', 'terminate', udid, BUNDLE], env=environment, check=True, capture_output=True)
        run(command, environment, output / 'test.log')
        summary = json.loads(subprocess.check_output(['xcrun', 'xcresulttool', 'get', 'test-results', 'summary', '--path', str(output / 'Tests.xcresult')], env=environment, text=True))
        (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        if summary.get('totalTestCount') != 15 or summary.get('passedTests') != 15 or summary.get('failedTests') != 0 or summary.get('skippedTests') != 0:
            raise RuntimeError('Expected all12 native core and3 real touch UI cases; missing/zero/skipped cases fail')
        container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', udid, BUNDLE, 'data'], env=environment, text=True).strip())
        public = output / 'signature.json'; shutil.copyfile(container / 'Documents/signature.json', public)
        verifier = subprocess.check_output(['node', str(HERE / 'verify-public.mjs'), str(REPO), str(public)], env=environment, text=True)
        independent = json.loads(verifier)
        if inputs() != before: raise RuntimeError('Owning signer sources changed during the run')
        log = (output / 'test.log').read_text()
        counts = {label: max([int(value) for value in re.findall('SIGNER_' + label + '_ASSERTIONS=(\\d+)', log)] or [0]) for label in ('CORE', 'UI')}
        if any(value <= 0 for value in counts.values()): raise RuntimeError('Native assertion counts missing or zero')
        report.update(passed=True, cases=15, coreCases=12, touchUICases=3, assertions=sum(counts.values()),
            assertionCounts=counts, independent=independent, sourceUnchanged=True)
    finally:
        for bundle in [BUNDLE, BUNDLE + '.ui.xctrunner']:
            subprocess.run(['xcrun', 'simctl', 'terminate', udid, bundle], env=environment, capture_output=True)
            subprocess.run(['xcrun', 'simctl', 'uninstall', udid, bundle], env=environment, check=True, capture_output=True)
        installed = apps(environment, udid)
        report['retainedInventoryUnchanged'] = set(installed) == inventory
        report['ownedAppsRemoved'] = all(bundle not in installed for bundle in [BUNDLE, BUNDLE + '.ui.xctrunner'])
        (output / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    if not report['ownedAppsRemoved'] or not report['retainedInventoryUnchanged']: raise RuntimeError('Disposable native signer apps were not removed')
    print(json.dumps({'passed': report['passed'], 'cases': report['cases'], 'assertions': report['assertions'], 'receipt': str(output / 'receipt.json')}))

if __name__ == '__main__': main()
