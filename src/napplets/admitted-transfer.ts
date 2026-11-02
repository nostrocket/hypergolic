import { assertVerifiedNappletAdmission } from './first-open-consent.ts';
import { stageVerifiedArtifact, type NativePublishedTransferPort } from './native-transfer.ts';

/** Production handoff: check the reviewed grant at every native staging boundary. */
export async function stageAdmittedPublishedArtifact(
  admission: unknown, artifact: unknown, sessionId: string,
  port: NativePublishedTransferPort, signal: AbortSignal, assertActive: () => void,
): Promise<string> {
  assertVerifiedNappletAdmission(admission, artifact);
  const check = (): void => {
    assertActive();
    assertVerifiedNappletAdmission(admission, artifact);
  };
  return stageVerifiedArtifact(artifact, sessionId, port, signal, check);
}
