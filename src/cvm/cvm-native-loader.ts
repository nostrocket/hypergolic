import {randomUUID} from 'expo-crypto';
import {requireNativeModule} from 'expo';
import {createCvmNativePort,type CvmHostModule,type CvmSignerModule} from './cvm-native-port';
export function loadCvmNativePort(){
  const host=requireNativeModule<CvmHostModule>('HypergolicNappletHost'),signer=requireNativeModule<CvmSignerModule>('HypergolicSignerCore');
  return Object.freeze({port:createCvmNativePort(host,signer,Date.now,randomUUID),configure:(relays:readonly string[])=>host.synchronizeCvmRelays(relays.slice(0,4))});
}
