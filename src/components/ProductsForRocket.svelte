<script lang="ts">
	import type { NDKEvent } from '@nostr-dev-kit/ndk';

	import Todo from './Todo.svelte';
	import { writable, type Readable } from 'svelte/store';
	import { getMapOfProductsFromRocket, type RocketProduct } from '@/event_helpers/rockets';
	import ProductPurchases from './ProductPurchases.svelte';
	import ProductCard from './ProductCard.svelte';
	import ProductCardFromEvent from './ProductCardFromEvent.svelte';


	export let rocketEvent: NDKEvent;

	$: rocketProducts = getMapOfProductsFromRocket(rocketEvent);
</script>

{#if rocketEvent && rocketProducts.size > 0}
	{#each rocketProducts as [id, product]}
    <ProductCardFromEvent rocket={rocketEvent} productID={product.ID} />
		<ProductPurchases rocket={rocketEvent} {product} />{/each}
{/if}


