#!/usr/bin/env python3
"""Verify the pinned SecureStore patch and execute both owning native policies.

Host checks only; OS encrypted storage and installed bridge require native evidence.
The installed package is only read; patch application occurs in a temporary tree.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PACKAGE = ROOT / 'node_modules/expo-secure-store'
PATCH = ROOT / 'patches/expo-secure-store@57.0.3.patch'
manifest = json.loads((HERE / 'source-manifest.json').read_text())
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
def run(command, **options):
    subprocess.run([str(arg) for arg in command], check=True, **options)
metadata = json.loads((PACKAGE / 'package.json').read_text())
if metadata['version'] != manifest['version'] or metadata['gitHead'] != manifest['upstreamGitHead']:
    raise SystemExit('SecureStore package provenance differs from pin')
if sha(PATCH) != manifest['patchSha256']:
    raise SystemExit('SecureStore patch differs from reviewed hash')
for name, expected in manifest['dependencies'].items():
    if sha(PACKAGE / name) != expected: raise SystemExit('Native dependency source changed: ' + name)

with tempfile.TemporaryDirectory(prefix='hypergolic-config-policy-') as temporary:
    tree = Path(temporary)
    patched = all((PACKAGE / name).is_file() and sha(PACKAGE / name) == expected
                  for name, expected in manifest['patched'].items())
    for name, expected in (manifest['patched'] if patched else manifest['original']).items():
        if not (PACKAGE / name).is_file() or sha(PACKAGE / name) != expected:
            raise SystemExit('Installed native source changed: ' + name)
        target = tree / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(PACKAGE / name, target)
    if patched:
        run(['git', 'apply', '--reverse', PATCH], cwd=tree)
    run(['git', 'apply', '--check', PATCH], cwd=tree)
    run(['git', 'apply', PATCH], cwd=tree)
    for name, expected in manifest['patched'].items():
        if sha(tree / name) != expected: raise SystemExit('Patched native source changed: ' + name)
    android = (tree / 'android/src/main/java/expo/modules/securestore/SecureStoreModule.kt').read_text()
    ios = (tree / 'ios/SecureStoreModule.swift').read_text()
    for text in [android, ios]:
        names = re.findall(r'(?:AsyncFunction|Function)\("([^"]+)"\)', text)
        if sorted(names) != sorted(['setValueWithKeyAsync', 'getValueWithKeyAsync',
                'setValueWithKeySync', 'getValueWithKeySync', 'deleteValueWithKeyAsync',
                'canUseBiometricAuthentication']):
            raise SystemExit('SecureStore native export set changed')
    for name in ['getItemImpl', 'setItemImpl', 'deleteItemImpl']:
        if not re.search(r'fun ' + name + r'\([^\n]+\)[^{]*\{\s*requireConfigAccess\(key, options\)', android):
            raise SystemExit('Android access gate missing: ' + name)
    for token in ['getLegacyKeyEntry', 'getKeyEntryCompat', 'removeAllEntriesUnderKeychainService',
                  'removeKeyFromKeystore', 'PreferenceManager', 'removeItem(', 'prefs.getString(key,',
                  'prefs.edit().remove(key)', 'keyStore.deleteEntry', 'HybridAESEncryptor']:
        if token in android: raise SystemExit('Android alternate or legacy access remains: ' + token)
    if '?: throw DecryptException("The protected configuration key is missing"' not in android:
        raise SystemExit('A missing key could hide an existing configuration record')
    if not re.search(r'catch \(e: KeyPermanentlyInvalidatedException\) \{\s*throw DecryptException', android):
        raise SystemExit('An invalidated key could hide an existing configuration record')
    if android.count('.remove(') != 1 or '.remove(createKeychainAwareKey(key, options.keychainService))' not in android:
        raise SystemExit('Android delete is not restricted to its config address')
    if 'NappletConfigPolicy.allowsRecord(' not in android or 'saveEncryptedItem(encryptedItem, prefs, keychainAwareKey, false' not in android:
        raise SystemExit('Android record metadata boundary missing')
    for name in ['get', 'set']:
        if not re.search(r'func ' + name + r'\([^\n]+\)[^{]*\{\s*try requireConfigAccess\(key: key, options: options\)', ios):
            raise SystemExit('iOS access gate missing: ' + name)
    if not re.search(r'AsyncFunction\("deleteValueWithKeyAsync"\)[^{]*\{[^\n]*\n\s*try requireConfigAccess', ios):
        raise SystemExit('iOS deletion gate missing')
    for token in ['if let authenticatedItem', 'if let legacyItem', 'requireAuthentication:', 'SecAccessControlCreateWithFlags', 'options.accessGroup {']:
        if token in ios: raise SystemExit('iOS alternate access remains: ' + token)
    if ios.count('SecItemDelete(') != 1 or 'let service = NappletConfigPolicy.service + ":no-auth"' not in ios:
        raise SystemExit('iOS delete or service boundary changed')
    print('Native source/export/fallback guards passed; all original and patched hashes verified', flush=True)
    java = ROOT / '.tools/jdk/Contents/Home/bin/java'
    javac = java.with_name('javac')
    if not java.is_file() or not javac.is_file(): raise SystemExit('Pinned Java toolchain is unavailable')
    classes = tree / 'classes'
    classes.mkdir()
    policy = tree / 'android/src/main/java/expo/modules/securestore/NappletConfigPolicy.java'
    run([javac, '--release', '11', '-Xlint:all', '-Werror', '-d', classes, policy, HERE / 'ConfigPolicyProof.java'])
    run([java, '-cp', classes, 'ConfigPolicyProof'])
    swift = shutil.which('swiftc')
    if not swift: raise SystemExit('Swift toolchain is unavailable')
    executable = tree / 'config-swift-policy'
    run([swift, '-warnings-as-errors', '-module-cache-path', tree / 'swift-cache',
         tree / 'ios/NappletConfigPolicy.swift', HERE / 'main.swift', '-o', executable])
    run([executable])
    node = ROOT / '.tools/node/bin/node'
    if not node.is_file(): raise SystemExit('Pinned Node toolchain is unavailable')
    env = dict(os.environ, HYPERGOLIC_CONFIG_POLICY_CLASSES=str(classes), HYPERGOLIC_CONFIG_POLICY_JAVA=str(java))
    run([node, '--experimental-strip-types', '--test', HERE / 'config-roundtrip.test.ts'], cwd=ROOT, env=env)
print('HOST policy/caller verification passed; no installed package or persisted data was mutated')
