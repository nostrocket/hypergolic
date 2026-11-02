import { useRef } from 'react';
import type { SharedValue } from 'react-native-reanimated';
import type { RuntimeOwner } from '../runtime/runtime-owner';
import { bundledDescriptor, type BundledVariant } from './fixtures';
import { openNapplet, type Workspace } from './workspace';

interface Props {
  current: Readonly<{ current: Workspace }>;
  runtime: RuntimeOwner | null;
  position: SharedValue<number>; progress: SharedValue<number>;
  change(next: Workspace): void; setSettings(open: boolean): void;
}

/** Bundled lab instances receive distinct session IDs and the same workspace transition. */
export function useBundledNapplets({ current, runtime, position, progress, change, setSettings }: Props) {
  const nextNumber = useRef(Math.max(3, ...current.current.sessions.map(session => Number(session.title.match(/ ([1-9][0-9]*)$/)?.[1] ?? 0))) + 1);
  return (variant: BundledVariant) => {
    while (current.current.sessions.some(session => session.id === `${variant}-${nextNumber.current}`)) nextNumber.current++;
    if (variant !== 'ux-lab' && !runtime) return;
    const number = nextNumber.current++;
    const descriptor = variant === 'ux-lab' ? bundledDescriptor(variant, number) : runtime!.descriptor(variant, number);
    const next = openNapplet(current.current, descriptor);
    position.set(next.sessions.length - 1);
    progress.set(0);
    change(next);
    setSettings(false);
  };
}
