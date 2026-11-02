import {requireNativeView} from 'expo';
import * as SQLite from 'expo-sqlite';
import {useEffect,useRef,useState} from 'react';
import {Platform,Pressable,StyleSheet,Text,View,type NativeSyntheticEvent,type ViewProps} from 'react-native';
import {loadNativeCapabilityPort} from '../../../src/runtime/native-capability-port';
import {createCapabilityBroker} from '../../../src/runtime/capability-broker';
import {createRelaySubscriptionBroker,type NativeRelaySubscriptionPort} from '../../../src/runtime/relay-subscription-broker';
import {createRelaySubscriptions} from '../../../src/network/relay-subscriptions';
import {openShellDatabase} from '../../../src/storage/database';
import {BUNDLED_FIXTURES} from '../../../src/runtime/bundled-catalog';
import type {NativeCapabilityEvent} from '../../../src/runtime/runtime-owner';
import events from '../feed-query/events.json';
import afterEOSE from './after-eose.json';

type HostEvent=NativeCapabilityEvent|{type:'ready'|'error';sessionId:string};
const Host=requireNativeView<ViewProps&{configuration:string;active:boolean;onHostEvent:(event:NativeSyntheticEvent<HostEvent>)=>void}>('HypergolicNappletHost');
export const STREAM_CASES=['signed-live','duplicate','bad-signature','wrong-filter','foreign-sub','frame-flood','oversized-frame','view-revoke','paused-owner-revoke'] as const;
type Scenario=typeof STREAM_CASES[number];
const config={sessionId:'stream-matrix',instanceId:'stream-matrix',epoch:0,user:'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',publisher:'f'.repeat(64),appId:'feed-lab',version:BUNDLED_FIXTURES['feed-lab'].aggregateHash,fixture:'feed-lab',domains:['identity','relay','theme']};
function frames(scenario:Scenario,sub:string):string[] {
  const event=(value:unknown,recipient=sub)=>JSON.stringify(['EVENT',recipient,value]);
  const eose=JSON.stringify(['EOSE',sub]);
  if(scenario==='bad-signature')return[event({...events[0],sig:'0'.repeat(128)})];
  if(scenario==='wrong-filter')return[event(events[1])];
  if(scenario==='foreign-sub')return[event(events[0],'foreign')];
  if(scenario==='frame-flood')return Array.from({length:65},()=>JSON.stringify(['NOTICE','diagnostic']));
  if(scenario==='oversized-frame')return['x'.repeat(66*1024+1)];
  if(scenario==='duplicate')return[event(events[0]),event(events[0]),eose];
  return[event(events[0]),eose,event(afterEOSE)];
}
/** Only frame input is doubled. Native admission, captured push, SDK and production validators stay real. */
function useCase(scenario:Scenario) {
  const [prepared,setPrepared]=useState(false),[visible,setVisible]=useState(true),[receipt,setReceipt]=useState('Waiting for SDK subscription');
  const receive=useRef<((event:HostEvent)=>void)|null>(null);
  useEffect(()=> {
    let live=true,ownerActive=true,generation:string|null=null,streams:ReturnType<typeof createRelaySubscriptionBroker>|null=null,ordinary:ReturnType<typeof createCapabilityBroker>|null=null;
    let closeDatabase:(()=>Promise<void>)|null=null;
    const timers:ReturnType<typeof setTimeout>[]=[],later=(work:()=>void,ms:number)=>timers.push(setTimeout(work,ms));
    let calls=0,cancelled=0,late=0,eventReplies=0,eoseReplies=0,closedReplies=0;
    const base=loadNativeCapabilityPort(),port=base.subscriptions!;
    const native:NativeRelaySubscriptionPort={...port,send(token,response){const result=port.send(token,response);if(result===true){const type=JSON.parse(response).type;if(type==='relay.event')eventReplies++;else if(type==='relay.eose')eoseReplies++;else if(type==='relay.closed')closedReplies++;}return result;}};
    const revoked=scenario==='view-revoke'||scenario==='paused-owner-revoke';
    const manager=createRelaySubscriptions({newInstanceId:base.newInstanceId,open(_id,_url,_request,sub,frame){
      calls++;let stopped=false;
      if(revoked) {
        later(()=>{if(scenario==='paused-owner-revoke')manager.setForeground(false);ownerActive=false;if(scenario==='view-revoke'){streams?.revoke();setVisible(false);}},40);
        later(()=>{manager.setForeground(true);},100);
        later(()=>{late++;frames(scenario,sub).forEach(frame);},220);
      }else later(()=>frames(scenario,sub).forEach(frame),10);
      later(()=> {
        const valid=calls===1&&cancelled===(scenario==='signed-live'||scenario==='duplicate'?0:1)&&late===(revoked?1:0)&&
          eventReplies===(scenario==='signed-live'?2:scenario==='duplicate'?1:0)&&eoseReplies===(scenario==='signed-live'||scenario==='duplicate'?1:0)&&closedReplies===(revoked||scenario==='signed-live'||scenario==='duplicate'?0:1);
        if(live)setReceipt(`${valid?'PASS':'FAIL'} ${scenario}: calls ${calls}, cancel ${cancelled}, late ${late}, events ${eventReplies}, EOSE ${eoseReplies}, closed ${closedReplies}`);
      },450);
      return()=>{if(!stopped){stopped=true;cancelled++;}};
    }},()=>['wss://relay.example.org']);
    void openShellDatabase(SQLite,Platform.OS==='ios'?'ios':'android').then(database=> {
      if(!live){void database.close();return;}closeDatabase=()=>database.close();
      receive.current=event=> {
        if(event.type!=='capability'||event.sessionId!==config.sessionId)return;
        if(generation===null) {
          generation=event.generation;const owner={registration:{...config,generation},assertActive(){if(!live||!ownerActive)throw new Error('Diagnostic owner revoked');}};
          streams=createRelaySubscriptionBroker(native,manager,owner);ordinary=createCapabilityBroker(database,base,owner,undefined,request=>streams?.close(request));
        }
        if(generation!==event.generation)return;
        if(event.lane==='subscription')streams!.dispatch(event.token);else if(event.lane===undefined)void ordinary!.dispatch(event.token);
      };
      setVisible(true);setPrepared(true);setReceipt('Waiting for SDK subscription');
    }).catch(()=>setReceipt('FAIL database unavailable'));
    return()=>{live=false;ownerActive=false;streams?.revoke();ordinary?.revoke();manager.revokeAll();receive.current=null;timers.forEach(clearTimeout);void closeDatabase?.();};
  },[scenario]);
  return{prepared,visible,receipt,receive};
}
export function StreamMatrix() {
  const [index,setIndex]=useState(0),scenario=STREAM_CASES[index]!;
  return <MatrixCase key={scenario} scenario={scenario} next={index<STREAM_CASES.length-1?()=>setIndex(value=>value+1):null}/>;
}
function MatrixCase({scenario,next}:{scenario:Scenario;next:(()=>void)|null}) {
  const state=useCase(scenario);
  return <View style={styles.root}><Text style={styles.text}>Controlled stream · {scenario}</Text><Text style={styles.text}>{state.receipt}</Text>
    {next?<Pressable accessibilityRole="button" onPress={next} style={styles.button}><Text style={styles.text}>Next stream case</Text></Pressable>:null}
    {state.prepared&&state.visible?<Host configuration={JSON.stringify(config)} active onHostEvent={event=>state.receive.current?.(event.nativeEvent)} style={styles.host}/>:null}
  </View>;
}
const styles=StyleSheet.create({root:{flex:1,backgroundColor:'#140f0b'},host:{flex:1},text:{color:'#f3efeb',fontSize:12,padding:8,textAlign:'center'},button:{minHeight:44,backgroundColor:'#34251d',justifyContent:'center'}});
