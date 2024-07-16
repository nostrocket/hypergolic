<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { MapOfVotes, Vote, Votes, type MeritRequest } from '@/event_helpers/merits';
	import { ndk } from '@/ndk';
	import { NDKEvent, type NDKKind } from '@nostr-dev-kit/ndk';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { ExternalLink, Info } from 'lucide-svelte';
	import { onDestroy } from 'svelte';
	import VoteOnMeritRequest from './VoteOnMeritRequest.svelte';

	import { Separator } from '$lib/components/ui/separator/index.js';
	import * as Table from '@/components/ui/table';
	import { Rocket, RocketATagFilter } from '@/event_helpers/rockets';
	import { getRocketURL, unixToRelativeTime } from '@/helpers';
	import { derived } from 'svelte/store';

	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import Alert from '@/components/ui/alert/alert.svelte';
	import { currentUser } from '@/stores/session';
	import CornerDownLeft from 'lucide-svelte/icons/corner-down-left';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';

	export let merit: MeritRequest;
	export let rocket: NDKEvent;

	let parsedRocket = new Rocket(rocket);

	let _votes = $ndk.storeSubscribe(
		{ '#a': [RocketATagFilter(rocket)], '#e': [merit.ID], kinds: [1410 as NDKKind] },
		{
			subId: merit.ID
		}
	);

	onDestroy(() => {
		_votes.unsubscribe();
	});

	let votes = derived(_votes, ($_votes) => {
		return new MapOfVotes($_votes, parsedRocket, merit).Votes;
	});

	let rocketUpdates = derived([votes, currentUser], ([$votes, $currentUser]) => {
		let events: NDKEvent[] = [];
		if ($currentUser && parsedRocket && parsedRocket.VotePowerForPubkey($currentUser.pubkey) > 0) {
			let votes = new Votes(Array.from($votes, ([_, v]) => v));
			let result = votes.Results().Result(parsedRocket);
			if (result && result == 'ratify' && !merit.IncludedInRocketState(parsedRocket)) {
				let e = parsedRocket.CreateUnsignedAMRProof(merit, votes);
				if (e) {
					e.ndk = $ndk;
					e.sign().then(() => {
						if (parsedRocket.ValidateAMRProof(e)) {
							let updatedRocket = parsedRocket.UpsertAMR(merit, e);
							if (updatedRocket) {
								updatedRocket.ndk = $ndk;
								updatedRocket.sign().then(() => {
									updatedRocket.publish().then(() => {
										goto(`${base}/rockets/${getRocketURL(rocket)}`);
									});
								});
							}
						}
					});
				}
			}
		}
		return events;
	});

	rocketUpdates.subscribe((c) => {
		if (c.length > 0) {
			console.log(c);
		}
	});
</script>

<Card.Root class="sm:col-span-2">
	<Card.Header class="pb-3">
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
			<Name ndk={$ndk} pubkey={merit.Pubkey} class="inline-block max-w-32 truncate p-2" />
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
							A competent freelance developer earns $70 CuckLoserBucks an hour (on average). Using
							this rate, the contributor is claiming to have spent about {merit.Sats / 1000} hours working
							on this.
						</span>
					</div>
					<div class="grid auto-rows-max gap-3">
						<div class="font-semibold">Reference Time</div>
						<div class="text-muted-foreground">{merit.Sats / 1000} hours</div>
					</div>
				</div>
				<Separator class="my-4" />
				<div class="font-semibold">Votes</div>
				{#if $votes.size == 0}<Alert
						><Info />Waiting for existing <span class="italic">{new Rocket(rocket).Name()}</span> Merit
						holders to vote</Alert
					>
				{/if}
				<Table.Root>
					<Table.Body>
						{#each $votes as [id, vote], _ (id)}
							<Table.Row
								on:click={() => {
									console.log(vote.Event.rawEvent());
								}}
								class="cursor-pointer {vote.VoteDirection == 'ratify'
									? 'bg-lime-600'
									: 'bg-red-700'} {vote.VoteDirection == 'ratify'
									? 'hover:bg-lime-700'
									: 'hover:bg-red-800'}"
							>
								<Table.Cell>
									<div class="flex flex-nowrap">
										<Avatar
											ndk={$ndk}
											pubkey={vote.Pubkey}
											class="h-10 w-10 flex-none rounded-full object-cover"
										/>
										<Name
											ndk={$ndk}
											pubkey={vote.Pubkey}
											class="inline-block max-w-32 truncate p-2"
										/>
									</div>
								</Table.Cell>
								<Table.Cell class="hidden text-left md:table-cell">{vote.VoteDirection}</Table.Cell>
								<Table.Cell class="table-cell text-right"
									>{unixToRelativeTime(vote.TimeStamp * 1000)}</Table.Cell
								>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div></Card.Content
		>
	</Card.Header>
	<Card.Footer class="flex flex-row items-center border-t px-6 py-3">
		<VoteOnMeritRequest {merit} rocket={new Rocket(rocket)} />
	</Card.Footer>
</Card.Root>

<Card.Root class="sm:col-span-1">
	<Card.Header class="pb-3"><Card.Title>Discussion</Card.Title></Card.Header>
	<form
		class="relative overflow-hidden rounded-lg border bg-background focus-within:ring-1 focus-within:ring-ring"
	>
		<Label for="message" class="sr-only">Message</Label>
		<Textarea
			id="message"
			placeholder="Type your comment here..."
			class="min-h-12 resize-none border-0 p-3 shadow-none"
		/>
		<div class="flex items-center p-3 pt-0">
			<Button type="submit" size="sm" class="ml-auto gap-1.5">
				Publish
				<CornerDownLeft class="size-3.5" />
			</Button>
		</div>
	</form>
</Card.Root>
