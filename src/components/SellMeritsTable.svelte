<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { Checkbox } from '@/components/ui/checkbox';
	import * as Table from '@/components/ui/table';
	import { currentUser } from '@/stores/session';
	import { type RocketAMR, AMRAuction, Rocket } from '@/event_helpers/rockets';
	import CreateAMRAuction from './CreateAMRAuction.svelte';
	import Heading from './Heading.svelte';

	export let rocket: Rocket;
	export let amr: RocketAMR[];

	let selected_amrs: AMRAuction | undefined;

	function toggleSelected(amr: RocketAMR) {
		if (!selected_amrs) {
			selected_amrs = new AMRAuction(rocket.Event);
		}
		let existing = selected_amrs;
		if (existing.AMRIDs.includes(amr.ID)) {
			existing.Pop(amr);
		} else {
			existing.Push(amr);
		}
		selected_amrs = existing;
	}

	function getSelectedStatus(id: string, data: AMRAuction): boolean {
		let has = false;
		let amr = data;
		if (amr) {
			has = amr.AMRIDs.includes(id);
		}
		return has;
	}
</script>

{#if $currentUser && amr.length > 0}
	<Heading title={`ROCKET: ${rocket.Name()}`} />
	<Table.Root>
		<Table.Header>
			<Table.Row>
				<Table.Head class="w-[100px]">Selected</Table.Head>
				<Table.Head class="w-[10px]">AMR</Table.Head>
				<Table.Head>Merits</Table.Head>
				<Table.Head>Status</Table.Head>
				<Table.Head>Receiving Address</Table.Head>
				<Table.Head class="text-right">Sats (approx)</Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each rocket.PendingAMRAuctions().filter((r) => {
				return Boolean(r.Owner == $currentUser.pubkey);
			}) as p}
				<Table.Row class="bg-purple-500 hover:bg-purple-600">
					<Table.Cell><Checkbox /></Table.Cell>
					<Table.Cell>{p.AMRIDs.length > 1 ? 'multiple' : p.AMRIDs[0].substring(0, 12)}</Table.Cell>
					<Table.Cell>{p.Merits}</Table.Cell>
					<Table.Cell>Pending</Table.Cell>
					<Table.Cell>{p.RxAddress}</Table.Cell>
					<Table.Cell class="text-right">{p.Merits}</Table.Cell>
				</Table.Row>
			{/each}

			{#each amr as a, id (a.ID)}
				{#if rocket.CanThisAMRBeSold(a.ID)}
					<Table.Row
						class={getSelectedStatus(a.ID, selected_amrs)
							? 'bg-orange-500 hover:bg-orange-500'
							: ''}
					>
						<Table.Cell
							><Checkbox
								disabled={Boolean(a.Extra?.eventAMR)}
								id={a.ID}
								checked={getSelectedStatus(a.ID, selected_amrs)}
								on:click={() => {
									toggleSelected(a);
								}}
							/></Table.Cell
						>
						<Table.Cell>
							<span
								class="cursor-pointer font-medium underline"
								on:click={() => {
									goto(`${base}/rockets/merits/${a.ID}`);
								}}
							>
								{a.ID.substring(0, 6)}
							</span>
						</Table.Cell>
						<Table.Cell>{a.Merits}</Table.Cell>
						<Table.Cell>{a.Extra?.eventAMR ? 'pending' : 'Eligible'}</Table.Cell>
						<Table.Cell>{a.Extra?.eventAMR?.RxAddress}</Table.Cell>
						<Table.Cell class="text-right">{a.Merits}</Table.Cell>
					</Table.Row>
				{/if}
			{/each}
		</Table.Body>
	</Table.Root>
	<CreateAMRAuction {rocket} amrAuction={selected_amrs} bind:selected_amrs />
{/if}
