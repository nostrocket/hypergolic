<script lang="ts">
	import { onMount } from 'svelte';
	import { ndk } from '@/ndk';
	import ProductCard from './ProductCard.svelte';
	import { fetchEvent } from '@/event_helpers/products';
	import { Product, ZapPurchase, type Rocket } from '@/event_helpers/rockets';
	export let productID: string | undefined = undefined;
	export let rocket: Rocket;
	export let product: Product | undefined = undefined;
	export let unratifiedZaps: Map<string, ZapPurchase> | undefined = undefined;

	onMount(() => {
		if (!product && productID) {
			fetchEvent(productID, $ndk).then((e) => (product = new Product(e)));
		}
	});
</script>

{#if product}
	<ProductCard
		productFromRocket={rocket.Products().get(product.ID())}
		{unratifiedZaps}
		{rocket}
		{product}
	>
		<slot />
	</ProductCard>
{/if}
