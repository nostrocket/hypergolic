<script lang="ts">
	import type { RocketProduct } from '@/event_helpers/rockets';
	import { ndk } from '@/ndk';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import { onDestroy } from 'svelte';
	import * as Card from '@/components/ui/card';
	import * as Table from '@/components/ui/table';
	import { Badge } from '@/components/ui/badge';

	export let product: RocketProduct;
	export let rocket: NDKEvent;

	let zaps = $ndk.storeSubscribe(
		[{ '#a': [`31108:${rocket.author.pubkey}:${rocket.dTag}`], kinds: [9735] }],
		{
			subId: product.ID
		}
	);

	onDestroy(() => {
		zaps?.unsubscribe();
	});

	//todo: validate zaps against product, publish store of all successful payments including those already in rocket. Publish another store with successful payments that are not yet included in rocket state so we can update the state and republish.
</script>

{#each $zaps as z}<a
		href="#"
		on:click={() => {
			console.log(z.rawEvent());
		}}>{z.id}</a
	><br />{/each}

<Card.Root
	data-x-chunk-name="dashboard-05-chunk-3"
	data-x-chunk-description="A table of recent orders showing the following columns: Customer, Type, Status, Date, and Amount."
>
	<Card.Header class="px-7">
		<Card.Title>Purchases</Card.Title>
		<Card.Description>Purchase history for {product.ID}</Card.Description>
	</Card.Header>
	<Card.Content>
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>Buyer</Table.Head>
					<Table.Head class="hidden md:table-cell">Date</Table.Head>
					<Table.Head class="text-right">Amount</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				<Table.Row class="bg-accent">
					<Table.Cell>
						<div class="font-medium">Liam Johnson</div>
						<div class="hidden text-sm text-muted-foreground md:inline">liam@example.com</div>
					</Table.Cell>
					<Table.Cell class="hidden md:table-cell">2023-06-23</Table.Cell>
					<Table.Cell class="text-right">$250.00</Table.Cell>
				</Table.Row>
			</Table.Body>
		</Table.Root>
	</Card.Content>
</Card.Root>
