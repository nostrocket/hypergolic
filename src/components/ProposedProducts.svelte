<script lang="ts">
	import { ndk } from '@/ndk';
	import { onDestroy } from 'svelte';
	import { derived } from 'svelte/store';
	import ProductCard from './ProductCard.svelte';
	import { Product, type Rocket } from '@/event_helpers/rockets';
	import * as Card from '@/components/ui/card';

	export let rocket: Rocket;

	let proposals = $ndk.storeSubscribe(
		[
			{
				'#a': [`31108:${rocket.Event.author.pubkey}:${rocket.Event.dTag}`],
				kinds: [1908 as number]
			}
		],
		{ subId: rocket.Name() }
	);

	onDestroy(() => {
		proposals.unsubscribe();
	});

	let unratified = derived(proposals, ($proposals) => {
		$proposals = $proposals.filter((p) => {
			return Boolean(!rocket.Products().get(p.id));
		});
		let products = new Map<string, Product>();
		for (let p of $proposals) {
			products.set(p.id, new Product(p));
		}
		return products;
	});
</script>

{#if $unratified.size > 0}
	<Card.Root>
		<Card.Header>PROPOSED PRODUCTS</Card.Header>
		<Card.Content>
			TODO: make this look better
			{#each $unratified as [_, product] (product.ID())}<ProductCard
					productFromRocket={rocket.Products().get(product.ID())}
					{rocket}
					{product}
				/>{/each}
		</Card.Content>
	</Card.Root>
{/if}
