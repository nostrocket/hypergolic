<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { Rocket } from '@/event_helpers/rockets';
	import { ndk } from '@/ndk';
	import { devmode } from '@/stores/session';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { ChevronRight, RocketIcon, ShoppingCart, BicepsFlexed, User } from 'lucide-svelte';
	import BadgeMaker from './BadgeMaker.svelte';

	export let rocket: Rocket;

	//$page.url.searchParams.get("tab")
</script>

<Card.Root class="flex flex-col justify-between">
	<Card.Header>
		<Card.Title>
			<div class="flex flex-nowrap items-stretch">
				{rocket.Name()}<BadgeMaker right
					><div slot="icon"><RocketIcon /></div>
					<div slot="content">
						<div class="flex items-center gap-2">
							<Avatar
								ndk={$ndk}
								pubkey={rocket.Event.pubkey}
								class="h-5 w-5 flex-none rounded-full object-cover"
							/>
							<Name
								npubMaxLength={10}
								ndk={$ndk}
								pubkey={rocket.Event.pubkey}
								class="inline-block truncate"
							/>
						</div>
					</div></BadgeMaker
				>
			</div>
		</Card.Title>
		{#if rocket.Mission()}<Card.Description>MISSION: {rocket.Mission()}</Card.Description>
		{/if}
	</Card.Header>
	<Card.Content>
		<BadgeMaker
			><div slot="icon"><ShoppingCart /></div>
			<div slot="content">{rocket.Products().size}</div></BadgeMaker
		>
		<BadgeMaker
			><div slot="icon"><BicepsFlexed /></div>
			<div slot="content">{rocket.ApprovedMeritRequests().size}</div></BadgeMaker
		>
		<BadgeMaker
			><div slot="icon"><User /></div>
			<div slot="content">{rocket.Owners().size}</div></BadgeMaker
		>
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
