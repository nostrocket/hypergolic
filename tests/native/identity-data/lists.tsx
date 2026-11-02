/** Real native/SDK/SQLite tracer with diagnostic signed relay frames. No external network or signer. */
import {registerRootComponent,requireNativeView} from 'expo';
import * as SQLite from 'expo-sqlite';
import {useEffect,useRef,useState} from 'react';
import {AppState,Modal,Platform,Pressable,ScrollView,StyleSheet,Text,View,type ViewProps,type NativeSyntheticEvent} from 'react-native';
import {SafeAreaProvider,SafeAreaView} from 'react-native-safe-area-context';
import {createCapabilityBroker,type NativeCapabilityPort} from '../../../src/runtime/capability-broker';
import {loadNativeCapabilityPort} from '../../../src/runtime/native-capability-port';
import {createNativeRelayQuery} from '../../../src/network/native-relay-query';
import {queryMatches,type QueryFilter} from '../../../src/network/relay-query-contract';
import {openShellDatabase} from '../../../src/storage/database';
import {openIdentityCache} from '../../../src/identity/identity-cache';
import {createIdentityDataService} from '../../../src/identity/identity-service';
import {openIdentityListAccess,type IdentityListAccess} from '../../../src/identity/identity-permissions';
import {loadIdentityListNativePolicy} from '../../../src/identity/identity-permissions-native';
import {IdentityListReview} from '../../../src/shell/IdentityListReview';
import {IdentityListSettings} from '../../../src/shell/IdentityListSettings';
import {BUNDLED_FIXTURES} from '../../../src/runtime/bundled-catalog';
import type {NativeRegistration} from '../../../src/runtime/capability-protocol';
import type {NativeCapabilityEvent} from '../../../src/runtime/runtime-owner';
import fixture from './public-list-fixture.json';
const cases=['primary','offline','other-app','other-publisher','other-user','bad-badge','bad-signature','queued-regrant','owner-epoch','background'] as const;
type Event=NativeCapabilityEvent|{type:'ready'|'error';sessionId:string};
const Host=requireNativeView<ViewProps & {configuration:string;active:boolean;onHostEvent(event:NativeSyntheticEvent<Event>):void}>('HypergolicNappletHost');
function Lab(){
 const [index,setIndex]=useState(0),[prepared,setPrepared]=useState(false),[access,setAccess]=useState<IdentityListAccess|null>(null),[settings,setSettings]=useState(false),[status,setStatus]=useState('Opening public lists…'),[receipt,setReceipt]=useState('No identity receipt'),[readCount,setReadCount]=useState(0);
 const config=useRef(''),receiver=useRef<((event:Event)=>void)|null>(null),stop=useRef<(()=>void)|null>(null);const scenario=cases[index]!;
 const user=scenario==='other-user'?fixture.other:fixture.user;
 useEffect(()=>{
  let live=true,foreground=true,ownerActive=true,generation:string|null=null,registration:NativeRegistration|null=null,broker:ReturnType<typeof createCapabilityBroker>|null=null;
  let database:Awaited<ReturnType<typeof openShellDatabase>>|null=null,cache:Awaited<ReturnType<typeof openIdentityCache>>|null=null,permission:IdentityListAccess|null=null;
  let calls=0,frames=0,cancelled=0,queued=false;const tokens=new Map<string,string>(),timers:ReturnType<typeof setTimeout>[]=[];
  const platform=Platform.OS==='ios'?'ios':'android',native=loadNativeCapabilityPort(),name=scenario==='other-app'?'state-lab-peer':'state-lab';
  const configuration={sessionId:'identity-lists',epoch:index,user,publisher:(scenario==='other-publisher'?'e':'f').repeat(64),appId:name,version:BUNDLED_FIXTURES[name].aggregateHash,instanceId:'identity-lists',fixture:name,domains:['identity','storage','theme']};
  const appState=AppState.addEventListener('change',next=>{foreground=next==='active';if(!foreground){broker?.revoke();permission?.dismissPending();}});
  const record=(type:string,response:string|null)=>{if(live){setReadCount(value=>value+1);setReceipt('Identity receipt: '+type+'; calls '+calls+'; frames '+frames+'; cancelled '+cancelled+'; reply '+(response===null?'denied':JSON.parse(response).error?'error':'success'));}};
  const observed:NativeCapabilityPort={take(token){const raw=native.take(token);if(raw)tokens.set(token,JSON.parse(JSON.parse(raw).request).type);return raw;},isActive:native.isActive,finish(token,response){
   const type=tokens.get(token)??'unknown';
   if(scenario==='queued-regrant'&&type==='identity.getMutes'&&response!==null&&!JSON.parse(response).error&&!queued){
    queued=true;const grant=permission?.getSnapshot().grants.find(value=>value.appId===name&&value.user===user);
    if(!grant||!registration){native.finish(token,null);record(type,null);return;}
    void permission!.revoke(grant).then(()=>permission!.authorize(registration!,new AbortController().signal,()=>{if(!live||!foreground)throw Error('Fixture inactive');})).then(check=>{check();if(!native.isActive(token)){setStatus('Queued native ticket expired before reapproval');native.finish(token,null);record(type,null);return;}native.finish(token,response);setReadCount(value=>value+1);setReceipt('Queued native delivery after revoke and reapproval');setStatus('Queued reply handed to revoked native ticket after reapproval');}).catch(()=>{native.finish(token,null);record(type,null);});return;
   }
   native.finish(token,response);record(type,response);
  }};
  const controlled=createNativeRelayQuery({newInstanceId:native.newInstanceId,cancelPublishedRelay(){cancelled++;},async queryPublishedRelay(_id,_url,wire,sub){
   frames++;if(scenario==='background')setStatus('Background identity query pending');const filters=(JSON.parse(wire) as unknown[]).slice(2) as QueryFilter[];
   if(scenario==='owner-epoch'||scenario==='background')await new Promise<void>(resolve=>{timers.push(setTimeout(()=>{if(scenario==='owner-epoch')ownerActive=false;resolve();},scenario==='background'?2200:80));});
   const source=scenario==='bad-badge'?fixture.badEvents:scenario==='bad-signature'?fixture.events.map(event=>({...event,sig:'0'.repeat(128)})):fixture.events;
   return [...source.filter(event=>filters.some(filter=>queryMatches(event,filter))).map(event=>JSON.stringify(['EVENT',sub,event])),JSON.stringify(['EOSE',sub])];
  }},()=>scenario==='offline'?[]:['wss://relay.example.org']);
  stop.current=()=>{live=false;broker?.revoke();permission?.dismissPending();};
  void(async()=>{
   database=await openShellDatabase(SQLite,platform);cache=await openIdentityCache(SQLite,platform);
   permission=await openIdentityListAccess(SQLite,platform,loadIdentityListNativePolicy(),()=>live?user:'');
   if(!live){await permission.close();await cache.close();await database.close();return;}
   const identity=createIdentityDataService(cache,{query(filters,signal,active){calls++;return controlled.query(filters,signal,active);}},()=>Date.now()+(scenario==='primary'||scenario==='other-app'||scenario==='other-user'?0:300001),permission);
   receiver.current=event=>{
    if(event.type!=='capability'){if(event.type==='ready')setStatus('Native public lists connected');return;}
    if(event.sessionId!==configuration.sessionId||event.lane!==undefined)return;
    if(generation===null){generation=event.generation;registration={...configuration,generation} as NativeRegistration;broker=createCapabilityBroker(database!,observed,{registration,assertActive(){if(!live||!foreground||!ownerActive)throw Error('Public lists owner revoked');}},undefined,undefined,undefined,identity);}
    if(generation===event.generation)void broker!.dispatch(event.token);
   };
   config.current=JSON.stringify(configuration);setAccess(permission);setPrepared(true);
  })().catch(()=>{if(live)setStatus('Public list fixture unavailable');});
  return()=>{live=false;appState.remove();broker?.revoke();receiver.current=null;timers.forEach(clearTimeout);void permission?.close();void cache?.close();void database?.close();};
 },[scenario,user,index]);
 return <View style={styles.root}>
  <Text style={styles.text}>{'Public lists case: '+scenario}</Text><Text style={styles.text}>{status}</Text><Text style={styles.text}>{receipt}</Text><Text style={styles.text}>{'Identity request count: '+readCount}</Text>
  <View style={styles.actions}><Pressable accessibilityRole="button" style={styles.button} onPress={()=>setSettings(true)}><Text style={styles.text}>Public list Settings</Text></Pressable>
   {index<cases.length-1&&<Pressable accessibilityRole="button" style={styles.button} onPress={()=>{stop.current?.();setPrepared(false);setAccess(null);setReceipt('No identity receipt');setIndex(value=>value+1);}}><Text style={styles.text}>Next public lists case</Text></Pressable>}</View>
  {prepared&&<Host key={scenario} configuration={config.current} active style={styles.host} onHostEvent={event=>receiver.current?.(event.nativeEvent)}/>}
  <IdentityListReview service={access}/>
  <Modal visible={settings} animationType="none" onRequestClose={()=>setSettings(false)}><SafeAreaProvider><SafeAreaView style={styles.root}><Pressable accessibilityRole="button" style={styles.close} onPress={()=>setSettings(false)}><Text style={styles.text}>Close public list Settings</Text></Pressable><ScrollView contentContainerStyle={{padding:24}}><IdentityListSettings service={access} user={user}/></ScrollView></SafeAreaView></SafeAreaProvider></Modal>
 </View>;
}
const styles=StyleSheet.create({root:{flex:1,backgroundColor:'#140f0b'},host:{flex:1},text:{color:'#f3efeb',fontSize:12,padding:6,textAlign:'center'},actions:{flexDirection:'row'},close:{minHeight:48,justifyContent:'center',backgroundColor:'#34251d'},button:{flex:1,minHeight:48,justifyContent:'center',backgroundColor:'#34251d'}});
function Root(){return <SafeAreaProvider><SafeAreaView style={styles.root}><Lab/></SafeAreaView></SafeAreaProvider>;}
registerRootComponent(Root);
