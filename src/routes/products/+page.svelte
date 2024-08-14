<script lang="ts">
	import { ndk } from '@/ndk';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import type { NDKEventStore } from '@nostr-dev-kit/ndk-svelte';
	import { onDestroy } from 'svelte';
	import { derived } from 'svelte/store';
	import Heading from '../../components/Heading.svelte';
	import { Product, Rocket } from '@/event_helpers/rockets';
	import ProductGroup from '../../components/ProductGroup.svelte';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import ExclamationTriangle from 'svelte-radix/ExclamationTriangle.svelte';
	import * as Alert from '$lib/components/ui/alert/index.js';

	let rockets: NDKEventStore<NDKEvent> | undefined;
	let products: NDKEventStore<NDKEvent> | undefined;
	onDestroy(() => {
		rockets?.unsubscribe();
		products?.unsubscribe();
	});

	rockets = $ndk.storeSubscribe([{ kinds: [31108 as number] }], { subId: 'rockets' });
	products = $ndk.storeSubscribe([{ kinds: [1908 as number] }], { subId: 'products' });

	let rocketsWithProducts = derived(rockets, ($rockets) => {
		$rockets = $rockets.filter((r) => {
			return r.getMatchingTags('product').length > 0;
		});
		return $rockets;
	});

	let productsToRenderStore = derived(
		[rocketsWithProducts, products],
		([$rocketsWP, $products]) => {
			let mainnet: Map<Rocket, Map<string, Product[]>> = new Map();
			let testnet: Map<Rocket, Map<string, Product[]>> = new Map();

			let productMap = new Map($products.map((e) => [e.id, e]));

			for (let r of $rocketsWP) {
				let events: Product[] = [];
				for (let p of r.getMatchingTags('product')) {
					let productEvent = productMap.get(p[1].split(':')[0]);
					if (productEvent) {
						events.push(new Product(productEvent));
					}
				}
				if (events.length > 0) {
					let groupedProducts = groups(events);
					if (r.dTag!.toLowerCase().includes('test')) {
						testnet.set(new Rocket(r), groupedProducts);
					} else {
						mainnet.set(new Rocket(r), groupedProducts);
					}
				}
			}

			function groups(products: Product[]): Map</* group name*/ string, Product[]> {
				return products.reduce((acc, product) => {
					const group = product.Group();
					if (!acc.has(group)) {
						acc.set(group, []);
					}
					acc.get(group)!.push(product);
					return acc;
				}, new Map<string, Product[]>());
			}

			return { mainnet, testnet };
		}
	);

	let mainnet: Map<Rocket, Map<string, Product[]>> = new Map();
	let testnet: Map<Rocket, Map<string, Product[]>> = new Map();

	productsToRenderStore.subscribe(($productsToRenderStore) => {
		mainnet = $productsToRenderStore.mainnet;
		testnet = $productsToRenderStore.testnet;
	});
</script>

<Heading title="Products" />
<Tabs.Root value="mainnet">
	<Tabs.List>
		<Tabs.Trigger value="mainnet">Mainnet</Tabs.Trigger>
		<Tabs.Trigger value="testnet">Testnet</Tabs.Trigger>
	</Tabs.List>
	<Tabs.Content value="mainnet">
		{#if mainnet.size > 0}
			{#each mainnet as [rocket, groups] (rocket.Event.id)}
				<Heading title={rocket.Event.dTag} />
				<div class="grid gap-4" style="grid-template-columns: repeat(auto-fit, 350px);">
					{#each groups as [identifier, products] (identifier)}
						<ProductGroup {products} {rocket} />
					{/each}
				</div>
			{/each}
		{:else}
			<Alert.Root>
				<Alert.Description>No products found!</Alert.Description>
			</Alert.Root>
		{/if}
	</Tabs.Content>
	<Tabs.Content value="testnet">
		<Alert.Root class="my-2">
			<ExclamationTriangle class="h-4 w-4" />
			<Alert.Title>Note</Alert.Title>
			<Alert.Description>The following products are for testing and are not real.</Alert.Description
			>
		</Alert.Root>
		{#each testnet as [rocket, groups] (rocket.Event.id)}
			<Heading title={rocket.Event.dTag} />
			<div class="grid gap-4" style="grid-template-columns: repeat(auto-fit, 350px);">
				{#each groups as [identifier, products] (identifier)}
					<ProductGroup {products} {rocket} />
				{/each}
			</div>
		{/each}
	</Tabs.Content>
</Tabs.Root>
