import { registerRootComponent, requireNativeView } from 'expo';
import * as SQLite from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type NativeSyntheticEvent, type ViewProps } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { createCapabilityBroker } from '../../../src/runtime/capability-broker';
import { loadNativeCapabilityPort } from '../../../src/runtime/native-capability-port';
import { loadNativeResourceHost } from '../../../src/resources/native-resource-port';
import { openNativeResourceSettings, type NativeResourceSettings } from '../../../src/resources/resource-settings-native';
import { ResourceMatrix } from './matrix';
import { ResourceSettings } from '../../../src/shell/ResourceSettings';
import { loadNativeRelayQuery } from '../../../src/network/native-relay-query-port';
import { BUNDLED_FIXTURES } from '../../../src/runtime/bundled-catalog';
import { openShellDatabase } from '../../../src/storage/database';
import type { NativeRegistration } from '../../../src/runtime/capability-protocol';
import type { NativeCapabilityEvent } from '../../../src/runtime/runtime-owner';

type Event = NativeCapabilityEvent | {type:'ready'|'error';sessionId:string};
const Host = requireNativeView<ViewProps & {configuration:string;active:boolean;onHostEvent:(event:NativeSyntheticEvent<Event>)=>void}>('HypergolicNappletHost');
// Public scalar-2 public key only. No identity store, signer, publication or secret exists in this fixture.
const configuration = Object.freeze({ sessionId:'resource-native',epoch:0,
  user:'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5', publisher:'f'.repeat(64),
  appId:'resource-lab',version:BUNDLED_FIXTURES['resource-lab'].aggregateHash,instanceId:'resource-native',fixture:'resource-lab',domains:['resource','link','theme'] });
function Fixture() {
  const [settingsVisible,setSettingsVisible]=useState(false),[settings,setSettings]=useState<NativeResourceSettings|null>(null);
  const [focused,setFocused]=useState(true);
  const [visible,setVisible]=useState(true),[generation,setGeneration]=useState(0),[prepared,setPrepared]=useState(false),[status,setStatus]=useState('Opening resource fixture…');
  const receiver=useRef<((event:Event)=>void)|null>(null);
  const stop=useRef<(()=>void)|null>(null);
  useEffect(()=> {
    setPrepared(false);
    setSettings(null);
    let closeDatabase:(()=>Promise<void>)|null=null, closeSettings:(()=>Promise<void>)|null=null;
    let live=true;let broker:ReturnType<typeof createCapabilityBroker>|null=null;let nativeGeneration:string|null=null;
    const native=loadNativeCapabilityPort(), queries=loadNativeRelayQuery(()=>['wss://nos.lol']);

    const platform=Platform.OS==='ios'?'ios':'android';
    void openShellDatabase(SQLite,platform).then(async database=> {
      let resourceSettings:NativeResourceSettings;
      try {resourceSettings=await openNativeResourceSettings(SQLite);}
      catch(error) {await database.close();throw error;}
      closeSettings=()=>resourceSettings.close();
      const resources=loadNativeResourceHost(()=>resourceSettings.servers(),queries);
      if(!live){void database.close();void resourceSettings.close();return;}
      setSettings(resourceSettings);
      closeDatabase=()=>database.close();
      receiver.current=event=> {
        if(event.type!=='capability'){if(event.type==='error')broker?.revoke();setStatus(event.type==='ready'?'Native host connected':'Native host failed');return;}
        if(event.sessionId!==configuration.sessionId||event.lane!==undefined)return;
        if(nativeGeneration===null){nativeGeneration=event.generation;broker=createCapabilityBroker(database,native,{registration:{...configuration,generation:nativeGeneration} as NativeRegistration,assertActive(){if(!live)throw new Error('fixture revoked');}},queries,undefined,resources);}
        if(event.generation===nativeGeneration)void broker!.dispatch(event.token);
      };
      stop.current=()=>{live=false;broker?.revoke();receiver.current=null;};
      setPrepared(true);setStatus('Resource fixture ready');
    }).catch(()=>setStatus('Resource fixture unavailable'));
    return()=>{live=false;broker?.revoke();receiver.current=null;void closeDatabase?.();void closeSettings?.();};
  },[generation]);
  const toggle=()=> {
    if(visible){stop.current?.();setVisible(false);setStatus('Resource Lab closed');}
    else{setFocused(true);setPrepared(false);setGeneration(value=>value+1);setVisible(true);}
  };
  return <View style={styles.root}>
    <Text style={styles.notice}>Read-only resource fixture · public identity · no signing</Text>
    <Text testID="resource-native-status" style={styles.notice}>{status}</Text>
    <Pressable accessibilityRole="button" onPress={toggle} style={styles.button}><Text style={styles.label}>{visible?'Close Resource Lab':'Open Resource Lab'}</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={()=>setSettingsVisible(value=>!value)} style={styles.button}><Text style={styles.label}>{settingsVisible?'Return to Resource Lab':'Download settings'}</Text></Pressable>
    {settingsVisible?<View style={styles.settings}><ResourceSettings service={settings}/></View>:null}
    {visible?<Pressable accessibilityRole="button" onPress={()=>setFocused(value=>!value)} style={styles.button}><Text style={styles.label}>{focused?'Hide Resource Lab':'Show Resource Lab'}</Text></Pressable>:null}
    {visible&&prepared?<Host key={generation} configuration={JSON.stringify(configuration)} active={focused&&!settingsVisible} onHostEvent={event=>receiver.current?.(event.nativeEvent)} style={styles.host}/>:null}
  </View>;
}
const styles=StyleSheet.create({settings:{padding:16},root:{flex:1,backgroundColor:'#140f0b'},host:{flex:1},notice:{color:'#f3efeb',fontSize:12,padding:8,textAlign:'center'},button:{minHeight:48,justifyContent:'center',alignItems:'center',backgroundColor:'#34251d'},label:{color:'#e8805d',fontSize:16}});
function Root() {
  const [diagnostics,setDiagnostics]=useState(false);
  return <SafeAreaProvider><SafeAreaView style={styles.root}>{diagnostics?<ResourceMatrix/>:<Fixture/>}<Pressable accessibilityRole="button" style={styles.button} onPress={()=>setDiagnostics(value=>!value)}><Text style={styles.label}>{diagnostics?'Return to resource journey':'Resource diagnostics'}</Text></Pressable></SafeAreaView></SafeAreaProvider>;
}
registerRootComponent(Root);
