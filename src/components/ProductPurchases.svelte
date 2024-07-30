<script lang="ts">
	import * as Table from '@/components/ui/table';
	import { ValidateZapPublisher, ZapPurchase, type RocketProduct } from '@/event_helpers/rockets';
	import { unixToRelativeTime } from '@/helpers';
	import { ndk } from '@/ndk';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { onDestroy, onMount } from 'svelte';
	import { derived, writable } from 'svelte/store';

	export let product: RocketProduct;
	export let rocket: NDKEvent;

	export let unratifiedZaps:number = 0; //todo upstream bind this and parse outstanding zaps to merits and satflow component.

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

	let validZaps = derived(zaps, ($zaps) => {
		let zapMap = new Map<string, ZapPurchase>();
		for (let z of $zaps) {
			let zapPurchase = new ZapPurchase(z);
			if (zapPurchase.Valid(rocket) && zapPurchase.ProductID == product.ID) {
				zapMap.set(zapPurchase.ZapReceipt.id, zapPurchase);
			}
		}
		return zapMap;
	});

	let zapsNotInRocket = derived(validZaps, ($validZaps) => {
		let zapMap = new Map<string, ZapPurchase>();
		for (let [id, z] of $validZaps) {
			if (!z.IncludedInRocketState(rocket)) {
				zapMap.set(id, z);
			}
		}
		return zapMap;
	});

	let validPubkeys = writable(new Set<string>())

	zapsNotInRocket.subscribe((z) => {
		z.forEach((z) => {
			ValidateZapPublisher(rocket, z.ZapReceipt).then((result) => {
				if (result) {
					validPubkeys.update(existing=>{
						existing.add(z.ZapReceipt.pubkey);
						return existing
					})
				}
			});
		});
	});

	let validatedZapsNotInRocket = derived([zapsNotInRocket, validPubkeys], ([$zapsNotInRocket, $validPubkeys]) => {
		let zapMap = new Map<string, ZapPurchase>();
		for (let [id, zap] of $zapsNotInRocket) {
			if ($validPubkeys.has(zap.ZapReceipt.pubkey)) {
				zapMap.set(id, zap);
			}
		}
		return zapMap;
	});

	validatedZapsNotInRocket.subscribe(zaps=>{
		let total = 0
		for (let [_, z] of zaps) {
			total += z.Amount
		}
		unratifiedZaps = total/1000
	})

	//todo: get existing purchases from rocket and render them

	//todo: update rocket event with confirmed zaps if we have votepower
</script>

	<Table.Root>
		<Table.Caption
			class="mt-0 caption-top text-center text-lg font-semibold tracking-tight text-card-foreground"
			>Purchases</Table.Caption
		>
		<Table.Header>
			<Table.Row>
				<Table.Head>Buyer</Table.Head>
				<Table.Head class="hidden md:table-cell">Sats Paid</Table.Head>
				<Table.Head class="text-right"></Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each $validatedZapsNotInRocket as [id, purchase], _ (id)}
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
