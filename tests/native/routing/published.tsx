import {createRoutingSettings} from '../../../src/routing/routing-settings';
/** Normal IdentityShell/signed local routing admission with disposable public identities. */
import {registerRootComponent,requireNativeModule} from 'expo';
import * as SQLite from 'expo-sqlite';
import {useEffect,useState} from 'react';
import {Platform,StyleSheet,Text,View} from 'react-native';
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
import {bindLinkOwner,type NativeLinkOwner} from '../../../src/links/link-owner';
import {loadNativeResourceHost} from '../../../src/resources/native-resource-port';
import {SIGNED_ROUTING_ARTIFACTS} from './published-fixture';
import {openRoutingCatalog} from '../../../src/routing/routing-catalog';
import {RoutingBroker} from '../../../src/routing/routing-broker';
import {RoutingReviewService} from '../../../src/routing/routing-review';
import {createRoutingTargets} from '../../../src/routing/routing-targets';
import {loadRoutingNativePort} from '../../../src/routing/routing-native';
import {bindRoutingOwner,type NativeRoutingOwner} from '../../../src/routing/routing-owner';
import type {RuntimeOwner} from '../../../src/runtime/runtime-owner';
const USERS=['79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798','c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'];
initializeNativeRandom();
async function openFixture():Promise<TrustedIdentityOwner>{
 const platform=Platform.OS;if(platform!=='ios'&&platform!=='android')throw Error('Native fixture required');
 const qa=await SQLite.openDatabaseAsync('hypergolic-signed-routing-qa.db');
 await qa.execAsync('CREATE TABLE IF NOT EXISTS qa (id INTEGER PRIMARY KEY, selected TEXT NOT NULL, revision INTEGER NOT NULL)');
 await qa.runAsync('INSERT OR IGNORE INTO qa VALUES (1, ?, 1)',USERS[0]);
 const row=await qa.getFirstAsync<{selected:string;revision:number}>('SELECT * FROM qa WHERE id=1');
 if(!row||!USERS.includes(row.selected))throw Error('Invalid public QA state');
 const makeSnapshot=(selectedPubkey:string,revision:number):VaultSnapshot=>Object.freeze({vaultId:'public_routing_admission_fixture',revision,selectedPubkey,
  identities:Object.freeze(USERS.map(pubkey=>Object.freeze({pubkey,addedAt:1,origin:'generated' as const,status:'active' as const}))),pendingDeletion:null});
 let snapshot=makeSnapshot(row.selected,row.revision);
 const vault={getSnapshot:()=>snapshot,async select(pubkey:string){if(!USERS.includes(pubkey))throw new VaultError('NOT_FOUND');
  const next=makeSnapshot(pubkey,snapshot.revision+1);await qa.runAsync('UPDATE qa SET selected=?,revision=? WHERE id=1',pubkey,next.revision);snapshot=next;return next;},
  async prepareImport(){return null;},cancelImport(){},async commitImport():Promise<VaultSnapshot>{throw new VaultError('AUTHORIZATION_DENIED');}};
 const database=await openShellDatabase(SQLite,platform);
 const transition=await IdentityTransition.open({vault,database,seed:emptyWorkspace,assertAvailable:assertWorkspaceAvailability});
 bindLinkOwner(transition,requireNativeModule<NativeLinkOwner>('HypergolicNappletHost'));
 const query={async query(){return [];}};
 const nativeModule=requireNativeModule<NativeRoutingOwner>('HypergolicNappletHost');bindRoutingOwner(transition,nativeModule);
 const capability=loadNativeCapabilityPort(),native=loadRoutingNativePort(),catalog=await openRoutingCatalog(SQLite,platform),reviews=new RoutingReviewService();
 let runtime:RuntimeOwner|null=null;
 const broker=new RoutingBroker(capability,native,catalog,reviews,createRoutingTargets(transition,()=>runtime,reviews,native));
 const routing=Object.freeze({broker,catalog,reviews,settings:createRoutingSettings(transition,native,catalog,broker)});
 runtime=createRuntimeOwner(database,transition,capability,undefined,{sqlite:SQLite,native:loadNativePublishedTransferPort(),lookupRelays:()=>['wss://relay.example.org'],
  source:{async query(coordinate){const value=SIGNED_ROUTING_ARTIFACTS.find(value=>value.event.pubkey===coordinate.pubkey&&value.appId===coordinate.identifier);if(!value)throw Error('Unknown signed local artifact');return [value.event];},
   async readHtml(hash){const value=SIGNED_ROUTING_ARTIFACTS.find(value=>value.htmlHash===hash);if(!value)throw Error('Unknown local bytes');return new TextEncoder().encode(value.html);}}},query,undefined,loadNativeResourceHost(()=>[],query),undefined,undefined,routing);
 return Object.freeze({transition,formatNpub,runtime,routing,relaySettings:null,resourceSettings:null});
}
function Fixture(){
 const [owner,setOwner]=useState<TrustedIdentityOwner|null>(null),[failed,setFailed]=useState(false);
 useEffect(()=>{let live=true;void openFixture().then(value=>{if(live)setOwner(value);else value.runtime?.revokeAllPublished();}).catch(()=>{if(live)setFailed(true);});return()=>{live=false;};},[]);
 return <GestureHandlerRootView style={styles.root}><SafeAreaProvider><View style={styles.root}><SafeAreaView edges={['top']}>
  <Text style={styles.notice}>Signed Routing QA · disposable public identities · locally supplied signed artifacts</Text>
  {SIGNED_ROUTING_ARTIFACTS.map(artifact=><Text selectable key={artifact.event.pubkey+'-'+artifact.appId} testID={'signed-'+artifact.role+'-address'} accessibilityLabel={artifact.address} style={styles.address}>{artifact.address}</Text>)}
 </SafeAreaView>{owner?<IdentityShell owner={owner}/>:<Text style={styles.notice}>{failed?'Signed Routing QA unavailable':'Opening signed routing fixture…'}</Text>}
 </View></SafeAreaProvider></GestureHandlerRootView>;
}
const styles=StyleSheet.create({root:{flex:1,backgroundColor:'#140f0b'},notice:{color:'#f3efeb',fontSize:10,padding:3,textAlign:'center'},address:{color:'#f3efeb',fontSize:8,paddingHorizontal:8}});
registerRootComponent(Fixture);
