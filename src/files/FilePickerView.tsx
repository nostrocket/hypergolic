import {memo, useCallback, useEffect, useState, useSyncExternalStore} from 'react';
import {AppState, Button, FlatList, StyleSheet, Text, TextInput, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {ShellModal} from '../shell/ShellModal';
import {useShellStyles, type ShellPalette, type ShellFonts} from '../shell/theme';
import {filePicker} from './file-picker';

const DocumentRow = memo(function DocumentRow({name,select}: {name:string; select:(name:string)=>void}) {
  const choose = useCallback(() => select(name),[name, select]);
  return <Button title={name} onPress={choose} />;
});
const rowKey = (name:string) => name;

function DocumentSelection({choice}: {choice: NonNullable<ReturnType<typeof filePicker.snapshot>>}) {
  const [editedName,setName] = useState<string | null>(null);
  const name = editedName ?? choice.suggestedName;
  const {styles} = useShellStyles(createStyles);
  const select = useCallback((entry:string) => {
    if (choice.save) setName(entry); else choice.finish(entry);
  },[choice]);
  const renderDocument = useCallback(({item}: {item:string}) => <DocumentRow name={item} select={select} />,[select]);
  useEffect(() => {
    const listener = AppState.addEventListener('change',state => { if (state !== 'active') choice.finish(null); });
    return () => listener.remove();
  },[choice]);
  return <ShellModal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => choice.finish(null)}>
    <SafeAreaView style={styles.screen}>
      <View style={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>{choice.save ? 'Choose a save location' : 'Open a document'}</Text>
        <Text style={styles.label}>Documents for {choice.app}</Text>
        <FlatList keyboardShouldPersistTaps="handled" data={choice.names} keyExtractor={rowKey} renderItem={renderDocument}
          ListEmptyComponent={choice.save ? undefined : <Text style={styles.label}>This folder is empty.</Text>} />
        {choice.save && <><TextInput accessibilityLabel="File name" style={styles.input} value={name} onChangeText={setName} maxLength={255} />
          <Button title="Choose file" disabled={!name} onPress={() => choice.finish(name)} /></>}
        <Button title="Cancel" onPress={() => choice.finish(null)} />
      </View>
    </SafeAreaView>
  </ShellModal>;
}

export function FilePickerView() {
  const choice = useSyncExternalStore(filePicker.subscribe,filePicker.snapshot);
  return choice ? <DocumentSelection choice={choice} /> : null;
}
const createStyles = (colors:ShellPalette, fonts:ShellFonts) => StyleSheet.create({
  screen:{flex:1,backgroundColor:colors.background},
  content:{flex:1,gap:12,padding:20},
  title:{fontFamily:fonts.strong,fontSize:22,color:colors.text},
  label:{fontFamily:fonts.body,fontSize:16,color:colors.muted},
  input:{padding:10,borderWidth:1,borderColor:colors.border,color:colors.text},
});
