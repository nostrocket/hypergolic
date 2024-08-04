<script lang="ts">
	import { onMount } from 'svelte';
	import { ndk } from '@/ndk';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import ProductCard from './ProductCard.svelte';
	import { fetchEvent } from '@/event_helpers/products';
	import { Product, type Rocket } from '@/event_helpers/rockets';
	export let productID: string | undefined = undefined;
	export let rocket: Rocket;
	export let product:Product | undefined = undefined;

	onMount(() => {
		if (!product && productID) {
			fetchEvent(productID, $ndk).then(e => product = new Product(e))
		}
	});

</script>

{#if product}
	<ProductCard {rocket} {product}>
		<slot />
	</ProductCard>
{/if}
