<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { getMission, getRocketURL } from '@/helpers';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import { ChevronRight } from 'lucide-svelte';

	export let event: NDKEvent;
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
</script>

{#if validate(event)}
	<Card.Root class="w-[350px] m-2">
		<Card.Header>
			<Card.Title>{event.getMatchingTags('name')[0][1]}</Card.Title>
			<Card.Description>{event.getMatchingTags('description')[0][1]}</Card.Description>
		</Card.Header>
		<img src={event.getMatchingTags('cover')[0][1]} />
		<Card.Content></Card.Content>
		<Card.Footer class="flex justify-between">
			<Button
				on:click={() => {
					goto(`${base}/rockets/${getRocketURL(event)}`);
				}}>Make Available to Purchase<ChevronRight class="h-4 w-4" /></Button
			>
		</Card.Footer>
	</Card.Root>
{/if}
