<script lang="ts">
	import { Button } from '@/components/ui/button';
	import { MeritRequest } from '@/event_helpers/merits';
	import type { Rocket } from '@/event_helpers/rockets';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import type NDKSvelte from '@nostr-dev-kit/ndk-svelte';
	import { Name } from '@nostr-dev-kit/ndk-svelte-components';
	import Login from './Login.svelte';

	export let merit: MeritRequest;
	export let rocket: Rocket;

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
		e.tags.push(['a', `31108:${rocket.Event.pubkey}:${rocket.Event.dTag}`]);
		e.tags.push(['request', merit.ID]);
		e.tags.push(['e', merit.ID]);
		e.tags.push(['p', merit.Pubkey]);
		e.tags.push(['vote', direction]);
		console.log(e.rawEvent());
		e.publish().then((x) => {
			console.log(x);
		});
	}

	$:currentUserHasVotepower = false;

	$:{
		if (currentUser && $currentUser) {
			currentUserHasVotepower = (rocket.VotePowerForPubkey($currentUser.pubkey) > 0)
		}
	}

	
</script>

{#if $currentUser}
	<Button
		variant="default"
		class="m-2"
		on:click={() => {
			if (currentUserHasVotepower) {
				publish($ndk, 'ratify');
			} else {
				alert(`Your pubkey does not have votepower in ${rocket.Name()}`)
			}
			
		}}>Vote to Approve</Button
	>
	<Button
		variant="destructive"
		class="m-2"
		on:click={() => {
						if (currentUserHasVotepower) {
				publish($ndk, 'blackball');
			} else {
				alert(`Your pubkey does not have votepower in ${rocket.Name()}`)
			}
		}}>Vote to Reject</Button
	>
{:else}
	<Login />
{/if}
