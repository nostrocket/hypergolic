import { get } from 'svelte/store';
import { NDKEvent } from '@nostr-dev-kit/ndk';
import type { EventTemplate, SignedEvent } from 'blossom-client-sdk';

import { ndk } from '../ndk';

export async function signEventTemplate(template: EventTemplate): Promise<SignedEvent> {
	const _ndk = get(ndk);
	const e = new NDKEvent(_ndk);
	e.kind = template.kind;
	e.content = template.content;
	e.tags = template.tags;
	e.created_at = template.created_at;
	await e.sign();
	return e.rawEvent() as SignedEvent;
}
