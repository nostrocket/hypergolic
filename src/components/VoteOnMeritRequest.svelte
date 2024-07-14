<script lang="ts">
	import { Button } from '@/components/ui/button';
	import { MeritRequest } from '@/event_helpers/merits';
	import { currentUser } from '@/stores/session';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import type NDKSvelte from '@nostr-dev-kit/ndk-svelte';
	import Login from './Login.svelte';
	import { ndk } from '@/ndk';

	export let merit: MeritRequest;
	export let rocket: NDKEvent;

	function publish(ndk: NDKSvelte, direction: string) {
		if (!ndk.signer) {
			throw new Error('no ndk signer found');
		}
		let e = new NDKEvent(ndk);
		let author = $currentUser;
		if (!author) {
			throw new Error('no current user');
		}
		e.author = author;
		e.kind = 1410;
		e.created_at = Math.floor(new Date().getTime() / 1000);
		e.tags.push(['a', `31108:${rocket.pubkey}:${rocket.dTag}`]);
		e.tags.push(['request', merit.ID]);
		e.tags.push(['e', merit.ID]);
		e.tags.push(['p', merit.Pubkey]);
		e.tags.push(['vote', direction]);
		console.log(e.rawEvent());
		e.publish().then((x) => {
			console.log(x);
		});
	}
</script>

{#if $currentUser}
	<Button
		variant="default"
		class="m-2"
		on:click={() => {
			publish($ndk, 'ratify');
		}}>Vote to Approve</Button
	>
	<Button
		variant="destructive"
		class="m-2"
		on:click={() => {
			publish($ndk, 'ratify');
		}}>Vote to Reject</Button
	>
{:else}
	<Login />
{/if}
