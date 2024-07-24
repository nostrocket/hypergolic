<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import { Terminal } from 'lucide-svelte';
	import * as Alert from '@/components/ui/alert';
	import type NDKSvelte from '@nostr-dev-kit/ndk-svelte';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { getRocketURL } from '@/helpers';
	import type { NDKEventStore } from '@nostr-dev-kit/ndk-svelte';
	import { onDestroy } from 'svelte';
	import { writable } from 'svelte/store';

	let rockets: NDKEventStore<NDKEvent> | undefined;
	const rocketsStore = writable<NDKEvent[]>([]);
	let name: string = '';
	$: nameInValid = true;
	$: nameError = '';

	rockets = $ndk.storeSubscribe([{ kinds: [31108 as number] }], { subId: 'rockets' });
	onDestroy(() => {
		rockets?.unsubscribe();
	});
	$: if (rockets) {
		rockets.subscribe((events) => {
			rocketsStore.set(events);
		});
	}

	const rocketNameValidator = /^\w{4,20}$/;
	const nameIsUnique = (name: string, rocketEvents: NDKEvent[]) => {
		return !rocketEvents.some((event) => event.tags[0][1] === name);
	};

	$: if (name) {
		if (!rocketNameValidator.test(name)) {
			nameInValid = true;
			nameError = 'Rocket names MUST be 4-20 alphanumeric characters';
		} else if (!$rocketsStore) {
			nameInValid = true;
			nameError = 'Loading Nostr';
		} else if (!nameIsUnique(name, $rocketsStore)) {
			nameInValid = true;
			nameError = 'Rocket names MUST be unique';
		} else {
			nameInValid = false;
			nameError = '';
		}
	}

	function publish(ndk: NDKSvelte, name: string) {
		if (!ndk.signer) {
			throw new Error('no ndk signer found');
		}
		let e = new NDKEvent(ndk);
		let author = $currentUser;
		if (!author) {
			throw new Error('no current user');
		}
		if (nameInValid) {
			throw new Error('name is invalid');
		}
		e.author = author;
		e.kind = 31108;
		e.created_at = Math.floor(new Date().getTime() / 1000);
		e.tags.push(['d', name]);
		e.tags.push(['ruleset', '334000']);
		e.tags.push(['ignition', 'this']);
		e.tags.push(['parent', 'this']);
		e.publish().then((x) => {
			console.log(x);
			goto(`${base}/rockets/${getRocketURL(e)}`);
		});
	}
</script>

<Dialog.Root>
	<Dialog.Trigger class={`${buttonVariants({ variant: 'default' })} w-full`}
		>Create a Rocket</Dialog.Trigger
	>
	<Dialog.Content class="sm:max-w-[425px]">
		<Dialog.Header>
			<Dialog.Title>Name Your Rocket</Dialog.Title>
			{#if !currentUser}
				<Alert.Root>
					<Terminal class="h-4 w-4" />
					<Alert.Title>Heads up!</Alert.Title>
					<Alert.Description
						>You need a nostr signing extension to use Nostrocket!</Alert.Description
					>
				</Alert.Root>
			{/if}
			<Dialog.Description>Choose a name for your new Rocket and click Publish</Dialog.Description>
		</Dialog.Header>
		<div class="grid gap-4 py-4">
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="name" class="text-right">Name</Label>
				<Input bind:value={name} id="name" placeholder="Name-of-your-rocket" class="col-span-3" />
			</div>
		</div>
		<div class="m-0 p-0 text-sm text-red-500">{nameError}</div>
		<Dialog.Footer>
			<Button
				disabled={nameInValid}
				on:click={() => {
					publish($ndk, name);
				}}
				type="submit">Publish</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
