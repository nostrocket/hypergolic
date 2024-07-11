<script lang="ts">
	import type { NDKEvent } from '@nostr-dev-kit/ndk';

	import { getMapOfProductsFromRocket } from '@/event_helpers/rockets';
	import ProductCardFromID from './ProductCardFromID.svelte';
	import ProductPurchases from './ProductPurchases.svelte';


	export let rocketEvent: NDKEvent;

	$: rocketProducts = getMapOfProductsFromRocket(rocketEvent);
</script>

{#if rocketEvent && rocketProducts.size > 0}
	{#each rocketProducts as [id, product]}
    <ProductCardFromID rocket={rocketEvent} productID={product.ID} />
		<ProductPurchases rocket={rocketEvent} {product} />{/each}
{/if}


