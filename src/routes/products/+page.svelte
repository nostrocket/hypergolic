<script lang="ts">
	import { ndk } from '@/ndk';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import type { NDKEventStore } from '@nostr-dev-kit/ndk-svelte';
	import { onDestroy } from 'svelte';
	import { derived } from 'svelte/store';
	import Heading from '../../components/Heading.svelte';
	import { Product, Rocket } from '@/event_helpers/rockets';
	import ProductGroup from '../../components/ProductGroup.svelte';

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
		let data = new Map<Rocket, Map<string, Product[]>>();
		let productMap = new Map($products.map((e) => [e.id, e]));
		for (let r of $rocketsWP) {
			let events: Product[] = [];
			for (let p of r.getMatchingTags('product')) {
				let productEvent = productMap.get(p[1].split(':')[0]);
				if (productEvent) {
					events.push(new Product(productEvent));
				}
			}
			if (events.length > 0) {
				data.set(new Rocket(r), groups(events));
			}
		}

		function groups(products: Product[]): Map</* group name*/ string, Product[]> {
			return products.reduce((acc, product) => {
				const group = product.Group();
				if (!acc.has(group)) {
					acc.set(group, []);
				}
				acc.get(group)!.push(product);
				return acc;
			}, new Map<string, Product[]>());
		}
		return data;
	});
</script>

{#if productsToRender && $productsToRender}
	{#each $productsToRender as [rocket, groups] (rocket.Event.id)}
		<Heading title={rocket.Event.dTag} />
		<div class="grid gap-4" style="grid-template-columns: repeat(auto-fit, 350px);">
			{#each groups as [identifier, products] (identifier)}
				<ProductGroup {products} {rocket} />
			{/each}
		</div>
	{/each}
{/if}
