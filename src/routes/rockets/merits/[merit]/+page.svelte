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

	let meritRequest: MeritRequest | undefined = undefined;

	$: {
		if (meritRequestID.length == 64 && !meritRequest) {
			$ndk.fetchEvent(meritRequestID).then((e) => {
				if (e) {
					meritRequest = new MeritRequest(e);
				}
			});
		}
	}

	let rocketEvents: NDKEventStore<NDKEvent> | undefined;
	let latestRocketEvent: Readable<ExtendedBaseType<NDKEvent> | undefined>;

	onDestroy(() => {
		rocketEvents?.unsubscribe();
	});

	$: {
		if (meritRequest && meritRequest.BasicValidation()) {
			rocketEvents = $ndk.storeSubscribe([meritRequest.REQFilter()], {
				subId: meritRequest.RocketTag!.split(':')[2]
			});
		}
	}

	$: {
		if (rocketEvents && !latestRocketEvent) {
			latestRocketEvent = derived(rocketEvents, ($events) => {
				let sorted = $events.filter((e) => {
					return e.kind == 31108;
				});
				sorted = sorted.toSorted((a, b) => {
					return a.created_at - b.created_at;
				});
				return sorted[0];
			});
		}
	}
</script>

{#if latestRocketEvent && $latestRocketEvent && meritRequest}
	<MeritRequestDashboard rocket={$latestRocketEvent} merit={meritRequest} />
{:else}
	<Heading title="Fetching events for this Merit Request" />
	Merit Request ID: {$page.params.merit} <br />
{/if}
