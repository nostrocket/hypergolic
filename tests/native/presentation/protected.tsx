/** Test-only entry: the ordinary IdentityEntry and real protected identity owner. */
import {registerRootComponent} from 'expo';
import {useState} from 'react';
import {Pressable,StyleSheet,Text,View} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {SafeAreaProvider,SafeAreaView} from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import {CryptoDigestAlgorithm,digestStringAsync} from 'expo-crypto';
import {IdentityEntry} from '../../../src/shell/IdentityEntry';
import {getIdentityState} from '../../../src/security/identity-state';
import {CONFIG_STORE_SERVICE} from '../../../src/presentation/config-store';
import {CONFIGURATION_SAMPLES,offerIncompatibleConfigurationUpdate} from './protected-source';
const DEVELOPMENT_USER = '3c46337f0515d71f85601c9a538cc259b9420970cda8bbc9c0f182566c752775';
const options = {keychainService:CONFIG_STORE_SERVICE,requireAuthentication:false,keychainAccessible:SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY};
function assertEmptyDevelopmentWorkspace() {
  const state = getIdentityState();
  if (state.status !== 'ready') throw new Error('Owner unavailable');
  const transition = state.owner.transition.getSnapshot();
  if (transition.phase !== 'ready' || transition.pending !== null ||
      transition.session.vault.selectedPubkey !== DEVELOPMENT_USER ||
      transition.session.workspace.getSnapshot().workspace.sessions.length !== 0) throw new Error('Development workspace is not empty');
}
async function sampleKeys() {
  return Promise.all(CONFIGURATION_SAMPLES.map(row => {
    const version = row.event.tags.find(tag => tag[0] === 'x')?.[1];
    if (!version) throw new Error('Missing signed version');
    return digestStringAsync(CryptoDigestAlgorithm.SHA256,JSON.stringify([DEVELOPMENT_USER,row.event.pubkey,row.appId,version])).then(hash => 'scope.' + hash);
  }));
}
async function checkEmptySamples() {
  assertEmptyDevelopmentWorkspace();
  for (const key of await sampleKeys()) {
    if (await SecureStore.getItemAsync(key,options) !== null) throw new Error('Preexisting configuration sample');
  }
  assertEmptyDevelopmentWorkspace();
}
async function eraseOwnedSamples() {
  assertEmptyDevelopmentWorkspace();
  for (const key of await sampleKeys()) {
    assertEmptyDevelopmentWorkspace();
    await SecureStore.deleteItemAsync(key,options);
    if (await SecureStore.getItemAsync(key,options) !== null) throw new Error('Sample erase failed');
  }
}
function ProtectedConfigurationFixture() {
  const [status,setStatus] = useState('Signed local configuration samples; real protected development identity.'),[offered,setOffered]=useState(false);
  function act(operation:()=>Promise<void>,success:string) {
    void operation().then(()=>setStatus(success)).catch(()=>setStatus('Configuration sample operation refused.'));
  }
  return <GestureHandlerRootView style={styles.root}><SafeAreaProvider><View style={styles.root}>
    <SafeAreaView edges={['top']}><Text testID="qa-protected-status" style={styles.notice}>{status}</Text>
      <View style={styles.controls}><Pressable testID="qa-check-config-empty" accessibilityRole="button" onPress={()=>act(checkEmptySamples,'Exact configuration samples initially absent.')}><Text style={styles.notice}>Check empty samples</Text></Pressable>
        <Pressable testID="qa-clean-config-samples" accessibilityRole="button" onPress={()=>act(eraseOwnedSamples,'Exact configuration samples erased.')}><Text style={styles.notice}>Erase owned samples</Text></Pressable>
        <Pressable testID="qa-offer-config-incompatible-update" accessibilityRole="button" onPress={()=>{offerIncompatibleConfigurationUpdate();setOffered(true);}}><Text style={styles.notice}>{offered?'Incompatible update offered.':'Offer incompatible update'}</Text></Pressable></View>
      {CONFIGURATION_SAMPLES.filter(row=>row.role!=='config-incompatible-update').map(row=><Text key={row.role} testID={'signed-'+row.role+'-address'} accessibilityLabel={row.address} numberOfLines={1} style={styles.address}>{row.address}</Text>)}
    </SafeAreaView><IdentityEntry /></View></SafeAreaProvider></GestureHandlerRootView>;
}
const styles=StyleSheet.create({root:{flex:1,backgroundColor:'#140f0b'},controls:{flexDirection:'row',justifyContent:'space-around'},notice:{color:'#f3efeb',fontSize:10,padding:4,textAlign:'center'},address:{color:'#f3efeb',fontSize:8,paddingHorizontal:8}});
registerRootComponent(ProtectedConfigurationFixture);
