<script lang="ts">
	import { AMRAuction, MeritPurchase, Rocket } from '@/event_helpers/rockets';
	import { ndk } from '@/ndk';
	import { bitcoinTip, getIncomingTransactions, txs } from '@/stores/bitcoin';
	import { currentUser } from '@/stores/session';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import { onDestroy } from 'svelte';
	import { derived, writable } from 'svelte/store';
	import AssociateBitcoinAddress from '../../components/AssociateBitcoinAddress.svelte';
	import BuyAmrCard from '../../components/BuyAMRCard.svelte';
	import Login from '../../components/Login.svelte';
	import MeritAuctions from '../../stateupdaters/MeritAuctions.svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import * as Tabs from '$lib/components/ui/tabs/index.js';

	let rocketEvents = $ndk.storeSubscribe([{ kinds: [31108 as number] }], { subId: 'all_rockets' });

	onDestroy(() => {
		rocketEvents?.unsubscribe();
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

	let pendingSales = derived(rockets, ($rockets) => {
		let mainnetMerits = new Map<Rocket, AMRAuction[]>();
		let testnetMerits = new Map<Rocket, AMRAuction[]>();

		for (let r of $rockets) {
			let _auctions: AMRAuction[] = r.PendingAMRAuctions();
			if (r.Testnet()) {
				testnetMerits.set(r, _auctions);
			} else {
				mainnetMerits.set(r, _auctions);
			}
		}

		return { mainnet: mainnetMerits, testnet: testnetMerits };
	});

	let _transactions = writable(new Map<string, txs>());
	let transactions = derived(pendingSales, ($pendingSales) => {
		for (let network of ['mainnet', 'testnet'] as const) {
			for (let [r, s] of $pendingSales[network]) {
				for (let amr of s) {
					if (!$_transactions.has(amr.RxAddress)) {
						_transactions.update((map) => {
							map.set(amr.RxAddress, new txs(amr.RxAddress));
							return map;
						});
					}
					let existing = $_transactions.get(amr.RxAddress)!;
					if (Math.floor(new Date().getTime() / 1000) > existing.LastAttempt + 10000) {
						existing.LastAttempt = Math.floor(new Date().getTime() / 1000);
						getIncomingTransactions(amr.RxAddress)
							.then((result) => {
								if (result) {
									existing.LastUpdate = Math.floor(new Date().getTime() / 1000);
								}
								if (Array.isArray(result)) {
									if (result.length > 0) {
										existing.Data = result;
										_transactions.update((map) => {
											map.set(amr.RxAddress, existing);
											return map;
										});
									}
								}
							})
							.catch((c) => {
								console.log(c);
							});
					}
				}
			}
		}
		return _transactions;
	});

	transactions.subscribe((t) => {});

	let nextSoldButNotInState = derived(
		[pendingSales, _transactions, bitcoinTip, currentUser],
		([$pendingSales, $_transactions, $bitcoinTip, $currentUser]) => {
			if ($currentUser) {
				for (let network of ['mainnet', 'testnet'] as const) {
					for (let [r, p] of $pendingSales[network]) {
						if (r.VotePowerForPubkey($currentUser.pubkey) > 0) {
							for (let amrAuction of p) {
								if (
									amrAuction.Status(
										r,
										$bitcoinTip.height,
										$_transactions.get(amrAuction.RxAddress)
									) == 'SOLD & PENDING RATIFICATION'
								) {
									let txs = $_transactions.get(amrAuction.RxAddress);
									if (txs) {
										for (let [address, txo] of txs.From()) {
											for (let [_, ba] of r.BitcoinAssociations()) {
												if (ba.Address == txo.From) {
													return new MeritPurchase(r, amrAuction, ba.Pubkey, txo);
												}
											}
										}
									}
								}
							}
						}
					}
				}
			}
		}
	);

	nextSoldButNotInState.subscribe((t) => {
		if (t) {
			//console.log(t.rocket.UpsertMeritTransfer(t)?.rawEvent());
			let e = t.rocket.UpsertMeritTransfer(t);
			if (e) {
				e.publish().then((x) => {
					console.log(goto(`${base}/${new Rocket(e).URL()}`));
				});
			}
			//t.rocket.UpsertMeritTransfer(t)?.publish()
		}
	});

	let nostrocket = derived(rockets, ($rockets) => {
		let rocket: Rocket | undefined = undefined;
		for (let r of $rockets) {
			if (
				r.Name() == 'NOSTROCKET' &&
				r.Event.pubkey == 'd91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075'
			) {
				//we consume the current list of bitcoin addresses from Nostrocket as a service so that users don't need to add a new address for every rocket
				//todo: make this dependent on votepower not my pubkey
				//todo: also allow rockets to have their own list of addresses so they can be used without nostrocket
				rocket = r;
			}
		}
		return rocket;
	});
</script>

{#if $nostrocket}
	<AssociateBitcoinAddress rocket={$nostrocket} />
{/if}

{#if $currentUser}
	<Tabs.Root value="mainnet">
		<Tabs.List>
			<Tabs.Trigger value="mainnet">Mainnet</Tabs.Trigger>
			<Tabs.Trigger value="testnet">Testnet</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="mainnet">
			{#each $pendingSales.mainnet as [rocket, amr] (rocket.Event.id)}
				{#if amr.length > 0}
					<BuyAmrCard {rocket} {amr} transactions={$_transactions} />
				{/if}
			{/each}
		</Tabs.Content>
		<Tabs.Content value="testnet">
			{#each $pendingSales.testnet as [rocket, amr] (rocket.Event.id)}
				{#if amr.length > 0}
					<BuyAmrCard {rocket} {amr} transactions={$_transactions} />
				{/if}
			{/each}
		</Tabs.Content>
	</Tabs.Root>
{:else}<Login />{/if}
<MeritAuctions {rockets} />
