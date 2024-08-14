<script lang="ts">
	import { Button } from '@/components/ui/button';
	import {
		MeritRequest,
		prepareMeritNoteEvent,
		prepareMeritVoteEvent,
		type VoteDirection
	} from '@/event_helpers/merits';
	import type { Rocket } from '@/event_helpers/rockets';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import type NDKSvelte from '@nostr-dev-kit/ndk-svelte';
	import Login from './Login.svelte';

	export let merit: MeritRequest;
	export let rocket: Rocket;

	function publish(ndk: NDKSvelte, direction: VoteDirection) {
		if (!ndk.signer) {
			throw new Error('no ndk signer found');
		}
		let author = $currentUser;
		if (!author) {
			throw new Error('no current user');
		}
		prepareMeritVoteEvent({
			ndk,
			rocket,
			merit,
			direction
		})
			.publish()
			.then((x) => {
				console.log(x);
				if (direction === 'ratify') {
					let content = `I've voted to ratify your merit request! ${merit.Problem()} \n\n ${merit.Solution() ? merit.Solution() : ''}`;
					prepareMeritNoteEvent({
						ndk,
						merit,
						content
					})
						.publish()
						.then((x) => {
							console.log(x);
						});
				}
			});
	}

	$: currentUserHasVotepower = false;

	$: {
		if (currentUser && $currentUser) {
			currentUserHasVotepower = rocket.VotePowerForPubkey($currentUser.pubkey) > 0;
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
				alert(`Your pubkey does not have votepower in ${rocket.Name()}`);
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
				alert(`Your pubkey does not have votepower in ${rocket.Name()}`);
			}
		}}>Vote to Reject</Button
	>
{:else}
	<Login />
{/if}
