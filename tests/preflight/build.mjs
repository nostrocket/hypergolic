import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(realpathSync(`${root}/runtime/node_modules/vite/package.json`));
const { build } = require('esbuild');
const fixture = `
export const fixture = { calls: [], available: false, availabilityFailure: null, claim: true, missingStore: false };
export function forbidden(name) { fixture.calls.push(name); throw Error('TEST: forbidden '+name); }
export const store = {
 activateNativeVault() { fixture.calls.push('activate-vault'); return true; },
 isNativeVaultAvailableAsync: async () => { fixture.calls.push('available'); if(fixture.availabilityFailure) throw fixture.availabilityFailure; return fixture.available; },
 openNativeVaultAsync: async () => forbidden('open-native-vault'),
 cancelNativeVaultAction() { fixture.calls.push('cancel-native-action'); }
};
`;
const mocks = {
 'test:fixture': fixture,
 'expo': `import {fixture,store} from 'test:fixture'; export function requireNativeModule(name) { fixture.calls.push('module:'+name); if(name==='HypergolicSignerCore'&&!fixture.missingStore) return store; throw Error('TEST: module unavailable'); }`,
 'react-native': `import {forbidden} from 'test:fixture'; export const Platform={OS:'ios'}; export const View='View',Text='Text',ActivityIndicator='ActivityIndicator',Modal='Modal',ScrollView='ScrollView',StatusBar='StatusBar'; export const useColorScheme=()=> 'light'; export const StyleSheet={create:value=>value};`,
 'expo-crypto': `import {forbidden} from 'test:fixture'; export const CryptoDigestAlgorithm={SHA256:'SHA-256'}; export const digest=()=>forbidden('artifact-digest'); export const digestStringAsync=()=>forbidden('config-digest');`,
 'expo-sqlite': `import {forbidden} from 'test:fixture'; export const openDatabaseAsync=()=>forbidden('open-sqlite');`,
 'expo-secure-store': `import {forbidden} from 'test:fixture'; export const WHEN_UNLOCKED_THIS_DEVICE_ONLY='when-unlocked-device-only'; export const isAvailableAsync=()=>forbidden('secure-store'); export const getItemAsync=()=>forbidden('config-read'); export const setItemAsync=()=>forbidden('config-write'); export const deleteItemAsync=()=>forbidden('config-delete');`,
 'expo-image': `export const Image='Image';`,
 'react-native-safe-area-context': `export const SafeAreaView='SafeAreaView',SafeAreaProvider='SafeAreaProvider';`,
 'react': `export * from '${root}/node_modules/react/index.js'; export function useEffect() {} export function useMemo(create) { return create(); } export function useContext(context) { return context._currentValue; } export function useSyncExternalStore(subscribe,getState) { return getState(); }`,
 'native-identity-owner': `import {fixture} from 'test:fixture'; export function claimIdentityOwner(){fixture.calls.push('claim');return fixture.claim;}`,
 'crypto-bootstrap': `import {fixture} from 'test:fixture'; export function initializeNativeRandom(){fixture.calls.push('initialize-random');}`,
 'identity-crypto': `import {forbidden} from 'test:fixture'; export const identityCrypto={generateSecretKey:()=>forbidden('generate-key'),derivePublicKey:()=>forbidden('derive-key'),parseNsec:()=>forbidden('parse-nsec'),newId:()=>forbidden('random-id'),now:()=>forbidden('clock')}; export const formatNpub=()=>forbidden('format-npub'); export const publicKeyFromNsec=()=>forbidden('import-key');`,
 'published-session': `import {forbidden} from 'test:fixture'; export const createPublishedSessionCoordinator=()=>forbidden('published-session');`,
 'native-published-source-port': `import {forbidden} from 'test:fixture'; export const loadNativePublishedArtifactSource=()=>forbidden('published-source');`,
 'native-transfer-port': `import {forbidden} from 'test:fixture'; export const loadNativePublishedTransferPort=()=>forbidden('published-transfer');`,
 'Shell': `export const Shell='TEST_ONLY_SHELL';`,
 'IdentityShell': `export const IdentityShell='TEST_ONLY_IDENTITY_SHELL';`,
};
export async function buildPreflight() {
 const directory = await mkdtemp(join(tmpdir(), 'hypergolic-preflight-test-'));
 const outfile = join(directory, 'compiled.mjs');
 try {
 await build({
 stdin:{contents:`export { fixture } from 'test:fixture'; export {startIdentity,getIdentityState,subscribeIdentity} from './src/security/identity-state'; export {openTrustedIdentityOwner} from './src/security/trusted-identity-owner'; export {IdentityEntry} from './src/shell/IdentityEntry'; export {IdentityDeviceRequired} from './src/security/identity-device-required';`,resolveDir:fileURLToPath(new URL('../../',import.meta.url))},
 loader:{'.png':'dataurl'},jsx:'automatic',bundle:true,format:'esm',platform:'node',target:'node24',outfile,
 banner:{js:"import {createRequire as nodeRequire} from 'node:module'; const require=nodeRequire(import.meta.url);"},
 plugins:[{name:'explicit-test-only-native-ports',setup(builder){
  builder.onResolve({filter:/.*/},args=>{
   const key=Object.hasOwn(mocks,args.path)?args.path:args.path.split('/').at(-1)?.replace(/\.tsx?$/,'');
   if(Object.hasOwn(mocks,key))return {path:key,namespace:'native-test-fixture'};
  });
  builder.onLoad({filter:/.*/,namespace:'native-test-fixture'},args=>({contents:mocks[args.path],loader:'js',resolveDir:root}));
 }}],
});

 return { directory, url: pathToFileURL(outfile) };
 } catch (error) {
  await rm(directory, { recursive: true, force: true });
  throw error;
 }
}
