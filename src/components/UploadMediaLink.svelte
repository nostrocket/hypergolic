<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import { fetchUsersServers, uploadBlob, userServers } from '../lib/blossom/servers';
	import { ndk } from '../lib/ndk';

	const dispatch = createEventDispatcher();

	let uploading = false;
	let uploadInput: HTMLInputElement;

	// NOTE: this is kind of hacky and should be moved to some kind of "login" event
	onMount(() => {
		$ndk.signer?.user().then((user) => {
			if ($userServers.length === 0 && $ndk.signer) fetchUsersServers(user.pubkey);
		});
	});

	const handleUpload = async (event: Event & { currentTarget: EventTarget & HTMLInputElement }) => {
		const file = event.currentTarget.files?.item(0);

		if (file) {
			try {
				dispatch('uploading');
				const blob = await uploadBlob(file, $userServers);
				dispatch('uploaded', blob);
			} catch (error) {
				if (error instanceof Error) alert(`Failed to upload image: ${error.message}`);
			}
		}
	};
</script>

<input
	bind:this={uploadInput}
	type="file"
	class="hidden"
	on:change={handleUpload}
	disabled={uploading || null}
/>
<button on:click={() => uploadInput.click()} class="hover:underline">
	{#if uploading}
		Uploading...
	{:else}
		<slot />
	{/if}
</button>
