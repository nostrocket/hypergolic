import { useState } from 'react';
import { Keyboard, ScrollView, StyleSheet, Text } from 'react-native';
import { SettingsComposer, SettingsField, SettingsPrimary, SettingsRoomHeader } from './SettingsRoom';
import { useShellStyles, type ShellFonts, type ShellPalette } from './theme';

type Props<T> = {
  title: string; help: string; unavailable: string; invalid: string;
  field: { label: string; id: string; multiline?: boolean };
  save: { label: string; id: string };
  restore: { label: string; id: string };
  statusID: string;
  parse(input: string): T;
  saved(value: string): string;
  store: { read(): string; write(value: T): Promise<void>; restore(): Promise<void> } | null;
  onBack(): void;
};

function parsed<T>(input: string, parse: (input: string) => T) {
  try { return { value: parse(input) }; }
  catch { return undefined; }
}

export function BlossomSettings<T>({ title, help, unavailable, invalid, field, save, restore, statusID, parse, saved, store, onBack }: Props<T>) {
  const { styles } = useShellStyles(createStyles);
  const [input, setInput] = useState(() => store?.read() ?? '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const value = parsed(input, parse);
  const error = !value || status === invalid;
  const feedback = value ? status : invalid;
  const update = async (defaults: boolean) => {
    if (!store || busy || (!defaults && !value)) return;
    setBusy(true);
    setStatus('');
    try {
      if (defaults) await store.restore();
      else if (value) await store.write(value.value);
      const stored = store.read();
      setInput(stored);
      setStatus(saved(stored));
      Keyboard.dismiss();
    } catch { setStatus(invalid); }
    finally { setBusy(false); }
  };
  const apply = () => { void update(false); };
  const action = { label: restore.label, testID: restore.id, disabled: busy, onPress: () => { void update(true); } };
  return <>
    <SettingsRoomHeader title={title} onBack={onBack} {...(store && { action })} />
    <ScrollView style={styles.body} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.detail}>{help}</Text>
      {!store && <Text style={styles.detail}>{unavailable}</Text>}
    </ScrollView>
    {store && <SettingsComposer>
      <SettingsField accessibilityLabel={field.label} testID={field.id} value={input} autoCapitalize="none" autoCorrect={false}
        autoComplete="off" editable={!busy} onChangeText={text => { setInput(text); setStatus(''); }}
        multiline={!!field.multiline} style={field.multiline && styles.multiline}
        {...(field.multiline ? { textAlignVertical: 'top' } : { keyboardType: 'url', returnKeyType: 'done', submitBehavior: 'submit', onSubmitEditing: apply })} />
      {feedback !== '' && <Text accessibilityLiveRegion="polite" testID={statusID} style={[styles.detail, error && styles.error]}>{feedback}</Text>}
      <SettingsPrimary label={save.label} testID={save.id} disabled={busy || !value} onPress={apply} />
    </SettingsComposer>}
  </>;
}

const createStyles = (c: ShellPalette, f: ShellFonts) => StyleSheet.create({
  body: { flex: 1 },
  content: { paddingHorizontal: 24, gap: 12 },
  detail: { fontFamily: f.body, fontSize: 15, lineHeight: 20, color: c.muted },
  error: { color: c.accent },
  multiline: { height: 108 },
});
