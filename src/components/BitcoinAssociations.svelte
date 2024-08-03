<script lang="ts">
	import * as Card from '@/components/ui/card';
	import * as Table from '@/components/ui/table';
	import { BitcoinAssociation, Rocket } from '@/event_helpers/rockets';
	import { ndk } from '@/ndk';
	import { getBalance } from '@/stores/bitcoin';
	import { NDKKind } from '@nostr-dev-kit/ndk';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { onDestroy, onMount } from 'svelte';

	export let rocket: Rocket;

	let _associationRequests = $ndk.storeSubscribe(
		[{ '#a': [`31108:${rocket.Event.author.pubkey}:${rocket.Name()}`], kinds: [1413 as NDKKind] }],
		{
			subId: `${rocket.Name()}_bitcoin_associations`
		}
	);

	onDestroy(() => {
		_associationRequests?.unsubscribe();
	});

	let addresses = new Map<string, BitcoinAssociation>()

	onMount(()=>{
		addresses = rocket.BitcoinAssociations()
		addresses.forEach(a => {
			if (a.Address) {
				getBalance(a.Address).then(v=>{a.Balance = v; addresses.set(a.Pubkey, a); addresses = addresses})
			}
		})
	})

</script>

<Card.Root class="sm:col-span-3">
	<Card.Header class="px-7">
		<Card.Title>Registered Bitcoin Addresses</Card.Title>
		<Card.Description
			>These people have registered a Bitcoin address and want to sponsor Contributors working on {rocket.Name()}</Card.Description
		>
	</Card.Header>
	<Card.Content>
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head class="w-[200px]">Sponsor</Table.Head>
					<Table.Head class="hidden text-left md:table-cell">Amount (Sats)</Table.Head>
					<Table.Head class="table-cell">Address</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each addresses as [pubkey, ba], _ (pubkey)}
					<Table.Row>
						<Table.Cell>
							<div class="flex flex-nowrap">
								<Avatar
									ndk={$ndk}
									pubkey={pubkey}
									class="h-10 w-10 flex-none rounded-full object-cover"
								/>
								<Name
									ndk={$ndk}
									pubkey={pubkey}
									class="hidden max-w-32 truncate p-2 md:inline-block"
								/>
							</div>
						</Table.Cell>
						<Table.Cell class="hidden text-left md:table-cell">
							{ba.Balance?ba.Balance.toLocaleString():"just wait a sec..."}
						</Table.Cell>
						<Table.Cell class="table-cell">{ba.Address}</Table.Cell>
						
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Card.Content>
</Card.Root>
