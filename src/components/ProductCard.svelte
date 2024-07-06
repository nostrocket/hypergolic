<script lang="ts">
	import AddProductToRocket from './AddProductToRocket.svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { getMission, getRocketURL } from '@/helpers';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import { ChevronRight } from 'lucide-svelte';
	import PayNow from './PayNow.svelte';

	export let product: NDKEvent;
	export let rocket:NDKEvent;
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

	function includedInRocket():boolean {
		let included = false
		for (let p of rocket.getMatchingTags("product")) {
			if (p[1].split(":")[0] == product.id) {
				included = true
			}
		}
		return included
	}
</script>

{#if validate(product)}
	<Card.Root class="w-[350px] m-2">
		<Card.Header>
			<Card.Title>{product.getMatchingTags('name')[0][1]}</Card.Title>
			<Card.Description>{product.getMatchingTags('description')[0][1]}</Card.Description>
		</Card.Header>
		<img src={product.getMatchingTags('cover')[0][1]} />
		<Card.Content></Card.Content>
		<Card.Footer class="flex justify-between">
			{#if !includedInRocket()}
			<AddProductToRocket product={product} {rocket} />
			{:else}
			<PayNow {product} {rocket} />
			{/if}
		</Card.Footer>
	</Card.Root>
{/if}
