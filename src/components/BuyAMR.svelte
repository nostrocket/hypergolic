<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Alert from '@/components/ui/alert';
	import type { AMRAuction } from '@/event_helpers/rockets';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import type NDKSvelte from '@nostr-dev-kit/ndk-svelte';
	import { Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { Terminal } from 'lucide-svelte';

	export let auction: AMRAuction;
	let o = false;

	function publish(ndk: NDKSvelte) {
		if (!ndk.signer) {
			throw new Error('no ndk signer found');
		}
		let e = new NDKEvent(ndk);
		let author = $currentUser;
		if (!author) {
			throw new Error('no current user');
		}
		e.author = author;
		e.kind = 1216;
		e.created_at = Math.floor(new Date().getTime() / 1000);
		//todo validate d tag

		// e.publish().then((x) => {
		// 	console.log(x);
		// 	o = false;
		// 	goto(`${base}/rockets/${getRocketURL(rocketEvent)}`);
		// });
	}
</script>

<Dialog.Root bind:open={o}>
	<Dialog.Trigger class={buttonVariants({ variant: 'default' })}>Buy Now</Dialog.Trigger>
	<Dialog.Content class="sm:max-w-[425px]">
		{#if !currentUser}
			<Alert.Root>
				<Terminal class="h-4 w-4" />
				<Alert.Title>Heads up!</Alert.Title>
				<Alert.Description>You need a nostr signing extension to use Nostrocket!</Alert.Description>
			</Alert.Root>
		{:else}
			<Dialog.Header>
				<Dialog.Title>Buy Merits from <Name pubkey={auction.Owner} /></Dialog.Title>
			</Dialog.Header>
			<p>
				To buy these merits you MUST send {auction.Merits / 100000000} BTC from one of your registered
				addresses to {auction.RxAddress}.
			</p>
			<p>
				Once the transaction has 2 confirmations the Merits will automatically be transferred to
				your npub.
			</p>
			<Dialog.Footer>
				Todo: ask user to publish an event before making transaction so that multiple people don't
				pay for the same Merits.
				<!-- <Button
				on:click={() => {
					publish($ndk);
				}}
				type="submit">Publish</Button
			> -->
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
