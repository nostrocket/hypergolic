<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Product, Rocket } from '@/event_helpers/rockets';
	import { fetchEvent } from '@/event_helpers/products';
	import { ndk } from '@/ndk';
	import { derived, writable } from 'svelte/store';
	import ProductGroup from './ProductGroup.svelte';
	import CreateNewProduct from './CreateNewProduct.svelte';
	import CreateMeritRequest from './CreateMeritRequest.svelte';

	export let rocket: Rocket;
	export let unratifiedZaps: Map<string, number>;

	let products = writable(new Map<string, Product>());

	for (let [id, p] of rocket.Products()) {
		fetchEvent(id, $ndk).then((e) => {
			let _p = new Product(e);
			if (_p.Validate()) {
				products.update((existing) => {
					existing.set(id, _p);
					return existing;
				});
			}
		});
	}

	let groups = derived(products, ($products) => {
		let productGroups = new Map<string, Map<string, Product>>();
		for (let [id, p] of $products) {
			console.log(p.Group());
			if (!productGroups.get(p.Group())) {
				productGroups.set(p.Group(), new Map());
			}
			let existing = productGroups.get(p.Group())!;
			existing.set(id, p);
		}
		let productGroupArray = new Map<string, Product[]>();
		for (let [id, m] of productGroups) {
			productGroupArray.set(
				id,
				Array.from(m, ([_, p]) => {
					return p;
				})
			);
		}
		return productGroupArray;
	});
</script>

<Card.Root class="sm:col-span-3">
	<Card.Header class="pb-3">
		<Card.Title>Products and Purchases</Card.Title>
		<Card.Description></Card.Description>
	</Card.Header>

	<Card.Content class="grid grid-cols-1 gap-2">
		{#each $groups as [identifier, products] (identifier)}
			<ProductGroup {products} {rocket} bind:unratifiedZaps />
		{/each}
	</Card.Content>
	<Card.Footer><CreateNewProduct rocketEvent={rocket.Event} /></Card.Footer>
</Card.Root>
