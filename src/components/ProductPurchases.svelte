<script lang="ts">
	import * as Table from '@/components/ui/table';
	import { Product, Rocket, ValidateZapPublisher, ZapPurchase } from '@/event_helpers/rockets';
	import { unixToRelativeTime } from '@/helpers';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { onDestroy } from 'svelte';
	import { derived, writable } from 'svelte/store';

	export let products: Product[];
	//export let products: Product[];
	export let rocket: Rocket;

	export let unratifiedZaps: Map<string, ZapPurchase>;

	export let hidePurchases = false;

	let zaps = $ndk.storeSubscribe(
		[{ '#a': [`31108:${rocket.Event.author.pubkey}:${rocket.Event.dTag}`], kinds: [9735] }],
		{
			subId: rocket.Name() + '_zaps'
		}
	);

	onDestroy(() => {
		zaps?.unsubscribe();
	});

	function productsInclude(id: string) {
		let included = false;
		for (let p of products) {
			if (p.ID() == id) {
				included = true;
			}
		}
		return included;
	}

	let validZaps = derived(zaps, ($zaps) => {
		let zapMap = new Map<string, ZapPurchase>();
		for (let z of $zaps) {
			let zapPurchase = new ZapPurchase(z);
			if (zapPurchase.Valid(rocket.Event) && productsInclude(zapPurchase.ProductID)) {
				zapMap.set(zapPurchase.ZapReceipt.id, zapPurchase);
			}
		}
		return zapMap;
	});

	let zapsNotInRocket = derived(validZaps, ($validZaps) => {
		let zapMap = new Map<string, ZapPurchase>();
		for (let [id, z] of $validZaps) {
			if (!z.IncludedInRocketState(rocket.Event)) {
				zapMap.set(id, z);
			}
		}
		return zapMap;
	});

	let validPubkeys = writable(new Set<string>());

	zapsNotInRocket.subscribe((z) => {
		z.forEach((z) => {
			ValidateZapPublisher(rocket.Event, z.ZapReceipt)
				.then((result) => {
					if (result) {
						validPubkeys.update((existing) => {
							existing.add(z.ZapReceipt.pubkey);
							return existing;
						});
					}
				})
				.catch((e) => {
					if (e && e.pubkey && $currentUser && e.pubkey == $currentUser.pubkey) {
						alert(
							'Nostrocket could not validate that the zap receipts published on your behalf are legitimate, this usually means we could not query your lightning service provider API. Consider switching to a lightning service provider that is known to work (e.g. getAlby).'
						);
					}
				});
		});
	});

	let validatedZapsNotInRocket = derived(
		[zapsNotInRocket, validPubkeys],
		([$zapsNotInRocket, $validPubkeys]) => {
			let zapMap = new Map<string, ZapPurchase>();
			for (let [id, zap] of $zapsNotInRocket) {
				if ($validPubkeys.has(zap.ZapReceipt.pubkey)) {
					zapMap.set(id, zap);
				}
			}
			return zapMap;
		}
	);

	validatedZapsNotInRocket.subscribe((zaps) => {
		for (let [_, z] of zaps) {
			unratifiedZaps.set(z.ZapReceipt.id, z);
		}
		unratifiedZaps = unratifiedZaps;
	});

	//todo: get existing purchases from rocket and render them

	//todo: update rocket event with confirmed zaps if we have votepower
</script>

<Table.Root class={hidePurchases ? 'hidden' : ''}>
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
							class="h-8 w-8 flex-none rounded-full object-cover"
						/>
						<Name
							ndk={$ndk}
							pubkey={purchase.BuyerPubkey}
							class="inline-block max-w-32 truncate p-1"
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
