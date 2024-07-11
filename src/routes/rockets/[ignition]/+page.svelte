<script lang="ts">
	import { page } from '$app/stores';
	import { ndk } from '@/ndk';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import type { ExtendedBaseType, NDKEventStore } from '@nostr-dev-kit/ndk-svelte';
	import { onDestroy } from 'svelte';
	import { derived, type Readable } from 'svelte/store';
	import CreateNewProduct from '../../../components/CreateNewProduct.svelte';
	import Heading from '../../../components/Heading.svelte';
	import ProductCard from '../../../components/ProductCard.svelte';
	import ProductsForRocket from '../../../components/ProductsForRocket.svelte';
	import RocketDashboard from '../../../components/RocketDashboard.svelte';
	import Todo from '../../../components/Todo.svelte';
	//flow if we only have a d-tag: fetch all 31108's with this d-tag, sort by WoT, put Nostrocket Name Service one at the top. Dedupe same rocket (same state, shadows) from multiple users, just show them all as everyone agreeing.
	//second pass: fetch ignition event for each, rebuild current state and validate all proofs, compute votepower and display only the states with > 50%.

	let rIgnitionOrActual = $page.params.ignition;
	let rName = $page.url.searchParams.get('d');
	let rPubkey = $page.url.searchParams.get('p');

	let rocketEvents: NDKEventStore<NDKEvent> | undefined;
	let latestRocketEvent: Readable<ExtendedBaseType<NDKEvent> | undefined>;

	let candidateProducts: Readable<ExtendedBaseType<NDKEvent>[]>;
	onDestroy(() => {
		rocketEvents?.unsubscribe();
	});

	//if we don't have a d/p tags we just render the event provided
	//todo: to find the latest by name alone we should use a new route and redirect to this page once we've got the relevant data
	if (!rName && !rPubkey && rIgnitionOrActual.length == 64) {
		//this is the actual event ID the user wants to view so fetch the single event and render
		//warn user that this information is probably out of date and let them reroute to get the latest
	}

	if (rName && rPubkey) {
		//the user wants the latest valid state of this rocket
		rocketEvents = $ndk.storeSubscribe(
			[
				{ '#d': [rName], authors: [rPubkey], kinds: [31108 as number] },
				{ '#a': [`31108:${rPubkey}:${rName}`] }
			],
			{ subId: rName }
		);
	}

	$: {
		if (rocketEvents) {
			latestRocketEvent = derived(rocketEvents, ($events) => {
				if (rocketEvents) {
					let sorted = $events.filter((e) => {
						return e.kind == 31108;
					});
					sorted = sorted.toSorted((a, b) => {
						return a.created_at - b.created_at;
					});
					return sorted[0];
				}
				return undefined;
			});

			if ($latestRocketEvent) {
				candidateProducts = derived(rocketEvents, ($events) => {
					return $events.filter((e) => {
						for (let p of $latestRocketEvent.getMatchingTags('product')) {
							if (p[1].includes(e.id)) {
								return false;
							}
						}
						return e.kind == 1908;
					});
				});
			}
		}
	}

	class ZapPurchase {
		Amount: number;
		ProductID: string;
		Buyer: string;
		ZapReceiptID: string;
		constructor(zapReceipt: NDKEvent) {}
	}

	//todo: check that this zap is not already included in the payment JSON for the product
	//todo: list purchases on the rocket page (from product tags, as well as zap receipts that aren't yet included). Deduct total products available if not 0.
	//todo: make the page flash or something and show each time someone buys the product.
	//todo: split this out so that we can consume it for the payment page too (so that we know if there are really products left or they're all sold)
	//todo: make store of all purchases (in rocket and zaps), sort by timestamp and render with profile of buyer

	//todo: handle shadow events (fetch the shadowed event and render it instead)
</script>
{#if latestRocketEvent && $latestRocketEvent}
<RocketDashboard rocket={$latestRocketEvent} />
{:else}
	<Heading title="Fetching events for the requested rocket" />
	IGNITION: {rIgnitionOrActual} <br />
	NAME: {rName} <br />
	PUBKEY: {rPubkey} <br />
{/if}
{#if latestRocketEvent && $latestRocketEvent && false}
	<Heading title={$latestRocketEvent.getMatchingTags('d')[0][1]} />


	<div class="flex flex-col gap-1 text-left">
		<h3 class="text-xl font-bold tracking-tight">
			{$latestRocketEvent.getMatchingTags('d')[0][1].toLocaleUpperCase()} Products
		</h3>
		<p class="text-sm text-muted-foreground">
			If there are products available for purchase they will be listed here
		</p>
	</div>
	<ProductsForRocket rocketEvent={$latestRocketEvent} />

	<div class="flex flex-col gap-1 text-left pt-4">
		<h3 class="text-xl font-bold tracking-tight">
			{$latestRocketEvent.getMatchingTags('d')[0][1].toLocaleUpperCase()} Product Proposals
		</h3>
		<p class="text-sm text-muted-foreground">
			If particpants of {$latestRocketEvent.getMatchingTags('d')[0][1]} have proposed any new products that are not yet included for sale, they will be listed here.
		</p>
	</div>
	{#each $candidateProducts as r}<ProductCard rocket={$latestRocketEvent} product={r} />{/each}
	<CreateNewProduct rocketEvent={$latestRocketEvent} />
{/if}
