<script lang="ts">
	import { type RocketAMR, AMRAuction, Rocket } from '@/event_helpers/rockets';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import { onDestroy, onMount } from 'svelte';
	import { derived } from 'svelte/store';
	import Login from '../../components/Login.svelte';
	import SellMeritsTable from '../../components/SellMeritsTable.svelte';
	import MeritAuctions from '../../stateupdaters/MeritAuctions.svelte';
	import Heading from '../../components/Heading.svelte';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
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
			if (e.created_at > existing.created_at) {
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

	let meritRequestStore = derived(
		[currentUser, rockets, myAmrAuctionEvents],
		([$currentUser, $rockets, $myAmrAuctionEvents]) => {
			let mainnet: Map<Rocket, RocketAMR[]> = new Map();
			let testnet: Map<Rocket, RocketAMR[]> = new Map();

			if ($currentUser) {
				for (let r of $rockets) {
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

					if (r.Name().toLowerCase().includes('test')) {
						testnet.set(r, _merits);
					} else {
						mainnet.set(r, _merits);
					}
				}
			}

			return { mainnet, testnet };
		}
	);

	let mainnet: Map<Rocket, RocketAMR[]> = new Map();
	let testnet: Map<Rocket, RocketAMR[]> = new Map();

	meritRequestStore.subscribe(($meritRequestStore) => {
		mainnet = $meritRequestStore.mainnet;
		testnet = $meritRequestStore.testnet;
	});

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
	<Tabs.Root value="mainnet">
		<Tabs.List>
			<Tabs.Trigger value="mainnet">Mainnet</Tabs.Trigger>
			<Tabs.Trigger value="testnet">Testnet</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="mainnet">
			{#each mainnet as [rocket, amr]}
				<SellMeritsTable {rocket} {amr} />
			{/each}
		</Tabs.Content>
		<Tabs.Content value="testnet">
			{#each testnet as [rocket, amr]}
				<SellMeritsTable {rocket} {amr} />
			{/each}
		</Tabs.Content>
	</Tabs.Root>
{:else}<Login />{/if}
<MeritAuctions {rockets} />
