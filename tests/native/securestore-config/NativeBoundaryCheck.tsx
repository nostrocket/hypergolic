import {useState} from 'react';
import {requireNativeModule} from 'expo';
import {randomUUID} from 'expo-crypto';
import {StyleSheet, Text, View} from 'react-native';
import type {NativeVaultModule} from '../../../src/security/native-vault-contract';
import {ShellPressable} from '../../../src/shell/ShellPressable';
import {useShellStyles, type ShellPalette, type ShellFonts} from '../../../src/shell/theme';

type StoreOptions = Readonly<{keychainService: string; requireAuthentication: boolean; keychainAccessible: number; accessGroup?: string}>;
interface StoreModule {
  getValueWithKeyAsync(key: string, options: StoreOptions): Promise<string | null>;
  setValueWithKeyAsync(value: string, key: string, options: StoreOptions): Promise<unknown>;
  deleteValueWithKeyAsync(key: string, options: StoreOptions): Promise<unknown>;
  getValueWithKeySync(key: string, options: StoreOptions): string | null;
  setValueWithKeySync(value: string, key: string, options: StoreOptions): unknown;
}

const configOptions: StoreOptions = Object.freeze({
  keychainService: 'org.nostrocket.hypergolic.napplet-config.v1',
  requireAuthentication: false, keychainAccessible: 6,
});

async function denied(operation: () => unknown): Promise<void> {
  try {await operation();} catch {return;}
  throw new Error('A restricted native operation succeeded');
}

async function checkBoundary(): Promise<string> {
  let stage = 'module access';
  let key: string | null = null;
  let store: StoreModule | null = null;
  let completed = false;
  try {
    const signer = requireNativeModule<NativeVaultModule>('HypergolicSignerCore');
    const nativeStore = requireNativeModule<StoreModule>('ExpoSecureStore');
    store = nativeStore;
    stage = 'activation';
    if (signer.activateNativeVault() !== true) throw new Error('Native activation failed');
    stage = 'availability';
    const available = await signer.isNativeVaultAvailableAsync();
    if (typeof available !== 'boolean') throw new Error('Invalid native availability result');
    stage = 'fixture scope generation';
    const fixtureKey = 'scope.' + (randomUUID() + randomUUID()).replaceAll('-', '');
    key = fixtureKey;
    const targets = [
      {key: 'secret.' + '01'.repeat(32), options: {...configOptions, keychainService: 'org.nostrocket.hypergolic.identity.v1'}},
      {key: 'inventory', options: configOptions},
      {key: fixtureKey, options: {...configOptions, keychainService: 'org.nostrocket.hypergolic.native-signer.v1'}},
      {key: fixtureKey, options: {...configOptions, requireAuthentication: true}},
      {key: fixtureKey, options: {...configOptions, accessGroup: 'untrusted.fixture'}},
    ];
    for (const [index, target] of targets.entries()) {
      stage = `restricted calls group ${index + 1}`;
      await denied(() => nativeStore.getValueWithKeyAsync(target.key, target.options));
      await denied(() => nativeStore.setValueWithKeyAsync('public fixture value', target.key, target.options));
      await denied(() => nativeStore.deleteValueWithKeyAsync(target.key, target.options));
      await denied(() => nativeStore.getValueWithKeySync(target.key, target.options));
      await denied(() => nativeStore.setValueWithKeySync('public fixture value', target.key, target.options));
    }
    stage = 'configuration async write';
    await nativeStore.setValueWithKeyAsync('public fixture one', fixtureKey, configOptions);
    stage = 'configuration async read';
    if (await nativeStore.getValueWithKeyAsync(fixtureKey, configOptions) !== 'public fixture one') throw new Error('Async config readback failed');
    stage = 'configuration sync read';
    if (nativeStore.getValueWithKeySync(fixtureKey, configOptions) !== 'public fixture one') throw new Error('Sync config readback failed');
    stage = 'configuration sync write';
    nativeStore.setValueWithKeySync('public fixture two', fixtureKey, configOptions);
    stage = 'configuration sync write readback';
    if (await nativeStore.getValueWithKeyAsync(fixtureKey, configOptions) !== 'public fixture two') throw new Error('Sync config write failed');
    stage = 'configuration delete';
    await nativeStore.deleteValueWithKeyAsync(fixtureKey, configOptions);
    stage = 'configuration delete readback';
    if (await nativeStore.getValueWithKeyAsync(fixtureKey, configOptions) !== null || nativeStore.getValueWithKeySync(fixtureKey, configOptions) !== null) throw new Error('Config cleanup failed');
    completed = true;
    return `Native boundary passed.\nVault available: ${String(available)}. Vault was not opened.\n25 restricted calls denied across all five exports.\nAsync and sync configuration round trips passed; fixture record removed.`;
  } catch (error) {
    const allowed = new Set(['ERR_INVALID_KEY', 'ERR_KEY_CHAIN', 'AUTHORIZATION_DENIED', 'NOT_READY', 'STORAGE_FAILURE']);
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && allowed.has(error.code)
      ? error.code : 'UNCLASSIFIED';
    return `Native boundary failed at ${stage} (${code}). This run is not verification.`;
  } finally {
    if (!completed && store && key) {
      try {await store.deleteValueWithKeyAsync(key, configOptions);}
      catch { /* The failed test's disposable app is removed by the native driver. */ }
    }
  }
}

/** Disposable Expo entry only. Calls the real bridge; never opens the identity vault. */
export function NativeBoundaryCheck() {
  const {styles} = useShellStyles(createStyles);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  async function run() {
    if (busy) return;
    setBusy(true); setResult('');
    try {setResult(await checkBoundary());}
    catch {setResult('Native boundary failed. This run is not verification.');}
    finally {setBusy(false);}
  }
  return <View style={styles.group}>
    <Text style={styles.detail}>Check vault availability and native configuration access in this disposable app.</Text>
    <ShellPressable testID="signer-fixture-boundary-check" accessibilityRole="button" accessibilityState={{disabled: busy}}
      disabled={busy} style={styles.action} onPress={() => {void run();}}>
      <Text style={styles.detail}>{busy ? 'Checking native boundary…' : 'Check native boundary'}</Text>
    </ShellPressable>
    {result !== '' && <Text testID="signer-fixture-boundary-result" accessibilityLiveRegion="polite" style={styles.detail}>{result}</Text>}
  </View>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  group: {gap: 12},
  detail: {fontFamily: fonts.body, color: colors.text, fontSize: 16, lineHeight: 24},
  action: {borderWidth: 1, borderColor: colors.border, minHeight: 56, padding: 16},
});
