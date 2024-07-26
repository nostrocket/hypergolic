<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { RocketProduct } from '@/event_helpers/rockets';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import ProductCardFromId from './ProductCardFromID.svelte';
	import ProductPurchases from './ProductPurchases.svelte';
	import { writable, type Writable } from 'svelte/store';

	//export let product:RocketProduct;
	export let rocket: NDKEvent;

	let products: Writable<RocketProduct[]> = writable([]);

	$: {
		//fetch products from rocket and populate a store of them
		let _products: RocketProduct[] = [];
		for (let p of rocket.getMatchingTags('product')) {
			_products.push(new RocketProduct(p));
		}
		products.set(_products);
	}
</script>

<Card.Root class="sm:col-span-3">
	<Card.Header class="pb-3">
		<Card.Title>Products and Purchases</Card.Title>
		<Card.Description></Card.Description>
	</Card.Header>
	<Card.Content class="grid grid-cols-1 gap-2">
		{#each $products as product (product.ID)}
			<div>
				<ProductCardFromId {rocket} productID={product.ID}>
					<ProductPurchases {rocket} {product} />
				</ProductCardFromId>
			</div>
		{/each}
	</Card.Content>
	<Card.Footer></Card.Footer>
</Card.Root>
