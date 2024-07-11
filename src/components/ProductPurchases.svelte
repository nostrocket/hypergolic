<script lang="ts">
	import * as Card from '@/components/ui/card';
	import * as Table from '@/components/ui/table';
	import type { RocketProduct } from '@/event_helpers/rockets';
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

	let newZaps = derived(zaps, ($zaps) => {
		let zapMap = new Map<string, NDKEvent>();
		for (let z of $zaps) {
			if (!product.Purchases.get(z.id)) {
				let zapRequestEvent = getZapRequest(z);
				if (zapRequestEvent) {
					for (let zapEtag of zapRequestEvent.getMatchingTags('e')) {
						if (zapEtag && zapEtag.length > 1 && zapEtag[1].length == 64) {
							if (product.ID == zapEtag[1]) {
								//todo: validate zapper pubkey is from a LSP specified in rocket
								//todo: validate amount is same as product amount in rocket
								zapMap.set(z.id, z);
							}
						}
					}
				}
			}
		}
		return zapMap;
	});

	function getZapRequest(zapReceipt: NDKEvent): NDKEvent | undefined {
		let zapRequestEvent: NDKEvent | undefined = undefined;
		let zapRequest = zapReceipt.getMatchingTags('description');
		if (zapRequest.length == 1) {
			let zapRequestJSON = JSON.parse(zapRequest[0][1]);
			if (zapRequestJSON) {
				zapRequestEvent = new NDKEvent($ndk, zapRequestJSON);
			}
		}
		return zapRequestEvent;
	}

	function getZapAmount(zapRequest?: NDKEvent): number {
		let amount = 0;
		let amountTag = zapRequest?.getMatchingTags('amount');
		if (amountTag?.length == 1) {
			amount = parseInt(amountTag[0][1], 10);
		}
		return amount;
	}

	//fetch payments from rocket::product and live zaps and make a store Map<productID, []payments>
	//todo: validate zaps against product, publish store of all successful payments including those already in rocket. Publish another store with successful payments that are not yet included in rocket state so we can update the state and republish.
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
				{#each $newZaps as [id, zapReceipt]}
					<Table.Row on:click={()=>{console.log(getZapRequest(zapReceipt)?.rawEvent())}} class=" bg-red-800">
						<Table.Cell>
							<div class="flex flex-nowrap">
								<Avatar
									ndk={$ndk}
									pubkey={getZapRequest(zapReceipt)?.author.pubkey}
									class="h-10 w-10 flex-none rounded-full object-cover"
								/>
								<Name
									ndk={$ndk}
									pubkey={getZapRequest(zapReceipt)?.author.pubkey}
									class="inline-block truncate p-2"
								/>
							</div>
						</Table.Cell>
						<Table.Cell class="hidden md:table-cell"
							>{getZapAmount(getZapRequest(zapReceipt)) / 1000}</Table.Cell
						>
						<Table.Cell class="text-right">{unixToRelativeTime(zapReceipt.created_at*1000)}</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Card.Content>
</Card.Root>
