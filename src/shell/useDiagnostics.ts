import {useContext, useState} from 'react';
import {RuntimeContext} from '../runtime/RuntimeContext';
import type {DiagnosticEntry} from '../runtime/napplet-diagnostics';
import type {NappletDescriptor, Workspace} from './workspace';

export function useDiagnostics(workspace: Workspace, blocked: boolean, identity: string | undefined, clearMenu: () => void) {
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
  return {inspection: inspecting ? inspection : null, inspect, dismissInspection: () => setInspection(null)};
}
