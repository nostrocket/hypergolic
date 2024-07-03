<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';

	export let rocketEvent: NDKEvent;
</script>

<Card.Root class="w-[350px]">
	<Card.Header>
		<Card.Title>{rocketEvent.getMatchingTags('d')[0][1]}</Card.Title>
		<Card.Description>{rocketEvent.getMatchingTags('mission')[0][1]}</Card.Description>
	</Card.Header>
	<Card.Content></Card.Content>
	<Card.Footer class="flex justify-between">
        <Button on:click={()=>{console.log(rocketEvent.rawEvent())}} variant="outline">Print to Console</Button>
		<Button>View Full Rocket</Button>
	</Card.Footer>
</Card.Root>
