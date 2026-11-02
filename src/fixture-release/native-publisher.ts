import {requireNativeModule} from 'expo';
import {CryptoDigestAlgorithm, digest} from 'expo-crypto';
import {publishEvent} from '../network/relay-service';
import {loadNativePublishedArtifactSource} from '../napplets/native-published-source-port';
import type {NativeIdentityVault} from '../security/native-identity-vault';
import type {IdentityTransition} from '../security/identity-transition';
import {FixturePublisher, type FixtureReleasePort} from './publisher';

/** Composition stays in the claimed trusted identity owner. No signing hook enters a napplet. */
export function createNativeFixturePublisher(vault: NativeIdentityVault, transition: IdentityTransition): FixturePublisher {
  const native=requireNativeModule<FixtureReleasePort>('HypergolicNappletHost');
  const service=new FixturePublisher(native,{
    handoffState: source => vault.signingHandoffState(source),
    owner:()=>transition.sessionAuthority(),
    hash:async bytes=>Array.from(new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256,bytes)),value=>value.toString(16).padStart(2,'0')).join(''),
    now:()=>Math.floor(Date.now()/1000),
    signUpload:(snapshot,authority)=>vault.signApprovedUpload(snapshot,authority),
    signManifest:(snapshot,authority)=>vault.signApproved(snapshot,authority),
    publish:publishEvent,source:loadNativePublishedArtifactSource(),
  });
  const synchronize=()=>{
    const state=transition.getSnapshot();
    if(state.phase!=='ready')service.cancel();
    native.synchronizeFixturePublisher(state.session.vault.selectedPubkey,state.session.epoch,state.phase==='ready');
  };
  synchronize();transition.subscribe(synchronize);return service;
}
