<script lang="ts">
	import { ndk } from '@/ndk';
	import type { AMRAuction, Rocket } from '@/event_helpers/rockets';
	import { bitcoinTip, txs } from '@/stores/bitcoin';

	import BuyAmr from './BuyAMR.svelte';
	import Heading from './Heading.svelte';
	import { Avatar } from '@nostr-dev-kit/ndk-svelte-components';
	import * as Table from '@/components/ui/table';
	import * as Card from '@/components/ui/card';
	import { Badge } from '@/components/ui/badge';

	export let rocket: Rocket;
	export let amr: AMRAuction[];
	export let transactions: Map<string, txs>;

	let dev = false;

	function getRocketClass(rocket: Rocket): string {
		return rocket.Testnet() ? 'dark:border-red-600 mb-2' : 'mb-2';
	}
</script>

<Card.Root class={getRocketClass(rocket)}>
	<Card.CardHeader>
		<div class="flex flex-nowrap place-items-stretch">
			<h3 class=" mr-auto text-nowrap text-2xl">
				{`ROCKET: ${rocket.Name().toUpperCase()}`}
			</h3>
			{#if rocket.Testnet()}<Badge
					variant="destructive"
					class="flex h-8 shrink-0 items-center justify-center rounded-sm"
				>
					<span
						on:click={() => {
							dev = true;
							alert(
								'dev mode enabled, refresh page if this was unintentional or you may lose sats'
							);
						}}>TESTNET</span
					>
				</Badge>{/if}
		</div>
		<Heading></Heading>
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head class="w-[10px]">Seller</Table.Head>
					<Table.Head class="w-[10px]">AMR</Table.Head>
					<Table.Head class="w-[10px]">Merits</Table.Head>
					<Table.Head class="w-[150px] text-right">Current Price (sats)</Table.Head>
					<Table.Head>Status</Table.Head>
					<Table.Head>Receiving Address</Table.Head>
					<Table.Head></Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each amr as p (p.AMRIDs)}
					<Table.Row>
						<Table.Cell
							><Avatar
								ndk={$ndk}
								pubkey={p.Owner}
								class="aspect-square w-10 flex-none rounded-full object-cover"
							/></Table.Cell
						>
						<Table.Cell
							>{p.AMRIDs.length > 1 ? 'multiple' : p.AMRIDs[0].substring(0, 12)}</Table.Cell
						>
						<Table.Cell>{p.Merits}</Table.Cell>
						<Table.Cell class="text-right">{p.Merits}</Table.Cell>
						<Table.Cell
							>{p.Status(rocket, $bitcoinTip.height, transactions.get(p.RxAddress))}</Table.Cell
						>
						<Table.Cell
							on:click={() => {
								console.log(transactions.get(p.RxAddress)?.From());
							}}>{p.RxAddress}</Table.Cell
						>
						<Table.Cell
							>{#if p.Status(rocket, $bitcoinTip.height, transactions.get(p.RxAddress)) == 'OPEN' && (!rocket.Testnet() || dev)}
								<BuyAmr auction={p} />{/if}</Table.Cell
						>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Card.CardHeader>
</Card.Root>
