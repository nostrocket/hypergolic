<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import * as Card from '@/components/ui/card';
	import * as Table from '@/components/ui/table';
	import { MapOfMeritResult, MeritRequest } from '@/event_helpers/merits';
	import { Rocket, RocketATagFilter } from '@/event_helpers/rockets';
	import { unixToRelativeTime } from '@/helpers';
	import { ndk } from '@/ndk';
	import { NDKEvent, NDKKind } from '@nostr-dev-kit/ndk';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { onDestroy } from 'svelte';
	import { derived } from 'svelte/store';

	//export let rocket: NDKEvent;
	export let parsedRocket:Rocket;// = new Rocket(rocket);

	let _merits = $ndk.storeSubscribe(
		[{ '#a': [`31108:${parsedRocket.Event.author.pubkey}:${parsedRocket.Name()}`], kinds: [1409 as NDKKind] }],
		{
			subId: `${parsedRocket.Name()}_merits`
		}
	);

	let _votes = $ndk.storeSubscribe({ '#a': [RocketATagFilter(parsedRocket.Event)], kinds: [1410 as NDKKind] });

	onDestroy(() => {
		_merits?.unsubscribe();
		_votes?.unsubscribe();
	});

	let merits = derived(_merits, ($merits) => {
		let map = new Map<string, MeritRequest>();
		for (let z of $merits) {
			let meritRequest = new MeritRequest(z);
			if (meritRequest.BasicValidation()) {
				if (meritRequest.Event.sig) {
					//broadcast the events to our relays
					//meritRequest.Event.ndk = $ndk
					//meritRequest.Event.publish().then(r=>{ console.log(meritRequest.Event.pubkey,r)}).catch(e=>{})
				}
				map.set(meritRequest.ID, meritRequest);
			}
		}
		return map;
	});

	let votes = derived(_votes, ($_votes) => {
		return new MapOfMeritResult($_votes, parsedRocket).meritResult;
	});

	type MeritUIStatus = 'approved' | 'rejected' | 'pending';

	const status = (merit: MeritRequest): MeritUIStatus => {
		if (merit.IncludedInRocketState(parsedRocket)) {
			return 'approved';
		}
		if ($votes.get(merit.ID) === 'blackball') {
			return 'rejected';
		}
		return 'pending';
	};

	const background = (merit: MeritRequest) => {
		if (status(merit) === 'approved') {
			return 'bg-lime-500 hover:bg-lime-400 dark:hover:bg-lime-600';
		} else if (status(merit) === 'rejected') {
			return 'bg-red-500 hover:bg-red-400 dark:hover:bg-red-600';
		} else {
			return 'bg-accent';
		}
	};

	//todo: update rocket event with confirmed zaps if we have votepower
</script>

<Card.Root class="sm:col-span-3">
	<Card.Header class="px-7">
		<Card.Title>Merit Requests</Card.Title>
		<Card.Description>Merit Requests</Card.Description>
	</Card.Header>
	<Card.Content>
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>Contributor</Table.Head>
					<Table.Head class="hidden text-left md:table-cell">Problem</Table.Head>
					<Table.Head class="table-cell">Amount (Sats)</Table.Head>
					<Table.Head class="table-cell">Merits</Table.Head>
					<Table.Head class="hidden text-right md:table-cell">When</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each $merits as [id, merit], _ (id)}
					<Table.Row
						on:click={() => {
							goto(`${base}/rockets/merits/${merit.ID}`);
						}}
						class={`cursor-pointer ${background(merit)}`}
					>
						<Table.Cell>
							<div class="flex flex-nowrap">
								<Avatar
									ndk={$ndk}
									pubkey={merit.Pubkey}
									class="h-10 w-10 flex-none rounded-full object-cover"
								/>
								<Name
									ndk={$ndk}
									pubkey={merit.Pubkey}
									class="hidden max-w-32 truncate p-2 md:inline-block"
								/>
							</div>
						</Table.Cell>
						<Table.Cell class="hidden text-left md:table-cell">
							{merit.Problem().split('\n')[0]}
						</Table.Cell>
						<Table.Cell class="table-cell">{merit.Sats}</Table.Cell>
						<Table.Cell class="table-cell">{merit.Merits}</Table.Cell>
						<Table.Cell class="hidden text-right md:table-cell"
							>{unixToRelativeTime(merit.TimeStamp * 1000)}</Table.Cell
						>
						<Table.Cell class="table-cell">{status(merit).toUpperCase()}</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Card.Content>
</Card.Root>
