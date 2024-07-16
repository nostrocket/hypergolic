<script lang="ts">
	import { page } from '$app/stores';
	import { MeritRequest } from '@/event_helpers/merits';
	import { ndk } from '@/ndk';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import type { ExtendedBaseType, NDKEventStore } from '@nostr-dev-kit/ndk-svelte';
	import { onDestroy } from 'svelte';
	import { derived, type Readable } from 'svelte/store';
	import Heading from '../../../../components/Heading.svelte';
	import MeritRequestDashboard from '../../../../components/MeritRequestDashboard.svelte';
	
	let meritRequestID = $page.params.merit;

	let meritRequest:MeritRequest | undefined = undefined;

	$: {
		if (meritRequestID.length == 64 && !meritRequest) {
			$ndk.fetchEvent(meritRequestID).then(e=>{
				if (e) {
					meritRequest = new MeritRequest(e)
				}
			})
		}
	}

	let rocketEvents: NDKEventStore<NDKEvent> | undefined;
	let latestRocketEvent: Readable<ExtendedBaseType<NDKEvent> | undefined>;

	onDestroy(() => {
		rocketEvents?.unsubscribe();
	});

	$: {
		if (meritRequest && meritRequest.BasicValidation()) {
		//the user wants the latest valid state of this rocket
		rocketEvents = $ndk.storeSubscribe(
			[
				meritRequest.REQFilter()
			],
			{ subId: meritRequest.RocketTag!.split(":")[2] }
		);
	}
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

			}
		}
	}



	//todo: check that this zap is not already included in the payment JSON for the product
	//todo: list purchases on the rocket page (from product tags, as well as zap receipts that aren't yet included). Deduct total products available if not 0.
	//todo: make the page flash or something and show each time someone buys the product.
	//todo: split this out so that we can consume it for the payment page too (so that we know if there are really products left or they're all sold)
	//todo: make store of all purchases (in rocket and zaps), sort by timestamp and render with profile of buyer

	//todo: handle shadow events (fetch the shadowed event and render it instead)
</script>
{#if latestRocketEvent && $latestRocketEvent && meritRequest}
<MeritRequestDashboard rocket={$latestRocketEvent} merit={meritRequest} />
{:else}
	<Heading title="Fetching events for this Merit Request" />
	Merit Request ID: {$page.params.merit} <br />
{/if}
