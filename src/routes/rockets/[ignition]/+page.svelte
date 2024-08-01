<script lang="ts">
	import { page } from '$app/stores';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import type { ExtendedBaseType } from '@nostr-dev-kit/ndk-svelte';
	import { type Readable } from 'svelte/store';
	import Heading from '../../../components/Heading.svelte';
	import RocketDashboard from '../../../components/RocketDashboard.svelte';
	import Rocket from '../../../route_helpers/Rocket.svelte';
	//flow if we only have a d-tag: fetch all 31108's with this d-tag, sort by WoT, put Nostrocket Name Service one at the top. Dedupe same rocket (same state, shadows) from multiple users, just show them all as everyone agreeing.
	//second pass: fetch ignition event for each, rebuild current state and validate all proofs, compute votepower and display only the states with > 50%.

	let rIgnitionOrActual = $page.params.ignition;
	let dTag = $page.url.searchParams.get('d');
	let pubkey = $page.url.searchParams.get('p');

	let latestRocketEvent: Readable<ExtendedBaseType<NDKEvent> | undefined>;


	//if we don't have a d/p tags we just render the event provided
	//todo: to find the latest by name alone we should use a new route and redirect to this page once we've got the relevant data
	if (!dTag && !pubkey && rIgnitionOrActual.length == 64) {
		//this is the actual event ID the user wants to view so fetch the single event and render
		//warn user that this information is probably out of date and let them reroute to get the latest
	}

	if (dTag && pubkey) {
		//the user wants the latest valid state of this rocket
		
	}

	//todo: check that this zap is not already included in the payment JSON for the product
	//todo: list purchases on the rocket page (from product tags, as well as zap receipts that aren't yet included). Deduct total products available if not 0.
	//todo: make the page flash or something and show each time someone buys the product.
	//todo: split this out so that we can consume it for the payment page too (so that we know if there are really products left or they're all sold)
	//todo: make store of all purchases (in rocket and zaps), sort by timestamp and render with profile of buyer

	//todo: handle shadow events (fetch the shadowed event and render it instead)
</script>
{#if dTag && pubkey}
<Rocket bind:latestRocketEvent {dTag} {pubkey} />
{/if}

{#if latestRocketEvent && $latestRocketEvent}
	<RocketDashboard rocket={$latestRocketEvent} />
{:else}
	<Heading title="Fetching events for the requested rocket" />
	IGNITION: {rIgnitionOrActual} <br />
	NAME: {dTag} <br />
	PUBKEY: {pubkey} <br />
{/if}