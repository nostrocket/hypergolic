<script lang="ts">
	import { ndk } from '@/ndk';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import type { ExtendedBaseType, NDKEventStore } from '@nostr-dev-kit/ndk-svelte';
	import { onDestroy } from 'svelte';
	import { derived, type Readable } from 'svelte/store';

	export let dTag: string; // = $page.url.searchParams.get('d');
	export let pubkey: string; // = $page.url.searchParams.get('p');


	let rocketEvents: NDKEventStore<NDKEvent> | undefined;
	export let latestRocketEvent: Readable<ExtendedBaseType<NDKEvent> | undefined>;

	let candidateProducts: Readable<ExtendedBaseType<NDKEvent>[]>;
	onDestroy(() => {
		rocketEvents?.unsubscribe();
	});

	rocketEvents = $ndk.storeSubscribe(
		[
			{ '#d': [dTag], authors: [pubkey], kinds: [31108 as number] },
			{ '#a': [`31108:${pubkey}:${dTag}`] }
		],
		{ subId: dTag }
	);

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

			if ($latestRocketEvent && !candidateProducts) {
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
</script>
