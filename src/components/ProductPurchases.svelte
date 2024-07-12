<script lang="ts">
	import * as Card from '@/components/ui/card';
	import * as Table from '@/components/ui/table';
	import { ZapPurchase, type RocketProduct } from '@/event_helpers/rockets';
	import { unixToRelativeTime } from '@/helpers';
	import { ndk } from '@/ndk';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { onDestroy, onMount } from 'svelte';
	import { derived } from 'svelte/store';

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

	let productEvent: NDKEvent | undefined;

	onMount(() => {
		$ndk.fetchEvent(product.ID).then((e) => {
			if (e) {
				productEvent = e;
			}
		});
	});

	let purchases = derived(zaps, ($zaps) => {
		let zapMap = new Map<string, ZapPurchase>();
		for (let z of $zaps) {
			let zapPurchase = new ZapPurchase(z);
			if (zapPurchase.Valid(rocket)) {
				zapMap.set(zapPurchase.ZapReceipt.id, zapPurchase);
			}
		}
		return zapMap;
	});

	//todo: update rocket event with confirmed zaps if we have votepower
</script>

<Card.Root>
	<Card.Header class="px-7">
		<Card.Title>Purchases</Card.Title>
		<Card.Description
			>Purchase history for {productEvent?.getMatchingTags('name')[0][1]}</Card.Description
		>
	</Card.Header>
	<Card.Content>
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>Buyer</Table.Head>
					<Table.Head class="hidden md:table-cell">Sats Paid</Table.Head>
					<Table.Head class="text-right"></Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each $purchases as [id, purchase], _ (id)}
					<Table.Row
						on:click={() => {
							console.log(purchase.ZapReceipt.rawEvent());
						}}
						class="bg-accent"
					>
						<Table.Cell>
							<div class="flex flex-nowrap">
								<Avatar
									ndk={$ndk}
									pubkey={purchase.BuyerPubkey}
									class="h-10 w-10 flex-none rounded-full object-cover"
								/>
								<Name
									ndk={$ndk}
									pubkey={purchase.BuyerPubkey}
									class="inline-block max-w-32 truncate p-2"
								/>
							</div>
						</Table.Cell>
						<Table.Cell class="hidden md:table-cell">{purchase.Amount / 1000}</Table.Cell>
						<Table.Cell class="text-right"
							>{unixToRelativeTime(purchase.ZapReceipt.created_at * 1000)}</Table.Cell
						>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Card.Content>
</Card.Root>
