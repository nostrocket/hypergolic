import { get, writable } from 'svelte/store';
import { BlossomClient, getServersFromServerListEvent } from 'blossom-client-sdk';
import { ndk } from '../ndk';
import { signEventTemplate } from './signer';

export const userServers = writable<URL[]>([]);

export async function fetchUsersServers(pubkey: string) {
	const ndkSvelte = get(ndk);

	const event = await ndkSvelte.fetchEvent({ kinds: [10063 as number], authors: [pubkey] });
	if (!event) userServers.set([]);
	else userServers.set(getServersFromServerListEvent(event));
}

export async function uploadBlob(file: File, servers?: URL[]) {
	if (!servers) servers = get(userServers);
	if (servers.length === 0) throw new Error('User does not have any blossom servers');

	const sha256 = await BlossomClient.getFileSha256(file);
	const auth = await BlossomClient.createUploadAuth(sha256, signEventTemplate, 'Upload Image');
	const blob = await BlossomClient.uploadBlob(servers[0], file, auth);

	// mirror blob to other servers in background
	for (const server of servers.slice(1)) {
		BlossomClient.mirrorBlob(server, blob.url, auth)
			.catch((err) => {
				// not all servers support mirroring, so attempt to upload
				return BlossomClient.uploadBlob(server, file, auth);
			})
			.catch((error) => {
				// upload filed, ignore error
			});
	}

	return blob;
}
