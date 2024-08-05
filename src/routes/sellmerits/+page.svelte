<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { Checkbox } from '@/components/ui/checkbox';
	import * as Table from '@/components/ui/table';
	import { type RocketAMR, AMRAuction, Rocket } from '@/event_helpers/rockets';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import { onDestroy, onMount } from 'svelte';
	import { derived } from 'svelte/store';
	import Login from '../../components/Login.svelte';
	import CreateAMRAuction from '../../components/CreateAMRAuction.svelte';
	import MeritAuctions from '../../stateupdaters/MeritAuctions.svelte';
	import Heading from '../../components/Heading.svelte';
	import type { NDKEventStore, ExtendedBaseType } from '@nostr-dev-kit/ndk-svelte';
	let rocketEvents = $ndk.storeSubscribe([{ kinds: [31108 as number] }], { subId: 'all_rockets' });
	let amrAuctionEvents = $ndk.storeSubscribe([{ kinds: [1412 as number] }], {
		subId: 'my_auctions'
	});

	onDestroy(() => {
		rocketEvents?.unsubscribe();
		amrAuctionEvents?.unsubscribe();
	});

	let rockets = derived(rocketEvents, ($rocketEvents) => {
		let m = new Map<string, NDKEvent>();
		for (let e of $rocketEvents) {
			let existing = m.get(e.pubkey + e.dTag);
			if (!existing) {
				existing = e;
			}
			if (e.created_at > existing) {
				existing = e;
			}
			m.set(e.pubkey + e.dTag, e);
		}
		return Array.from(m, ([_, e]) => new Rocket(e));
	});

	let myAmrAuctionEvents = derived(
		[currentUser, amrAuctionEvents],
		([$currentUser, $amrAuctionEvents]) => {
			let events = new Map<string, AMRAuction>();
			if ($currentUser) {
				for (let e of $amrAuctionEvents) {
					if (e.pubkey == $currentUser.pubkey) {
						let amr = e.tagValue('request');
						if (amr) {
							events.set(amr, new AMRAuction(undefined, e, undefined));
						}
					}
				}
			}
			return events;
		}
	);

	let myMeritRequests = derived(
		[currentUser, rockets, myAmrAuctionEvents],
		([$currentUser, $rockets, $myAmrAuctionEvents]) => {
			let merits = new Map<Rocket, RocketAMR[]>();
			if ($currentUser) {
				for (let r of $rockets) {
					//let parsedRocket = new Rocket(r);
					let _merits: RocketAMR[] = [];
					for (let [_, amr] of r.ApprovedMeritRequests()) {
						let amrAuction = $myAmrAuctionEvents.get(amr.ID);
						if (amrAuction) {
							amr.Extra = { eventAMR: amrAuction };
						}
						if (amr.Pubkey == $currentUser.pubkey) {
							_merits.push(amr);
						}
					}
					merits.set(r, _merits);
				}
			}

			return merits;
		}
	);

	let selected_amrs = new Map</* rocket id */ string, AMRAuction>();
	function toggleSelected(amr: RocketAMR, rocket: Rocket) {
		if (!selected_amrs.has(rocket.Event.id)) {
			selected_amrs.set(rocket.Event.id, new AMRAuction(rocket.Event));
		}
		let existing = selected_amrs.get(rocket.Event.id)!;
		if (existing.AMRIDs.includes(amr.ID)) {
			existing.Pop(amr);
		} else {
			existing.Push(amr);
		}
		selected_amrs.set(rocket.Event.id, existing);
		selected_amrs = selected_amrs;
	}

	function getSelectedStatus(rocket: string, id: string, data: Map<string, AMRAuction>): boolean {
		let has = false;
		let amr = data.get(rocket);
		if (amr) {
			has = amr.AMRIDs.includes(id);
		}
		return has;
	}

	function getMerits(rocket: string, data: Map<string, AMRAuction>): number {
		let m = data.get(rocket);
		console.log(m);
		let merits = 0;
		if (m && m.Merits) {
			merits = m.Merits;
		}
		return merits;
	}

	// function getTotal(auction:AMRAuction):number {
	//     let total = 0
	//     for (let [_, amr] of list) {
	//         total += amr.Merits
	//     }
	//     return total
	// }

	// function getAllForRocket(rocket:Rocket, selected:Map<string, AMRAuction>):Map<string, AMRAuction> {
	//     let thisRocket = new Map<string, AMRAuction>()
	//     for (let [_, amr] of selected) {
	//         if (amr.RocketD == rocket.Name() && amr.RocketP == rocket.Event.author.pubkey) {
	//             thisRocket.set(amr.AMRID, amr)
	//         }
	//     }
	// 	return thisRocket
	// }
</script>

<Heading title="Trade your Merits for Sats" />

{#if $currentUser}
	{#each $myMeritRequests as [rocket, amr]}
		{#if amr.length > 0}
			<h1>ROCKET: {rocket.Name()}</h1>

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
							<Table.Cell
								>{p.AMRIDs.length > 1 ? 'multiple' : p.AMRIDs[0].substring(0, 12)}</Table.Cell
							>
							<Table.Cell>{p.Merits}</Table.Cell>
							<Table.Cell>Pending</Table.Cell>
							<Table.Cell>{p.RxAddress}</Table.Cell>
							<Table.Cell class="text-right">{p.Merits}</Table.Cell>
						</Table.Row>
					{/each}

					{#each amr as a, id (a.ID)}
						{#if rocket.CanThisAMRBeSold(a.ID)}
							<Table.Row
								class={getSelectedStatus(rocket.Event.id, a.ID, selected_amrs)
									? 'bg-orange-500 hover:bg-orange-500'
									: ''}
							>
								<Table.Cell
									><Checkbox
										disabled={Boolean(a.Extra.eventAMR)}
										id={a.ID}
										checked={getSelectedStatus(rocket.Event.id, a.ID, selected_amrs)}
										on:click={() => {
											toggleSelected(a, rocket);
										}}
									/></Table.Cell
								>
								<Table.Cell
									><span
										class="cursor-pointer font-medium underline"
										on:click={() => {
											goto(`${base}/rockets/merits/${a.ID}`);
										}}>{a.ID.substring(0, 6)}</span
									></Table.Cell
								>
								<Table.Cell>{a.Merits}</Table.Cell>
								<Table.Cell>{a.Extra.eventAMR ? 'pending' : 'Eligible'}</Table.Cell>
								<Table.Cell>{a.Extra.eventAMR?.RxAddress}</Table.Cell>
								<Table.Cell class="text-right">{a.Merits}</Table.Cell>
							</Table.Row>
						{/if}
					{/each}
				</Table.Body>
			</Table.Root>
			<CreateAMRAuction
				{rocket}
				amrAuction={selected_amrs.get(rocket.Event.id)}
				bind:selected_amrs
			/>
		{/if}
	{/each}
{:else}<Login />{/if}
<MeritAuctions {rockets} />
