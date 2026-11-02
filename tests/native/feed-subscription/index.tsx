import {registerRootComponent,requireNativeView} from 'expo';
import * as SQLite from 'expo-sqlite';
import {useEffect,useRef,useState} from 'react';
import {AppState,Platform,Pressable,StyleSheet,Text,View,type NativeSyntheticEvent,type ViewProps} from 'react-native';
import {SafeAreaProvider,SafeAreaView} from 'react-native-safe-area-context';
import {loadNativeCapabilityPort} from '../../../src/runtime/native-capability-port';
import {createCapabilityBroker} from '../../../src/runtime/capability-broker';
import {createRelaySubscriptionBroker} from '../../../src/runtime/relay-subscription-broker';
import {attachNativeRelayLifecycle,loadNativeRelayStreamPort} from '../../../src/network/native-relay-subscription-port';
import {createRelaySubscriptions} from '../../../src/network/relay-subscriptions';
import {loadNativeRelayQuery} from '../../../src/network/native-relay-query-port';
import {openShellDatabase} from '../../../src/storage/database';
import {BUNDLED_FIXTURES} from '../../../src/runtime/bundled-catalog';
import {StreamMatrix} from './matrix';
import type {NativeCapabilityEvent} from '../../../src/runtime/runtime-owner';

// Public key only. No signing, identity vault or publication in this standalone fixture.
const user='c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
type Event=NativeCapabilityEvent|{type:'ready'|'error';sessionId:string};
const Host=requireNativeView<ViewProps&{configuration:string;active:boolean;onHostEvent:(event:NativeSyntheticEvent<Event>)=>void}>('HypergolicNappletHost');
const stats={open:0,stop:0,frames:0,eose:0,background:0,foreground:0};
let manager:ReturnType<typeof createRelaySubscriptions>|null=null;
function FixtureHost({name,instance,active,ownerEpoch}:{name:string;instance:number;active:boolean;ownerEpoch:number}) {
  const [configuration]=useState(()=>({sessionId:'feed-stream-'+name+'-'+instance,epoch:ownerEpoch,user,publisher:'f'.repeat(64),appId:'feed-lab',
    version:BUNDLED_FIXTURES['feed-lab'].aggregateHash,instanceId:'feed-stream-'+name+'-'+instance,fixture:'feed-lab',domains:['identity','relay','theme']}));
  const receive=useRef<((event:Event)=>void)|null>(null);
  const [ready,setReady]=useState(false);
  useEffect(()=> {
    let live=true,broker:ReturnType<typeof createCapabilityBroker>|null=null,streams:ReturnType<typeof createRelaySubscriptionBroker>|null=null,generation:string|null=null;
    let closeDatabase:(()=>Promise<void>)|null=null;
    const native=loadNativeCapabilityPort(),queries=loadNativeRelayQuery(()=>['wss://nos.lol']);
    void openShellDatabase(SQLite,Platform.OS==='ios'?'ios':'android').then(database=> {
      if(!live){void database.close();return;}
      closeDatabase=()=>database.close();
      receive.current=event=> {
        if(event.type!=='capability'){if(event.type==='error'){broker?.revoke();streams?.revoke();}return;}
        if(event.sessionId!==configuration.sessionId)return;
        if(generation===null) {
          generation=event.generation;
          const owner={registration:{...configuration,generation},assertActive(){if(!live)throw new Error('Public fixture owner revoked');}};
          streams=createRelaySubscriptionBroker(native.subscriptions!,manager!,owner);
          broker=createCapabilityBroker(database,native,owner,queries,request=>streams?.close(request));
        }
        if(event.generation!==generation)return;
        if(event.lane==='subscription')streams!.dispatch(event.token);else if(event.lane===undefined)void broker!.dispatch(event.token);
      };
      setReady(true);
    });
    return()=>{live=false;streams?.revoke();broker?.revoke();receive.current=null;void closeDatabase?.();};
  },[configuration]);
  return ready?<Host configuration={JSON.stringify(configuration)} active={active} onHostEvent={event=>receive.current?.(event.nativeEvent)} style={styles.nativeHost}/>:null;
}
function Fixture() {
  const [prepared,setPrepared]=useState(false),[focus,setFocus]=useState('A'),[open,setOpen]=useState({A:true,B:false}),[instance,setInstance]=useState({A:1,B:1}),[epoch,setEpoch]=useState(0),[receipt,setReceipt]=useState('');
  useEffect(()=> {
    const port=loadNativeRelayStreamPort();
    manager=createRelaySubscriptions({...port,open(...args){stats.open++;const stop=port.open(args[0],args[1],args[2],args[3],text=>{stats.frames++;if(JSON.parse(text)[0]==='EOSE')stats.eose++;args[4](text);},args[5],args[6]);let ended=false;return()=>{if(!ended){ended=true;stats.stop++;stop();}};}},()=>['wss://nos.lol']);
    const detach=attachNativeRelayLifecycle(manager);
    const lifecycle=AppState.addEventListener('change',state=>{if(state==='active')stats.foreground++;else stats.background++;});
    setPrepared(true);
    return()=>{lifecycle.remove();detach();manager?.revokeAll();manager=null;};
  },[]);
  const snapshot=()=>setReceipt(`Streams opened ${stats.open}, stopped ${stats.stop}, frames ${stats.frames}, EOSE ${stats.eose}, background ${stats.background}, foreground ${stats.foreground}`);
  const switchFeed=()=>{const next=focus==='A'?'B':'A';setOpen(value=>({...value,[next]:true}));setFocus(next);};
  const toggle=()=>{const key=focus as 'A'|'B';if(!open[key])setInstance(value=>({...value,[key]:value[key]+1}));setOpen(value=>({...value,[key]:!value[key]}));};
  return <View style={styles.root}>
    <Text style={styles.notice}>Read-only live feed · public fixture owner</Text>
    <Text style={styles.notice}>Feed {focus} foreground · owner {epoch}</Text>
    <View style={styles.actions}><Pressable accessibilityRole="button" onPress={switchFeed} style={styles.button}><Text style={styles.label}>Switch feed</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={toggle} style={styles.button}><Text style={styles.label}>{open[focus as 'A'|'B']?'Close':'Open'} feed {focus}</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={()=>{setOpen({A:false,B:false});setEpoch(value=>value+1);}} style={styles.button}><Text style={styles.label}>Change public owner</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={snapshot} style={styles.button}><Text style={styles.label}>Read stream counters</Text></Pressable></View>
    <Text style={styles.notice}>{receipt}</Text>
    <View style={styles.host}>{prepared&&(['A','B'] as const).map(name=>open[name]?<View collapsable={false} key={name+'-'+instance[name]+'-'+epoch} pointerEvents={focus===name?'auto':'none'} accessibilityElementsHidden={focus!==name} importantForAccessibility={focus===name?'auto':'no-hide-descendants'} style={[styles.fill,focus!==name&&styles.hidden]}>
      <FixtureHost name={name} instance={instance[name]} active={focus===name} ownerEpoch={epoch}/></View>:null)}</View>
  </View>;
}
const styles=StyleSheet.create({root:{flex:1,backgroundColor:'#140f0b'},host:{flex:1},nativeHost:{flex:1},fill:{...StyleSheet.absoluteFill},hidden:{opacity:0},notice:{color:'#f3efeb',fontSize:11,padding:5,textAlign:'center'},actions:{flexDirection:'row',flexWrap:'wrap',justifyContent:'center'},button:{minHeight:44,padding:8,justifyContent:'center',alignItems:'center',backgroundColor:'#34251d'},label:{color:'#e8805d',fontSize:13}});
function Root(){const [matrix,setMatrix]=useState(false);return <SafeAreaProvider><SafeAreaView style={styles.root}>{matrix?<StreamMatrix/>:<><Pressable accessibilityRole="button" style={styles.button} onPress={()=>setMatrix(true)}><Text style={styles.label}>Controlled stream faults</Text></Pressable><Fixture/></>}</SafeAreaView></SafeAreaProvider>;}
registerRootComponent(Root);
