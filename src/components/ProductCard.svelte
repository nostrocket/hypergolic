<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Product, Rocket } from '@/event_helpers/rockets';
	import AddProductToRocket from './AddProductToRocket.svelte';
	import PayNow from './PayNow.svelte';

	export let product: Product;
	export let rocket: Rocket;
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
		<Card.Footer class="flex items-center justify-center pt-2">
			{#if !rocket.Products().get(product.ID())}
				<AddProductToRocket {product} {rocket} />
			{:else}
				<PayNow {product} rocketProduct={rocket.Products().get(product.ID())} {rocket} />
			{/if}
		</Card.Footer>
	</Card.Root>
{/if}
