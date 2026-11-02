import { createContext } from 'react';
import type { RuntimeOwner } from './runtime-owner';

/** Absent in the standalone visual shell; privileged access requires the process-owned identity. */
export const RuntimeContext = createContext<RuntimeOwner | null>(null);
