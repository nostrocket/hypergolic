import type { NDKEvent, NDKUser } from '@nostr-dev-kit/ndk';
import type NDKSvelte from '@nostr-dev-kit/ndk-svelte';
import { writable } from 'svelte/store';

export const currentUser = writable<NDKUser | undefined>(undefined);
export const pubkey = writable<string>('');

export async function prepareUserSession(ndk: NDKSvelte, user: NDKUser): Promise<void> {
	return new Promise((resolve) => {
		//implement any session set up stuff here
	});
}

export const devmode = writable(false);
export const mainnet = writable(false);
