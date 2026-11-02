/** Test-only local signed samples; uses ordinary IdentityEntry and real protected vault. */
import {registerRootComponent} from 'expo';
import {useState} from 'react';
import {Pressable,StyleSheet,Text,View} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {SafeAreaProvider,SafeAreaView} from 'react-native-safe-area-context';
import {IdentityEntry} from '../../../src/shell/IdentityEntry';
import {NOTIFICATION_SAMPLES,offerNotificationUpdate} from './protected-notify-source';
function ProtectedNotificationFixture() {
  const [offered,setOffered]=useState(false);
  return <GestureHandlerRootView style={styles.root}><SafeAreaProvider><View style={styles.root}>
    <SafeAreaView edges={['top']}><Text style={styles.notice}>Signed local notification samples; real protected identity.</Text>
      {NOTIFICATION_SAMPLES.map(row=><Text key={row.role} testID={'signed-'+row.role+'-address'} accessibilityLabel={row.address} numberOfLines={1} style={styles.address}>{row.address}</Text>)}
      <Pressable accessibilityRole="button" testID="qa-offer-notify-update" onPress={()=>{offerNotificationUpdate();setOffered(true);}}><Text style={styles.offer}>{offered ? 'Distinct signed notification version available.' : 'Offer signed notification update'}</Text></Pressable>
    </SafeAreaView><IdentityEntry /></View></SafeAreaProvider></GestureHandlerRootView>;
}
const styles=StyleSheet.create({root:{flex:1,backgroundColor:'#140f0b'},notice:{color:'#f3efeb',fontSize:10,padding:4,textAlign:'center'},offer:{color:'#e8805d',padding:10,textAlign:'center'},address:{color:'#f3efeb',fontSize:8,paddingHorizontal:8}});
registerRootComponent(ProtectedNotificationFixture);
