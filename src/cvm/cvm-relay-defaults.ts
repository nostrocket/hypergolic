import type {NativeRelaySettings} from '../network/relay-settings-native';
import type {RelaySettingsSnapshot,RelayRole} from '../network/relay-settings';
/** Existing trusted Settings edits update future CVM defaults; an admitted request keeps its reviewed snapshot. */
export function withCvmRelayDefaults(settings:NativeRelaySettings,configure:(relays:readonly string[])=>void):NativeRelaySettings{
  const sync=(snapshot:RelaySettingsSnapshot)=>{configure(snapshot.networkRelays.slice(0,4));return snapshot;};
  sync(settings.getSettings());
  return Object.freeze({getSettings:settings.getSettings,
    addRelay:async(role:RelayRole,url:string)=>sync(await settings.addRelay(role,url)),
    removeRelay:async(role:RelayRole,url:string)=>sync(await settings.removeRelay(role,url)),
    restoreDefaults:async (role?:RelayRole)=>sync(await settings.restoreDefaults(role)),
    close:()=>settings.close(),
  });
}
