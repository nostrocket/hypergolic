<script lang="ts">
	import Button from '@/components/ui/button/button.svelte';
	import * as Table from '@/components/ui/table';
	import { AMRAuction, Rocket } from '@/event_helpers/rockets';
	import { ndk } from '@/ndk';
	import { bitcoinTip, getIncomingTransactions, txs } from '@/stores/bitcoin';
	import { currentUser } from '@/stores/session';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import { Avatar } from '@nostr-dev-kit/ndk-svelte-components';
	import { onDestroy } from 'svelte';
	import { derived } from 'svelte/store';
	import AssociateBitcoinAddress from '../../components/AssociateBitcoinAddress.svelte';
	import Heading from '../../components/Heading.svelte';
	import Login from '../../components/Login.svelte';
	import MeritAuctions from '../../stateupdaters/MeritAuctions.svelte';
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
		let merits = new Map<Rocket, AMRAuction[]>();
		for (let r of $rockets) {
			let _auctions: AMRAuction[] = r.PendingAMRAuctions();
			merits.set(r, _auctions);
		}

		return merits;
	});

	let _transactions = new Map<string, txs>();
	let transactions = derived(pendingSales, ($pendingSales) => {
		for (let [r, s] of $pendingSales) {
			for (let amr of s) {
				if (!_transactions.get(amr.RxAddress)) {
					_transactions.set(amr.RxAddress, new txs(amr.RxAddress));
				}
				let existing = _transactions.get(amr.RxAddress)!;
				if (Math.floor(new Date().getTime() / 1000) > existing.LastAttempt + 10000) {
					existing.LastAttempt = Math.floor(new Date().getTime() / 1000);
					getIncomingTransactions(amr.RxAddress)
						.then((result) => {
							if (result) {
								existing.LastUpdate = Math.floor(new Date().getTime() / 1000);
							}
							if (result.length > 0) {
								existing.Data = result;
								_transactions.set(amr.RxAddress, existing);
								_transactions = _transactions;
							}
						})
						.catch((c) => {
							console.log(c);
						});
				}
			}
		}
		return _transactions;
	});

	let nextSoldButNotInState = derived(
		[pendingSales, transactions, bitcoinTip, currentUser],
		([$pendingSales, $transactions, $bitcoinTip, $currentUser]) => {
			if ($currentUser) {
				for (let [r, p] of $pendingSales) {
					if (r.VotePowerForPubkey($currentUser.pubkey) > 0) {
						for (let amrAuction of p) {
							if (
								amrAuction.Status(r, $bitcoinTip.height, $transactions.get(amrAuction.RxAddress)) ==
								'SOLD & PENDING RATIFICATION'
							) {
								let txs = $transactions.get(amrAuction.RxAddress);
								if (txs) {
									for (let [address, txo] of txs.From()) {
										for (let [_, ba] of r.BitcoinAssociations()) {
											if (ba.Address == txo.From) {
												return {
													auction: amrAuction,
													buyer: ba.Pubkey,
													txid: txo.ID,
													sats: txo.Amount
												};
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
		if (t) console.log(t);
	});

	transactions.subscribe((t) => {});

	let noAssociatedBitcoinAddress = derived(
		[currentUser, pendingSales],
		([$currentUser, $pendingSales]) => {
			let show = false;
			if ($currentUser) {
				for (let [r, a] of $pendingSales) {
					if (a.length > 0 && !r.BitcoinAssociations().get($currentUser.pubkey)) {
						console.log($currentUser.pubkey, r.Name());
						show = true;
					}
				}
			}
			return show;
		}
	);
</script>

{#if $noAssociatedBitcoinAddress}<AssociateBitcoinAddress />{/if}

{#if $currentUser}
	{#each $pendingSales as [rocket, amr] (rocket.Event.id)}
		{#if amr.length > 0}
			<Heading title={`ROCKET: ${rocket.Name()}`} />
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
								>{p.Status(rocket, $bitcoinTip.height, $transactions.get(p.RxAddress))}</Table.Cell
							>
							<Table.Cell
								on:click={() => {
									console.log($transactions.get(p.RxAddress)?.From());
								}}>{p.RxAddress}</Table.Cell
							>
							<Table.Cell
								>{#if p.Status(rocket, $bitcoinTip.height, $transactions.get(p.RxAddress)) == 'OPEN'}<Button
										>BUY NOW</Button
									>{/if}</Table.Cell
							>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	{/each}
{:else}<Login />{/if}
<MeritAuctions {rockets} />
