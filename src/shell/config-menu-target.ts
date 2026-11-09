import type {ConfigMenuTarget} from '../presentation/config-broker.ts';
import {resolveBundledSession} from './fixtures.ts';
import type {NappletDescriptor} from './workspace.ts';

export function configMenuTarget(menu: readonly ConfigMenuTarget[], session: NappletDescriptor): ConfigMenuTarget | null {
  try {
    const identity = session.source === 'published' ? {...session, fixture: 'published'} : resolveBundledSession(session);
    let target: ConfigMenuTarget | null = null;
    for (const entry of menu) {
      const {origin} = entry;
      if (origin.sessionId !== session.id || origin.fixture !== identity.fixture || origin.publisher !== identity.publisher ||
          origin.appId !== identity.appId || origin.version !== identity.version) continue;
      if (target) return null;
      target = entry;
    }
    return target;
  } catch {return null;}
}
