<script lang="ts">
	import ProductCardFromId from './ProductCardFromID.svelte';
	import ProductPurchases from './ProductPurchases.svelte';
	import * as Pagination from '@/components/ui/pagination';
	import { ChevronLeft, ChevronRight } from 'lucide-svelte';
	import { Product, Rocket, ZapPurchase } from '@/event_helpers/rockets';

	export let rocket: Rocket;
	export let products: Product[];
	export let unratifiedZaps: Map<string, ZapPurchase> | undefined = undefined;
</script>

<Pagination.Root count={products.length} perPage={1} siblingCount={1} let:pages let:currentPage>
	{#if currentPage}
		<ProductCardFromId {unratifiedZaps} {rocket} product={products[currentPage - 1]}>
			{#if unratifiedZaps}
				<ProductPurchases bind:unratifiedZaps {rocket} {products} />
			{/if}
		</ProductCardFromId>
	{/if}
	{#if products.length > 1}
		<Pagination.Content>
			<Pagination.Item>
				<Pagination.PrevButton>
					<ChevronLeft class="h-4 w-4" />
					<span class="hidden sm:block">Previous Option</span>
				</Pagination.PrevButton>
			</Pagination.Item>
			{#each pages as page (page.key)}
				{#if page.type === 'ellipsis'}
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
