import { publicFixtureSigningMethods } from '../public-signing-methods';
/** Isolated QA of normal signed admission with public disposable identities and diagnostic frames. */
import {registerRootComponent} from 'expo';
import * as SQLite from 'expo-sqlite';
import {useEffect,useState} from 'react';
import {Platform,Pressable,StyleSheet,Text,View} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {SafeAreaProvider,SafeAreaView} from 'react-native-safe-area-context';
import {initializeNativeRandom} from '../../../src/security/crypto-bootstrap';
import {formatNpub} from '../../../src/security/public-identity';
import {IdentityTransition} from '../../../src/security/identity-transition';
import {VaultError,type VaultSnapshot} from '../../../src/security/identity-vault';
import type {TrustedIdentityOwner} from '../../../src/security/trusted-identity-owner';
import {loadNativeCapabilityPort} from '../../../src/runtime/native-capability-port';
import {createRuntimeOwner} from '../../../src/runtime/runtime-owner';
import {loadNativePublishedTransferPort} from '../../../src/napplets/native-transfer-port';
import {openShellDatabase} from '../../../src/storage/database';
import {assertWorkspaceAvailability} from '../../../src/shell/fixtures';
import {emptyWorkspace} from '../../../src/shell/workspace';
import {IdentityShell} from '../../../src/shell/IdentityShell';
import {openIdentityCache} from '../../../src/identity/identity-cache';
import {createIdentityDataService} from '../../../src/identity/identity-service';
import {openIdentityListAccess} from '../../../src/identity/identity-permissions';
import {loadIdentityListNativePolicy} from '../../../src/identity/identity-permissions-native';
import {createNativeRelayQuery} from '../../../src/network/native-relay-query';
import {queryMatches,type QueryFilter} from '../../../src/network/relay-query-contract';
import fixture from './public-list-fixture.json';
import {SIGNED_IDENTITY_ARTIFACTS} from './published-fixture';
initializeNativeRandom();
interface Observation {reads:number;queries:number;frames:number;artifacts:number;offline:boolean;receipt:string}
async function openFixture(notify:(value:Observation)=>void):Promise<{owner:TrustedIdentityOwner;toggle():Promise<void>}> {
 const platform=Platform.OS;if(platform!=='ios'&&platform!=='android')throw Error('Native fixture required');
 const qa=await SQLite.openDatabaseAsync('hypergolic-public-admission-qa.db');
 await qa.execAsync('CREATE TABLE IF NOT EXISTS qa (id INTEGER PRIMARY KEY, selected TEXT NOT NULL, revision INTEGER NOT NULL, offline INTEGER NOT NULL, advanced INTEGER NOT NULL)');
 await qa.runAsync('INSERT OR IGNORE INTO qa VALUES (1, ?, 1, 0, 0)',fixture.user);
 const row=await qa.getFirstAsync<{selected:string;revision:number;offline:number;advanced:number}>('SELECT * FROM qa WHERE id=1');
 if(!row||![fixture.user,fixture.other].includes(row.selected))throw Error('Invalid public QA state');
 let offline=row.offline===1,advanced=row.advanced===1,reads=0,queries=0,frames=0,artifacts=0,receipt='No native identity receipt';
 const report=()=>notify({reads,queries,frames,artifacts,offline,receipt});
 const makeSnapshot=(selectedPubkey:string,revision:number):VaultSnapshot=>Object.freeze({vaultId:'public_identity_admission_fixture',revision,selectedPubkey,
  identities:Object.freeze([fixture.user,fixture.other].map(pubkey=>Object.freeze({pubkey,addedAt:1,origin:'generated' as const,status:'active' as const}))),pendingDeletion:null});
 let snapshot=makeSnapshot(row.selected,row.revision);
 const vault={...publicFixtureSigningMethods(()=>snapshot),getSnapshot:()=>snapshot,async select(pubkey:string){if(![fixture.user,fixture.other].includes(pubkey))throw new VaultError('NOT_FOUND');
  const next=makeSnapshot(pubkey,snapshot.revision+1);await qa.runAsync('UPDATE qa SET selected=?,revision=? WHERE id=1',pubkey,next.revision);snapshot=next;return next;},
  async prepareImport(){return null;},cancelImport(){},async commitImport():Promise<VaultSnapshot>{throw new VaultError('AUTHORIZATION_DENIED');}};
 const database=await openShellDatabase(SQLite,platform),cache=await openIdentityCache(SQLite,platform);
 const transition=await IdentityTransition.open({vault,database,seed:emptyWorkspace,assertAvailable:assertWorkspaceAvailability});
 const listAccess=await openIdentityListAccess(SQLite,platform,loadIdentityListNativePolicy(),()=>{const state=transition.getSnapshot();return state.phase==='ready'?state.session.vault.selectedPubkey:'';});
 const native=loadNativeCapabilityPort(),tokens=new Map<string,{type:string;user:string}>();
 const observed={...native,take(token:string){const raw=native.take(token);if(raw){const value=JSON.parse(raw);tokens.set(token,{type:JSON.parse(value.request).type,user:value.registration.user});}return raw;},
  finish(token:string,response:string|null){native.finish(token,response);const value=tokens.get(token);tokens.delete(token);if(value?.type.startsWith('identity.')){reads++;receipt=value.type+'; user '+value.user+'; '+(response===null?'denied':JSON.parse(response).error?'error':'success');report();}}};
 const controlled=createNativeRelayQuery({newInstanceId:native.newInstanceId,cancelPublishedRelay(){},async queryPublishedRelay(_id,_url,wire,sub){frames++;report();
  const filters=(JSON.parse(wire) as unknown[]).slice(2) as QueryFilter[];
  return [...fixture.events.filter(event=>filters.some(filter=>queryMatches(event,filter))).map(event=>JSON.stringify(['EVENT',sub,event])),JSON.stringify(['EOSE',sub])];
 }},()=>offline?[]:['wss://relay.example.org']);
 const query={query:(filters:readonly QueryFilter[],signal:AbortSignal,active:()=>void)=>{queries++;report();return controlled.query(filters,signal,active);}};
 const runtime=createRuntimeOwner(database,transition,observed,undefined,{sqlite:SQLite,native:loadNativePublishedTransferPort(),lookupRelays:()=>['wss://relay.example.org'],
  source:{async query(coordinate){artifacts++;report();const value=SIGNED_IDENTITY_ARTIFACTS.find(value=>value.event.pubkey===coordinate.pubkey&&value.appId===coordinate.identifier);if(!value)throw Error('Unknown local signed artifact');return [value.event];},
   async readHtml(hash){const value=SIGNED_IDENTITY_ARTIFACTS.find(value=>value.htmlHash===hash);if(!value)throw Error('Unknown local bytes');return new TextEncoder().encode(value.html);}}},query,undefined,undefined,undefined,
  createIdentityDataService(cache,query,()=>Date.now()+(advanced?300001:0),listAccess));
 report();return {owner:Object.freeze({transition,formatNpub,runtime,listAccess,relaySettings:null,resourceSettings:null}),
  async toggle(){const next=!offline;await qa.runAsync('UPDATE qa SET offline=?,advanced=1 WHERE id=1',next?1:0);offline=next;advanced=true;report();}};
}
function Fixture(){
 const [value,setValue]=useState<Awaited<ReturnType<typeof openFixture>>|null>(null),[failed,setFailed]=useState(false);
 const [observation,setObservation]=useState<Observation>({reads:0,queries:0,frames:0,artifacts:0,offline:false,receipt:'No native identity receipt'});
 useEffect(()=>{let live=true;void openFixture(value=>{if(live)setObservation(value);}).then(value=>{if(live)setValue(value);else value.owner.runtime?.revokeAllPublished();}).catch(()=>{if(live)setFailed(true);});return()=>{live=false;};},[]);
 return <GestureHandlerRootView style={styles.root}><SafeAreaProvider><View style={styles.root}><SafeAreaView edges={['top']}>
  <Text style={styles.notice}>Signed Identity QA · disposable public identities · local artifacts and diagnostic frames</Text>
  {SIGNED_IDENTITY_ARTIFACTS.map(artifact=><Text selectable key={artifact.appId} testID={'signed-'+artifact.role+'-address'} accessibilityLabel={artifact.address} style={styles.address}>{artifact.address}</Text>)}
  <Pressable accessibilityRole="button" onPress={()=>{void value?.toggle().catch(()=>setFailed(true));}} style={styles.control}><Text style={styles.notice}>{observation.offline?'Use online diagnostic frames':'Use controlled offline cache'}</Text></Pressable>
  <Text style={styles.notice}>{'Identity request count: '+observation.reads+'; query calls '+observation.queries+'; frames '+observation.frames+'; artifact queries '+observation.artifacts}</Text>
  <Text style={styles.notice}>{'Native identity receipt: '+observation.receipt}</Text>
 </SafeAreaView>{value?<IdentityShell owner={value.owner}/>:<Text style={styles.notice}>{failed?'Signed Identity QA unavailable':'Opening signed identity fixture…'}</Text>}
 </View></SafeAreaProvider></GestureHandlerRootView>;
}
const styles=StyleSheet.create({root:{flex:1,backgroundColor:'#140f0b'},notice:{color:'#f3efeb',fontSize:10,padding:3,textAlign:'center'},address:{color:'#f3efeb',fontSize:8,paddingHorizontal:8},control:{minHeight:36,justifyContent:'center',backgroundColor:'#34251d'}});
registerRootComponent(Fixture);
