<script lang="ts">
	import { page } from '$app/stores';
	import { ndk } from '@/ndk';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import type { ExtendedBaseType, NDKEventStore } from '@nostr-dev-kit/ndk-svelte';
	import { onDestroy } from 'svelte';
	import { derived, type Readable } from 'svelte/store';
	import Heading from '../../../components/Heading.svelte';
	//flow if we only have a d-tag: fetch all 31108's with this d-tag, sort by WoT, put Nostrocket Name Service one at the top. Dedupe same rocket (same state, shadows) from multiple users, just show them all as everyone agreeing.
	//second pass: fetch ignition event for each, rebuild current state and validate all proofs, compute votepower and display only the states with > 50%.

	let rIgnitionOrActual = $page.params.ignition;
	let rName = $page.url.searchParams.get('d');
	let rPubkey = $page.url.searchParams.get('p');

	let events: NDKEventStore<NDKEvent> | undefined;
	let latest: Readable<ExtendedBaseType<NDKEvent> | undefined>;
	onDestroy(() => {
		events?.unsubscribe();
	});

	//if we don't have a d/p tags we just render the event provided
	//todo: to find the latest by name alone we should use a new route and redirect to this page once we've got the relevant data
	if (!rName && !rPubkey && rIgnitionOrActual.length == 64) {
		//this is the actual event ID the user wants to view so fetch the single event and render
		//warn user that this information is probably out of date and let them reroute to get the latest
	}

	if (rIgnitionOrActual.length == 64 && rName && rPubkey) {
		//the user wants the latest valid state of this rocket
		events = $ndk.storeSubscribe(
			[{ '#d': [rName], authors: [rPubkey], kinds: [31108 as number] }],
			{ subId: rName }
		);
	}

	$: {
		if (events) {
			latest = derived(events, ($events) => {
				if (events) {
					let sorted = $events.toSorted((a, b) => {
						return a.created_at - b.created_at;
					});
					return sorted[0];
				}
				return undefined;
			});
		}
	}

	//todo: handle shadow events (fetch the shadowed event and render it instead)
</script>

{#if latest && $latest}
<Heading title={$latest.getMatchingTags("d")[0][1]} />
	<p>{$latest.id}</p>
{:else}
	IGNITION: {rIgnitionOrActual} <br />
	NAME: {rName} <br />
	PUBKEY: {rPubkey} <br />
{/if}
