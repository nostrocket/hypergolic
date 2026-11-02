import {registerRootComponent} from 'expo';
import {useState} from 'react';
import {Pressable,StyleSheet,Text,View} from 'react-native';
import {SafeAreaProvider,SafeAreaView} from 'react-native-safe-area-context';
import {ApprovalSheet} from '../../../../src/shell/ApprovalSheet';
import {PublicationReceiptSheet} from '../../../../src/shell/PublicationReceiptSheet';
import {colors} from '../../../../src/shell/theme';
import {captureEventSnapshot} from '../../../../src/security/event-snapshot';
import {validateSignedEvent} from '../../../../src/security/signed-event';
import {captureOutboxPublicationReceipt,type OutboxPublicationReceipt} from '../../../../src/outbox/publication-receipt';
import type {ApprovalItem} from '../../../../src/security/approval-service';
import type {OutboxPublicationPlan} from '../../../../src/outbox/publication-plan';
import fixtures from './fixtures.json';

const snapshot=captureEventSnapshot(fixtures.plan.event.event,fixtures.plan.event.selectedPubkey,fixtures.plan.event.destinations);
const primary=validateSignedEvent(snapshot,fixtures.primary),ancillary=validateSignedEvent(captureEventSnapshot({kind:fixtures.list.kind,content:fixtures.list.content,tags:fixtures.list.tags,created_at:fixtures.list.created_at},primary.pubkey,snapshot.destinations),fixtures.list);
const plan:OutboxPublicationPlan=Object.freeze<OutboxPublicationPlan>({requestId:fixtures.plan.requestId,event:snapshot,ownSource:'nip65',ancillary,
  requiredInboxes:[snapshot.destinations[1]!],destinations:[{relay:snapshot.destinations[0]!,sources:[{kind:'own',author:primary.pubkey}]},{relay:snapshot.destinations[1]!,sources:[{kind:'inbox',author:'a'.repeat(64)},{kind:'explicit'}]}]});
const item:ApprovalItem=Object.freeze({id:'outbox-review-presentation',requestId:plan.requestId,event:snapshot,outbox:plan,
  origin:{generation:'presentation-only',sessionId:'outbox-review',instanceId:'outbox-review',fixture:'feed-lab',epoch:0,user:primary.pubkey,publisher:'f'.repeat(64),appId:'feed-lab',version:'e'.repeat(64),domains:['identity','outbox','relay','theme']}});
function receipt(unknown:boolean):OutboxPublicationReceipt {
  const primaryRows=snapshot.destinations.map((relay,index)=>({relay,eventId:primary.id,status:unknown&&index===1?'unknown' as const:'accepted' as const,reason:unknown&&index===1?'relay acknowledgement unavailable':'stored'}));
  const listRows=snapshot.destinations.map((relay,index)=>({relay,eventId:ancillary.id,status:index===1?'cancelled-before-send' as const:'rejected' as const,reason:index===1?'publication stopped before send':'blocked: fixture policy'}));
  return captureOutboxPublicationReceipt(plan,primary,primaryRows,listRows);
}
/** Native presentation only. No source admission, signer, protected identity or network effect. */
function Fixture(){
 const [review,setReview]=useState(false),[result,setResult]=useState<OutboxPublicationReceipt|null>(null);
 return <SafeAreaView style={styles.root}><Text style={styles.title}>Outbox review fixture</Text><Text style={styles.text}>Presentation only · no signing or publication</Text>
  <Pressable accessibilityRole="button" style={styles.button} onPress={()=>setReview(true)}><Text style={styles.text}>Review destinations</Text></Pressable>
  <Pressable accessibilityRole="button" style={styles.button} onPress={()=>setResult(receipt(false))}><Text style={styles.text}>Show successful primary</Text></Pressable>
  <Pressable accessibilityRole="button" style={styles.button} onPress={()=>setResult(receipt(true))}><Text style={styles.text}>Show required inbox unknown</Text></Pressable>
  <ApprovalSheet item={review?item:null} nappletTitle="Feed Lab presentation fixture" busy={false} error={null} onApprove={()=>{setReview(false);setResult(receipt(true));}} onReject={()=>setReview(false)} onDismiss={()=>setReview(false)}/>
  {result&&<PublicationReceiptSheet receipt={result} onDismiss={()=>setResult(null)}/>}<View/>
 </SafeAreaView>;
}
function App(){return <SafeAreaProvider><Fixture/></SafeAreaProvider>;}
const styles=StyleSheet.create({root:{flex:1,backgroundColor:colors.background,padding:24,gap:18},title:{color:colors.text,fontSize:25,fontWeight:'700'},text:{color:colors.text,fontSize:16,lineHeight:24},button:{minHeight:52,backgroundColor:colors.raised,padding:16,borderRadius:12}});
registerRootComponent(App);
