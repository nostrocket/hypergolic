<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Rocket } from '@/event_helpers/rockets';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import ProductCardFromId from './ProductCardFromID.svelte';
	import ProductPurchases from './ProductPurchases.svelte';

	export let rocket: NDKEvent;
	let products = new Rocket(rocket).Products()

</script>

<Card.Root class="sm:col-span-3">
	<Card.Header class="pb-3">
		<Card.Title>Products and Purchases</Card.Title>
		<Card.Description></Card.Description>
	</Card.Header>
	<Card.Content class="grid grid-cols-1 gap-2">
		{#each products as product (product.ID)}
			<div>
				<ProductCardFromId {rocket} productID={product.ID}>
					<ProductPurchases {rocket} {product} />
				</ProductCardFromId>
			</div>
		{/each}
	</Card.Content>
	<Card.Footer></Card.Footer>
</Card.Root>
