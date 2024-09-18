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
	import { currentUser, devmode } from '@/stores/session';
	import BadgeMaker from './BadgeMaker.svelte';
	import Login from './Login.svelte';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { ndk } from '@/ndk';
	import * as HoverCard from '$lib/components/ui/hover-card';
	import ProfileCard from './ProfileCard.svelte';

	export let product: ProductEvent;
	export let rocket: Rocket;
	export let productFromRocket: RocketProduct | undefined;
	export let unratifiedZaps: Map<string, ZapPurchase> | undefined = undefined;

	//$:productFromRocket = rocket.Products().get(product.ID())// RocketProduct | undefined = undefined;

	onMount(() => {
		if (!product.Validate()) {
			throw new Error('this should not happen');
		}
	});

	function disabled(productFromRocket: RocketProduct): boolean {
		let disabled = false;
		if (!productFromRocket?.ValidNow()) {
			disabled = true;
		}
		if (
			productFromRocket.MaxPurchases() > 0 &&
			productFromRocket.MaxPurchases() - zapsForThisProduct(productFromRocket!).size == 0
		) {
			disabled = true;
		}
		return disabled;
		// productFromRocket.MaxPurchases() > 0 &&
		// productFromRocket.MaxPurchases() - zapsForThisProduct(productFromRocket).size == 0 && !productFromRocket.ValidNow()
	}

	function zapsForThisProduct(product: RocketProduct): Map<string, ZapPurchase> {
		let m = new Map<string, ZapPurchase>();
		if (unratifiedZaps) {
			for (let [_, zap] of unratifiedZaps) {
				if (zap.ProductID == product.ID()) {
					m.set(zap.ZapReceipt.id, zap);
				}
			}
		}
		return m;
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
			<div class="flex w-full justify-start">
				<HoverCard.Root>
					<HoverCard.Trigger>
						<BadgeMaker>
							<div slot="icon">PROPOSED:</div>
							<div slot="content">
								<div class="flex items-center gap-2">
									<Avatar
										ndk={$ndk}
										pubkey={product.Creator()}
										class="h-5 w-5 flex-none rounded-full object-cover"
									/>
									<Name
										npubMaxLength={10}
										ndk={$ndk}
										pubkey={product.Creator()}
										class="inline-block truncate"
									/>
								</div>
							</div>
						</BadgeMaker>
					</HoverCard.Trigger>
					<HoverCard.Content>
						<ProfileCard pubkey={product.Creator()} />
					</HoverCard.Content>
				</HoverCard.Root>
			</div>
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
					<div class="mb-4 flex flex-nowrap">
						<BadgeMaker
							><div slot="icon">SOLD:</div>
							<div slot="content">{zapsForThisProduct(productFromRocket).size}</div></BadgeMaker
						>
						<BadgeMaker
							><div slot="icon">AVAILABLE:</div>
							<div slot="content">
								{productFromRocket.MaxPurchases() - zapsForThisProduct(productFromRocket).size}
							</div></BadgeMaker
						>
					</div>
				{/if}
				{#if $currentUser}
					<PayNow
						disabled={disabled(productFromRocket)}
						{product}
						rocketProduct={rocket.Products().get(product.ID())}
						{rocket}
					/>
				{:else}
					<Login />
				{/if}
			{/if}
			{#if $devmode}
				<a
					href="#"
					on:click={() => {
						console.log(product);
						if (productFromRocket) {
							console.log(productFromRocket);
							console.log(
								'max purchases',
								productFromRocket.MaxPurchases(),
								'price',
								productFromRocket.Price(),
								'valid after',
								productFromRocket.ValidAfter(),
								'seconds till valid',
								productFromRocket.TimeTillValid(),
								'validNow',
								productFromRocket.ValidNow()
							);
						}
					}}>print product</a
				>

				<a
					href="#"
					on:click={() => {
						console.log(unratifiedZaps);
					}}>print unratified zaps</a
				>
			{/if}
		</Card.Footer>
	</Card.Root>
{/if}
