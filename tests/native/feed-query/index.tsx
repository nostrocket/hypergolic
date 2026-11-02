import { QueryMatrix } from './matrix';
import { registerRootComponent, requireNativeView } from 'expo';
import * as SQLite from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type NativeSyntheticEvent, type ViewProps } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { createCapabilityBroker } from '../../../src/runtime/capability-broker';
import { loadNativeCapabilityPort } from '../../../src/runtime/native-capability-port';
import { loadNativeRelayQuery } from '../../../src/network/native-relay-query-port';
import { BUNDLED_FIXTURES } from '../../../src/runtime/bundled-catalog';
import { openShellDatabase } from '../../../src/storage/database';
import type { NativeRegistration } from '../../../src/runtime/capability-protocol';
import type { NativeCapabilityEvent } from '../../../src/runtime/runtime-owner';

type Event = NativeCapabilityEvent | {type:'ready'|'error';sessionId:string};
const Host = requireNativeView<ViewProps & {configuration:string;active:boolean;onHostEvent:(event:NativeSyntheticEvent<Event>)=>void}>('HypergolicNappletHost');
// Public scalar-2 public key only. No identity store, signer, publication or secret exists in this fixture.
const configuration = Object.freeze({ sessionId:'feed-query-native',epoch:0,
  user:'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5', publisher:'f'.repeat(64),
  appId:'feed-lab',version:BUNDLED_FIXTURES['feed-lab'].aggregateHash,instanceId:'feed-query-native',fixture:'feed-lab',domains:['identity','relay','theme'] });
function Fixture() {
  const [visible,setVisible]=useState(true),[generation,setGeneration]=useState(0),[prepared,setPrepared]=useState(false),[status,setStatus]=useState('Opening query fixture…');
  const receiver=useRef<((event:Event)=>void)|null>(null);
  const stop=useRef<(()=>void)|null>(null);
  useEffect(()=> {
    setPrepared(false);
    let closeDatabase:(()=>Promise<void>)|null=null;
    let live=true;let broker:ReturnType<typeof createCapabilityBroker>|null=null;let nativeGeneration:string|null=null;
    const native=loadNativeCapabilityPort(), queries=loadNativeRelayQuery(()=>['wss://nos.lol']);
    const platform=Platform.OS==='ios'?'ios':'android';
    void openShellDatabase(SQLite,platform).then(database=> {
      if(!live){void database.close();return;}
      closeDatabase=()=>database.close();
      receiver.current=event=> {
        if(event.type!=='capability'){if(event.type==='error')broker?.revoke();setStatus(event.type==='ready'?'Native host connected':'Native host failed');return;}
        if(event.sessionId!==configuration.sessionId||event.lane!==undefined)return;
        if(nativeGeneration===null){nativeGeneration=event.generation;broker=createCapabilityBroker(database,native,{registration:{...configuration,generation:nativeGeneration} as NativeRegistration,assertActive(){if(!live)throw new Error('fixture revoked');}},queries);}
        if(event.generation===nativeGeneration)void broker!.dispatch(event.token);
      };
      stop.current=()=>{live=false;broker?.revoke();receiver.current=null;};
      setPrepared(true);setStatus('Query fixture ready');
    }).catch(()=>setStatus('Query fixture unavailable'));
    return()=>{live=false;broker?.revoke();receiver.current=null;void closeDatabase?.();};
  },[generation]);
  const toggle=()=> {
    if(visible){stop.current?.();setVisible(false);setStatus('Feed Lab closed');}
    else{setPrepared(false);setGeneration(value=>value+1);setVisible(true);}
  };
  return <View style={styles.root}>
    <Text style={styles.notice}>Read-only query fixture · public identity · no signing</Text>
    <Text testID="query-native-status" style={styles.notice}>{status}</Text>
    <Pressable accessibilityRole="button" onPress={toggle} style={styles.button}><Text style={styles.label}>{visible?'Close Feed Lab':'Open Feed Lab'}</Text></Pressable>
    {visible&&prepared?<Host key={generation} configuration={JSON.stringify(configuration)} active onHostEvent={event=>receiver.current?.(event.nativeEvent)} style={styles.host}/>:null}
  </View>;
}
const styles=StyleSheet.create({root:{flex:1,backgroundColor:'#140f0b'},host:{flex:1},notice:{color:'#f3efeb',fontSize:12,padding:8,textAlign:'center'},button:{minHeight:48,justifyContent:'center',alignItems:'center',backgroundColor:'#34251d'},label:{color:'#e8805d',fontSize:16}});
function Root() {
  const [matrix,setMatrix]=useState(false);
  if(matrix)return <SafeAreaProvider><SafeAreaView style={styles.root}><QueryMatrix/></SafeAreaView></SafeAreaProvider>;
  return <SafeAreaProvider><SafeAreaView style={styles.root}><Pressable accessibilityRole="button" style={styles.button} onPress={()=>setMatrix(true)}><Text style={styles.label}>Controlled query faults</Text></Pressable><Fixture/></SafeAreaView></SafeAreaProvider>;
}
registerRootComponent(Root);
