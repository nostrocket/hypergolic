<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import type { MeritRequest } from '@/event_helpers/merits';
	import { ndk } from '@/ndk';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { ExternalLink } from 'lucide-svelte';
	import { onDestroy } from 'svelte';
	import VoteOnMeritRequest from './VoteOnMeritRequest.svelte';

	import ChevronLeft from 'lucide-svelte/icons/chevron-left';
	import ChevronRight from 'lucide-svelte/icons/chevron-right';
	import Copy from 'lucide-svelte/icons/copy';
	import CreditCard from 'lucide-svelte/icons/credit-card';
	import EllipsisVertical from 'lucide-svelte/icons/ellipsis-vertical';
	import Truck from 'lucide-svelte/icons/truck';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Pagination from '$lib/components/ui/pagination/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';

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
	<Card.Header class="bg-muted/50 pb-3">
		<div class="flex flex-nowrap justify-between">
			<Card.Title>Problem: {merit.Problem().substring(0, 20)}</Card.Title>{#if merit.Solution()}<a
					class="flex flex-nowrap text-orange-500 underline decoration-orange-500"
					href={merit.Solution()}>View Solution <ExternalLink size={18} class="m-1" /></a
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
		<Card.Content class="p-6 text-sm">
			<div class="grid gap-3">
				<div class="font-semibold">Merit Request Details</div>
				<ul class="grid gap-3">
					<li class="flex items-center justify-between">
						<span class="text-muted-foreground"> Number of Merits being requested </span>
						<span>{merit.Merits.toLocaleString()}</span>
					</li>
					<li class="flex items-center justify-between">
						<span class="text-muted-foreground">
							Value in Sats at the time the request was made
						</span>
						<span>{merit.Sats.toLocaleString()}</span>
					</li>
					<li class="flex items-center justify-between">
						<span class="text-muted-foreground">
							Approximate value of {merit.Sats.toLocaleString()} sats in CuckLoserBucks
						</span>
						<span>${merit.Sats.toLocaleString()}</span>
					</li>
				</ul>
				<Separator class="my-4" />
				<div class="grid grid-cols-2 gap-4">
					<div class="grid gap-3">
						<div class="font-semibold">Analysis</div>
						<span class="grid gap-0.5 not-italic text-muted-foreground">
							A competent freelance developer earns $70 CuckLoserBucks an hour (on average). Using this rate, the contributor is claiming to have spent about {merit.Sats/1000} hours working on this.
						</span>
					</div>
					<div class="grid auto-rows-max gap-3">
						<div class="font-semibold">Reference Time</div>
						<div class="text-muted-foreground">{merit.Sats/1000} hours</div>
					</div>
				</div>

				
		</Card.Content>
	</Card.Header>
	<Card.Footer class="flex flex-row items-center border-t px-6 py-3">
		<VoteOnMeritRequest {merit} {rocket} />
	</Card.Footer>
</Card.Root>
