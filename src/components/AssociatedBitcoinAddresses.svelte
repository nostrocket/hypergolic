<script lang="ts">
	import * as Card from '@/components/ui/card';
	import * as Table from '@/components/ui/table';
	import { BitcoinAssociation, Rocket } from '@/event_helpers/rockets';
	import { getCuckPrice } from '@/helpers';
	import { ndk } from '@/ndk';
	import { getBalance } from '@/stores/bitcoin';
	import { NDKKind } from '@nostr-dev-kit/ndk';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { onDestroy, onMount } from 'svelte';
	import { derived, writable } from 'svelte/store';

	export let rocket: Rocket;

	let cuckprice = 0;

	let associations = writable(new Map<string, BitcoinAssociation>());

	onMount(() => {
		getCuckPrice().then((price) => {
			if (price) cuckprice = price;
		});
		associations.set(rocket.BitcoinAssociations());
		$associations.forEach((a) => {
			if (a.Address) {
				getBalance(a.Address)
					.then((v) => {
						a.Balance = v;
						associations.update((existing) => {
							existing.set(a.Address!, a);
							return existing;
						});
					})
					.catch((err) => {
						console.log(err);
					});
			}
		});
	});

	let amounts = derived(associations, ($associations) => {
		let amounts = new Map<string, number>();
		for (let [_, a] of $associations) {
			if (a.Balance > 0) {
				let existing = amounts.get(a.Pubkey);
				if (!existing) {
					existing = 0;
				}
				existing += a.Balance;
				amounts.set(a.Pubkey, existing);
			}
		}
		return amounts;
	});

	let total = derived(amounts, ($amounts) => {
		let t = 0;
		for (let [_, a] of $amounts) {
			t += a;
		}
		return t;
	});
</script>

<Card.Root class="sm:col-span-3">
	<Card.Header class="px-7">
		<Card.Title>Sponsors</Card.Title>
		<Card.Description
			>These people want to sponsor Contributors working on {rocket.Name()}.</Card.Description
		>
	</Card.Header>
	<Card.Content>
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head class="w-[200px]">Sponsor</Table.Head>
					<Table.Head class="hidden text-left md:table-cell">Amount (Sats)</Table.Head>
					<Table.Head class="hidden text-left md:table-cell">CuckLoserBucks</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each $amounts as [npub, amount], _ (npub)}
					<Table.Row>
						<Table.Cell>
							<div class="flex flex-nowrap">
								<Avatar
									ndk={$ndk}
									pubkey={npub}
									class="h-10 w-10 flex-none rounded-full object-cover"
								/>
								<Name
									ndk={$ndk}
									pubkey={npub}
									class="hidden max-w-32 truncate p-2 md:inline-block"
								/>
							</div>
						</Table.Cell>
						<Table.Cell class="hidden text-left md:table-cell">
							{amount.toLocaleString()}
						</Table.Cell>
						<Table.Cell class="hidden text-left md:table-cell">
							${Math.floor((amount / 100000000) * cuckprice).toLocaleString()}
						</Table.Cell>
					</Table.Row>
				{/each}
				{#if $total > 0}
					<Table.Row
						class=" bg-violet-200 hover:bg-violet-300 dark:bg-violet-950 dark:hover:bg-violet-900"
					>
						<Table.Cell>TOTAL</Table.Cell>
						<Table.Cell class="hidden text-left md:table-cell">
							{$total.toLocaleString()}
						</Table.Cell>
						<Table.Cell class="hidden text-left md:table-cell">
							${Math.floor(($total / 100000000) * cuckprice).toLocaleString()}
						</Table.Cell>
					</Table.Row>
				{/if}
			</Table.Body>
		</Table.Root>
	</Card.Content>
</Card.Root>
