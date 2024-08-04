<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Product, Rocket } from '@/event_helpers/rockets';
	import ProductCardFromId from './ProductCardFromID.svelte';
	import ProductPurchases from './ProductPurchases.svelte';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import { fetchEvent } from '@/event_helpers/products';
	import { ndk } from '@/ndk';
	import { derived, writable } from 'svelte/store';
	import * as Pagination from '@/components/ui/pagination';
	import { ChevronLeft, ChevronRight } from 'lucide-svelte';

	export let rocket: Rocket;
	export let unratifiedZaps:Map<string, number>;

	let products = writable(new Map<string, Product>());

	for (let [id, p] of rocket.Products()) {
		fetchEvent(id, $ndk).then((e) => {
			let _p = new Product(e);
			if (_p.Validate()) {
				products.update(existing => {
					existing.set(id, _p)
					return existing
				})
			}
		});
	}

	let groups = derived(products, ($products) => {
		let productGroups = new Map<string, Map<string, Product>>();
		for (let [id, p] of $products) {
			console.log(p.Group())
			if (!productGroups.get(p.Group())) {
				productGroups.set(p.Group(), new Map());
			}
			let existing = productGroups.get(p.Group())!;
			existing.set(id, p);
		}
		let productGroupArray = new Map<string, Product[]>()
		for (let [id, m] of productGroups) {
			productGroupArray.set(id, Array.from(m, ([_, p]) => {return p}))
		}
		return productGroupArray
	});
</script>

<Card.Root class="sm:col-span-3">
	<Card.Header class="pb-3">
		<Card.Title>Products and Purchases</Card.Title>
		<Card.Description></Card.Description>
	</Card.Header>
	<Card.Content class="grid grid-cols-1 gap-2">
		{#each $groups as [identifier, products] (identifier)}
		<Pagination.Root count={products.length} perPage={1} siblingCount={1} let:pages let:currentPage>
			{#if currentPage} <ProductCardFromId {rocket} product={products[currentPage-1]}>
				
				<ProductPurchases bind:unratifiedZaps {rocket} {products} />
			</ProductCardFromId>{/if}
			{#if products.length > 1}
			<Pagination.Content>
			  <Pagination.Item>
				<Pagination.PrevButton>
				  <ChevronLeft class="h-4 w-4" />
				  <span class="hidden sm:block">Previous Option</span>
				</Pagination.PrevButton>
			  </Pagination.Item>
			  {#each pages as page (page.key)}
				{#if page.type === "ellipsis"}
				  <Pagination.Item>
					<Pagination.Ellipsis />
				  </Pagination.Item>
				{:else}
				  <Pagination.Item>
					<Pagination.Link {page} isActive={currentPage === page.value}>
					  {page.value}
					</Pagination.Link>
				  </Pagination.Item>
				{/if}
			  {/each}
			  <Pagination.Item>
				<Pagination.NextButton>
				  <span class="hidden sm:block">Next Option</span>
				  <ChevronRight class="h-4 w-4" />
				</Pagination.NextButton>
			  </Pagination.Item>
			</Pagination.Content>	
			{/if}	
		  </Pagination.Root>
		  
		<!-- {#each map as [id, product]} {#if true}
		
		{/if}{/each} -->
		{/each}
		<!-- {#each products as [id, product] (id)}
			<div>
				<ProductCardFromId {rocket} {product}>
					<ProductPurchases bind:unratifiedZaps {rocket} product={rocket.Products().get(id)} />
				</ProductCardFromId>
			</div>
		{/each} -->
	</Card.Content>
	<Card.Footer></Card.Footer>
</Card.Root>
