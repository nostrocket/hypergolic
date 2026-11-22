import { requireNativeModule } from 'expo';
import type { NativePublishedBodyPort } from './native-published-body.ts';
import type { NativePublishedTransferPort } from './native-transfer.ts';

/** Loaded only by the trusted React Native owner, never by the isolated guest. */
export function loadNativePublishedTransferPort(): NativePublishedTransferPort {
  const port = requireNativeModule<NativePublishedTransferPort & NativePublishedBodyPort>('HypergolicNappletHost');
  return {
    bodies: port,
    registerPublishedSession: port.registerPublishedSession.bind(port),
    beginPublishedArtifact: port.beginPublishedArtifact.bind(port),
    ...(port.beginPublishedSnapshot ? {beginPublishedSnapshot: port.beginPublishedSnapshot.bind(port)} : {}),
    appendPublishedArtifact: port.appendPublishedArtifact.bind(port),
    finishPublishedArtifact: port.finishPublishedArtifact.bind(port),
    cancelPublishedArtifact: port.cancelPublishedArtifact.bind(port),
    revokePublishedSession: port.revokePublishedSession.bind(port),
    revokeAllPublishedArtifacts: port.revokeAllPublishedArtifacts.bind(port),
  };
}
