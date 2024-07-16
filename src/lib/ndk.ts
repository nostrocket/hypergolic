import NDKSvelte from '@nostr-dev-kit/ndk-svelte';
import NDKCacheAdapterDexie from '@nostr-dev-kit/ndk-cache-dexie';

import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const _ndk = new NDKSvelte({
	explicitRelayUrls: [
		'wss://purplepag.es',
		'wss://relay.nostr.band',
		'wss://nos.lol'
		//'wss://relay.nostrocket.org'
	],
	enableOutboxModel: false,
	clientName: 'nostrocket'
	//clientNip89: "31990:fa984bd7dbb282f07e16e7ae87b26a2a7b9b90b7246a44771f0cf5ae58018f52:1716498133442",
});

//we need to check for browser environment before calling window because svelte is slightly retarded when used client side only
if (browser && window.indexedDB) {
	_ndk.cacheAdapter = new NDKCacheAdapterDexie({ dbName: 'gulag' });
}

export const ndk = writable(_ndk);
