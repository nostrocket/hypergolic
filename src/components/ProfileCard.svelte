<script lang="ts">
	import { ndk } from '@/ndk';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { fade } from 'svelte/transition';
	import { nip19 } from 'nostr-tools';

	export let pubkey: string;

	const npub = nip19.npubEncode(pubkey);
	const nprofile = nip19.nprofileEncode({
		pubkey: pubkey,
		relays: [
			'wss://relay.nostr.band',
			'wss://nos.lol',
			'wss://relay.nostrocket.org',
			'wss://relay.damus.io'
		]
	});

	async function getUserProfile(pubkey: string) {
		try {
			const user = $ndk.getUser({ pubkey });
			await user.fetchProfile();
			return user.profile;
		} catch (error) {
			console.error('Error retrieving profile:', error);
		}
	}

	function getNostrClientLinks(npub: string, nprofile: string) {
		return [
			{ name: 'Nosta', url: `https://nosta.me/${nprofile}` },
			{ name: 'Primal', url: `https://primal.net/p/${npub}` },
			{ name: 'Nostrudel', url: `https://nostrudel.ninja/#/u/${nprofile}` },
			{ name: 'Coracle', url: `https://coracle.social/${nprofile}` }
		];
	}

	let isCopied = false;

	function copyPubkey() {
		navigator.clipboard.writeText(npub).then(
			() => {
				isCopied = true;
				setTimeout(() => {
					isCopied = false;
				}, 2000);
			},
			(err) => {
				console.error('Copy failed: ', err);
			}
		);
	}

	function ensureHttps(url: string): string {
		if (url.startsWith('http://') || url.startsWith('https://')) {
			return url;
		}
		return `https://${url}`;
	}
</script>

<div class="profile-content">
	<div class="mb-4 flex items-center">
		<Avatar ndk={$ndk} {pubkey} class="mr-3 h-12 w-12 rounded-full object-cover" />
		<div>
			<Name
				npubMaxLength={10}
				ndk={$ndk}
				{pubkey}
				class="text-lg font-semibold text-gray-900 dark:text-white"
			/>
			<button
				on:click={copyPubkey}
				class="flex cursor-pointer items-center text-sm text-gray-500 transition-colors duration-200 hover:text-blue-500 dark:text-gray-400 dark:hover:text-blue-400"
			>
				<span class="mr-1">{npub.slice(0, 12)}...</span>
				{#if isCopied}
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-4 w-4 text-green-500"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M5 13l4 4L19 7"
						/>
					</svg>
				{:else}
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-4 w-4"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
						/>
					</svg>
				{/if}
			</button>
		</div>
	</div>

	{#await getUserProfile(pubkey)}
		<div class="mb-2 h-4 w-3/4 animate-pulse rounded bg-gray-200 dark:bg-gray-700"></div>
		<div class="h-4 w-1/2 animate-pulse rounded bg-gray-200 dark:bg-gray-700"></div>
	{:then profile}
		{#if profile}
			<div transition:fade={{ duration: 200 }}>
				{#if profile.about}
					<p class="mb-2 text-sm text-gray-700 dark:text-gray-300">{profile.about}</p>
				{/if}
				{#if profile.website}
					<p class="text-xs text-blue-500 hover:underline">
						<a href={ensureHttps(profile.website)} target="_blank" rel="noopener noreferrer">
							{profile.website}
						</a>
					</p>
				{/if}
				{#if profile.nip05}
					<p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
						NIP-05: {profile.nip05}
					</p>
				{/if}
			</div>
		{:else}
			<p class="text-sm text-gray-500 dark:text-gray-400">No profile information available.</p>
		{/if}

		<div class="mt-4">
			<p class="mb-1 text-xs text-gray-500 dark:text-gray-400">Open in Nostr client:</p>
			<div class="flex flex-wrap gap-2">
				{#each getNostrClientLinks(npub, nprofile) as link}
					<a
						href={link.url}
						target="_blank"
						rel="noopener noreferrer"
						class="rounded bg-blue-500 px-2 py-1 text-xs text-white transition duration-300 hover:bg-blue-600"
					>
						{link.name}
					</a>
				{/each}
			</div>
		</div>
	{:catch error}
		<p class="text-sm text-red-500">Failed to load profile: {error.message}</p>
	{/await}
</div>
