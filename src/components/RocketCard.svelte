<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { Rocket } from '@/event_helpers/rockets';
	import { ndk } from '@/ndk';
	import { devmode } from '@/stores/session';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { ChevronRight } from 'lucide-svelte';

	export let rocket: Rocket;

	//$page.url.searchParams.get("tab")
</script>

<Card.Root class="flex flex-col justify-between">
	<Card.Header>
		<Card.Title>{rocket.Name()}</Card.Title>
		<Card.Description>{rocket.Mission()}</Card.Description>
	</Card.Header>
	<Card.Content>
		<div class="flex items-center gap-2">
			<Avatar
				ndk={$ndk}
				pubkey={rocket.Event.pubkey}
				class="h-5 w-5 flex-none rounded-full object-cover"
			/>
			<Name ndk={$ndk} pubkey={rocket.Event.pubkey} class="inline-block truncate" />
		</div>
	</Card.Content>
	<Card.Footer>
		<div class="flex flex-wrap justify-between gap-2 lg:gap-1">
			{#if $devmode}
				<Button
					on:click={() => {
						console.log(rocket.Event.rawEvent());
					}}
					variant="outline">Print to Console</Button
				>{/if}
			<Button
				on:click={() => {
					goto(`${base}/rockets/${rocket.URL()}`);
				}}>View Full Rocket <ChevronRight class="h-4 w-4" /></Button
			>
		</div>
	</Card.Footer>
</Card.Root>
