<script lang="ts">
	import { ndk } from '@/ndk';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import { onDestroy } from 'svelte';
	import ProductCard from './ProductCard.svelte';
	import { derived } from 'svelte/store';

	export let rocket: NDKEvent;

	let proposals = $ndk.storeSubscribe(
		[{ '#a': [`31108:${rocket.author.pubkey}:${rocket.dTag}`], kinds: [1908 as number] }],
		{ subId: rocket.dTag }
	);

	onDestroy(() => {
		proposals.unsubscribe();
	});

	let unratified = derived(proposals, ($proposals) => {
		return $proposals.filter((p) => {
			let found = false;
			for (let product of rocket.getMatchingTags('product')) {
				if (product[1].split(':')[0] == p.id) {
					found = true;
				}
			}
			return !found;
		});
	});
</script>

{#each $unratified as r}<ProductCard {rocket} product={r} />{/each}
