<script lang="ts">
	import * as Card from '@/components/ui/card';

	import Heading from './Heading.svelte';
	import InputBitcoinAddress from './InputBitcoinAddress.svelte';
	import { Button } from '@/components/ui/button';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import validate from 'bitcoin-address-validation';
	import type { Rocket } from '@/event_helpers/rockets';
	import { derived } from 'svelte/store';
	import { onDestroy } from 'svelte';
	import type { NDKEventStore, ExtendedBaseType } from '@nostr-dev-kit/ndk-svelte';

	let bitcoinAddress: string;
	export let rocket: Rocket;

	let associations: NDKEventStore<ExtendedBaseType<NDKEvent>> | undefined = undefined;

	$: {
		if ($currentUser && !associations) {
			associations = $ndk.storeSubscribe(
				[{ authors: [$currentUser.pubkey], kinds: [1413 as number] }],
				{
					subId: `1413-${$currentUser.pubkey}`
				}
			);
		}
	}

	onDestroy(() => {
		associations?.unsubscribe();
	});

	let associatedAddresses = derived(currentUser, ($currentUser) => {
		let addresses: Set<string> = new Set();
		if ($currentUser) {
			for (let [_, a] of rocket.BitcoinAssociations()) {
				if (a.Pubkey == $currentUser.pubkey && a.Address && validate(a.Address)) {
					addresses.add(a.Address);
				}
			}
		}
		return addresses;
	});

	function publish(address: string) {
		if (!$ndk.signer) {
			throw new Error('no ndk signer found');
		}
		let author = $currentUser;
		if (!author) {
			throw new Error('no current user');
		}
		if (!validate(address)) {
			throw new Error('invalid bitcoin address');
		}
		let event = new NDKEvent($ndk);
		event.kind = 1413;
		event.tags.push(['onchain', address]);
		event.tags.push(rocket.ATag());
		//todo: let user specify a rocket
		console.log('todo: let user specify a rocket');
		event
			.publish()
			.then((x) => {
				console.log(x);
			})
			.catch(() => {
				console.log('failed to publish', event.rawEvent());
			});
	}
</script>

<Heading title="Sponsor a Contributor" />
Contributors who need Sats are able to list their Merits for sale, to sponsor them simply buy some of
their Merits.
<Card.Root class="m-2 mb-4">
	<Card.Header><Card.Title>Your Bitcoin Addresses</Card.Title></Card.Header>
	<Card.Content>
		<div class="m-2 flex">
			Merit purchases must be conducted with a Bitcoin address that is associated with your pubkey,
			otherwise you will not recieve the Merits upon payment.
		</div>
		{#if ($associatedAddresses.size == 0 && !associations) || ($associatedAddresses.size == 0 && associations && $associations.length == 0)}
			You do not have any registered addresses
		{:else if $associatedAddresses.size == 0 && associations && $associations && $associations.length > 0}
			<h4 class="text-lg font-bold dark:text-white">Pending Additions</h4>
			<ul class="m-2 flex flex-col">
				{#each $associations as event}<li class="list-item list-disc">
						{event.getMatchingTags('onchain')[0][1]}
					</li>{/each}
			</ul>
		{:else if $associatedAddresses.size > 0}
			<h4 class="text-lg font-bold dark:text-white">Your registered addresses</h4>

			<ul class="m-2 flex flex-col">
				{#each $associatedAddresses as address}<li class="list-item list-disc">{address}</li>{/each}
			</ul>
		{/if}
		<h4 class="text-lg font-bold dark:text-white">Add a new address now</h4>

		<div class="flex">
			<InputBitcoinAddress bind:bitcoinAddress /><Button
				on:click={() => publish(bitcoinAddress)}
				class="mt-3 max-w-xs">Publish</Button
			>
		</div>
	</Card.Content>
</Card.Root>
