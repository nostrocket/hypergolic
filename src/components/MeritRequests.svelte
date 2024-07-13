<script lang="ts">
	import * as Card from '@/components/ui/card';
	import * as Table from '@/components/ui/table';
	import { MeritRequest } from '@/event_helpers/merits';
	import { ZapPurchase, type RocketProduct } from '@/event_helpers/rockets';
	import { unixToRelativeTime } from '@/helpers';
	import { ndk } from '@/ndk';
	import { NDKEvent, NDKKind } from '@nostr-dev-kit/ndk';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { onDestroy, onMount } from 'svelte';
	import { derived } from 'svelte/store';

	export let rocket: NDKEvent;

	let _merits = $ndk.storeSubscribe(
		[{ '#a': [`31108:${rocket.author.pubkey}:${rocket.dTag}`], kinds: [1409 as NDKKind] }],
		{
			subId: `${rocket.dTag}_merits`
		}
	);

	onDestroy(() => {
		_merits?.unsubscribe();
	});




	let merits = derived(_merits, ($merits) => {
		let map = new Map<string, MeritRequest>();
		for (let z of $merits) {
			let meritRequest = new MeritRequest(z);
			if (meritRequest.Valid(rocket)) {
				map.set(meritRequest.ID, meritRequest);
			}
		}
		return map;
	});

	//todo: update rocket event with confirmed zaps if we have votepower
</script>

<Card.Root class="sm:col-span-3">
	<Card.Header class="px-7">
		<Card.Title>Merit Requests</Card.Title>
		<Card.Description
			>Merit Requests</Card.Description
		>
	</Card.Header>
	<Card.Content>
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>Contributor</Table.Head>
					<Table.Head class="hidden md:table-cell text-left">Problem</Table.Head>
					<Table.Head class="table-cell">Amount (Sats)</Table.Head>
					<Table.Head class="table-cell">Merits</Table.Head>
					<Table.Head class="hidden md:table-cell text-right">When</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each $merits as [id, merit], _ (id)}
					<Table.Row
						on:click={() => {
							console.log(merit.Request.rawEvent());
						}}
						class="bg-accent cursor-pointer"
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
									class="hidden md:inline-block max-w-32 truncate p-2"
								/>
							</div>
						</Table.Cell>
						<Table.Cell class="hidden md:table-cell text-left"
						>{merit.Problem()}</Table.Cell
					>
						<Table.Cell class="table-cell">{merit.Sats}</Table.Cell>
						<Table.Cell class="table-cell">{merit.Merits}</Table.Cell>
						<Table.Cell class="hidden md:table-cell text-right"
							>{unixToRelativeTime(merit.TimeStamp * 1000)}</Table.Cell
						>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Card.Content>
</Card.Root>
