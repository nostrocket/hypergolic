<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import Badge from '@/components/ui/badge/badge.svelte';
	import * as Card from '@/components/ui/card';
	import * as Table from '@/components/ui/table';
	import { MapOfMeritResult, MeritRequest } from '@/event_helpers/merits';
	import { Rocket, RocketATagFilter } from '@/event_helpers/rockets';
	import { unixToRelativeTime } from '@/helpers';
	import { ndk } from '@/ndk';
	import { NDKKind } from '@nostr-dev-kit/ndk';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { onDestroy } from 'svelte';
	import { derived, writable } from 'svelte/store';
	import CreateMeritRequest from './CreateMeritRequest.svelte';

	//export let rocket: NDKEvent;
	export let rocket: Rocket; // = new Rocket(rocket);

	let _merits = $ndk.storeSubscribe(
		[{ '#a': [`31108:${rocket.Event.author.pubkey}:${rocket.Name()}`], kinds: [1409 as NDKKind] }],
		{
			subId: `${rocket.Name()}_merits`
		}
	);

	let _votes = $ndk.storeSubscribe({
		'#a': [RocketATagFilter(rocket.Event)],
		kinds: [1410 as NDKKind]
	});

	onDestroy(() => {
		_merits?.unsubscribe();
		_votes?.unsubscribe();
	});

	let truncate = writable(true);

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

	let meritsTruncated = derived([merits, truncate], ([$merits, $truncate]) => {
		let meritsArray = Array.from($merits, ([_, m]) => {
			return m;
		});
		if (meritsArray.length > 6 && $truncate) {
			meritsArray.length = 6;
		}
		return meritsArray;
	});

	let votes = derived(_votes, ($_votes) => {
		return new MapOfMeritResult($_votes, rocket).meritResult;
	});

	type MeritUIStatus = 'approved' | 'rejected' | 'pending';

	const status = (merit: MeritRequest): MeritUIStatus => {
		if (merit.IncludedInRocketState(rocket)) {
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
	<Card.Header class="pb-3">
		<Card.Title>Merit Requests</Card.Title>
		<Card.Description>Merit Requests</Card.Description>
	</Card.Header>
	<Card.Content>
		<CreateMeritRequest {rocket} />
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head class="w-[100px]">Contributor</Table.Head>
					<Table.Head class="hidden text-left md:table-cell">Problem</Table.Head>
					<Table.Head class="table-cell">Amount (Sats)</Table.Head>
					<Table.Head class="table-cell">Merits</Table.Head>
					<Table.Head class="hidden text-center md:table-cell">Status</Table.Head>
					<Table.Head class="hidden text-right md:table-cell">When</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each $meritsTruncated as merit, _ (merit.ID)}
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
									class="h-8 w-8 flex-none rounded-full object-cover"
								/>
								<Name
									ndk={$ndk}
									pubkey={merit.Pubkey}
									class="hidden max-w-32 truncate p-1 md:inline-block"
								/>
							</div>
						</Table.Cell>
						<Table.Cell class="hidden text-left md:table-cell">
							{merit.Problem().split('\n')[0]}
						</Table.Cell>
						<Table.Cell class="table-cell">{merit.Sats}</Table.Cell>
						<Table.Cell class="table-cell">{merit.Merits}</Table.Cell>
						<Table.Cell class="table-cell text-center">{status(merit).toUpperCase()}</Table.Cell>
						<Table.Cell class="hidden text-right md:table-cell"
							>{unixToRelativeTime(merit.TimeStamp * 1000)}</Table.Cell
						>
					</Table.Row>
				{/each}
				{#if $merits.size > $meritsTruncated.length}
					<span
						on:click={() => {
							truncate.set(false);
						}}
						class="m-2 flex w-48 flex-nowrap text-lg"
						><Badge href="#">View {$merits.size - $meritsTruncated.length} more</Badge></span
					>
				{/if}
			</Table.Body>
		</Table.Root>
	</Card.Content>
</Card.Root>
