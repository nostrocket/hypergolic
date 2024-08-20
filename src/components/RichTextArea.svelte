<script lang="ts">
	import type { HTMLTextareaAttributes } from 'svelte/elements';
	import Textarea from '../lib/components/ui/textarea/textarea.svelte';
	import { onMount } from 'svelte';
	import { fetchUsersServers, uploadBlob, userServers } from '../lib/blossom/servers';
	import { ndk } from '../lib/ndk';

	type $$Props = HTMLTextareaAttributes;

	export let value: $$Props['value'] = undefined;

	// NOTE: this is kind of hacky and should be moved to some kind of "login" event
	onMount(() => {
		$ndk.signer?.user().then((user) => {
			if ($userServers.length === 0 && $ndk.signer) fetchUsersServers(user.pubkey);
		});
	});

	const handlePaste = async (event: ClipboardEvent) => {
		const clipboardData = event.clipboardData;
		if (!clipboardData) return;

		// find the first image item
		const item = Array.from(clipboardData.items).find((item) => item.type.startsWith('image/'));
		if (!item) return;

		try {
			const file = item.getAsFile();
			if (file) {
				const blob = await uploadBlob(file, $userServers);

				// Insert the image URL into the textarea
				const insert = blob.url;
				const textarea = event.target as HTMLTextAreaElement;
				const startPos = textarea.selectionStart;
				const endPos = textarea.selectionEnd;

				const current = String(value);
				value = current.substring(0, startPos) + insert + current.substring(endPos);
			}
			event.preventDefault();
		} catch (error) {
			if (error instanceof Error) alert(`Image upload failed: ${error.message}`);
		}
	};
</script>

<Textarea bind:value on:paste={handlePaste} {...$$restProps} />
