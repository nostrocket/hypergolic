<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import type { MeritRequest } from '@/event_helpers/merits';
	import { ndk } from '@/ndk';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { ExternalLink } from 'lucide-svelte';
	import { onDestroy } from 'svelte';
	import VoteOnMeritRequest from './VoteOnMeritRequest.svelte';

	export let merit: MeritRequest;
	export let rocket: NDKEvent;

	let votes = $ndk.storeSubscribe([merit.REQFilter(1410)], {
		subId: merit.RocketTag!.split(':')[2] + '_votes'
	});

	onDestroy(() => {
		votes.unsubscribe();
	});
</script>

<Card.Root class="sm:col-span-2">
	<Card.Header class="pb-3">
		<div class="flex flex-nowrap justify-between">
			<Card.Title>Problem: {merit.Problem().substring(0, 20)}</Card.Title>{#if merit.Solution()}<a
					class="text-orange-500 underline decoration-orange-500 flex flex-nowrap"
					href={merit.Solution()}>View Solution <ExternalLink size={18} class="m-1"/></a
				>{/if}
		</div>
		<div class="flex flex-nowrap">
			<Avatar
				ndk={$ndk}
				pubkey={merit.Pubkey}
				class="h-10 w-10 flex-none rounded-full object-cover"
			/>
			<Name ndk={$ndk} pubkey={merit.Pubkey} class="hidden max-w-32 truncate p-2 md:inline-block" />
		</div>
		<Card.Description class="max-w-lg text-balance leading-relaxed">
			{#if merit.Problem().length > 20}{merit.Problem()}{/if}
		</Card.Description>
	</Card.Header>
	<Card.Footer>
		<VoteOnMeritRequest {merit} {rocket} />
	</Card.Footer>
</Card.Root>
