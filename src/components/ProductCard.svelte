<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import {
		Product as ProductEvent,
		Rocket,
		RocketProduct,
		ZapPurchase
	} from '@/event_helpers/rockets';
	import AddProductToRocket from './AddProductToRocket.svelte';
	import PayNow from './PayNow.svelte';
	import { onMount } from 'svelte';
	import { devmode } from '@/stores/session';

	export let product: ProductEvent;
	export let rocket: Rocket;
	export let unratifiedZaps: Map<string, ZapPurchase> | undefined = undefined;

	let productFromRocket = rocket.Products().get(product.ID());

	onMount(() => {
		if (!product.Validate()) {
			throw new Error('this should not happen');
		}
	});

	function remainingProducts(product: RocketProduct, zaps?: Map<string, ZapPurchase>): number {
		let numberOfPurchases = 0;
		if (zaps) {
			for (let [_, zap] of zaps) {
				if (zap.ProductID == product.ID()) {
					numberOfPurchases++;
				}
			}
		}
		let remaining = product.MaxPurchases() - numberOfPurchases;
		if (remaining < 0) {
			remaining = 0;
		}
		return remaining;
	}
</script>

{#if product.Validate()}
	<Card.Root>
		<Card.Header>
			<Card.Title
				>{product.Group()}
				{#if product.Option().length > 0}(variant: {product.Option()}){/if}</Card.Title
			>
			<Card.Description>{product.Description()}</Card.Description>
		</Card.Header>

		{#if $$slots.default}
			<Card.Content>
				<div class="flex flex-col items-center justify-center gap-2 md:flex-row">
					<img
						src={product.CoverImage()}
						alt="cover"
						class="aspect-square w-[300px] object-cover"
					/>
					<slot />
				</div>
			</Card.Content>
		{:else}
			<div class="grid place-items-center">
				<img src={product.CoverImage()} alt="cover" class="aspect-square object-cover" />
			</div>
		{/if}
		<Card.Footer class="flex flex-col items-center justify-center pt-2">
			{#if !rocket.Products().get(product.ID()) && !productFromRocket}
				<AddProductToRocket {product} {rocket} />
			{:else if productFromRocket}
				{#if productFromRocket.MaxPurchases() && unratifiedZaps}
					<div class="flex flex-nowrap">
						{remainingProducts(productFromRocket, unratifiedZaps)} available
					</div>
				{/if}
				<PayNow
					disabled={productFromRocket.MaxPurchases() > 0 &&
						remainingProducts(productFromRocket, unratifiedZaps) == 0}
					{product}
					rocketProduct={rocket.Products().get(product.ID())}
					{rocket}
				/>
			{/if}
			{#if $devmode}
				<a
					href="#"
					on:click={() => {
						console.log(product);
					}}>print to console</a
				>{/if}
		</Card.Footer>
	</Card.Root>
{/if}
