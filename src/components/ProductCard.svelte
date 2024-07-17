<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import AddProductToRocket from './AddProductToRocket.svelte';
	import PayNow from './PayNow.svelte';

	export let product: NDKEvent;
	export let rocket: NDKEvent;
	//$page.url.searchParams.get("tab")

	function validate(event: NDKEvent): boolean {
		let test = 0;
		if (
			event.getMatchingTags('name') &&
			event.getMatchingTags('name')[0] &&
			event.getMatchingTags('name')[0][1]
		) {
			test++;
		}
		if (
			event.getMatchingTags('description') &&
			event.getMatchingTags('description')[0] &&
			event.getMatchingTags('description')[0][1]
		) {
			test++;
		}
		if (
			event.getMatchingTags('cover') &&
			event.getMatchingTags('cover')[0] &&
			event.getMatchingTags('cover')[0][1]
		) {
			test++;
		}
		return test == 3;
	}

	function includedInRocket(): boolean {
		let included = false;
		for (let p of rocket.getMatchingTags('product')) {
			if (p[1].split(':')[0] == product.id) {
				included = true;
			}
		}
		return included;
	}
</script>

{#if validate(product)}
	<Card.Root>
		<Card.Header>
			<Card.Title>{product.getMatchingTags('name')[0][1]}</Card.Title>
			<Card.Description>{product.getMatchingTags('description')[0][1]}</Card.Description>
		</Card.Header>

		{#if $$slots.default}
			<Card.Content>
				<div class="flex flex-col items-center justify-center gap-2 sm:flex-row">
					<img
						src={product.getMatchingTags('cover')[0][1]}
						alt="cover"
						class="aspect-square w-[200px] object-cover"
					/>
					<slot />
				</div>
			</Card.Content>
		{:else}
			<img
				src={product.getMatchingTags('cover')[0][1]}
				alt="cover"
				class="aspect-square object-cover"
			/>
		{/if}
		<Card.Footer class="flex justify-between pt-2">
			{#if !includedInRocket()}
				<AddProductToRocket {product} {rocket} />
			{:else}
				<PayNow {product} {rocket} />
			{/if}
		</Card.Footer>
	</Card.Root>
{/if}
