import {useContext, useState} from 'react';
import {OwnerContext} from './IdentityOwnerContext';
import {NappletDiagnostics} from './NappletDiagnostics';
import {RuntimeContext} from '../runtime/RuntimeContext';
import type {DiagnosticEntry} from '../runtime/napplet-diagnostics';
import type {NappletDescriptor, Workspace} from './workspace';

export function useDiagnostics(workspace: Workspace, blocked: boolean, identity: string | undefined, clearMenu: () => void) {
  const owner = useContext(OwnerContext);
  const runtime = useContext(RuntimeContext);
  const [inspection, setInspection] = useState<{session: NappletDescriptor; rows: DiagnosticEntry[]; identity?: string} | null>(null);
  const inspecting = inspection && !blocked && inspection.identity === identity && workspace.sessions.includes(inspection.session);
  const inspect = (id: string) => {
    const session = workspace.sessions.find(item => item.id === id);
    if (!blocked && session?.source === 'published') {
      setInspection({session, rows: runtime?.diagnostics?.(id) ?? [], identity});
      clearMenu();
    }
  };
  const panel = inspecting ? <NappletDiagnostics session={inspection.session} rows={inspection.rows}
    relays={owner?.relaySettings} close={() => setInspection(null)} /> : null;
  return {panel, inspect};
}
