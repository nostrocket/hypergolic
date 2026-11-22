/** The reviewed Journal release keeps its new-entry editor outside its saved entries. */
export function supportsWorkspaceJournalCheckpoint(pin: Readonly<{
  appId: string; publisher?: string | undefined; eventId?: string | undefined; version: string;
}>): boolean {
  return pin.appId === 'workspace-journal' &&
    pin.publisher === 'b902388aa1e557a54b91081dfaf431fffd22739c1eac2502f3bdc9b3e6522278' &&
    pin.eventId === '54ae23083f1dccfaecf88e0df7281d6c9f1502dc31f288c127379169a36f53e2' &&
    pin.version === '4b916fa338865a96e18ff1c4d9468eb6de8040a2bae4d2b90b65fccaa3819573';
}
