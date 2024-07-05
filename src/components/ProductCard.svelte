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

</script>

<Card.Root class="w-[350px]">
	<Card.Header>
		<Card.Title>{event.getMatchingTags('name')[0][1]}</Card.Title>
		<Card.Description>{getMission(event)}</Card.Description>
	</Card.Header>
	<Card.Content></Card.Content>
	<Card.Footer class="flex justify-between">
        <Button on:click={()=>{console.log(event.rawEvent())}} variant="outline">Print to Console</Button>
		<Button on:click={()=>{goto(`${base}/rockets/${getRocketURL(event)}`)}}>View Full Rocket<ChevronRight class="h-4 w-4" /></Button>
	</Card.Footer>
</Card.Root>
