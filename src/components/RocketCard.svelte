<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Name, Avatar } from '@nostr-dev-kit/ndk-svelte-components';
	import { getMission, getRocketURL } from '@/helpers';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import { ChevronRight } from 'lucide-svelte';
	import { ndk } from '@/ndk';

	export let rocketEvent: NDKEvent;
	//$page.url.searchParams.get("tab")
</script>

<Card.Root class="w-[350px]">
	<Card.Header>
		<Card.Title>{rocketEvent.getMatchingTags('d')[0][1]}</Card.Title>
		<Card.Description>{getMission(rocketEvent)}</Card.Description>
	</Card.Header>
	<Card.Content>
		<div class="flex items-center gap-2">
			<Avatar
				ndk={$ndk}
				pubkey={rocketEvent.pubkey}
				class="h-5 w-5 flex-none rounded-full object-cover"
			/>
			<Name ndk={$ndk} pubkey={rocketEvent.pubkey} class="inline-block truncate" />
		</div>
	</Card.Content>
	<Card.Footer class="flex justify-between">
		<Button
			on:click={() => {
				console.log(rocketEvent.rawEvent());
			}}
			variant="outline">Print to Console</Button
		>
		<Button
			on:click={() => {
				goto(`${base}/rockets/${getRocketURL(rocketEvent)}`);
			}}>View Full Rocket<ChevronRight class="h-4 w-4" /></Button
		>
	</Card.Footer>
</Card.Root>
