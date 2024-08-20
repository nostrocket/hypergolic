<script lang="ts">
	import { Button } from '@/components/ui/button';
	import Checkbox from '@/components/ui/checkbox/checkbox.svelte';
	import Label from '@/components/ui/label/label.svelte';
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

	let checkboxes = new Map<string, boolean>();

	let haveUnchecked = true;
	$: {
		let foundUnchecked = false;
		for (let [_, c] of checkboxes) {
			if (!c) {
				foundUnchecked = true;
			}
		}
		haveUnchecked = foundUnchecked;
	}

	{
		checkboxes.set(
			'I believe the Problem is in the critical path to increased revenue, participation, or lulz.',
			false
		);
		checkboxes.set('I believe this problem is worth solving', false);
		checkboxes.set(
			'I believe the Problem statement is a true and accurate observation of reality',
			false
		);
		checkboxes.set("I believe the contributor's solution fully solves the stated problem", false);
		checkboxes.set(
			'I believe the Solution provided is the minimum possible answer to the described Problem, and no more complex than it needs to be',
			false
		);
		checkboxes.set(
			'I believe that the solution does NOT introduce any way to create Merits in this project other than by solving problems (proof of work)',
			false
		);
		checkboxes.set(
			'I believe that the Merit Holders are the sole beneficiary of any revenue that this solution potentially leads towards',
			false
		);
		checkboxes.set(
			"I can't see any way in which this solution could be harmful to any Nostrocket Participants, their families, community, or ecological system.",
			false
		);
		checkboxes.set(
			"I can't see any way in which this solution could be harmful to Bitcoin or Bitcoin users",
			false
		);
		checkboxes.set(
			'I believe the amount of Merits being claimed is reasonable for the work that has been done',
			false
		);
		checkboxes = checkboxes;
	}

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
					let content = `I've voted to ratify your merit request! ${merit.Problem()} \n\n ${merit.SolutionURL() ? merit.SolutionURL() : ''}`;
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
	<div class="flex flex-col">
		<div class="flex flex-col">
			{#each checkboxes as [text, bool]}
				<div class="mb-2 flex flex-nowrap text-left">
					<Checkbox
						on:click={() => {
							checkboxes.set(text, !bool), (checkboxes = checkboxes);
						}}
						id="worthsolving"
						bind:checked={bool}
					/>
					<Label
						on:mousedown={() => {
							checkboxes.set(text, !bool), (checkboxes = checkboxes);
						}}
						for={text}
						class=" ml-2 font-extralight peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
					>
						{text}
					</Label>
				</div>
			{/each}
		</div>
		<div class="flex">
			<Button
				variant="default"
				class="m-2"
				disabled={haveUnchecked}
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
				disabled={!haveUnchecked}
				on:click={() => {
					if (currentUserHasVotepower) {
						publish($ndk, 'blackball');
					} else {
						alert(`Your pubkey does not have votepower in ${rocket.Name()}`);
					}
				}}>Vote to Reject</Button
			>
		</div>
	</div>
{:else}
	<Login />
{/if}
