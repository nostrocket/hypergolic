<script lang="ts">
	import { page } from '$app/stores';
	import { ndk } from '@/ndk';
	import { NDKEvent, type NDKTag } from '@nostr-dev-kit/ndk';
	import type { ExtendedBaseType, NDKEventStore } from '@nostr-dev-kit/ndk-svelte';
	import { onDestroy } from 'svelte';
	import { derived, type Readable } from 'svelte/store';
	import Heading from '../../../components/Heading.svelte';
	import Todo from '../../../components/Todo.svelte';
	import CreateNewProduct from '../../../components/CreateNewProduct.svelte';
	import Subheading from '../../../components/Subheading.svelte';
	import ProductCard from '../../../components/ProductCard.svelte';
	//flow if we only have a d-tag: fetch all 31108's with this d-tag, sort by WoT, put Nostrocket Name Service one at the top. Dedupe same rocket (same state, shadows) from multiple users, just show them all as everyone agreeing.
	//second pass: fetch ignition event for each, rebuild current state and validate all proofs, compute votepower and display only the states with > 50%.

	let rIgnitionOrActual = $page.params.ignition;
	let rName = $page.url.searchParams.get('d');
	let rPubkey = $page.url.searchParams.get('p');

	let rocketEvents: NDKEventStore<NDKEvent> | undefined;
	let latestRocketEvent: Readable<ExtendedBaseType<NDKEvent> | undefined>;
	let zaps: Readable<ExtendedBaseType<NDKEvent>[]>;

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

				zaps = derived(rocketEvents, ($events) => {
					return $events.filter((e) => {
						return e.kind == 9735;
					});
				});
			}
		}
	}

	function getMapOfProducts(rocket: NDKEvent): Map<string, NDKTag> {
		let productIDs = new Map<string, NDKTag>();
		for (let product of rocket.getMatchingTags('product')) {
			if (product.length > 1 && product[1].split(':') && product[1].split(':').length > 0) {
				productIDs.set(product[1].split(':')[0], product);
			}
		}
		return productIDs;
	}

	//todo: check that this zap is not already included in the payment JSON for the product
	//todo: list purchases on the rocket page (from product tags, as well as zap receipts that aren't yet included). Deduct total products available if not 0.
	//todo: make the page flash or something and show each time someone buys the product.
	//todo: split this out so that we can consume it for the payment page too (so that we know if there are really products left or they're all sold)
	function getZapData(zap: NDKEvent) {
		let productPrice = 0;
		let zapAmount = 0;
		let productID: string | undefined = undefined;
		let buyerPubkey: string | undefined = undefined;
		let zapRequest: NDKEvent | undefined = undefined;

		let desc = zap.getMatchingTags('description');
		if (desc && desc.length == 1 && $latestRocketEvent) {
			zapRequest = new NDKEvent($ndk, JSON.parse(desc[0][1]));
			let zapRequestETags = zapRequest.getMatchingTags('e');

			if (zapRequestETags && zapRequestETags.length > 0) {
				for (let productIDfromZapRequest of zapRequestETags) {
					if (productIDfromZapRequest.length > 1) {
						let productsInRocket = getMapOfProducts($latestRocketEvent);
						if (productsInRocket) {
							productID = productIDfromZapRequest[1];
							if (productID.length == 64) {
								let productDataFromRocket = productsInRocket.get(productID);
								if (productDataFromRocket) {
									productPrice = parseInt(productDataFromRocket[1].split(':')[1], 10);
								}
							} else {
							}
						}
					}
				}
			}
			let amount = zapRequest.getMatchingTags('amount');
			if (amount && amount.length == 1) {
				if (amount[0].length == 2) {
					zapAmount = parseInt(amount[0][1], 10);
				}
			}
			buyerPubkey = zapRequest.author.pubkey;
		}
		let success = false;
		if (zapRequest && productID && buyerPubkey && productPrice && zapAmount) {
			if (zapAmount >= productPrice && productID.length == 64 && buyerPubkey.length == 64) {
				success = true;
				return {
					productPrice: productPrice,
					zapAmount: zapAmount,
					productID: productID,
					buyerPubkey: buyerPubkey,
					zapReceipt: zap.id
				};
			}
		}
		if (!success) {
			console.log('invalid product payment zap found:', zapRequest?.rawEvent());
		}
	}

	//todo: handle shadow events (fetch the shadowed event and render it instead)
</script>

{#if latestRocketEvent && $latestRocketEvent}
	<Heading title={$latestRocketEvent.getMatchingTags('d')[0][1]} />

	<Todo
		text={[
			'delete rocket (if current user is rocket creator)',
			'modify relevant data and republish event according to https://github.com/nostrocket/NIPS/blob/main/31108.md and https://github.com/nostrocket/NIPS/blob/main/MSBR334000.md '
		]}
	/>
	{#if candidateProducts && $candidateProducts}
		<Subheading title="Product Candidates" />
		<CreateNewProduct rocketEvent={$latestRocketEvent} />
		{#each $candidateProducts as r}<ProductCard rocket={$latestRocketEvent} product={r} />{/each}
	{/if}

	{#if zaps && $zaps}
		{#each $zaps as z}<p
				on:click={() => {
					let zapdata = getZapData(z);
					if (zapdata) {
						console.log(zapdata);
					}
				}}
			>
				{z.id}
			</p>{/each}
	{/if}
{:else}
	IGNITION: {rIgnitionOrActual} <br />
	NAME: {rName} <br />
	PUBKEY: {rPubkey} <br />
{/if}
