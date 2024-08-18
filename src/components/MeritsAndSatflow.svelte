<script lang="ts">
	import * as Card from '@/components/ui/card';
	import * as Table from '@/components/ui/table';
	import { Rocket, ZapPurchase } from '@/event_helpers/rockets';
	import { ndk } from '@/ndk';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { writable } from 'svelte/store';
	import Pie from './Pie.svelte';
	import NumberIncrement from './NumberIncrement.svelte';
	import { toast } from 'svelte-sonner';
	import { onMount } from 'svelte';
	import PurchaseToast from './PurchaseToast.svelte';
	import { devmode } from '@/stores/session';
	import Button from '@/components/ui/button/button.svelte';
	import { sleep } from '@/helpers';

	export let rocket: Rocket;
	export let unratifiedZaps: Map<string, ZapPurchase>;

	let unratifiedZapsAmount = 0;
	let lastCheckTime = Date.now() / 1000;

	let revenueClass = '';

	function toastIt(zapPurchase: ZapPurchase) {
		revenueClass = ' text-xl';
		toast(PurchaseToast, {
			componentProps: {
				zapPurchase,
				rocket: rocket
			}
		});
		sleep(3000).then(() => {
			revenueClass = 'text-base';
		});
	}

	function checkNewZaps() {
		const currentTime = Date.now() / 1000;
		const recentZaps = Array.from(unratifiedZaps.values()).filter(
			(zap) =>
				zap.ZapReceipt.created_at &&
				zap.ZapReceipt.created_at > lastCheckTime &&
				zap.ZapReceipt.created_at <= currentTime
		);

		recentZaps.forEach((zapPurchase) => {
			toastIt(zapPurchase);
		});

		lastCheckTime = currentTime;
	}
	$: {
		if (unratifiedZaps.size > 0) {
			checkNewZaps();
		}
	}

	onMount(() => {
		lastCheckTime = Date.now() / 1000 - 30; // 30 seconds ago
	});

	$: mostRecentZap = Array.from(unratifiedZaps.values()).sort((a, b) => {
		if (a.ZapReceipt.created_at && b.ZapReceipt.created_at) {
			return b.ZapReceipt.created_at - a.ZapReceipt.created_at;
		} else return 0;
	})[0];

	$: {
		unratifiedZapsAmount = 0;
		for (let [_, a] of unratifiedZaps) {
			unratifiedZapsAmount += a.Amount / 1000;
		}
		unratifiedZapsAmount = unratifiedZapsAmount;
	}
	let _merits: { pubkey: string; merits: number; sats: number }[] = [];

	let merits = writable(_merits);

	$: {
		let m = new Map<string, { merits: number; sats: number }>();
		for (let [_, amr] of rocket.ApprovedMeritRequests()) {
			let existing = m.get(amr.Pubkey);
			if (!existing) {
				existing = { merits: 0, sats: 0 };
			}
			existing.merits += amr.Merits;
			existing.sats += amr.SatsOwed();
			m.set(amr.Pubkey, existing);
		}

		//calculate percentage ownership of each pubkey and divide the unratified sats among them (round up to nearest sat):
		let satsPerMeritPercentage = unratifiedZapsAmount / 100;
		let totalMerits = rocket.TotalMerits();
		for (let [id, _m] of m) {
			_m.sats += (_m.merits / totalMerits) * 100 * satsPerMeritPercentage;
			_m.sats = Math.round(_m.sats);
			m.set(id, _m);
		}

		let _merits: { pubkey: string; merits: number; sats: number }[] = [];
		for (let [pubkey, _m] of m) {
			_merits.push({ pubkey: pubkey, merits: _m.merits, sats: _m.sats });
		}
		if (_merits.length == 0) {
			_merits.push({ pubkey: rocket.Event.pubkey, merits: 1, sats: 0 });
		}

		merits.set(_merits);
	}

	const COLORS = [
		'bg-rose-500',
		'bg-pink-500',
		'bg-teal-500',
		'bg-orange-500',
		'bg-purple-500',
		'bg-sky-500',
		'bg-green-500',
		'bg-yellow-500',
		'bg-zinc-500',
		'bg-light-500'
	];

	function c(i: number) {
		return COLORS[i];
	}
</script>

<Card.Root class="sm:col-span-3">
	<Card.Header class="pb-3">
		<Card.Title>Merits and Satflow</Card.Title>
		<Card.Description class="grid grid-cols-1 lg:grid-cols-2">
			<div class="col-span-1">
				This graph displays the Meritization of equity in {rocket.Name()}
				<Pie data={$merits} />
			</div>

			<Table.Root class="col-span-1 text-black">
				<Table.Header>
					<Table.Row class="">
						<Table.Head>Participant</Table.Head>
						<Table.Head class="table-cell">Merits</Table.Head>
						<Table.Head class="text-right">Revenue (Sats)</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each $merits as { pubkey, merits, sats }, i (pubkey)}
						<Table.Row class="{c(i)} hover:{c(i)} hover:brightness-125 hover:contrast-150">
							<Table.Cell>
								<div class="flex flex-nowrap items-center gap-2">
									<Avatar ndk={$ndk} {pubkey} class="h-8 w-8 flex-none rounded-full object-cover" />
									<Name ndk={$ndk} {pubkey} class="hidden max-w-32 truncate p-1 md:inline-block" />
								</div>
							</Table.Cell>
							<Table.Cell
								class="table-cell text-pretty font-mono font-extrabold text-white dark:text-gray-900"
							>
								<NumberIncrement targetValue={merits} />
							</Table.Cell>
							<Table.Cell
								class="table-cell text-pretty text-right font-mono font-extrabold text-white dark:text-gray-900 {revenueClass}"
							>
								<NumberIncrement targetValue={sats} />
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Description>
	</Card.Header>
	<Card.Footer>
		{#if $devmode}
			<Button
				on:click={() => {
					if (!mostRecentZap) {
						toast('unratifiedZaps is null');
					} else {
						toastIt(mostRecentZap);
					}
				}}
				variant="outline">Popup Last Purchase Notification</Button
			>
			<Button variant="outline" on:click={() => console.log(Array.from(unratifiedZaps.values()))}
				>print unratifiedZaps</Button
			>
		{/if}
	</Card.Footer>
</Card.Root>
