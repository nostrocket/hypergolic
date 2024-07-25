<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import { Terminal } from 'lucide-svelte';
	import * as Alert from '@/components/ui/alert';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import { Rocket } from '@/event_helpers/rockets';

	export let rocketEvent: NDKEvent;
	const parsedRocket = new Rocket(rocketEvent);
	let mission = rocketEvent.tagValue('mission') || '';
	let missionError = '';
	let open = false;

	$: missionError = getMissionError(mission);

	function getMissionError(mission: string): string {
		if (mission.length < 1) return 'Mission is empty';
		if (mission.length > 140) return 'Mission MUST be concise, under 140 characters';
		return '';
	}

	async function publish() {
		if (missionError) throw new Error('Mission invalid');
		if (!$ndk.signer) throw new Error('No NDK signer found');

		const author = $currentUser;
		if (!author) throw new Error('No current user');

		if (parsedRocket.VotePowerForPubkey(author.pubkey) < 0.8) {
			throw new Error('You do not have 80% vote power to edit the mission');
		}

		try {
			await parsedRocket.UpdateMission(mission).publish();
			open = false;
		} catch (error) {
			console.error('Failed to publish:', error);
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Trigger class={buttonVariants({ variant: 'default' })}>Edit mission</Dialog.Trigger>
	<Dialog.Content class="sm:max-w-[425px]">
		{#if !$currentUser}
			<Alert.Root>
				<Terminal class="h-4 w-4" />
				<Alert.Title>Heads up!</Alert.Title>
				<Alert.Description>You need a nostr signing extension to use Nostrocket!</Alert.Description>
			</Alert.Root>
		{/if}
		<Dialog.Header>
			<Dialog.Title>Edit mission</Dialog.Title>
			<Dialog.Description>Modify your Rocket's mission!</Dialog.Description>
		</Dialog.Header>
		<div class="grid gap-4">
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="mission" class="text-right">Mission</Label>
				<Textarea
					bind:value={mission}
					id="mission"
					placeholder="Rocket's mission"
					class="col-span-3"
				/>
			</div>
		</div>
		{#if missionError}
			<div class="m-0 p-0 text-sm text-red-500">{missionError}</div>
		{/if}
		<Dialog.Footer>
			<Button disabled={!!missionError} on:click={publish} type="submit">Submit</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
