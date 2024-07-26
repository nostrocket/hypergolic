<script lang="ts">
	import { ndk } from '@/ndk';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import type { NDKEventStore } from '@nostr-dev-kit/ndk-svelte';
	import { onDestroy } from 'svelte';
	import { derived } from 'svelte/store';
	import Heading from '../../components/Heading.svelte';
	import ProductCard from '../../components/ProductCard.svelte';

	let rockets: NDKEventStore<NDKEvent> | undefined;
	let products: NDKEventStore<NDKEvent> | undefined;
	onDestroy(() => {
		rockets?.unsubscribe();
		products?.unsubscribe();
	});

	rockets = $ndk.storeSubscribe([{ kinds: [31108 as number] }], { subId: 'rockets' });
	products = $ndk.storeSubscribe([{ kinds: [1908 as number] }], { subId: 'products' });

	let rocketsWithProducts = derived(rockets, ($rockets) => {
		$rockets = $rockets.filter((r) => {
			return r.getMatchingTags('product').length > 0;
		});
		return $rockets;
	});

	let productsToRender = derived([rocketsWithProducts, products], ([$rocketsWP, $products]) => {
		let data = new Map<NDKEvent, NDKEvent[]>();
		let productMap = new Map($products.map((e) => [e.id, e]));
		for (let r of $rocketsWP) {
			let events = [];
			for (let p of r.getMatchingTags('product')) {
				let productEvent = productMap.get(p[1].split(':')[0]);
				if (productEvent) {
					events.push(productEvent);
				}
			}
			if (events.length > 0) {
				data.set(r, events);
			}
		}
		return data;
	});
</script>

{#if productsToRender && $productsToRender}
	{#each $productsToRender as [r, p] (r.id)}
		<Heading title={r.dTag} />
		<div class="grid gap-2" style="grid-template-columns: repeat(auto-fit, 350px);">
			{#each p as product (product.id)}
				<ProductCard {product} rocket={r} />
			{/each}
		</div>
	{/each}
{/if}
