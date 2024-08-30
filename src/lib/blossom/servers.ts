import { get, writable } from 'svelte/store';
import {
	BlossomClient,
	getServersFromServerListEvent,
	type BlobDescriptor
} from 'blossom-client-sdk';
import { ndk } from '../ndk';
import { signEventTemplate } from './signer';

const defaultBlossomServer = new URL('https://cdn.nostrcheck.me/');

export const userServers = writable<URL[]>([]);

export async function fetchUsersServers(pubkey: string) {
	const ndkSvelte = get(ndk);

	const event = await ndkSvelte.fetchEvent({ kinds: [10063 as number], authors: [pubkey] });
	if (!event) userServers.set([defaultBlossomServer]);
	else userServers.set(getServersFromServerListEvent(event));
}

export async function uploadBlob(file: File, servers?: URL[]) {
	if (!servers) servers = get(userServers);
	if (servers.length === 0) throw new Error('User does not have any blossom servers');

	const sha256 = await BlossomClient.getFileSha256(file);
	const auth = await BlossomClient.createUploadAuth(sha256, signEventTemplate, 'Upload Image');

	let blob: BlobDescriptor | undefined = undefined;

	// mirror blob to other servers in background
	for (const server of servers) {
		try {
			if (!blob) {
				// if blob is not set, try to upload it
				blob = await BlossomClient.uploadBlob(server, file, auth);
			} else {
				// else try to mirror it to the server
				await BlossomClient.mirrorBlob(server, blob.url, auth).catch((err) => {
					// not all servers support mirroring, so attempt to upload
					return BlossomClient.uploadBlob(server, file, auth);
				});
			}
		} catch (error) {
			// ignore error
		}
	}

	return blob;
}
