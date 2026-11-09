import type {NativeRelaySettings} from '../network/relay-settings-native';
import type {CvmRelayDefaultsState,NetworkRelayMove,RelaySettingsSnapshot,RelayRole} from '../network/relay-settings';

/** An admitted CVM request keeps its reviewed snapshot. Settings edits affect future defaults. */
export function withCvmRelayDefaults(settings:NativeRelaySettings,configure:(relays:readonly string[])=>void):NativeRelaySettings{
  let state:CvmRelayDefaultsState='configured';
  const sync=(snapshot:RelaySettingsSnapshot):RelaySettingsSnapshot=>{
    try {configure(snapshot.networkRelays.slice(0,4));state='configured';}
    catch {
      state='unknown';
      configure([]);
      state='cleared';
    }
    return snapshot;
  };
  sync(settings.getSettings());
  let writes:Promise<void>=Promise.resolve();
  const serial=<T>(action:()=>Promise<T>):Promise<T>=>{
    const result=writes.then(action);
    writes=result.then(()=>undefined,()=>undefined);
    return result;
  };
  const edit=(action:()=>Promise<RelaySettingsSnapshot>)=>serial(async()=>sync(await action()));
  return Object.freeze({getSettings:settings.getSettings,getCvmDefaultsState:()=>state,
    addRelay:(role:RelayRole,url:string)=>edit(()=>settings.addRelay(role,url)),
    removeRelay:(role:RelayRole,url:string)=>edit(()=>settings.removeRelay(role,url)),
    moveNetworkRelay:(url:string,direction:NetworkRelayMove)=>edit(()=>settings.moveNetworkRelay(url,direction)),
    restoreDefaults:(role?:RelayRole)=>edit(()=>settings.restoreDefaults(role)),
    close:()=>serial(()=>settings.close()),
  });
}
