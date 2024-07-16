<script lang="ts">
	import { onMount } from 'svelte';
	import { ndk } from '@/ndk';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import ProductCard from './ProductCard.svelte';
	export let productID: string;
	export let rocket: NDKEvent;
	let productEvent: NDKEvent | undefined;

	onMount(() => {
		$ndk.fetchEvent(productID).then((e) => {
			if (e) {
				productEvent = e;
			}
		});
	});
</script>

{#if productEvent}
	<ProductCard {rocket} product={productEvent} />
{/if}
