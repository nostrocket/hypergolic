<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { MapOfVotes, Votes, type MeritRequest, type VoteDirection } from '@/event_helpers/merits';
	import { ndk } from '@/ndk';
	import { NDKEvent, type NDKKind } from '@nostr-dev-kit/ndk';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { ExternalLink, Info } from 'lucide-svelte';
	import { onDestroy } from 'svelte';
	import VoteOnMeritRequest from './VoteOnMeritRequest.svelte';

	import { Separator } from '$lib/components/ui/separator/index.js';
	import * as Table from '@/components/ui/table';
	import { Rocket, RocketATagFilter } from '@/event_helpers/rockets';
	import {
		formatReferenceTime,
		getCuckPrice,
		getRocketURL,
		parseProblem,
		unixToRelativeTime
	} from '@/helpers';
	import { derived } from 'svelte/store';

	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { Alert } from '@/components/ui/alert';
	import { currentUser } from '@/stores/session';
	import MeritComment from './MeritComment.svelte';

	export let merit: MeritRequest;
	export let rocket: NDKEvent;
	let cuckPrice: number | undefined = undefined;

	let result: VoteDirection | undefined;

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

	$: {
		if (!cuckPrice) {
			getCuckPrice().then((data) => {
				if (data instanceof Error) {
					console.error(data);
				} else {
					cuckPrice = data;
				}
			});
		}
	}

	$: referenceTime = cuckPrice
		? formatReferenceTime(((merit.Sats / 100000000) * cuckPrice) / 70)
		: '...';

	let votes = derived(_votes, ($_votes) => {
		return new MapOfVotes($_votes, parsedRocket, merit).Votes;
	});

	let rocketUpdates = derived([votes, currentUser], ([$votes, $currentUser]) => {
		let events: NDKEvent[] = [];

		let votes = new Votes(Array.from($votes, ([_, v]) => v));
		result = votes.Results().Result(parsedRocket);
		if (result && result == 'ratify' && !merit.IncludedInRocketState(parsedRocket)) {
			if (
				$currentUser &&
				parsedRocket &&
				parsedRocket.VotePowerForPubkey($currentUser.pubkey) > 0
			) {
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

	let border = '';
	let background = '';
	$: {
		if (result == 'blackball' && !merit.IncludedInRocketState(parsedRocket)) {
			border = 'border-red-600';
			background = 'bg-red-600';
		}
		if (merit.IncludedInRocketState(parsedRocket)) {
			border = 'border-lime-600';
			background = 'bg-lime-600';
		}
	}
</script>

<Card.Root class="sm:col-span-2 {border}">
	<Card.Header class="pb-3">
		<div class="flex flex-nowrap justify-between">
			<Card.Title>
				{#await parseProblem(merit.Problem())}
					Problem: {merit.Problem().substring(0, 20)}
				{:then parsed}
					{parsed}
				{/await}
			</Card.Title>{#if merit.Solution()}<a
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
						<span>${cuckPrice ? ((merit.Sats / 100000000) * cuckPrice).toFixed(2) : 'Loading'}</span
						>
					</li>
				</ul>
				<Separator class="my-4" />
				<div class="grid grid-cols-2 gap-4">
					<div class="grid gap-3">
						<div class="font-semibold">Analysis</div>
						<span class="grid gap-0.5 not-italic text-muted-foreground">
							A competent freelance developer earns $70 CuckLoserBucks an hour (on average). Using
							this rate, the contributor is claiming to have spent about {referenceTime} working on this.
						</span>
					</div>
					<div class="grid auto-rows-max gap-3">
						<div class="font-semibold">Reference Time</div>
						<div class="text-muted-foreground">{referenceTime}</div>
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
	<Card.Footer class="flex flex-row justify-center border-t px-6 py-3 text-center {background}">
		{#if merit.IncludedInRocketState(parsedRocket)}
			<span class="scroll-m-20 text-lg font-semibold tracking-tight md:text-xl">APPROVED</span>
			<!-- <Alert><div slot="title">Approved</div>This Merit Request has been approved!</Alert> -->
		{:else if result == 'blackball'}
			<span class="scroll-m-20 text-lg font-semibold tracking-tight md:text-xl">REJECTED</span>
		{:else if !result}
			<VoteOnMeritRequest {merit} rocket={new Rocket(rocket)} />
		{/if}
	</Card.Footer>
</Card.Root>

<MeritComment {merit} />
