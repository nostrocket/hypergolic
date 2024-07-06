<script lang="ts">
	import { page } from '$app/stores';
	import { ndk } from '@/ndk';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
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

	if (rIgnitionOrActual.length == 64 && rName && rPubkey) {
		//the user wants the latest valid state of this rocket
		rocketEvents = $ndk.storeSubscribe(
			[{ '#d': [rName], authors: [rPubkey], kinds: [31108 as number] },
            { '#a': [`31108:${rPubkey}:${rName}`]}],
			{ subId: rName }
		);
	}

	$: {
		if (rocketEvents) {
			latestRocketEvent = derived(rocketEvents, ($events) => {
				if (rocketEvents) {
                    let sorted = $events.filter(e=>{
                        return e.kind == 31108;
                    })
					sorted = sorted.toSorted((a, b) => {
						return a.created_at - b.created_at;
					});
					return sorted[0];
				}
				return undefined;
			});

            if ($latestRocketEvent) {
                candidateProducts = derived(rocketEvents, ($events) =>{
                    return $events.filter(e=>{
						for (let p of $latestRocketEvent.getMatchingTags("product")) {
							if (p[1].includes(e.id)) {
								return false
							}
						}
                        return e.kind == 1908;
                    })
                })
            }
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
	
{:else}
	IGNITION: {rIgnitionOrActual} <br />
	NAME: {rName} <br />
	PUBKEY: {rPubkey} <br />
{/if}
